// HTML to Desktop App Generator
// 基于 Electron 将 HTML/应用描述转换为完整的桌面应用项目
// 支持一体化流程：生成代码 → 安装依赖 → 打包 → 压缩
import path from 'node:path';
import fs from 'node:fs/promises';
import { execSync } from 'node:child_process';
import archiver from 'archiver';
import { createWriteStream } from 'node:fs';
import logger from '../../src/logger/index.js';
import { config } from '../../src/config/index.js';
import { chatCompletion } from '../../src/openai/client.js';
import { abs as toAbs, toPosix } from '../../src/utils/path.js';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

// 支持的框架列表
const FRAMEWORKS = new Set(['electron-vanilla', 'electron-react', 'electron-vue', 'vanilla', 'react', 'vue']);

function isTimeoutError(e) {
  const msg = String(e?.message || e || '').toLowerCase();
  const code = String(e?.code || '').toUpperCase();
  return (
    code === 'ETIMEDOUT' ||
    code === 'ESOCKETTIMEDOUT' ||
    code === 'ECONNABORTED' ||
    msg.includes('timeout') ||
    msg.includes('timed out')
  );
}

function normalizeSentraProjectXmlText(raw) {
  const s0 = String(raw || '').trim();
  if (!s0) return '';
  const startRe = /<sentra_project\s*>/i;
  const endRe = /<\/sentra_project\s*>/ig;

  const startIdx = s0.search(startRe);
  if (startIdx < 0) return s0;
  let s = s0.slice(startIdx);

  const ends = [...s.matchAll(endRe)];
  if (ends.length > 0) {
    const last = ends[ends.length - 1];
    const endIdx = last.index + String(last[0]).length;
    s = s.slice(0, endIdx);
  }

  // Remove duplicate root start tags (keep the first)
  const startMatches = [...s.matchAll(startRe)];
  if (startMatches.length > 1) {
    const firstStart = startMatches[0].index;
    let out = s.slice(0, firstStart + String(startMatches[0][0]).length);
    out += s.slice(firstStart + String(startMatches[0][0]).length).replace(startRe, '');
    s = out;
  }

  // Remove duplicate close tags (keep the last)
  const closeTag = '</sentra_project>';
  const parts = s.split(closeTag);
  if (parts.length > 2) {
    s = parts.slice(0, -1).join('') + closeTag + parts[parts.length - 1];
  }

  return s.trim();
}

function checkProjectFiles(files) {
  if (!files || typeof files !== 'object') return { ok: false, error: '未解析到任何文件内容' };

  const requiredFiles = ['package.json', 'main.js', 'index.html'];
  const extracted = Object.keys(files);
  for (const rf of requiredFiles) {
    if (!files[rf]) {
      return { ok: false, error: `生成的项目结构不完整。已提取文件：${extracted.join(', ')}。缺少必要文件：${requiredFiles.join(', ')}` };
    }
  }

  // Basic path safety: disallow absolute paths and traversal
  for (const p of extracted) {
    const k = String(p || '').trim();
    if (!k) return { ok: false, error: '存在空文件路径' };
    if (k.includes('\u0000')) return { ok: false, error: `文件路径包含非法字符: ${k}` };
    if (path.isAbsolute(k) || /^[a-zA-Z]:[\\/]/.test(k)) return { ok: false, error: `禁止输出绝对路径文件: ${k}` };
    const segs = k.split(/[\\/]+/).filter(Boolean);
    if (segs.some((s) => s === '..')) return { ok: false, error: `禁止输出包含 .. 的文件路径: ${k}` };
  }

  let pkg;
  try {
    pkg = JSON.parse(String(files['package.json'] || ''));
  } catch {
    return { ok: false, error: 'package.json 不是合法 JSON' };
  }

  const mainOk = String(pkg?.main || '').trim() === 'main.js';
  if (!mainOk) return { ok: false, error: 'package.json 中 main 必须为 main.js' };

  const startOk = typeof pkg?.scripts?.start === 'string' && pkg.scripts.start.trim().length > 0;
  if (!startOk) return { ok: false, error: 'package.json 中缺少 scripts.start' };

  const buildOk = typeof pkg?.scripts?.build === 'string' && pkg.scripts.build.trim().length > 0;
  if (!buildOk) return { ok: false, error: 'package.json 中缺少 scripts.build（electron-builder）' };

  const hasElectron = !!pkg?.devDependencies?.electron;
  const hasBuilder = !!pkg?.devDependencies?.['electron-builder'];
  if (!hasElectron || !hasBuilder) return { ok: false, error: 'package.json 中 devDependencies 必须包含 electron 与 electron-builder' };

  return { ok: true };
}

