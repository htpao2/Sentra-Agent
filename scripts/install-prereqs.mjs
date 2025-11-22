#!/usr/bin/env node
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn, spawnSync } from 'node:child_process';
import chalk from 'chalk';

const platform = os.platform();
const isWindows = platform === 'win32';
const isLinux = platform === 'linux';

if (!isWindows && !isLinux) {
  console.error(chalk.red('目前自动安装脚本仅支持 Windows 与 Linux。'));
  process.exit(1);
}

async function maybeInstallNapcat() {
  const skipRaw = String(process.env.SENTRA_SKIP_NAPCAT_INSTALL || '').toLowerCase();
  if (skipRaw === '1' || skipRaw === 'true') {
    info('根据环境变量 SENTRA_SKIP_NAPCAT_INSTALL 跳过 NapCat 安装。');
    return;
  }

  if (!promptAvailable) {
    info('当前终端不可交互，默认跳过 NapCat QQ 适配器自动安装。');
    return;
  }

  console.log(chalk.magenta('\nNapCat QQ 适配器（可选组件）'));
  console.log(chalk.gray(`参考官方指引 ${napcatDocUrl}`));
  const confirmed = await promptYesNo('是否现在自动执行 NapCat 官方安装流程？', false);
  if (!confirmed) {
    info('已跳过 NapCat 自动安装（可稍后手动执行 napcat-adapter 指南）。');
    return;
  }

  try {
    if (ctx.isWindows) {
      await installNapcatWindows();
    } else if (ctx.isLinux) {
      await installNapcatLinux();
    } else {
      warn('当前平台暂未提供 NapCat 自动安装脚本，请参考官方链接手动配置。');
      return;
    }
    info('NapCat 安装流程已执行完毕，请在图形界面或 TUI 中完成 QQ 登录并确认服务运行。');
  } catch (err) {
    warn(`NapCat 自动安装失败：${err?.message || err}. 请参考 ${napcatDocUrl} 手动处理。`);
  }
}

async function installNapcatWindows() {
  info('开始下载 NapCat.Win.Installer（Windows 一键安装器）...');
  const release = await fetchLatestGithubRelease('NapNeko/NapCat-Win-Installer');
  const asset = release?.assets?.find((item) => /installer/i.test(item.name) && item.name.toLowerCase().endsWith('.exe'))
    || release?.assets?.find((item) => item.name.toLowerCase().endsWith('.exe'));
  if (!asset) {
    throw new Error('未能在最新 NapCat-Win-Installer 发布中找到可下载的 EXE 资源。');
  }

  const downloadDir = path.join(napcatInstallDir, 'windows-installer');
  await fs.promises.mkdir(downloadDir, { recursive: true });
  const exePath = path.join(downloadDir, asset.name);
  await downloadFile(asset.browser_download_url, exePath);
  info(`已下载 NapCatInstaller：${exePath}`);
  info('可通过设定 NAPCAT_INSTALL_DIR 环境变量自定义下载目录，上述路径默认位于项目同级 napcat-installer 目录。');
  info('请手动以管理员身份运行上述安装器，按照图形界面提示完成 NapCat 配置');
}

