import { spawn } from 'node:child_process';
import { mkdtemp, cp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const secret = 'smoke-secret-value';
const port = await new Promise((resolvePort) => {
  const probe = createServer();
  probe.listen(0, '127.0.0.1', () => {
    const address = probe.address();
    const chosen = typeof address === 'object' && address ? address.port : 0;
    probe.close(() => resolvePort(chosen));
  });
});

function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', rejectRun);
    child.on('close', (code) => {
      resolveRun({ code: code ?? 1, stdout, stderr });
    });
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const stage = await mkdtemp(join(tmpdir(), 'insales-smoke-'));
const elsewhere = await mkdtemp(join(tmpdir(), 'insales-smoke-cwd-'));
const runtimeDir = join(stage, 'runtime');

try {
  await cp(join(root, 'dist'), join(stage, 'dist'), { recursive: true });
  await cp(join(root, 'package.json'), join(stage, 'package.json'));
  await cp(join(root, 'package-lock.json'), join(stage, 'package-lock.json'));
  await cp(join(root, '.npmrc'), join(stage, '.npmrc'));

  const installed = await run('npm', ['ci', '--omit=dev'], { cwd: stage });
  assert(installed.code === 0, `npm ci --omit=dev failed\n${installed.stderr}`);

  const keygen = await run(process.execPath, [join(stage, 'dist/cli.js'), 'keygen'], {
    cwd: elsewhere,
    env: { PATH: process.env.PATH ?? '' },
  });
  assert(keygen.code === 0, `keygen failed\n${keygen.stderr}`);
  assert(
    /^[0-9a-f]{64}\s*$/.test(keygen.stdout),
    `keygen output is not a 64-char hex key: ${keygen.stdout}`,
  );

  const env = {
    PATH: process.env.PATH ?? '',
    APP_ENV: 'development',
    INSALES_APP_ID: 'demo-app',
    INSALES_APP_SECRET: secret,
    APP_BASE_URL: `http://127.0.0.1:${port}`,
    APP_ENCRYPTION_KEY: 'ab'.repeat(32),
    ALLOWED_SHOPS: 'shop.example',
    APP_RUNTIME_DIR: runtimeDir,
    APP_DB: join(runtimeDir, 'app.sqlite3'),
    BIND_HOST: '127.0.0.1',
    PORT: String(port),
    LOG_LEVEL: 'silent',
    LOCAL_DEMO: 'false',
  };

  const migrated = await run(process.execPath, [join(stage, 'dist/cli.js'), 'db:migrate'], {
    cwd: elsewhere,
    env,
  });
  assert(migrated.code === 0, `db:migrate failed\n${migrated.stdout}\n${migrated.stderr}`);
  assert(!migrated.stdout.includes(secret), 'db:migrate printed the app secret');
  assert(
    migrated.stdout.includes('Версия 1') && migrated.stdout.includes('Версия 2'),
    migrated.stdout,
  );

  const status = await run(process.execPath, [join(stage, 'dist/cli.js'), 'db:status'], {
    cwd: elsewhere,
    env,
  });
  assert(status.code === 0, `db:status failed\n${status.stdout}`);

  const broken = await run(process.execPath, [join(stage, 'dist/cli.js'), 'doctor'], {
    cwd: elsewhere,
    env: { ...env, APP_ENCRYPTION_KEY: 'short' },
  });
  assert(broken.code !== 0, 'doctor with a bad key exited 0');
  assert(!`${broken.stdout}\n${broken.stderr}`.includes(secret), 'doctor printed the app secret');

  const server = spawn(process.execPath, [join(stage, 'dist/server.js')], {
    cwd: elsewhere,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (chunk) => {
    serverLog += chunk.toString();
  });
  server.stderr.on('data', (chunk) => {
    serverLog += chunk.toString();
  });

  const deadline = Date.now() + 10_000;
  let healthy = false;
  while (Date.now() < deadline) {
    try {
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      const ready = await fetch(`http://127.0.0.1:${port}/ready`);
      if (health.status === 200 && ready.status === 200) {
        healthy = true;
        const page = await fetch(`http://127.0.0.1:${port}/`);
        const css = await fetch(`http://127.0.0.1:${port}/app.css`);
        const pageText = await page.text();
        const cssText = await css.text();
        assert(page.status === 401, `expected 401 from /, got ${page.status}`);
        assert(pageText.includes('Требуется вход'), 'login template was not rendered');
        assert(css.status === 200, `expected CSS, got ${css.status}`);
        assert(cssText.length > 0, 'CSS is empty');
        break;
      }
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
  }
  assert(healthy, `server did not become ready\n${serverLog}`);
  assert(!serverLog.includes(secret), 'server log printed the app secret');

  const exited = await new Promise((resolveExit) => {
    const timer = setTimeout(() => resolveExit(null), 10_000);
    server.once('exit', (code) => {
      clearTimeout(timer);
      resolveExit(code);
    });
    server.kill('SIGTERM');
  });
  assert(exited === 0, `server exit code was ${exited}\n${serverLog}`);
  console.log('production smoke ok');
} finally {
  await rm(stage, { recursive: true, force: true });
  await rm(elsewhere, { recursive: true, force: true });
}