function isProjectXmlReady(xmlText) {
  const xml = normalizeSentraProjectXmlText(xmlText);
  if (!isWellFormedXml(xml)) return false;
  try {
    const files = parseXmlProjectFiles(xml);
    return checkProjectFiles(files).ok === true;
  } catch {
    return false;
  }
}

function buildAdvice(kind, ctx = {}) {
  const tool = 'html_to_app';
  const base = {
    suggested_reply: '',
    next_steps: [],
    persona_hint: '你需要明确告诉用户当前是生成桌面应用项目的工具，优先收集缺失信息并给出可执行的下一步。',
    context: { tool, ...ctx },
  };

  if (kind === 'INVALID') {
    return {
      ...base,
      suggested_reply: '你的参数里缺少必要信息（例如 description/app_name/details）。请补充后我再为你生成完整的桌面应用项目。',
      next_steps: [
        '补充完整的 description（功能需求）与 details（UI/UX 细节）',
        '确认 app_name 只包含字母/数字/下划线/连字符',
      ],
    };
  }
  if (kind === 'PROJECT_EXISTS') {
    return {
      ...base,
      suggested_reply: '目标项目目录已存在。请更换 app_name，或先删除/清空现有目录后再生成。',
      next_steps: ['更换 app_name', '或删除现有项目目录后重试'],
    };
  }
  if (kind === 'INVALID_XML') {
    return {
      ...base,
      suggested_reply: '模型输出的 XML 不完整或不合法，导致无法解析出项目文件。我可以尝试继续拉取剩余内容，或者你也可以让我重新生成。',
      next_steps: [
        '确认模型输出必须只包含一个完整的 XML 根节点（无 Markdown、无解释文字）',
        '如仍失败，建议减少需求复杂度或拆分需求后重试',
      ],
    };
  }
  if (kind === 'INVALID_PROJECT') {
    return {
      ...base,
      suggested_reply: '生成的项目文件不完整或关键文件内容无法解析（例如 package.json 不是合法 JSON）。建议我重新生成，并强调必须包含必需文件。',
      next_steps: ['重新生成并确保包含 package.json / main.js / index.html', '确保 package.json 是合法 JSON 且 main 指向 main.js'],
    };
  }
  if (kind === 'TIMEOUT') {
    return {
      ...base,
      suggested_reply: '生成或拉取代码超时了。你可以稍后重试，或降低需求复杂度/减少一次输出文件数量。',
      next_steps: ['稍后重试', '减少需求复杂度或拆分功能后重试'],
    };
  }
  return {
    ...base,
    suggested_reply: '生成过程中出现异常。我可以根据报错信息调整提示词或缩小需求范围后重试。',
    next_steps: ['把报错信息发给我以便定位', '尝试重试或拆分需求'],
  };
}

function normalizeFramework(fw) {
  const normalized = String(fw || 'vanilla').toLowerCase();
  if (normalized === 'vanilla' || normalized === 'html') return 'electron-vanilla';
  if (normalized === 'react') return 'electron-react';
  if (normalized === 'vue') return 'electron-vue';
  return FRAMEWORKS.has(normalized) ? normalized : 'electron-vanilla';
}

function generateSystemPromptXml(framework) {
  return `你是一个专业的 Electron 应用开发助手。请根据用户需求生成完整的桌面应用项目代码。

框架类型：${framework}

## 输出格式（必须严格遵守）

你必须只输出一个完整的 XML 文档，且只有一个根节点 "<sentra_project>"，禁止输出 Markdown、代码块、解释文字、前后缀。

强制要求：
- 输出必须以 "<sentra_project>" 开始，并以 "</sentra_project>" 结束。
- XML 之外不得有任何字符（包括前置解释、后置说明、代码块标记）。

XML 结构必须为：

<sentra_project>
  <file path="package.json"><![CDATA[...]]></file>
  <file path="main.js"><![CDATA[...]]></file>
  <file path="preload.js"><![CDATA[...]]></file>
  <file path="index.html"><![CDATA[...]]></file>
  <file path="renderer.js"><![CDATA[...]]></file>
  <file path="styles.css"><![CDATA[...]]></file>
  <file path="README.md"><![CDATA[...]]></file>
</sentra_project>

要求：
- 每个文件内容必须放在 CDATA 内，确保不会破坏 XML。
- 文件内容中如果出现 "]]>"，必须拆分为多个 CDATA 段（禁止直接输出导致 XML 断裂）。
- 必须生成 package.json、main.js、index.html（缺一不可）。
- package.json 必须是合法 JSON，且 main 指向 main.js。
- scripts 至少包含："start": "electron ."，并提供 build（electron-builder）。
- electron 与 electron-builder 必须在 devDependencies。
- 不要输出占位符 "..."；内容必须可直接运行。

如果输出较长导致未能一次输出完整 XML，请在后续收到用户消息 "continue" 时：
- 只从中断处继续输出剩余内容
- 禁止重复输出 "<sentra_project>" 或 "</sentra_project>"
- 禁止重头再输出已给出的文件
- 优先继续补齐未输出完的 "<file ...>" 节点

当你已经输出过 "</sentra_project>" 时，表示已完成：此后不得再输出任何内容。`;
}