async function installNapcatLinux() {
  info('准备执行 NapCat 官方 Shell 安装脚本（支持 Ubuntu/Debian/CentOS）。');
  const installerUrl = process.env.NAPCAT_INSTALLER_URL
    || 'https://nclatest.znin.net/NapNeko/NapCat-Installer/main/script/install.sh';
  const tempDir = os.tmpdir();
  const scriptPath = path.join(tempDir, `napcat-install-${Date.now()}.sh`);
  await downloadFile(installerUrl, scriptPath);
  await fs.promises.chmod(scriptPath, 0o755);

  const scriptArgs = [];
  if (await promptYesNo('使用 NapCat 官方 TUI 可视化安装器 (--tui)？', true)) {
    scriptArgs.push('--tui');
  }

  const dockerMode = (await promptYesNo('采用 Docker 方式部署 NapCat？(否则为 Shell 直装)', false)) ? 'y' : 'n';
  scriptArgs.push('--docker', dockerMode);

  if (dockerMode === 'n') {
    const installCli = await promptYesNo('是否同步安装 NapCat TUI-CLI (--cli)？', true) ? 'y' : 'n';
    scriptArgs.push('--cli', installCli);
  } else {
    const presetQQ = await promptText('（可选）预填 NapCat Docker 登录 QQ 号（直接回车跳过）');
    if (presetQQ) {
      scriptArgs.push('--qq', presetQQ.trim());
    }
    const preferReverse = await promptText('（可选）指定连接模式 (ws/reverse)，回车采用默认 ws', { defaultValue: '' });
    if (preferReverse) {
      scriptArgs.push('--mode', preferReverse.trim());
    }
    if (await promptYesNo('Docker 安装中自动确认所有提示 (--confirm)？', true)) {
      scriptArgs.push('--confirm');
    }
  }

  if (await promptYesNo('需要强制重装 NapCat (--force)？', false)) {
    scriptArgs.push('--force');
  }

  info('开始运行 napcat.sh 脚本，后续安装过程可能耗时数分钟。');
  await runCommand('bash', [scriptPath, ...scriptArgs]);
}

async function fetchLatestGithubRelease(repo) {
  const resp = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers: githubHeaders });
  if (!resp.ok) {
    throw new Error(`GitHub API 请求失败 (${resp.status}): ${await resp.text()}`);
  }
  return resp.json();
}

async function downloadFile(url, destPath) {
  const resp = await fetch(url, { headers: { 'User-Agent': githubHeaders['User-Agent'] } });
  if (!resp.ok || !resp.body) {
    throw new Error(`下载失败 (${resp.status}): ${url}`);
  }
  await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
  await pipeline(Readable.fromWeb(resp.body), fs.createWriteStream(destPath));
}

async function promptYesNo(question, defaultValue = false) {
  if (!promptAvailable) return defaultValue;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const suffix = defaultValue ? ' [Y/n] ' : ' [y/N] ';
  const answer = (await rl.question(`${question}${suffix}`)).trim();
  rl.close();
  if (!answer) return defaultValue;
  return /^y(es)?$/i.test(answer);
}

