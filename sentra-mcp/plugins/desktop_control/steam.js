/**
 * Steam 控制测试
 * 
 * 功能：
 * 1. 启动 Steam 应用
 * 2. 等待窗口加载
 * 3. 最大化窗口
 * 
 * 运行方式：
 * node plugins/desktop_control/test-steam.js
 */

import { handler } from './index.js';
import path from 'node:path';

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

function log(color, ...args) {
  console.log(color, ...args, colors.reset);
}

function section(title) {
  console.log('\n' + colors.cyan + '═'.repeat(70) + colors.reset);
  log(colors.cyan, title);
  console.log(colors.cyan + '═'.repeat(70) + colors.reset + '\n');
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 主测试流程
 */
async function testSteam() {
  console.clear();
  log(colors.cyan, '\n🎮 Steam 控制测试\n');

  // 步骤 1: 启动 Steam
  section('步骤 1: 启动 Steam');
  
  log(colors.yellow, '正在启动 Steam...');
  
  // Steam 常见安装路径
  const steamPaths = [
    'C:\\Program Files (x86)\\Steam\\steam.exe',
    'C:\\Program Files\\Steam\\steam.exe',
    'D:\\Steam\\steam.exe',
    'E:\\Steam\\steam.exe',
    'steam://open/main' // Steam 协议（如果 Steam 已安装）
  ];
  
  let launched = false;
  let usedPath = '';
  
  // 尝试使用 Steam 协议启动（最简单）
  log(colors.yellow, '尝试方法 1: 使用 Steam 协议...');
  try {
    const result = await handler({
      action: 'launch_app',
      path: 'cmd.exe',
      args: '/c start steam://open/main'
    });
    
    if (result.success) {
      log(colors.green, '✓ 已通过 Steam 协议启动');
      launched = true;
      usedPath = 'steam://open/main';
    }
  } catch (err) {
    log(colors.yellow, '⚠ Steam 协议启动失败，尝试直接路径...');
  }
  
  // 如果协议失败，尝试常见路径
  if (!launched) {
    log(colors.yellow, '\n尝试方法 2: 常见安装路径...');
    
    for (const steamPath of steamPaths) {
      if (steamPath.startsWith('steam://')) continue; // 跳过协议
      
      try {
        log(colors.yellow, `尝试: ${steamPath}`);
        const result = await handler({
          action: 'launch_app',
          path: steamPath
        });
        
        if (result.success) {
          log(colors.green, `✓ 已启动 Steam: ${steamPath}`);
          launched = true;
          usedPath = steamPath;
          break;
        }
      } catch (err) {
        // 继续尝试下一个路径
      }
    }
  }
  
  if (!launched) {
    log(colors.red, '✗ Steam 启动失败');
    log(colors.yellow, '\n💡 可能的原因：');
    console.log('  1. Steam 未安装');
    console.log('  2. Steam 安装在自定义路径');
    console.log('  3. 需要管理员权限');
    
    log(colors.yellow, '\n📝 手动启动 Steam 的方法：');
    console.log('  1. 打开开始菜单搜索 "Steam"');
    console.log('  2. 或访问: https://store.steampowered.com/about/');
    console.log('  3. 然后重新运行此脚本，直接跳到步骤2\n');
    
    log(colors.cyan, '按 Ctrl+C 退出，或等待 5 秒后尝试控制已运行的 Steam...');
    await sleep(5000);
  } else {
    log(colors.green, `\n✅ Steam 已启动！使用路径: ${usedPath}`);
  }

  // 步骤 2: 等待 Steam 加载
  section('步骤 2: 等待 Steam 窗口加载');
  
  log(colors.yellow, '等待 Steam 窗口完全加载...');
  log(colors.yellow, '(Steam 启动可能需要 5-10 秒)\n');
  
  // 等待 Steam 窗口出现（最多等待 30 秒）
  let steamReady = false;
  for (let i = 0; i < 30; i++) {
    try {
      // 尝试激活 Steam 窗口（如果能激活说明窗口存在）
      const result = await handler({
        action: 'focus',
        processName: 'steam'
      });
      
      if (result.success) {
        steamReady = true;
        log(colors.green, `✓ Steam 窗口已就绪 (等待 ${i + 1} 秒)`);
        break;
      }
    } catch (err) {
      // 继续等待
    }
    
    // 每秒显示进度
    if ((i + 1) % 5 === 0) {
      log(colors.yellow, `⏳ 已等待 ${i + 1} 秒...`);
    }
    
    await sleep(1000);
  }
  
  if (!steamReady) {
    log(colors.red, '\n✗ Steam 窗口未就绪');
    log(colors.yellow, '💡 请手动打开 Steam，然后重新运行此脚本');
    return;
  }

  // 步骤 3: 最大化 Steam 窗口
  section('步骤 3: 最大化 Steam 窗口');
  
  log(colors.yellow, '正在最大化 Steam 窗口...');
  await sleep(1000); // 稍作延迟确保窗口稳定
  
  try {
    const result = await handler({
      action: 'maximize',
      processName: 'steam'
    });
    
    if (result.success) {
      log(colors.green, '✓ Steam 窗口已最大化');
      log(colors.green, '\n🎮 Steam 数据:');
      console.log(JSON.stringify(result.data, null, 2));
    } else {
      log(colors.red, '✗ 最大化失败: ' + result.error);
    }
  } catch (err) {
    log(colors.red, '✗ 最大化异常: ' + err.message);
  }

  // 完成
  section('✅ 测试完成');
  
  log(colors.green, '所有步骤已完成！');
  
  log(colors.cyan, '\n💡 其他可用操作：');
  console.log('  • 最小化: await handler({ action: "minimize", processName: "steam" })');
  console.log('  • 恢复: await handler({ action: "restore", processName: "steam" })');
  console.log('  • 关闭: await handler({ action: "close", processName: "steam" })');
  console.log('  • 激活: await handler({ action: "focus", processName: "steam" })');
  
  log(colors.yellow, '\n⚠️  注意事项：');
  console.log('  • Steam 启动较慢，首次加载可能需要 10-15 秒');
  console.log('  • 如果 Steam 已在后台运行，会直接激活窗口');
  console.log('  • 某些系统可能需要管理员权限');
  
  console.log('\n');
}

// 运行测试
testSteam().catch(err => {
  log(colors.red, '\n✗ 测试失败:', err.message);
  console.error(err);
  process.exit(1);
});
