import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const zig = path.join(repositoryRoot, '.tools', 'zig', 'zig-x86_64-windows-0.14.1', 'zig.exe');
const source = path.join(repositoryRoot, 'src', 'main', 'media', 'native', 'no_replace_move.c');
const outputDirectory = path.join(repositoryRoot, '.tools', 'media-publish');
const output = path.join(outputDirectory, 'no-replace-move.exe');

function run(binary, args) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      ZIG_GLOBAL_CACHE_DIR: path.join(repositoryRoot, '.tools', 'zig-global-cache'),
      ZIG_LOCAL_CACHE_DIR: path.join(repositoryRoot, '.tools', 'zig-local-cache'),
    };
    const child = spawn(binary, args, { cwd: repositoryRoot, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.once('error', reject);
    child.once('close', (code) => {
      const out = Buffer.concat(stdout).toString('utf8').trim();
      const err = Buffer.concat(stderr).toString('utf8').trim();
      if (code === 0) resolve(out);
      else reject(new Error(`${path.basename(binary)} exited ${code}: ${err}`));
    });
  });
}

const version = await run(zig, ['version']);
if (version !== '0.14.1') throw new Error(`Expected Zig 0.14.1 but found ${version}.`);
await mkdir(outputDirectory, { recursive: true });
await run(zig, [
  'cc', '-target', 'x86_64-windows-gnu', '-O2', '-static', '-municode', source, '-o', output,
]);
process.stdout.write(`Built ${path.relative(repositoryRoot, output)} with Zig ${version}.\n`);