async function promptText(question, options = {}) {
  const { defaultValue = '' } = options;
  if (!promptAvailable) return defaultValue;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${question}${defaultValue ? ` (默认: ${defaultValue})` : ''}: `)).trim();
  rl.close();
  return answer || defaultValue;
}

const ctx = {
  platform,
  isWindows,
  isLinux,
  windowsInstaller: isWindows ? detectWindowsInstaller() : null,
  linuxPkgManager: isLinux ? detectLinuxPackageManager() : null,
  aptUpdated: false,
  pacmanSynced: false
};

const promptAvailable = Boolean(process.stdin.isTTY && process.stdout.isTTY);
const githubHeaders = {
  'User-Agent': 'sentra-agent-install-script',
  Accept: 'application/vnd.github+json'
};
const napcatDocUrl = 'https://www.napcat.wiki/guide/boot/Shell';
const napcatInstallDir = path.resolve(process.env.NAPCAT_INSTALL_DIR || path.join(process.cwd(), '..', 'napcat-installer'));

const prerequisites = [
  {
    name: 'Git',
    check: () => commandExists('git', ['--version']),
    installers: {
      windows: () => installWindowsPackage({ wingetId: 'Git.Git', chocoPkg: 'git' }),
      linux: () => installLinuxPackages({ apt: ['git'], dnf: ['git'], yum: ['git'], pacman: ['git'] })
    },
    manualHint: '请访问 https://git-scm.com/downloads 获取安装包。'
  },
  {
    name: 'Node.js (>= 18)',
    check: () => versionAtLeast(getCommandVersion('node', ['-v']), '18.0.0'),
    installers: {
      windows: () => installWindowsPackage({ wingetId: 'OpenJS.NodeJS.LTS', chocoPkg: 'nodejs-lts' }),
      linux: () => installNodeOnLinux()
    },
    manualHint: '参见 https://nodejs.org/en/download/ 选择适合系统的 LTS 版本。'
  },
  {
    name: 'Python (>= 3.10)',
    check: () => versionAtLeast(getCommandVersion('python3', ['--version']) || getCommandVersion('python', ['--version']), '3.10.0'),
    installers: {
      windows: () => installWindowsPackage({ wingetId: 'Python.Python.3.11', chocoPkg: 'python' }),
      linux: () => installLinuxPackages({
        apt: ['python3', 'python3-pip', 'python3-venv'],
        dnf: ['python3', 'python3-pip'],
        yum: ['python3', 'python3-pip'],
        pacman: ['python', 'python-pip']
      })
    },
    manualHint: '若安装包缺失，请访问 https://www.python.org/downloads/'
  },
  {
    name: 'Redis Server',
    skipEnv: 'SENTRA_SKIP_REDIS_INSTALL',
    check: () => commandExists('redis-server', ['--version']),
    installers: {
      windows: () => installRedisOnWindows(),
      linux: () => installLinuxPackages({ apt: ['redis-server'], dnf: ['redis'], yum: ['redis'], pacman: ['redis'] })
    },
    manualHint: 'Windows 推荐使用 Memurai（Redis 兼容）：访问 https://www.memurai.com/download/ 下载安装包并按向导安装，安装后确保 Redis/Memurai 服务已启动。'
  },
  {
    name: 'PM2 (全局 npm 包)',
    check: () => commandExists('pm2', ['-v']),
    installers: {
      all: () => installPm2Global()
    },
    manualHint: '如需手动安装，可执行 npm install -g pm2'
  },
  {
    name: 'Neo4j 图数据库',
    skipEnv: 'SENTRA_SKIP_NEO4J_INSTALL',
    check: () => commandExists('neo4j', ['--version']) || commandExists('neo4j-admin', ['--version']),
    installers: {
      windows: () => installNeo4jOnWindows(),
      linux: () => installNeo4jOnLinux()
    },
    manualHint: 'Windows 可从 https://neo4j.com/download/ 下载 Neo4j Desktop/Server 安装包；Linux 可参考官方文档或使用 apt 源安装（脚本会为 Debian/Ubuntu 自动添加 Neo4j 源）。'
  }
];

const failures = [];

(async function main() {
  console.log(chalk.bold.magenta('\nSentra Agent 前置依赖安装器'));
  console.log(chalk.gray('将自动检测并按需安装 Git / Node.js / Python / Redis / PM2 / Neo4j。\n'));

  info(`检测到平台：${isWindows ? 'Windows' : 'Linux'}`);
  if (isWindows && !ctx.windowsInstaller) {
    warn('未检测到 winget 或 chocolatey，自动安装可能无法进行。');
  }
  if (isLinux && !ctx.linuxPkgManager) {
    warn('未检测到受支持的 Linux 包管理器 (apt/dnf/yum/pacman)。');
  }

  for (const prereq of prerequisites) {
    await ensurePrerequisite(prereq);
  }

  await maybeInstallNapcat();

  if (failures.length > 0) {
    const requiredFailures = failures.filter(f => !f.optional);
    const optionalFailures = failures.filter(f => f.optional);

    console.log('\n' + chalk.red('以下依赖未能自动安装：'));
    if (requiredFailures.length > 0) {
      console.log(chalk.red.bold('✖ 必需依赖：'));
      requiredFailures.forEach((failure) => {
        console.log(chalk.red(`- ${failure.name}: ${failure.message}`));
        if (failure.manualHint) {
          console.log(chalk.yellow(`  提示：${failure.manualHint}`));
        }
      });
    }
    if (optionalFailures.length > 0) {
      console.log(chalk.yellow.bold('\n⚠ 可选依赖（不影响核心功能，可以稍后安装）：'));
      optionalFailures.forEach((failure) => {
        console.log(chalk.yellow(`- ${failure.name}: ${failure.message}`));
        if (failure.manualHint) {
          console.log(chalk.yellow(`  提示：${failure.manualHint}`));
        }
      });
    }

    if (requiredFailures.length > 0) {
      console.log('\n' + chalk.red('❌ 部分必需依赖仍未就绪，请根据提示手动安装后再继续。'));
      process.exit(1);
    }

    console.log('\n' + chalk.yellow('⚠ 所有必需依赖已就绪，但部分可选组件尚未安装，可稍后根据提示手动补全。'));
    process.exit(0);
  }

  console.log('\n' + chalk.green('✅ 所有必需依赖均已准备就绪。'));
  process.exit(0);
})();

async function ensurePrerequisite(prereq) {
  process.stdout.write(chalk.cyan(`\n• 检查 ${prereq.name}... `));
  if (prereq.skipEnv) {
    const raw = String(process.env[prereq.skipEnv] || '').toLowerCase();
    if (raw === '1' || raw === 'true' || raw === 'yes') {
      console.log(chalk.yellow(`已根据环境变量 ${prereq.skipEnv} 跳过自动安装（请确保你已通过其它方式准备好 ${prereq.name}）。`));
      return;
    }
  }

  if (prereq.check()) {
    console.log(chalk.green('已安装'));
    return;
  }

  console.log(chalk.yellow('未安装，开始处理'));
  try {
    const installer = pickInstaller(prereq.installers);
    if (!installer) {
      if (prereq.optional) {
        console.log(chalk.yellow('当前平台未提供自动安装，已跳过（可稍后手动安装）。'));
        return;
      }
      throw new Error('当前平台未提供自动安装步骤');
    }
    await installer();
    if (!prereq.check()) {
      throw new Error('安装命令执行完毕，但仍检测不到。');
    }
    console.log(chalk.green(`→ ${prereq.name} 安装完成`));
  } catch (err) {
    const message = err?.message || String(err);
    console.log(chalk.red(`→ 安装失败：${message}`));
    failures.push({ name: prereq.name, message, manualHint: prereq.manualHint, optional: prereq.optional });
    if (prereq.optional) {
      console.log(chalk.yellow('  该依赖为可选组件，可稍后手动安装。'));
    }
  }
}

function pickInstaller(installers = {}) {
  if (!installers) return null;
  if (ctx.isWindows && installers.windows) return installers.windows;
  if (ctx.isLinux && installers.linux) return installers.linux;
  if (installers.all) return installers.all;
  return null;
}

function detectWindowsInstaller() {
  if (commandExists('winget', ['--version'])) return 'winget';
  if (commandExists('choco', ['-v'])) return 'choco';
  return null;
}

function detectLinuxPackageManager() {
  if (!isLinux) return null;
  if (commandExists('apt-get', ['--version'])) return 'apt';
  if (commandExists('dnf', ['--version'])) return 'dnf';
  if (commandExists('yum', ['--version'])) return 'yum';
  if (commandExists('pacman', ['-V'])) return 'pacman';
  return null;
}

function commandExists(cmd, args = ['--version']) {
  try {
    const result = spawnSync(cmd, args, { stdio: 'ignore', shell: platform === 'win32' });
    return result.status === 0;
  } catch {
    return false;
  }
}

function getCommandVersion(cmd, args = ['--version']) {
  try {
    const result = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: platform === 'win32' });
    if (result.status !== 0) return null;
    const output = result.stdout || result.stderr || '';
    const match = output.match(/\d+\.\d+\.\d+/);
    return match ? match[0] : null;
  } catch {
    return null;
  }
}

function versionAtLeast(current, target) {
  if (!current) return false;
  const cur = current.split('.').map(Number);
  const tar = target.split('.').map(Number);
  const len = Math.max(cur.length, tar.length);
  for (let i = 0; i < len; i++) {
    const c = cur[i] || 0;
    const t = tar[i] || 0;
    if (c > t) return true;
    if (c < t) return false;
  }
  return true;
}

async function runCommand(cmd, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', shell: false, ...options });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(' ')} 退出码 ${code}`));
    });
    child.on('error', reject);
  });
}