// 生成系统提示词（引导 LLM 使用 Markdown 代码块输出）
function generateSystemPrompt(framework) {
  return `你是一个专业的 Electron 应用开发助手。请根据用户需求生成完整的桌面应用项目代码。

框架类型：${framework}

## 输出格式

请按以下格式输出各个文件的代码，每个文件使用独立的 Markdown 代码块：

### 文件：package.json
\`\`\`json
{
  "name": "app-name",
  "version": "1.0.0",
  ...
}
\`\`\`

### 文件：main.js
\`\`\`javascript
const { app, BrowserWindow } = require('electron');
...
\`\`\`

### 文件：preload.js
\`\`\`javascript
const { contextBridge } = require('electron');
...
\`\`\`

### 文件：index.html
\`\`\`html
<!DOCTYPE html>
<html>
...
</html>
\`\`\`

### 文件：renderer.js
\`\`\`javascript
// 渲染进程代码
...
\`\`\`

### 文件：styles.css
\`\`\`css
body {
  ...
}
\`\`\`

### 文件：README.md
\`\`\`markdown
# 项目名称
...
\`\`\`

## 必须生成的文件

1. **package.json**（必需）：
   - name、version、main (指向 main.js)
   - scripts: "start": "electron .", "build": "electron-builder"
   - devDependencies: electron 和 electron-builder（必须都在 devDependencies）
   - dependencies: 其他运行时依赖（如有需要）
   - 注意：electron 必须在 devDependencies，不能在 dependencies

2. **main.js**（必需）：
   - 创建 BrowserWindow
   - 加载 index.html
   - 处理应用生命周期
   - 配置安全选项（webPreferences）

3. **preload.js**（必需）：
   - 使用 contextBridge 暴露安全 API
   - 不要直接暴露 Node.js 模块

4. **index.html**（必需）：
   - 完整的 HTML5 文档结构
   - 引用 styles.css 和 renderer.js
   - 实现用户需求的界面

5. **renderer.js**（推荐）：
   - 界面交互逻辑
   - 使用 window.electronAPI 与主进程通信

6. **styles.css**（推荐）：
   - 美观的样式设计
   - 响应式布局

7. **README.md**（推荐）：
   - 项目说明
   - 安装和运行步骤

## 代码质量要求

- 代码规范、注释清晰（中文注释）
- 遵循 Electron 最佳安全实践
- 禁用 nodeIntegration，使用 contextBridge
- 使用现代 JavaScript（ES6+）
- 确保代码可直接运行

## 重要提示

- 每个文件必须使用 "### 文件：<文件名>" 标记
- 代码块必须指定语言（json/javascript/html/css/markdown）
- 不要添加额外的解释文字
- 确保所有文件路径引用正确
- package.json 中的依赖版本要兼容`;
}

// 生成用户提示词
function generateUserPrompt(description, details, htmlContent, features) {
  let prompt = `请生成一个桌面应用项目，需求如下：

## 主要功能需求
${description}`;

  // 细节要求（新增）
  if (details) {
    prompt += `\n\n## UI/UX 细节要求\n${details}`;
  }

  if (htmlContent) {
    prompt += `\n\n## 已有的 HTML 代码\n请整合到项目中：\n\`\`\`html\n${htmlContent}\n\`\`\``;
  }

  if (features && features.length > 0) {
    prompt += `\n\n## 功能特性\n${features.map(f => `- ${f}`).join('\n')}`;
  }

  prompt += `\n\n请严格按照上述需求和细节要求生成完整的项目文件。`;

  return prompt;
}

