import { spawn } from 'node:child_process';
import { cp, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');

await rm(dist, { recursive: true, force: true });

await new Promise((resolveRun, rejectRun) => {
  const child = spawn(
    process.execPath,
    [resolve(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'],
    {
      cwd: root,
      stdio: 'inherit',
    },
  );
  child.on('error', rejectRun);
  child.on('exit', (code) => {
    if (code === 0) resolveRun();
    else rejectRun(new Error(`tsc exited with code ${code ?? 'unknown'}`));
  });
});

await cp(resolve(root, 'templates'), resolve(dist, 'templates'), { recursive: true });
await cp(resolve(root, 'public'), resolve(dist, 'public'), { recursive: true });
await cp(resolve(root, 'migrations'), resolve(dist, 'migrations'), { recursive: true });