async function installWindowsPackage({ wingetId, chocoPkg }) {
  if (ctx.windowsInstaller === 'winget' && wingetId) {
    await runCommand('winget', ['install', '--id', wingetId, '-e', '--source', 'winget', '--accept-package-agreements', '--accept-source-agreements', '--silent']);
    return;
  }
  if (ctx.windowsInstaller === 'choco' && chocoPkg) {
    await runCommand('choco', ['install', chocoPkg, '-y']);
    return;
  }
  throw new Error('未检测到可用的包管理器 (winget/choco)。');
}

async function installLinuxPackages(packageMap) {
  const manager = ctx.linuxPkgManager;
  if (!manager) {
    throw new Error('当前 Linux 发行版尚未适配自动安装。');
  }
  const packages = packageMap[manager];
  if (!packages || packages.length === 0) {
    throw new Error(`包 ${manager} 尚未提供适配名称。`);
  }
  if (manager === 'apt') {
    if (!ctx.aptUpdated) {
      await runCommand('sudo', ['apt-get', 'update']);
      ctx.aptUpdated = true;
    }
    await runCommand('sudo', ['apt-get', 'install', '-y', ...packages]);
  } else if (manager === 'dnf') {
    await runCommand('sudo', ['dnf', 'install', '-y', ...packages]);
  } else if (manager === 'yum') {
    await runCommand('sudo', ['yum', 'install', '-y', ...packages]);
  } else if (manager === 'pacman') {
    if (!ctx.pacmanSynced) {
      await runCommand('sudo', ['pacman', '-Sy']);
      ctx.pacmanSynced = true;
    }
    await runCommand('sudo', ['pacman', '-S', '--noconfirm', ...packages]);
  } else {
    throw new Error('暂未支持该包管理器：' + manager);
  }
}