// 从 Markdown 响应中提取文件
function parseMarkdownFiles(content) {
  const files = {};

  // 匹配 "### 文件：filename" 后面跟着的代码块
  const filePattern = /###\s*文件[：:](\S+)\s*```(\w+)?\s*([\s\S]*?)```/g;

  let match;
  while ((match = filePattern.exec(content)) !== null) {
    const filename = match[1].trim();
    const code = match[3].trim();
    files[filename] = code;
  }

  return files;
}

function isWellFormedXml(content) {
  const s = String(content || '').trim();
  if (!s) return false;
  if (!s.startsWith('<')) return false;
  const res = XMLValidator.validate(s);
  return res === true;
}

function mergeTextWithOverlap(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  if (!left) return right;
  if (!right) return left;
  if (left.includes(right)) return left;

  const maxCheck = Math.min(left.length, right.length, 8192);
  const leftTail = left.slice(left.length - maxCheck);
  let best = 0;
  const maxOverlap = Math.min(leftTail.length, right.length);
  for (let k = 1; k <= maxOverlap; k += 1) {
    if (leftTail.slice(leftTail.length - k) === right.slice(0, k)) best = k;
  }
  return left + right.slice(best);
}

function parseXmlProjectFiles(xml) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
    cdataPropName: '#cdata',
    preserveOrder: false,
    parseTagValue: false,
    trimValues: false,
  });
  const obj = parser.parse(String(xml || '').trim());
  const root = obj?.sentra_project || obj?.sentraProject || obj?.project || obj;
  let nodes = root?.file || root?.files?.file;
  if (!nodes) return {};
  if (!Array.isArray(nodes)) nodes = [nodes];

  const out = {};
  for (const n of nodes) {
    const p = String(n?.['@_path'] || n?.path || '').trim();
    if (!p) continue;
    const raw = (typeof n === 'string')
      ? n
      : (typeof n?.['#cdata'] === 'string' ? n['#cdata'] : (typeof n?.['#text'] === 'string' ? n['#text'] : ''));
    out[p] = String(raw || '');
  }
  return out;
}

async function collectXmlWithContinue({
  messages,
  temperature,
  apiKey,
  baseURL,
  model,
  omitMaxTokens,
  maxContinueCalls,
}) {
  const convo = Array.isArray(messages) ? [...messages] : [];
  const first = await chatCompletion({ messages: convo, temperature, apiKey, baseURL, model, omitMaxTokens });
  const firstText = first?.choices?.[0]?.message?.content || '';
  convo.push({ role: 'assistant', content: firstText });
  let acc = String(firstText || '');
  let candidate = normalizeSentraProjectXmlText(acc);

  let used = 0;
  const limit = Number.isFinite(maxContinueCalls) ? Math.max(0, maxContinueCalls) : 0;
  while (!isProjectXmlReady(candidate) && used < limit) {
    for (let i = 0; i < 2 && used < limit; i += 1) {
      convo.push({ role: 'user', content: 'continue' });
      const r = await chatCompletion({ messages: convo, temperature, apiKey, baseURL, model, omitMaxTokens });
      const part = r?.choices?.[0]?.message?.content || '';
      convo.push({ role: 'assistant', content: part });
      acc = mergeTextWithOverlap(acc, String(part || ''));
      candidate = normalizeSentraProjectXmlText(acc);
      used += 1;
    }
  }
  return { xml: candidate, continueCalls: used, firstResp: first };
}

// 验证提取的文件结构
function validateProjectFiles(files) {
  return checkProjectFiles(files).ok === true;
}

// 写入项目文件到磁盘
async function writeProjectFiles(projectPath, files) {
  await fs.mkdir(projectPath, { recursive: true });

  const written = [];
  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = path.join(projectPath, filePath);
    const dir = path.dirname(fullPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(fullPath, content, 'utf-8');
    written.push(filePath);
  }

  return written;
}

