import { copyFile, mkdir, stat, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseDirectory = path.join(root, 'release');
const installerPath = path.join(releaseDirectory, 'VideoHelper-Setup.exe');
const pluginZipSource = path.join(root, 'native/thumbnail/VideoHelperThumbnail-0.1.0-win-x64.zip');
const pluginZipTarget = path.join(releaseDirectory, 'VideoHelperThumbnail-0.1.0-win-x64.zip');
const expectedPluginZipHash = 'f5b300517fc6872897fb8d547322ebac769c222fdc40f5b67d4fc8f311468b4a';

const installer = await stat(installerPath).catch(() => undefined);
if (!installer?.isFile() || installer.size === 0) throw new Error('electron-builder did not create release/VideoHelper-Setup.exe.');
await mkdir(releaseDirectory, { recursive: true });
await copyFile(pluginZipSource, pluginZipTarget);
const pluginZip = await stat(pluginZipTarget);
if (!pluginZip.isFile() || pluginZip.size === 0) throw new Error('The standalone thumbnail ZIP was not copied into release/.');
const pluginZipHash = createHash('sha256').update(await readFile(pluginZipTarget)).digest('hex');
if (pluginZip.size !== 247_600 || pluginZipHash !== expectedPluginZipHash) throw new Error('The standalone thumbnail ZIP copy failed its pinned size or SHA-256 check.');
process.stdout.write(`Finalized release: VideoHelper-Setup.exe (${installer.size} bytes), VideoHelperThumbnail-0.1.0-win-x64.zip (${pluginZip.size} bytes, SHA-256 ${pluginZipHash}).\n`);
