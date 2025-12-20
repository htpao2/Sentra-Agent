import { spawn, spawnSync, execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const ROOT = path.resolve(process.cwd());
const APP_NAME = 'sentra-agent';
const ENTRY = path.join(ROOT, 'Main.js');
const ECOSYSTEM = path.join(ROOT, 'ecosystem.config.cjs');

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { cmd: 'start', mode: 'auto', env: '', logs: true };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === 'start' || a === 'stop' || a === 'restart' || a === 'reload' || a === 'delete' || a === 'logs' || a === 'status' || a === 'monit') {
      out.cmd = a;
    } else if (a.startsWith('--mode=')) out.mode = a.split('=')[1];
    else if (a === '--mode' && args[i + 1]) out.mode = args[++i];
    else if (a.startsWith('--env=')) out.env = a.split('=')[1];
    else if (a === '--env' && args[i + 1]) out.env = args[++i];
    else if (a === '--no-logs') out.logs = false;
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/start.mjs <start|stop|restart|reload|delete|logs|status|monit> [--mode pm2|node|auto] [--env production|development] [--no-logs]');
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
  // Default to plain Node.js; PM2 is only used when explicitly requested
  return 'node';
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'inherit', shell: true, ...opts });
    p.on('close', (code) => code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`)));
  });
}

function ensureLogsDir() {
  const logsDir = path.join(ROOT, 'logs');
  try { fs.mkdirSync(logsDir, { recursive: true }); } catch {}
}

function pm2ProcessExists(name) {
  try {
    const out = execSync('pm2 jlist', { stdio: ['ignore', 'pipe', 'ignore'], shell: true }).toString();
    const list = JSON.parse(out);
    return Array.isArray(list) && list.some(p => p.name === name);
  } catch {
    return false;
  }
}

async function runPm2(cmd, opts) {
  ensureLogsDir();
  switch (cmd) {
    case 'start': {
      const exists = pm2ProcessExists(APP_NAME);
      if (!fs.existsSync(ECOSYSTEM)) throw new Error(`ecosystem file not found: ${ECOSYSTEM}`);
      if (exists) {
        const args = ['restart', APP_NAME];
        if (opts.env) args.push('--env', opts.env, '--update-env');
        else args.push('--update-env');
        await run('pm2', args);
      } else {
        const args = ['start', ECOSYSTEM];
        if (opts.env) args.push('--env', opts.env);
        await run('pm2', args);
      }
      if (opts.logs) await run('pm2', ['logs', APP_NAME]);
      break;
    }
    case 'stop':
      await run('pm2', ['stop', APP_NAME]);
      break;
    case 'restart':
      {
        const args = ['restart', APP_NAME];
        if (opts.env) args.push('--env', opts.env, '--update-env');
        else args.push('--update-env');
        await run('pm2', args);
      }
      break;
    case 'reload':
      {
        const args = ['reload', APP_NAME];
        if (opts.env) args.push('--env', opts.env, '--update-env');
        else args.push('--update-env');
        await run('pm2', args);
      }
      break;
    case 'delete':
      await run('pm2', ['delete', APP_NAME]);
      break;
    case 'logs':
      await run('pm2', ['logs', APP_NAME]);
      break;
    case 'status':
      await run('pm2', ['status']);
      break;
    case 'monit':
      await run('pm2', ['monit']);
      break;
  }
}

async function runNode(cmd, opts) {
  switch (cmd) {
    case 'start': {
      const env = { ...process.env };
      if (opts.env) env.NODE_ENV = opts.env;
      env.FORCE_COLOR = env.FORCE_COLOR || '3';
      await run(process.execPath, [ENTRY], { env });
      break;
    }
    case 'logs':
      console.log('Logs are attached to current console in node mode. Use start without --no-logs.');
      break;
    default:
      console.log(`Command ${cmd} is not applicable in node mode.`);
  }
}

async function main() {
  const opts = parseArgs();
  const mode = chooseMode(opts.mode);
  if (mode === 'pm2') {
    await runPm2(opts.cmd, opts);
  } else {
    await runNode(opts.cmd, opts);
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