// 执行命令（同步）
function execCommand(command, cwd, description, envOverrides = {}) {
  logger.info?.(`html_to_app: ${description}`, { command, cwd });

  // 合并环境变量
  const env = { ...process.env, ...envOverrides };

  try {
    const output = execSync(command, {
      cwd,
      encoding: 'utf-8',
      stdio: 'pipe',
      maxBuffer: 50 * 1024 * 1024, // 50MB buffer
      env,
    });
    logger.debug?.(`html_to_app: ${description} 完成`, { output: output.slice(0, 500) });
    return { success: true, output };
  } catch (e) {
    // 捕获完整的错误信息：stdout + stderr
    const stdout = e?.stdout?.toString() || '';
    const stderr = e?.stderr?.toString() || '';
    const fullError = [stdout, stderr].filter(Boolean).join('\n') || String(e?.message || e);

    logger.error?.(`html_to_app: ${description} 失败`, {
      error: String(e?.message || e),
      stdout: stdout.slice(0, 1000),
      stderr: stderr.slice(0, 1000),
      fullError: fullError.slice(0, 2000)
    });

    return {
      success: false,
      code: 'CMD_ERROR',
      error: fullError,
      stdout,
      stderr,
      advice: buildAdvice('ERR', { stage: 'execCommand', description })
    };
  }
}

// 自动安装依赖
async function installDependencies(projectPath, packageManager = 'npm', installArgs = '') {
  const pm = String(packageManager || 'npm').toLowerCase();
  const validPM = ['npm', 'pnpm', 'cnpm', 'yarn'].includes(pm) ? pm : 'npm';

  let installCmd;
  if (validPM === 'yarn') {
    installCmd = 'yarn install';
  } else {
    installCmd = `${validPM} install`;
  }

  if (installArgs) {
    installCmd += ` ${installArgs}`;
  }

  return execCommand(installCmd, projectPath, '安装依赖');
}

// 验证 package.json 中是否有 build script
async function checkBuildScript(projectPath) {
  try {
    const pkgPath = path.join(projectPath, 'package.json');
    const pkgContent = await fs.readFile(pkgPath, 'utf-8');
    const pkg = JSON.parse(pkgContent);

    if (!pkg.scripts?.build) {
      return { success: false, code: 'INVALID_PROJECT', error: 'package.json 中缺少 build script', advice: buildAdvice('INVALID_PROJECT', { stage: 'checkBuildScript', field: 'scripts.build' }) };
    }

    if (!pkg.devDependencies?.['electron-builder']) {
      return { success: false, code: 'INVALID_PROJECT', error: 'package.json 中缺少 electron-builder 依赖', advice: buildAdvice('INVALID_PROJECT', { stage: 'checkBuildScript', field: 'devDependencies.electron-builder' }) };
    }

    return { success: true, script: pkg.scripts.build };
  } catch (e) {
    return { success: false, code: 'INVALID_PROJECT', error: `读取 package.json 失败: ${e.message}`, advice: buildAdvice('INVALID_PROJECT', { stage: 'checkBuildScript' }) };
  }
}

// 自动打包应用
async function buildApp(projectPath, packageManager = 'npm', penv = {}) {
  const pm = String(packageManager || 'npm').toLowerCase();
  const validPM = ['npm', 'pnpm', 'cnpm', 'yarn'].includes(pm) ? pm : 'npm';

  // 验证 build script
  const checkResult = await checkBuildScript(projectPath);
  const checkOk = (checkResult && typeof checkResult === 'object')
    ? (checkResult.success === true || checkResult.valid === true)
    : false;
  if (!checkOk) {
    logger.error?.('html_to_app: 构建配置有误', { error: checkResult?.error });
    return { success: false, code: checkResult?.code || 'INVALID_PROJECT', error: checkResult?.error || '构建配置校验失败', advice: checkResult?.advice || buildAdvice('INVALID_PROJECT', { stage: 'buildApp' }) };
  }

  let buildCmd;
  if (validPM === 'yarn') {
    buildCmd = 'yarn build';
  } else {
    buildCmd = `${validPM} run build`;
  }

  return execCommand(buildCmd, projectPath, '打包应用', penv);
}

// 压缩目录为 zip
async function zipDirectory(sourceDir, outputZip) {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(outputZip);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => {
      logger.info?.('html_to_app: 压缩完成', { size: archive.pointer(), path: outputZip });
      resolve({ success: true, size: archive.pointer(), path: outputZip });
    });

    archive.on('error', (err) => {
      logger.error?.('html_to_app: 压缩失败', { error: String(err?.message || err) });
      reject(err);
    });

    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize();
  });
}

// 查找打包输出目录中的文件
async function findBuildOutput(projectPath) {
  const distDir = path.join(projectPath, 'dist');
  try {
    const entries = await fs.readdir(distDir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      if (entry.isFile()) {
        const fullPath = path.join(distDir, entry.name);
        const stat = await fs.stat(fullPath);
        files.push({ name: entry.name, path: fullPath, size: stat.size });
      }
    }
    return files;
  } catch (e) {
    logger.warn?.('html_to_app: 读取打包输出失败', { error: String(e?.message || e) });
    return [];
  }
}

