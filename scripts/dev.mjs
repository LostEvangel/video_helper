import { spawn } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electronCache = path.join(projectRoot, '.tools', 'electron-cache');
await mkdir(electronCache, { recursive: true });
process.env.electron_config_cache ??= electronCache;
const electronExecutable = createRequire(import.meta.url)('electron');
const rendererUrl = 'http://127.0.0.1:5173/';
const viteEntry = path.join(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js');
const typescriptEntry = path.join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc');
const children = new Set();
let shuttingDown = false;
let exitCode = 0;

function launch(executable, args, env = process.env) {
  const child = spawn(executable, args, {
    cwd: projectRoot,
    env,
    stdio: 'inherit',
    windowsHide: true,
  });
  children.add(child);
  child.once('close', () => children.delete(child));
  return child;
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode ?? 1);
  return new Promise((resolve) => child.once('close', (code) => resolve(code ?? 1)));
}

async function waitForServer() {
  for (let attempt = 0; attempt < 75; attempt += 1) {
    try {
      const response = await fetch(rendererUrl);
      if (response.ok) return;
    } catch {
      // The development server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Vite did not become ready at ${rendererUrl}.`);
}

async function stopChildren(signal = 'SIGTERM') {
  if (shuttingDown) return;
  shuttingDown = true;
  const active = [...children].filter((child) => child.exitCode === null && child.signalCode === null);
  for (const child of active) child.kill(signal);
  const done = Promise.all(active.map((child) => waitForExit(child)));
  await Promise.race([done, new Promise((resolve) => setTimeout(resolve, 1_500))]);
  for (const child of active) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

process.once('SIGINT', () => { exitCode = 130; void stopChildren(); });
process.once('SIGTERM', () => { exitCode = 143; void stopChildren(); });

try {
  await access(electronExecutable);
  const compile = launch(process.execPath, [typescriptEntry, '-p', 'tsconfig.main.json']);
  const compileCode = await waitForExit(compile);
  if (compileCode !== 0) throw new Error(`TypeScript main process build exited with code ${compileCode}.`);

  const server = launch(process.execPath, [viteEntry, '--host', '127.0.0.1', '--port', '5173', '--strictPort']);
  await waitForServer();
  const electron = launch(electronExecutable, [projectRoot], {
    ...process.env,
    VITE_DEV_SERVER_URL: rendererUrl,
  });
  const code = await waitForExit(electron);
  if (!shuttingDown) exitCode = code;
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  exitCode = 1;
} finally {
  await stopChildren();
  process.exitCode = exitCode;
}