async function installNodeOnLinux() {
  if (!ctx.linuxPkgManager) {
    throw new Error('无法识别包管理器，无法安装 Node.js');
  }
  if ((ctx.linuxPkgManager === 'apt' || ctx.linuxPkgManager === 'dnf' || ctx.linuxPkgManager === 'yum') && !commandExists('curl')) {
    await installLinuxPackages({
      apt: ['curl'],
      dnf: ['curl'],
      yum: ['curl'],
      pacman: ['curl']
    });
  }

  if (ctx.linuxPkgManager === 'apt') {
    await runCommand('bash', ['-c', 'curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -']);
    await runCommand('sudo', ['apt-get', 'install', '-y', 'nodejs']);
  } else if (ctx.linuxPkgManager === 'dnf' || ctx.linuxPkgManager === 'yum') {
    await runCommand('bash', ['-c', 'curl -fsSL https://rpm.nodesource.com/setup_18.x | sudo -E bash -']);
    await runCommand('sudo', [ctx.linuxPkgManager, 'install', '-y', 'nodejs']);
  } else if (ctx.linuxPkgManager === 'pacman') {
    await installLinuxPackages({ pacman: ['nodejs', 'npm'] });
  } else {
    throw new Error('当前包管理器暂不可自动安装 Node.js');
  }
}

async function installPm2Global() {
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  await runCommand(npmCmd, ['install', '-g', 'pm2']);
}