// 生成项目使用说明
function generateInstructions(projectPath, appName, automated = false) {
  const relativePath = path.relative(process.cwd(), projectPath);

  if (automated) {
    return `✅ 已完成一体化打包流程！

📦 项目位置：${projectPath}

🎉 打包结果已自动生成并压缩

🚀 如需修改和重新开发：

1. 进入项目目录
   cd ${relativePath}

2. 开发运行
   npm start

3. 重新打包
   npm run build

💡 提示：
- 打包结果已压缩为 zip 文件，可直接分发
- 修改代码后需要重新运行 npm run build
- 首次运行需要下载 Electron，可能需要几分钟`;
  }

  return `已成功生成桌面应用项目！

📦 项目位置：${projectPath}

🚀 快速开始：

1. 安装依赖
   cd ${relativePath}
   npm install

2. 开发运行
   npm start

3. 打包应用
   npm run build

打包后的应用将在 dist 目录中：
- Windows: dist/${appName} Setup.exe
- macOS: dist/${appName}.dmg
- Linux: dist/${appName}.AppImage

💡 提示：
- 首次运行需要下载 Electron，可能需要几分钟
- 打包需要较长时间，请耐心等待
- 修改代码后，重启应用即可看到效果`;
}

export default async function handler(args = {}, options = {}) {
  try {
    const penv = options?.pluginEnv || {};

    // === 1. 参数解析与验证 ===
    const description = String(args.description || '').trim();
    const appName = String(args.app_name || '').trim();
    const details = String(args.details || '').trim();

    if (!description) {
      return { success: false, code: 'INVALID', error: 'description 参数必填', advice: buildAdvice('INVALID', { field: 'description' }) };
    }

    if (!appName) {
      return { success: false, code: 'INVALID', error: 'app_name 参数必填', advice: buildAdvice('INVALID', { field: 'app_name' }) };
    }

    if (!details) {
      return { success: false, code: 'INVALID', error: 'details 参数必填，请提供具体的 UI/UX 细节要求', advice: buildAdvice('INVALID', { field: 'details' }) };
    }

    // 验证应用名称格式（只允许字母、数字、连字符、下划线）
    if (!/^[a-zA-Z0-9_-]+$/.test(appName)) {
      return { success: false, code: 'INVALID', error: 'app_name 只能包含字母、数字、连字符和下划线', advice: buildAdvice('INVALID', { field: 'app_name' }) };
    }

    const htmlContent = String(args.html_content || '').trim();
    const framework = normalizeFramework(args.framework || penv.HTML_TO_APP_DEFAULT_FRAMEWORK);
    const features = Array.isArray(args.features) ? args.features : [];

    // === 2. 准备输出目录 ===
    const outputBase = penv.HTML_TO_APP_OUTPUT_DIR || 'artifacts/apps';
    const projectPath = toAbs(path.join(outputBase, appName));

    // 检查项目是否已存在
    try {
      await fs.access(projectPath);
      return {
        success: false,
        code: 'PROJECT_EXISTS',
        error: `项目已存在：${projectPath}。请使用不同的 app_name 或删除现有项目。`,
        advice: buildAdvice('PROJECT_EXISTS', { projectPath })
      };
    } catch {
      // 项目不存在，可以继续
    }

    // === 3. 调用 LLM 生成项目代码 ===
    logger.info?.('html_to_app: 开始生成项目代码', { appName, framework, hasDetails: !!details });

    const outputFormat = String(penv.HTML_TO_APP_OUTPUT_FORMAT || process.env.HTML_TO_APP_OUTPUT_FORMAT || 'xml').toLowerCase();
    const useXml = outputFormat !== 'markdown';

    const systemPrompt = useXml ? generateSystemPromptXml(framework) : generateSystemPrompt(framework);
    const userPrompt = generateUserPrompt(description, details, htmlContent, features);

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];

    const apiKey = penv.HTML_TO_APP_API_KEY || process.env.HTML_TO_APP_API_KEY || config.llm.apiKey;
    const baseURL = penv.HTML_TO_APP_BASE_URL || process.env.HTML_TO_APP_BASE_URL || config.llm.baseURL;
    const model = penv.HTML_TO_APP_MODEL || process.env.HTML_TO_APP_MODEL || config.llm.model || 'gpt-4o';
    const maxContinueCalls = Number.parseInt(penv.HTML_TO_APP_MAX_CONTINUE_CALLS || process.env.HTML_TO_APP_MAX_CONTINUE_CALLS || '8', 10);

    let resp;
    let content = '';
    let files;

    try {
      if (useXml) {
        const gathered = await collectXmlWithContinue({
          messages,
          temperature: 0.3,
          apiKey,
          baseURL,
          model,
          omitMaxTokens: true,
          maxContinueCalls: Number.isFinite(maxContinueCalls) ? Math.max(0, maxContinueCalls) : 8,
        });
        content = String(gathered.xml || '').trim();
        resp = gathered.firstResp;

        if (!isWellFormedXml(content)) {
          logger.error?.('html_to_app: XML 不完整或不合法', { usedContinueCalls: gathered.continueCalls, preview: content.slice(0, 500) });
          return {
            success: false,
            code: 'INVALID_XML',
            error: `模型输出的 XML 不完整或不合法（已尝试 continue ${gathered.continueCalls} 次）。`,
            advice: buildAdvice('INVALID_XML', { usedContinueCalls: gathered.continueCalls })
          };
        }
        files = parseXmlProjectFiles(content);
      } else {
        resp = await chatCompletion({
          messages,
          temperature: 0.3,
          apiKey,
          baseURL,
          model,
          omitMaxTokens: true
        });
        content = resp.choices?.[0]?.message?.content?.trim() || '';
        files = parseMarkdownFiles(content);
      }
    } catch (e) {
      const isTimeout = isTimeoutError(e);
      logger.error?.('html_to_app: LLM 调用失败', { error: String(e?.message || e), code: e?.code, stack: e?.stack });
      return {
        success: false,
        code: isTimeout ? 'TIMEOUT' : 'ERR',
        error: String(e?.message || e),
        advice: buildAdvice(isTimeout ? 'TIMEOUT' : 'ERR', { stage: 'chatCompletion' }),
      };
    }
    
    if (!validateProjectFiles(files)) {
      const extractedFiles = Object.keys(files || {});
      const check = checkProjectFiles(files);
      logger.error?.('html_to_app: 提取的文件不完整', { extractedFiles, reason: check?.error });
      return {
        success: false,
        code: 'INVALID_PROJECT',
        error: String(check?.error || `生成的项目结构不完整。已提取文件：${extractedFiles.join(', ')}`),
        advice: buildAdvice('INVALID_PROJECT', { extractedFiles, reason: check?.error })
      };
    }
    
    // === 4. 写入项目文件 ===
    logger.info?.('html_to_app: 开始写入项目文件', { projectPath, filesCount: Object.keys(files).length });
    const writtenFiles = await writeProjectFiles(projectPath, files);
    
    // === 5. 可选：自动化流程（安装、打包、压缩）===
    const autoInstall = String(penv.HTML_TO_APP_AUTO_INSTALL || 'false').toLowerCase() === 'true';
    const autoBuild = String(penv.HTML_TO_APP_AUTO_BUILD || 'false').toLowerCase() === 'true';
    const autoZip = String(penv.HTML_TO_APP_AUTO_ZIP || 'false').toLowerCase() === 'true';
    const cleanBuild = String(penv.HTML_TO_APP_CLEAN_BUILD || 'false').toLowerCase() === 'true';
    const packageManager = penv.HTML_TO_APP_PACKAGE_MANAGER || 'npm';
    const installArgs = penv.HTML_TO_APP_INSTALL_ARGS || '';
    
    let installResult = null;
    let buildResult = null;
    let zipResult = null;
    let buildFiles = [];
    
    if (autoInstall) {
      logger.info?.('html_to_app: 开始自动安装依赖', { packageManager, projectPath });
      installResult = await installDependencies(projectPath, packageManager, installArgs);
      
      if (!installResult.success) {
        logger.warn?.('html_to_app: 依赖安装失败，跳过后续自动化步骤', { error: installResult.error });
        // 不返回错误，继续返回项目路径
      }
    }
    
    if (autoInstall && installResult?.success && autoBuild) {
      logger.info?.('html_to_app: 开始自动打包应用', { projectPath });
      
      // 准备环境变量（镜像和代理）
      const buildEnv = {};
      
      // Electron 镜像配置
      if (penv.HTML_TO_APP_ELECTRON_MIRROR) {
        buildEnv.ELECTRON_MIRROR = penv.HTML_TO_APP_ELECTRON_MIRROR;
        buildEnv.npm_config_electron_mirror = penv.HTML_TO_APP_ELECTRON_MIRROR;
      }
      
      if (penv.HTML_TO_APP_ELECTRON_BUILDER_BINARIES_MIRROR) {
        buildEnv.ELECTRON_BUILDER_BINARIES_MIRROR = penv.HTML_TO_APP_ELECTRON_BUILDER_BINARIES_MIRROR;
        buildEnv.npm_config_electron_builder_binaries_mirror = penv.HTML_TO_APP_ELECTRON_BUILDER_BINARIES_MIRROR;
      }
      
      // 代理配置
      if (penv.HTML_TO_APP_HTTP_PROXY) {
        buildEnv.HTTP_PROXY = penv.HTML_TO_APP_HTTP_PROXY;
        buildEnv.http_proxy = penv.HTML_TO_APP_HTTP_PROXY;
      }
      
      if (penv.HTML_TO_APP_HTTPS_PROXY) {
        buildEnv.HTTPS_PROXY = penv.HTML_TO_APP_HTTPS_PROXY;
        buildEnv.https_proxy = penv.HTML_TO_APP_HTTPS_PROXY;
      }
      
      logger.info?.('html_to_app: 使用环境配置', { 
        electronMirror: buildEnv.ELECTRON_MIRROR || 'default',
        binariesMirror: buildEnv.ELECTRON_BUILDER_BINARIES_MIRROR || 'default',
        httpProxy: buildEnv.HTTP_PROXY || 'none',
        httpsProxy: buildEnv.HTTPS_PROXY || 'none'
      });
      
      buildResult = await buildApp(projectPath, packageManager, buildEnv);
      
      if (buildResult.success) {
        buildFiles = await findBuildOutput(projectPath);
        logger.info?.('html_to_app: 打包完成', { filesCount: buildFiles.length });
      } else {
        logger.warn?.('html_to_app: 打包失败', { 
          error: buildResult.error,
          stdout: buildResult.stdout?.slice(0, 500),
          stderr: buildResult.stderr?.slice(0, 500),
          tip: '请手动运行 npm run build 查看详细错误'
        });
      }
    }
    
    if (buildResult?.success && autoZip) {
      logger.info?.('html_to_app: 开始压缩打包结果', { projectPath });
      const distDir = path.join(projectPath, 'dist');
      const zipPath = path.join(path.dirname(projectPath), `${appName}_build.zip`);
      
      try {
        zipResult = await zipDirectory(distDir, zipPath);
        
        // 清理构建文件（可选）
        if (cleanBuild && zipResult.success) {
          try {
            await fs.rm(distDir, { recursive: true, force: true });
            logger.info?.('html_to_app: 已清理构建目录', { distDir });
          } catch (e) {
            logger.warn?.('html_to_app: 清理构建目录失败', { error: String(e?.message || e) });
          }
        }
      } catch (e) {
        logger.error?.('html_to_app: 压缩失败', { error: String(e?.message || e) });
      }
    }
    
    // === 6. 生成使用说明 ===
    const automated = autoInstall && autoBuild;
    const instructions = generateInstructions(projectPath, appName, automated);
    
    // === 7. 返回结果 ===
    const result = {
      success: true,
      data: {
        action: 'html_to_app',
        project_path: projectPath,
        app_name: appName,
        framework,
        files_count: writtenFiles.length,
        files: writtenFiles,
        instructions,
        generation_info: {
          model: resp.model,
          created: resp.created,
          baseURL: penv.HTML_TO_APP_BASE_URL || process.env.HTML_TO_APP_BASE_URL || config.llm.baseURL,
        },
      },
    };

    // 添加自动化流程结果
    if (autoInstall || autoBuild || autoZip) {
      result.data.automation = {
        install: installResult ? { success: installResult.success, packageManager } : null,
        build: buildResult ? { success: buildResult.success, files: buildFiles } : null,
        zip: zipResult
          ? {
              success: true,
              path_markdown: `[${appName}_build.zip](${toPosix(zipResult.path)})`,
              size: zipResult.size,
            }
          : null,
      };
    }

    return result;
  } catch (e) {
    logger.error?.('html_to_app: 生成失败', { label: 'PLUGIN', error: String(e?.message || e), stack: e?.stack });
    const isTimeout = isTimeoutError(e);
    return {
      success: false,
      code: isTimeout ? 'TIMEOUT' : 'GENERATION_ERROR',
      error: String(e?.message || e),
      advice: buildAdvice(isTimeout ? 'TIMEOUT' : 'ERR', { stage: 'handler' }),
    };
  }
}
