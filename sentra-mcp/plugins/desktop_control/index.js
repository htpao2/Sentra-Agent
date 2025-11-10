import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 桌面控制插件 - nircmd.exe 实现
 * 功能丰富：窗口、鼠标、键盘、剪贴板、音量、截图、系统控制等
 * 官方网站：https://www.nirsoft.net/utils/nircmd.html
 */

/**
 * nircmd.exe 路径查找
 * 优先级：
 * 1. 插件 bin 目录
 * 2. 系统 PATH
 * 3. Windows\System32
 */
function getNircmdPath() {
  // 1. 插件 bin 目录
  const localPath = path.join(__dirname, 'bin', 'nircmd.exe');
  if (fs.existsSync(localPath)) {
    return localPath;
  }
  
  // 2. 系统 PATH 中查找
  return 'nircmd.exe';
}

const NIRCMD_PATH = getNircmdPath();

/**
 * 执行 nircmd 命令
 * 使用 windowsHide 参数确保完全隐藏窗口
 */
async function nircmd(...args) {
  // 转义参数中的引号
  const escapedArgs = args.map(arg => {
    if (typeof arg === 'string' && arg.includes(' ')) {
      return `"${arg.replace(/"/g, '\\"')}"`;
    }
    return arg;
  });
  
  // 直接调用 nircmd 命令
  const command = `"${NIRCMD_PATH}" ${escapedArgs.join(' ')}`;
  
  try {
    const { stdout, stderr } = await execAsync(command, {
      encoding: 'utf-8',
      timeout: 10000, // 10秒超时
      windowsHide: true // Node.js 参数：隐藏子进程窗口
    });
    
    return {
      success: true,
      stdout: stdout.trim(),
      stderr: stderr.trim()
    };
  } catch (error) {
    // nircmd 很多命令不输出内容，返回码非0也可能是正常的
    return {
      success: error.code === 0 || !error.stderr,
      stdout: error.stdout?.trim() || '',
      stderr: error.stderr?.trim() || error.message
    };
  }
}

// ==================== 指令解析（自然语言） ====================
/**
 * 解析自然语言指令为结构化动作
 * 支持：
 * - open/launch/start <app>
 * - close/focus/minimize/maximize/restore/show/hide <processName|"title">
 * - minimize all / show desktop
 * - click/right click/middle click/double click
 * - move mouse to X,Y
 * - press <keys>
 * - type <text>
 */
function parseInstruction(instruction) {
  if (!instruction || typeof instruction !== 'string') return null;
  const raw = instruction.trim();
  const s = raw.toLowerCase();

  // minimize all / show desktop
  if (/^(minimi[sz]e\s+all|show\s+desktop)$/.test(s)) {
    return { action: 'minimize_all' };
  }

  // move mouse to x,y
  {
    const m = s.match(/^move\s+mouse\s+to\s+(\d+)\s*[, ]\s*(\d+)$/);
    if (m) {
      return { action: 'mouse_move', x: parseInt(m[1], 10), y: parseInt(m[2], 10) };
    }
  }

  // mouse click variants
  if (/^(double\s+click|dblclick)$/.test(s)) return { action: 'mouse_doubleclick', button: 'left' };
  if (/^(right\s+click|click\s+right)$/.test(s)) return { action: 'mouse_click', button: 'right' };
  if (/^(middle\s+click|click\s+middle)$/.test(s)) return { action: 'mouse_click', button: 'middle' };
  if (/^click$/.test(s)) return { action: 'mouse_click', button: 'left' };

  // press keys
  {
    const m = s.match(/^press\s+(.+)$/);
    if (m) return { action: 'send_key', key: m[1].trim() };
  }

  // type text
  {
    const m = raw.match(/^type\s+(.+)$/i);
    if (m) return { action: 'type_text', text: m[1] };
  }

  // window actions with processName or title
  const winActionMap = ['minimize', 'min', 'maximize', 'max', 'restore', 'show', 'hide', 'close', 'focus', 'activate'];
  for (const act of winActionMap) {
    const re = new RegExp(`^${act}\\s+(?:window\\s+)?(?:\"([^\"]+)\"|(.+))$`, 'i');
    const m = raw.match(re);
    if (m) {
      const title = (m[1] || '').trim();
      const procOrTitle = (m[2] || '').trim();
      if (title) return { action: act, title };
      return { action: act, processName: procOrTitle };
    }
  }

  // open/launch/start app
  {
    const m = raw.match(/^(open|launch|start)\s+(.+)$/i);
    if (m) {
      let app = m[2].trim();
      // 简单别名映射
      const alias = {
        'vs code': 'code',
        'visual studio code': 'code',
        'chrome': 'chrome',
        'edge': 'msedge',
        'steam': 'steam',
        'notepad': 'notepad',
        '记事本': 'notepad'
      };
      const key = app.toLowerCase();
      if (alias[key]) app = alias[key];

      // URL/协议
      if (/^[a-z]+:\/\//i.test(app)) {
        return { action: 'launch_app', path: 'cmd.exe', args: `/c start ${app}` };
      }

      // 添加 .exe（如果没有后缀且不是带空格的已知命令）
      if (!/\.exe$/i.test(app) && !app.includes(' ')) app = `${app}.exe`;
      return { action: 'launch_app', path: app };
    }
  }

  return null; // 未匹配
}

// ==================== 窗口控制 ====================

/**
 * 窗口控制（按进程名）
 * nircmd win <action> process <process.exe>
 */