async function installRedisOnWindows() {
  if (!ctx.windowsInstaller) {
    throw new Error('未检测到 winget / chocolatey，无法自动安装 Redis/Memurai。');
  }

  try {
    if (ctx.windowsInstaller === 'winget') {
      info('尝试通过 winget 安装 Memurai（Redis 兼容）...');
      await runCommand('winget', [
        'install',
        '--id', 'Memurai.MemuraiDeveloper',
        '-e',
        '--source', 'winget',
        '--accept-package-agreements',
        '--accept-source-agreements'
      ]);
      info('Memurai 安装命令已执行，如未自动加入 PATH，请重启终端或检查系统服务是否已启动。');
      return;
    }

    if (ctx.windowsInstaller === 'choco') {
      info('尝试通过 chocolatey 安装 Memurai（Redis 兼容）...');
      await runCommand('choco', ['install', 'memurai-developer', '-y']);
      info('Memurai 安装命令已执行，请确认服务已启动。');
      return;
    }
  } catch (err) {
    warn(`通过 ${ctx.windowsInstaller} 安装 Memurai 失败：${err?.message || err}`);
    if (ctx.windowsInstaller === 'winget') {
      const launched = await runMemuraiInstallerInteractivelyFromWingetCache();
      if (launched) {
        info('请在弹出的安装向导中完成 Memurai 部署，完成后回到此终端继续。');
        return;
      }
    }
    throw new Error('自动安装 Memurai 失败，请从 https://www.memurai.com/download/ 手动下载安装包并完成配置后再重试。');
  }

  throw new Error('当前未配置可用的 Windows 包管理器用于安装 Redis/Memurai。');
}

async function runMemuraiInstallerInteractivelyFromWingetCache() {
  const homeDir = os.homedir();
  const cacheDir = path.join(homeDir, 'AppData', 'Local', 'Temp', 'WinGet');
  try {
    const dirEntries = await fs.promises.readdir(cacheDir, { withFileTypes: true });
    const candidates = dirEntries
      .filter((entry) => entry.isDirectory() && entry.name.toLowerCase().startsWith('memurai.memuraideveloper'))
      .sort((a, b) => b.name.localeCompare(a.name));
    for (const entry of candidates) {
      const fullDir = path.join(cacheDir, entry.name);
      const files = await fs.promises.readdir(fullDir);
      const msiName = files.find((name) => name.toLowerCase().endsWith('.msi'));
      if (!msiName) continue;
      const msiPath = path.join(fullDir, msiName);
      info(`发现已有 Memurai 安装包：${msiPath}`);
      info('将以交互模式启动安装器，请按照向导完成安装。');
      await runCommand('msiexec', ['/i', msiPath]);
      return true;
    }
  } catch {
    // ignore, fallback to manual guidance
  }
  return false;
}

async function installNeo4jOnWindows() {
  if (!ctx.windowsInstaller) {
    throw new Error('未检测到 winget / chocolatey，无法自动安装 Neo4j。');
  }

  if (ctx.windowsInstaller === 'winget') {
    info('尝试通过 winget 安装 Neo4j Desktop...');
    await runCommand('winget', [
      'install',
      '--id', 'Neo4j.Neo4jDesktop',
      '-e',
      '--source', 'winget',
      '--accept-package-agreements',
      '--accept-source-agreements'
    ]);
    info('Neo4j Desktop 安装命令已执行，请在安装完成后创建本地数据库并确保其运行。');
    return;
  }

  if (ctx.windowsInstaller === 'choco') {
    info('尝试通过 chocolatey 安装 Neo4j Community...');
    await runCommand('choco', ['install', 'neo4j-community', '-y']);
    info('Neo4j Community 安装命令已执行，请确保 Windows 服务已启动。');
    return;
  }

  throw new Error('当前未配置可用的 Windows 包管理器用于安装 Neo4j。');
}

async function installNeo4jOnLinux() {
  if (ctx.linuxPkgManager !== 'apt') {
    throw new Error('当前仅支持 Debian/Ubuntu (apt) 的自动安装方式。');
  }
  await runCommand('bash', ['-c', 'wget -qO - https://debian.neo4j.com/neotechnology.gpg.key | sudo gpg --dearmor -o /usr/share/keyrings/neo4j.gpg']);
  await runCommand('bash', ['-c', "echo 'deb [signed-by=/usr/share/keyrings/neo4j.gpg] https://debian.neo4j.com stable 5' | sudo tee /etc/apt/sources.list.d/neo4j.list > /dev/null"]);
  ctx.aptUpdated = false;
  await installLinuxPackages({ apt: ['neo4j'] });
}

function info(msg) {
  console.log(chalk.blue(msg));
}

function warn(msg) {
  console.log(chalk.yellow(msg));
}
