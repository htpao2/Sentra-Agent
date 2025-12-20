import { spawn, spawnSync, execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import boxen from 'boxen';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Repo root is one level above sentra-config-ui
const repoRoot = path.resolve(__dirname, '..', '..');
const appName = 'sentra-agent';
const entry = path.join(repoRoot, 'Main.js');
const ecosystem = path.join(repoRoot, 'ecosystem.config.cjs');

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { cmd: 'start', mode: 'auto', env: 'production', logs: true };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (['start', 'stop', 'restart', 'reload', 'delete', 'logs', 'status', 'monit'].includes(a)) out.cmd = a;
    else if (a.startsWith('--mode=')) out.mode = a.split('=')[1];
    else if (a === '--mode' && args[i + 1]) out.mode = args[++i];
    else if (a.startsWith('--env=')) out.env = a.split('=')[1];
    else if (a === '--env' && args[i + 1]) out.env = args[++i];
    else if (a === '--no-logs') out.logs = false;
    else if (a === '--help' || a === '-h') {
      console.log(chalk.cyan('Usage: node scripts/start.mjs <start|stop|restart|reload|delete|logs|status|monit> [--mode pm2|node|auto] [--env production|development] [--no-logs]'));
      process.exit(0);
    }
  }
  return out;
}

function commandExists(cmd) {
  try {
    const r = spawnSync(cmd, ['-v'], { stdio: 'ignore', shell: true });
    return r.status === 0;
  } catch {
    return false;
  }
}

function chooseMode(preferred) {
  if (preferred && preferred !== 'auto') return preferred;
  // Default: prefer plain Node.js; PM2 is only used when explicitly requested
  return 'node';
}

function quotePath(p) {
  // Always quote paths to handle spaces and Chinese characters
  return JSON.stringify(p);
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'inherit', shell: true, ...opts });
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`))));
  });
}

function ensureLogsDir() {
  const logsDir = path.join(repoRoot, 'logs');
  try { fs.mkdirSync(logsDir, { recursive: true }); } catch { }
}

function pm2ProcessExists(name) {
  try {
    const out = execSync('pm2 jlist', { stdio: ['ignore', 'pipe', 'ignore'], shell: true }).toString();
    const list = JSON.parse(out);
    return Array.isArray(list) && list.some((p) => p.name === name);
  } catch {
    return false;
  }
}

async function runPm2(cmd, opts) {
  ensureLogsDir();
  console.log(boxen(chalk.bold.blue(`PM2 Manager: ${cmd}`), { padding: 1, borderStyle: 'round' }));

  switch (cmd) {
    case 'start': {
      const exists = pm2ProcessExists(appName);
      if (!fs.existsSync(ecosystem)) throw new Error(`ecosystem file not found: ${ecosystem}`);
      if (exists) {
        console.log(chalk.yellow('Process already exists, restarting...'));
        const args = ['restart', quotePath(ecosystem)];
        if (opts.env) args.push('--env', opts.env);
        await run('pm2', args, { cwd: repoRoot });
      } else {
        console.log(chalk.green('Starting new process...'));
        const args = ['start', quotePath(ecosystem)];
        if (opts.env) args.push('--env', opts.env);
        await run('pm2', args, { cwd: repoRoot });
      }
      if (opts.logs) await run('pm2', ['logs', appName], { cwd: repoRoot });
      break;
    }
    case 'stop':
      await run('pm2', ['stop', appName], { cwd: repoRoot });
      break;
    case 'restart': {
      if (!fs.existsSync(ecosystem)) throw new Error(`ecosystem file not found: ${ecosystem}`);
      if (opts.env) {
        await run('pm2', ['restart', quotePath(ecosystem), '--env', opts.env], { cwd: repoRoot });
      } else {
        await run('pm2', ['restart', appName, '--update-env'], { cwd: repoRoot });
      }
      break;
    }
    case 'reload': {
      if (!fs.existsSync(ecosystem)) throw new Error(`ecosystem file not found: ${ecosystem}`);
      if (opts.env) {
        await run('pm2', ['reload', quotePath(ecosystem), '--env', opts.env], { cwd: repoRoot });
      } else {
        await run('pm2', ['reload', appName, '--update-env'], { cwd: repoRoot });
      }
      break;
    }
    case 'delete':
      await run('pm2', ['delete', appName], { cwd: repoRoot });
      break;
    case 'logs':
      await run('pm2', ['logs', appName], { cwd: repoRoot });
      break;
    case 'status':
      await run('pm2', ['status'], { cwd: repoRoot });
      break;
    case 'monit':
      await run('pm2', ['monit'], { cwd: repoRoot });
      break;
  }
}

async function runNode(cmd, opts) {
  console.log(boxen(chalk.bold.green(`Node.js Manager: ${cmd}`), { padding: 1, borderStyle: 'round' }));

  switch (cmd) {
    case 'start': {
      const env = { ...process.env };
      if (opts.env) env.NODE_ENV = opts.env;
      env.FORCE_COLOR = env.FORCE_COLOR || '3';
      env.TERM = env.TERM || 'xterm-256color';
      env.COLORTERM = env.COLORTERM || 'truecolor';

      console.log(chalk.blue(`Starting ${appName} in ${opts.env || 'production'} mode...`));
      await run(quotePath(process.execPath), [quotePath(entry)], { env, cwd: repoRoot });
      break;
    }
    case 'logs':
      console.log(chalk.yellow('Logs are attached to current console in node mode.'));
      break;
    default:
      console.log(chalk.red(`Command ${cmd} is not applicable in node mode.`));
  }
}

async function main() {
  const opts = parseArgs();
  const mode = chooseMode(opts.mode);
  if (mode === 'pm2') await runPm2(opts.cmd, opts);
  else await runNode(opts.cmd, opts);
}

main().catch((e) => {
  console.error(chalk.red.bold('Error: ') + (e.message || e));
  process.exit(1);
});
