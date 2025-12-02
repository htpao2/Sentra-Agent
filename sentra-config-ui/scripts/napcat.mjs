import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import boxen from 'boxen';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Repo root is one level above sentra-config-ui
const repoRoot = path.resolve(__dirname, '..', '..');
const napcatDir = path.join(repoRoot, 'sentra-adapter', 'napcat');

function commandExists(cmd, checkArgs = ['--version']) {
  try {
    const r = spawnSync(cmd, checkArgs, { stdio: 'ignore', shell: true });
    return r.status === 0;
  } catch {
    return false;
  }
}

function choosePM(preferred) {
  if (preferred && preferred !== 'auto') {
    if (!commandExists(preferred)) {
      throw new Error(`Package manager ${preferred} not found in PATH`);
    }
    return preferred;
  }
  // Auto detection priority: pnpm > npm > cnpm > yarn
  if (commandExists('pnpm')) return 'pnpm';
  if (commandExists('npm')) return 'npm';
  if (commandExists('cnpm')) return 'cnpm';
  if (commandExists('yarn')) return 'yarn';
  throw new Error('No package manager found. Please install one or set PACKAGE_MANAGER in .env');
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'inherit', shell: true, ...opts });
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`))));
  });
}

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { cmd: 'start' };
  if (args[0] && ['start', 'build'].includes(args[0])) out.cmd = args[0];
  return out;
}

async function main() {
  const { cmd } = parseArgs();
  const pm = choosePM(process.env.PACKAGE_MANAGER || 'auto');

  if (cmd === 'build') {
    console.log(boxen(chalk.bold.cyan(`Napcat: build (using ${pm})`), { padding: 1, borderStyle: 'round' }));
    await run(pm, ['run', 'build'], { cwd: napcatDir });
    return;
  }

  if (cmd === 'start') {
    console.log(boxen(chalk.bold.cyan(`Napcat: build → start (using ${pm})`), { padding: 1, borderStyle: 'round' }));
    await run(pm, ['run', 'build'], { cwd: napcatDir });
    await run(pm, ['run', 'start'], { cwd: napcatDir });
    return;
  }
}

main().catch((e) => {
  console.error(chalk.red.bold('Error: ') + (e.message || e));
  process.exit(1);
});
