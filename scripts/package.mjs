import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const expectedFiles = [
  ['vendor/ffmpeg/ffmpeg.exe', 101_897_728, '1326dde4c84ff1f96fe6b8916c5bed29e163e9b5dccf995f6f3db069d143ec5e'],
  ['vendor/ffmpeg/ffprobe.exe', 101_692_928, 'b49ccc7c6547b141ad5a2f6ec69cc04323d7133d7704d70b331b904c63eecb07'],
  ['vendor/ffmpeg/LICENSE', undefined, undefined],
  ['vendor/ffmpeg/README.txt', undefined, undefined],
  ['vendor/ffmpeg/README.md', undefined, undefined],
  ['vendor/ffmpeg/source.json', undefined, undefined],
  ['.tools/media-publish/no-replace-move.exe', 174_592, '07c3aeb02906a9159492fba240213d5610b843a838deb5090c49df00e960df5e'],
  ['native/thumbnail/dist/VideoHelperThumbnail.dll', 501_760, '308506b7434aa9c729332ed46dde294397062f6e604feb2623e6caadbb7ba2c1'],
  ['native/thumbnail/dist/manifest.json', undefined, undefined],
  ['native/thumbnail/dist/install.ps1', undefined, undefined],
  ['native/thumbnail/dist/uninstall.ps1', undefined, undefined],
  ['native/thumbnail/dist/README.md', undefined, undefined],
  ['native/thumbnail/VideoHelperThumbnail-0.1.0-win-x64.zip', 247_600, 'f5b300517fc6872897fb8d547322ebac769c222fdc40f5b67d4fc8f311468b4a'],
];
const expectedPluginLicenses = [
  'LICENSE-Zig.txt',
  'LICENSE-mingw-w64.txt',
  'LICENSE-libunwind.txt',
  'LICENSE-libcxxabi.txt',
  'LICENSE-libcxx.txt',
];

async function hashFile(absolutePath) {
  const bytes = await readFile(absolutePath);
  return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

async function validateFile(relativePath, expectedBytes, expectedSha256) {
  const absolutePath = path.join(root, relativePath);
  let metadata;
  try {
    metadata = await stat(absolutePath);
  } catch {
    throw new Error(`Required release input is missing: ${relativePath}`);
  }
  if (!metadata.isFile() || metadata.size === 0) throw new Error(`Required release input is empty or not a file: ${relativePath}`);
  const actual = await hashFile(absolutePath);
  if (expectedBytes !== undefined && actual.bytes !== expectedBytes) {
    throw new Error(`${relativePath} has ${actual.bytes} bytes; expected ${expectedBytes}.`);
  }
  if (expectedSha256 !== undefined && actual.sha256 !== expectedSha256) {
    throw new Error(`${relativePath} has SHA-256 ${actual.sha256}; expected ${expectedSha256}.`);
  }
  return { path: relativePath, ...actual };
}

async function validatePluginBundle() {
  const manifest = JSON.parse(await readFile(path.join(root, 'native/thumbnail/dist/manifest.json'), 'utf8'));
  const dll = await hashFile(path.join(root, 'native/thumbnail/dist/VideoHelperThumbnail.dll'));
  if (manifest.dllFile !== 'VideoHelperThumbnail.dll' || manifest.sha256?.toLowerCase() !== dll.sha256) {
    throw new Error('Thumbnail manifest does not match the DLL being packaged.');
  }
  for (const fileName of expectedPluginLicenses) {
    await validateFile(`native/thumbnail/dist/licenses/${fileName}`);
  }
  const actualLicenseFiles = (await readdir(path.join(root, 'native/thumbnail/dist/licenses'))).sort();
  const expectedSorted = [...expectedPluginLicenses].sort();
  if (JSON.stringify(actualLicenseFiles) !== JSON.stringify(expectedSorted)) {
    throw new Error(`Thumbnail license inventory changed: ${actualLicenseFiles.join(', ')}`);
  }
}

const validated = [];
for (const [relativePath, expectedBytes, expectedSha256] of expectedFiles) {
  validated.push(await validateFile(relativePath, expectedBytes, expectedSha256));
}
await validatePluginBundle();
process.stdout.write(`${JSON.stringify({ status: 'validated', inputs: validated }, null, 2)}\n`);
