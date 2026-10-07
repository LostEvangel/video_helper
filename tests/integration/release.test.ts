import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { publishOutput, resolveNativePublisherPath } from '../../src/main/media/publish.js';
import { probeMediaWithSignal } from '../../src/main/media/probe.js';
import { runMedia } from '../../src/main/media/process.js';
import { configureMediaToolRuntime, resetMediaToolRuntimeForTests, resolveMediaTool } from '../../src/main/media/tools.js';

const temporaryDirectories: string[] = [];
const previousEnvironment = {
  FFMPEG_PATH: process.env.FFMPEG_PATH,
  FFPROBE_PATH: process.env.FFPROBE_PATH,
  MEDIA_PUBLISH_MOVE_HELPER_PATH: process.env.MEDIA_PUBLISH_MOVE_HELPER_PATH,
};

afterEach(async () => {
  resetMediaToolRuntimeForTests();
  for (const [name, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  for (const directory of temporaryDirectories.splice(0)) {
    const normalized = path.resolve(directory);
    const allowedRoot = `${path.resolve(os.tmpdir())}${path.sep}`;
    if (!normalized.toLocaleLowerCase('en-US').startsWith(allowedRoot.toLocaleLowerCase('en-US'))) {
      throw new Error(`Refusing to remove a release test directory outside the OS temp folder: ${normalized}`);
    }
    await rm(normalized, { recursive: true, force: true });
  }
});

describe('release binary resolution', () => {
  it('uses only Electron resources in packaged mode and ignores all executable overrides', () => {
    process.env.FFMPEG_PATH = 'C:\\untrusted\\ffmpeg.exe';
    process.env.FFPROBE_PATH = 'C:\\untrusted\\ffprobe.exe';
    process.env.MEDIA_PUBLISH_MOVE_HELPER_PATH = 'C:\\untrusted\\publisher.exe';
    const resourcesPath = 'C:\\Video Helper\\resources';
    configureMediaToolRuntime({ packaged: true, resourcesPath });

    expect(resolveMediaTool('ffmpeg')).toBe(path.join(resourcesPath, 'bin', 'ffmpeg.exe'));
    expect(resolveMediaTool('ffprobe')).toBe(path.join(resourcesPath, 'bin', 'ffprobe.exe'));
    expect(resolveNativePublisherPath()).toBe(path.join(resourcesPath, 'media-publish', 'no-replace-move.exe'));
  });

  it('allows explicit development overrides and PATH fallback outside packaged mode', () => {
    configureMediaToolRuntime({ packaged: false });
    process.env.FFMPEG_PATH = 'D:\\tools\\ffmpeg.exe';
    delete process.env.FFPROBE_PATH;
    delete process.env.MEDIA_PUBLISH_MOVE_HELPER_PATH;

    expect(resolveMediaTool('ffmpeg')).toBe('D:\\tools\\ffmpeg.exe');
    expect(resolveMediaTool('ffprobe')).toBe(process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
    expect(resolveNativePublisherPath()).toBe(path.resolve(process.cwd(), '.tools', 'media-publish', 'no-replace-move.exe'));
  });
});

describe('release paths and safe publishing', () => {
  it('runs FFmpeg and FFprobe from a Unicode path and leaves an existing output untouched', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'Video Helper 發布路徑 '));
    temporaryDirectories.push(directory);
    const output = path.join(directory, '中文 空格', '樣片.mp4');
    const protectedOutput = path.join(path.dirname(output), 'already-here.mp4');
    const temporaryOutput = path.join(path.dirname(output), 'verified-output.mp4');
    await mkdir(path.dirname(output), { recursive: true });
    process.env.FFMPEG_PATH = path.resolve('vendor/ffmpeg/ffmpeg.exe');
    process.env.FFPROBE_PATH = path.resolve('vendor/ffmpeg/ffprobe.exe');

    await runMedia(resolveMediaTool('ffmpeg'), [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-f', 'lavfi', '-i', 'color=c=red:s=32x32:r=4:d=1',
      '-t', '1', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output,
    ], new AbortController().signal);
    const probe = await probeMediaWithSignal(output, new AbortController().signal);
    expect(probe.duration).toBeGreaterThan(0.9);
    expect(probe.streams.filter((stream) => stream.codecType === 'video')).toHaveLength(1);

    await writeFile(protectedOutput, 'keep existing user data', { flag: 'wx' });
    await writeFile(temporaryOutput, await readFile(output), { flag: 'wx' });
    await expect(publishOutput(temporaryOutput, protectedOutput, false)).rejects.toMatchObject({ code: 'OUTPUT_EXISTS' });
    expect(await readFile(protectedOutput, 'utf8')).toBe('keep existing user data');
    expect(createHash('sha256').update(await readFile(temporaryOutput)).digest('hex')).toBe(
      createHash('sha256').update(await readFile(output)).digest('hex'),
    );
  }, 15_000);
});