async function controlWindow(processName, action) {
  // 确保进程名包含 .exe
  const processFile = processName.endsWith('.exe') ? processName : `${processName}.exe`;
  
  const actionMap = {
    'min': 'min',
    'minimize': 'min',
    'max': 'max',
    'maximize': 'max',
    'restore': 'normal',
    'hide': 'hide',
    'show': 'show',
    'close': 'close',
    'activate': 'activate',
    'focus': 'activate'
  };
  
  const nircmdAction = actionMap[action.toLowerCase()];
  if (!nircmdAction) {
    throw new Error(`Unknown action: ${action}`);
  }
  
  const result = await nircmd('win', nircmdAction, 'process', processFile);
  return {
    processName,
    action: nircmdAction,
    success: result.success
  };
}

/**
 * 窗口控制（按标题）
 */
async function controlWindowByTitle(title, action) {
  const actionMap = {
    'min': 'min',
    'minimize': 'min',
    'max': 'max',
    'maximize': 'max',
    'restore': 'normal',
    'hide': 'hide',
    'show': 'show',
    'close': 'close',
    'activate': 'activate',
    'focus': 'activate'
  };
  
  const nircmdAction = actionMap[action.toLowerCase()];
  const result = await nircmd('win', nircmdAction, 'title', title);
  return {
    title,
    action: nircmdAction,
    success: result.success
  };
}

/**
 * 最小化所有窗口
 */
async function minimizeAll() {
  const result = await nircmd('win', 'min', 'alltop');
  return { message: 'All windows minimized', success: result.success };
}

/**
 * 关闭所有指定类型窗口
 */
async function closeAllProcess(processName) {
  const processFile = processName.endsWith('.exe') ? processName : `${processName}.exe`;
  const result = await nircmd('win', 'close', 'process', processFile);
  return { processName, success: result.success };
}

// ==================== 鼠标控制 ====================

/**
 * 移动鼠标
 */
async function moveMouse(x, y) {
  const result = await nircmd('setcursor', String(x), String(y));
  return { x, y, success: result.success };
}

/**
 * 鼠标点击
 */
async function mouseClick(button = 'left', action = 'click') {
  // button: left, right, middle
  // action: click, down, up, dblclick
  const result = await nircmd('sendmouse', button, action);
  return { button, action, success: result.success };
}

// ==================== 键盘控制 ====================

/**
 * 按键（组合键）
 */
async function sendKey(key) {
  // 支持：ctrl+c, alt+tab, win+d 等
  const result = await nircmd('sendkeypress', key);
  return { key, success: result.success };
}

/**
 * 输入文本
 */
async function typeText(text) {
  const result = await nircmd('sendkey', text, 'press');
  return { text, success: result.success };
}

// ==================== 系统控制 ====================

/**
 * 启动应用
 */
async function launchApp(appPath, args = '', workDir = '') {
  const result = await nircmd('exec', 'show', appPath, args, workDir);
  return { appPath, success: result.success };
}

// （已精简：移除系统操作函数）

/**
 * 主处理函数
 */
export async function handler(params) {
  
  try {
    // 优先使用自然语言指令
    if (params.instruction) {
      const parsed = parseInstruction(params.instruction);
      if (!parsed) {
        throw new Error(`Unsupported instruction: ${params.instruction}`);
      }
      // 将解析结果合并进参数流转
      Object.assign(params, parsed);
    }

    // 解析后的参数
    const { action, processName, title, path: appPath, args, workDir, x, y, button, key, text } = params;

    let result;
    
    // 窗口控制
    if (['min', 'minimize', 'max', 'maximize', 'restore', 'hide', 'show', 'close', 'activate', 'focus'].includes(action)) {
      if (title) {
        result = await controlWindowByTitle(title, action);
      } else if (processName) {
        result = await controlWindow(processName, action);
      } else {
        throw new Error('processName or title is required for window control');
      }
    }
    // 窗口批量操作
    else if (action === 'minimize_all') {
      result = await minimizeAll();
    }
    else if (action === 'close_all_process') {
      if (!processName) throw new Error('processName is required');
      result = await closeAllProcess(processName);
    }
    // 鼠标控制
    else if (action === 'mouse_move') {
      if (x === undefined || y === undefined) throw new Error('x and y are required');
      result = await moveMouse(x, y);
    }
    else if (action === 'mouse_click') {
      result = await mouseClick(button || 'left', 'click');
    }
    else if (action === 'mouse_down') {
      result = await mouseClick(button || 'left', 'down');
    }
    else if (action === 'mouse_up') {
      result = await mouseClick(button || 'left', 'up');
    }
    else if (action === 'mouse_doubleclick') {
      result = await mouseClick(button || 'left', 'dblclick');
    }
    // 键盘控制
    else if (action === 'send_key') {
      if (!key) throw new Error('key is required');
      result = await sendKey(key);
    }
    else if (action === 'type_text') {
      if (!text) throw new Error('text is required');
      result = await typeText(text);
    }
    else if (action === 'launch_app') {
      if (!appPath) throw new Error('path is required');
      result = await launchApp(appPath, args || '', workDir || '');
    }
    else {
      throw new Error(`Unknown action: ${action}`);
    }
    
    return {
      success: true,
      code: 'OK',
      data: result
    };
    
  } catch (error) {
    return {
      success: false,
      code: 'ERROR',
      error: error.message,
      data: null
    };
  }
}
