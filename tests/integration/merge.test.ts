import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DownloadManifest } from '../../src/shared/contracts.js';
import { inspectInput, selectManifest } from '../../src/main/hls/inspect.js';
import { localizeManifest } from '../../src/main/hls/localize.js';
import { mergeVideo } from '../../src/main/media/merge.js';
import { probeVideo } from '../../src/main/media/probe.js';
import { runMedia } from '../../src/main/media/process.js';
import { publishOutput, toExtendedWindowsPath } from '../../src/main/media/publish.js';
import { runDownload, resourceCachePath } from '../../src/main/download/queue.js';

const workspace = process.cwd();
const fixtureRoot = path.join(workspace, 'tests', 'generated', 'media-merge');
const mediaRoot = path.join(fixtureRoot, '測試 media');
const bundledBin = path.join(workspace, '.tools', 'ffmpeg-essentials', 'ffmpeg-8.1.2-essentials_build', 'bin');
const candidateFfmpeg = path.join(bundledBin, 'ffmpeg.exe');
const candidateFfprobe = path.join(bundledBin, 'ffprobe.exe');
const fixtureScript = path.join(workspace, 'scripts', 'create-fixtures.mjs');
const helperBuildScript = path.join(workspace, 'scripts', 'build-publish-helper.mjs');
const noReplaceHelper = path.join(workspace, '.tools', 'media-publish', 'no-replace-move.exe');
const priorFfmpeg = process.env.FFMPEG_PATH;
const priorFfprobe = process.env.FFPROBE_PATH;
const runDirectories: string[] = [];

function runNode(args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: workspace, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve(Buffer.concat(stdout).toString('utf8'));
      else reject(new Error(Buffer.concat(stderr).toString('utf8')));
    });
  });
}

async function createManifest(videoPlaylist: string, audioPlaylist?: string): Promise<DownloadManifest> {
  let inspectionPath = videoPlaylist;
  if (audioPlaylist) {
    const masterDirectory = path.dirname(videoPlaylist);
    const masterPath = path.join(masterDirectory, `integration-master-${randomUUID()}.m3u8`);
    const relativeAudio = path.relative(masterDirectory, audioPlaylist).split(path.sep).join('/');
    await writeFile(masterPath, [
      '#EXTM3U',
      `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="integration-audio",NAME="Integration audio",DEFAULT=YES,AUTOSELECT=YES,URI="${relativeAudio}"`,
      '#EXT-X-STREAM-INF:BANDWIDTH=1000000,AUDIO="integration-audio"',
      path.basename(videoPlaylist),
      '',
    ].join('\n'), 'utf8');
    inspectionPath = masterPath;
  }
  const inspection = await inspectInput({ kind: 'file', path: inspectionPath });
  const variant = inspection.variants[0];
  if (!variant) throw new Error(`Fixture did not produce a selectable variant: ${inspectionPath}`);
  const audioTrack = audioPlaylist ? inspection.audioTracks[0] : undefined;
  if (audioPlaylist && !audioTrack) throw new Error('The generated master playlist did not expose its independent audio track.');
  return selectManifest(inspection.id, variant.id, audioTrack?.id);
}

async function withLocalizedInput<T>(
  videoPlaylist: string,
  audioPlaylist: string | undefined,
  action: (input: { video: string; audio?: string }, cacheDir: string, manifest: DownloadManifest) => Promise<T>,
): Promise<T> {
  const workDir = await mkdtemp(path.join(fixtureRoot, 'run-'));
  runDirectories.push(workDir);
  const cacheDir = path.join(workDir, 'resource cache');
  const manifest = await createManifest(videoPlaylist, audioPlaylist);
  await runDownload(manifest, cacheDir, new AbortController().signal, () => {});
  const localized = await localizeManifest(manifest, cacheDir);
  return action(localized, cacheDir, manifest);
}

function outputPath(label: string, extension = '.mp4'): string {
  return path.join(os.tmpdir(), `video helper ${label} 測試-${randomUUID()}${extension}`);
}

beforeAll(async () => {
  process.env.FFMPEG_PATH = candidateFfmpeg;
  process.env.FFPROBE_PATH = candidateFfprobe;
  const helperBuild = await runNode([helperBuildScript], process.env);
  process.stdout.write(`${helperBuild.trim()}\n`);
  const version = await runNode(['-e', 'const {execFileSync}=require("node:child_process");process.stdout.write(execFileSync(process.env.FFMPEG_PATH,["-version"],{encoding:"utf8"}));'], process.env);
  if (!version.includes('8.1.2-essentials_build')) throw new Error(`Unexpected fixture FFmpeg candidate: ${version.split('\n')[0]}`);
  const generated = await runNode([fixtureScript], process.env);
  process.stdout.write(`Generated media fixtures with ${version.split('\n')[0]}: ${generated.trim()}\n`);
}, 30_000);

afterAll(async () => {
  await Promise.all(runDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  const generatedRoot = path.resolve(fixtureRoot);
  const generatedParent = path.resolve(workspace, 'tests', 'generated');
  if (generatedRoot.startsWith(`${generatedParent}${path.sep}`)) {
    await rm(generatedRoot, { recursive: true, force: true });
  }
  if (priorFfmpeg === undefined) delete process.env.FFMPEG_PATH;
  else process.env.FFMPEG_PATH = priorFfmpeg;
  if (priorFfprobe === undefined) delete process.env.FFPROBE_PATH;
  else process.env.FFPROBE_PATH = priorFfprobe;
});

describe('local HLS merge and safe output', () => {
  it.each([
    ['MPEG-TS HLS', path.join(mediaRoot, 'ts playlist', 'video.m3u8'), undefined, 'copy-mp4', true],
    ['fMP4 HLS', path.join(mediaRoot, 'fmp4 playlist', 'video.m3u8'), undefined, 'copy-mp4', true],
    ['AES-128 HLS', path.join(mediaRoot, 'aes playlist', 'video.m3u8'), undefined, 'copy-mp4', true],
    ['independent audio HLS', path.join(mediaRoot, 'independent audio', 'video', 'video.m3u8'), path.join(mediaRoot, 'independent audio', 'audio', 'audio.m3u8'), 'copy-mp4', true],
    ['video-only HLS', path.join(mediaRoot, 'video only', 'video.m3u8'), undefined, 'copy-mp4', false],
    ['MPEG-TS to MKV', path.join(mediaRoot, 'ts playlist', 'video.m3u8'), undefined, 'copy-mkv', true],
    ['MPEG-TS transcode', path.join(mediaRoot, 'ts playlist', 'video.m3u8'), undefined, 'transcode-mp4', true],
  ] as const)('merges %s and validates streams and duration', async (_label, video, audio, mode, expectedAudio) => {
    await withLocalizedInput(video, audio, async (input) => {
      const output = outputPath(_label, mode === 'copy-mkv' ? '.mkv' : '.mp4');
      try {
        await expect(mergeVideo({ ...input, output, mode, expectedDuration: 6 }, new AbortController().signal)).resolves.toBe(output);
        const info = await probeVideo(output);
        expect(info.streams.some((stream) => stream.kind === 'video' && !stream.attachedPicture)).toBe(true);
        expect(info.streams.some((stream) => stream.kind === 'audio')).toBe(expectedAudio);
        expect(Math.abs(info.duration - 6)).toBeLessThanOrEqual(Math.max(1, 6 * 0.01));
      } finally {
        await rm(output, { force: true });
      }
    });
  }, 90_000);

  it('probes the main video stream while marking attached pictures separately', async () => {
    const info = await probeVideo(path.join(mediaRoot, 'cover probe', 'attached-cover.mp4'));
    expect(info.streams.some((stream) => stream.kind === 'video' && stream.attachedPicture)).toBe(true);
    expect(info.width).toBe(320);
    expect(info.height).toBe(180);
  });

  it('does not publish output when a downloaded media segment is missing', async () => {
    await withLocalizedInput(path.join(mediaRoot, 'ts playlist', 'video.m3u8'), undefined, async (input, cacheDir, manifest) => {
      const segment = manifest.resources.find((resource) => resource.role === 'segment');
      if (!segment) throw new Error('Fixture has no media segments');
      await rm(resourceCachePath(cacheDir, segment.id));
      const output = outputPath('missing-segment');
      try {
        await expect(mergeVideo({ ...input, output, mode: 'copy-mp4', expectedDuration: 6 }, new AbortController().signal)).rejects.toBeTruthy();
        await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        await rm(output, { force: true });
      }
    });
  });

  it('does not publish output when the child process fails and keeps the downloaded cache', async () => {
    await withLocalizedInput(path.join(mediaRoot, 'ts playlist', 'video.m3u8'), undefined, async (input, cacheDir, manifest) => {
      const output = outputPath('child-failure');
      const prior = process.env.FFMPEG_PATH;
      process.env.FFMPEG_PATH = process.execPath;
      try {
        await expect(mergeVideo({ ...input, output, mode: 'copy-mp4', expectedDuration: 6 }, new AbortController().signal)).rejects.toMatchObject({ code: 'MEDIA_PROCESS_FAILED' });
      } finally {
        if (prior === undefined) delete process.env.FFMPEG_PATH;
        else process.env.FFMPEG_PATH = prior;
      }
      try {
        await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await readdir(cacheDir)).toContain(`${manifest.resources[0]!.id}.bin`);
      } finally {
        await rm(output, { force: true });
      }
    });
  });

  it.each([
    ['absolute HTTP URI', 'https://example.invalid/segment.ts'],
    ['protocol-relative URI', '//cdn.example.invalid/segment.ts'],
    ['Windows UNC path', '\\\\server\\share\\segment.ts'],
  ])('rejects %s before starting FFmpeg', async (label, uri) => {
    const playlist = path.join(mediaRoot, `unsafe ${label}.m3u8`);
    await writeFile(playlist, `#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\n${uri}\n#EXT-X-ENDLIST\n`, 'utf8');
    const output = outputPath(`network-reference-${label}`);
    await expect(mergeVideo({ video: playlist, output, mode: 'copy-mp4', expectedDuration: 6 }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'UNSAFE_INPUT' });
    await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('returns actionable child failures and kills the active child on cancellation', async () => {
    await expect(runMedia(process.execPath, ['-e', 'process.stderr.write("intentional failure");process.exit(7)'], new AbortController().signal))
      .rejects.toMatchObject({ code: 'MEDIA_PROCESS_FAILED', message: expect.stringContaining('intentional failure') });

    const controller = new AbortController();
    const task = runMedia(candidateFfmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=60', '-t', '60', '-f', 'null', '-'], controller.signal);
    setTimeout(() => controller.abort(), 100);
    await expect(task).rejects.toMatchObject({ name: 'AbortError' });
  }, 30_000);

  it('caps FFprobe stdout and keeps only the last 256 KB of stderr', async () => {
    await expect(runMedia(process.execPath, ['-e', 'process.stdout.write(Buffer.alloc(8*1024*1024+1))'], new AbortController().signal))
      .rejects.toMatchObject({ code: 'MEDIA_OUTPUT_TOO_LARGE' });
    const marker = 'END_OF_STDERR_MARKER';
    const result = await runMedia(process.execPath, [
      '-e', `process.stderr.write('BEGIN_OF_STDERR');process.stderr.write(Buffer.alloc(300*1024,65));process.stderr.write(${JSON.stringify(marker)})`,
    ], new AbortController().signal);
    expect(Buffer.byteLength(result.stderr, 'utf8')).toBeLessThanOrEqual(256 * 1024);
    expect(result.stderr.endsWith(marker)).toBe(true);
    expect(result.stderr).not.toContain('BEGIN_OF_STDERR');
  }, 30_000);

  it('does not overwrite an existing target unless replacement is explicit', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'video-helper-publish-'));
    const target = path.join(directory, 'target.mp4');
    const temp = path.join(directory, 'ready.partial.mp4');
    await writeFile(target, 'original');
    await writeFile(temp, 'new');
    await expect(publishOutput(temp, target, false)).rejects.toMatchObject({ code: 'OUTPUT_EXISTS' });
    expect(await readFile(target, 'utf8')).toBe('original');
    try {
      await expect(publishOutput(temp, target, true, {
        rename: async (from: string, to: string) => {
          if (from === temp && to === target) throw new Error('injected final rename failure');
          const { rename } = await import('node:fs/promises');
          await rename(from, to);
        },
      })).rejects.toMatchObject({ code: 'PUBLISH_FAILED' });
      expect(await readFile(target, 'utf8')).toBe('original');
      expect(await readFile(temp, 'utf8')).toBe('new');
      await publishOutput(temp, target, true);
      expect(await readFile(target, 'utf8')).toBe('new');
      expect(await readdir(directory)).toEqual(['target.mp4']);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('uses the native no-replace move when hard links fail, even when inode values are zero', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'video-helper-no-hardlink-'));
    let longDirectory = directory;
    while (longDirectory.length <= 270) longDirectory = path.join(longDirectory, `路径-${'長'.repeat(24)}`);
    await mkdir(toExtendedWindowsPath(longDirectory), { recursive: true });
    const target = toExtendedWindowsPath(path.join(longDirectory, '完成-目標.mp4'));
    const temp = toExtendedWindowsPath(path.join(longDirectory, 'validated-來源.partial.mp4'));
    const payload = Buffer.from('validated output bytes — 測試');
    await writeFile(temp, payload);
    const operations = {
      link: async () => { throw Object.assign(new Error('hard links are unsupported'), { code: 'ENOTSUP' }); },
      lstat: async (filePath: string) => new Proxy(await lstat(filePath), {
        get(stat, property, receiver) {
          return property === 'ino' ? 0 : Reflect.get(stat, property, receiver);
        },
      }),
    };
    try {
      await publishOutput(temp, target, false, operations as never);
      expect(await readFile(target)).toEqual(payload);
      await expect(readFile(temp)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(toExtendedWindowsPath(directory), { recursive: true, force: true });
    }
  });

  it('uses the native helper to move Unicode paths, refuses existing targets, and reports missing sources', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'video-helper-native-move-'));
    const source = path.join(directory, 'validated-來源.partial.mp4');
    const target = path.join(directory, '完成-目標.mp4');
    const signal = new AbortController().signal;
    try {
      await writeFile(source, 'native helper payload — ✓');
      await runMedia(noReplaceHelper, [toExtendedWindowsPath(source), toExtendedWindowsPath(target)], signal);
      expect(await readFile(target, 'utf8')).toBe('native helper payload — ✓');
      await expect(readFile(source)).rejects.toMatchObject({ code: 'ENOENT' });

      await writeFile(source, 'keep source');
      await writeFile(target, 'keep target');
      await expect(runMedia(noReplaceHelper, [toExtendedWindowsPath(source), toExtendedWindowsPath(target)], signal))
        .rejects.toMatchObject({ code: 'MEDIA_PROCESS_FAILED', message: expect.stringContaining('exit code 2') });
      expect(await readFile(source, 'utf8')).toBe('keep source');
      expect(await readFile(target, 'utf8')).toBe('keep target');

      const missingSource = path.join(directory, 'missing-來源.partial.mp4');
      const missingTarget = path.join(directory, 'missing-目標.mp4');
      await expect(runMedia(noReplaceHelper, [toExtendedWindowsPath(missingSource), toExtendedWindowsPath(missingTarget)], signal))
        .rejects.toMatchObject({ code: 'MEDIA_PROCESS_FAILED', message: expect.stringContaining('exit code 3') });
      await expect(readFile(missingTarget)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('normalizes drive and UNC paths to long-path form while preserving existing prefixes', () => {
    expect(toExtendedWindowsPath('D:\\folder\\video.mp4')).toBe('\\\\?\\D:\\folder\\video.mp4');
    expect(toExtendedWindowsPath('\\\\server\\share\\video.mp4')).toBe('\\\\?\\UNC\\server\\share\\video.mp4');
    const prefixed = '\\\\?\\UNC\\server\\share\\folder\\video.mp4';
    expect(toExtendedWindowsPath(prefixed)).toBe(prefixed);
  });

  it('keeps a raced target unchanged when the native no-replace move collides', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'video-helper-publish-race-'));
    const target = path.join(directory, 'destination.mp4');
    const temp = path.join(directory, 'validated.partial.mp4');
    await writeFile(temp, 'validated bytes');
    const winner = 'created by another process';
    const operations = {
      link: async (_source: string, destination: string) => {
        await writeFile(destination, winner);
        throw Object.assign(new Error('hard links are unsupported'), { code: 'EPERM' });
      },
    };
    try {
      await expect(publishOutput(temp, target, false, operations as never)).rejects.toMatchObject({ code: 'OUTPUT_EXISTS' });
      expect(await readFile(target, 'utf8')).toBe(winner);
      expect(await readFile(temp, 'utf8')).toBe('validated bytes');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('aborts before starting native publication and leaves the verified source available', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'video-helper-publish-cancel-'));
    const target = path.join(directory, 'destination.mp4');
    const temp = path.join(directory, 'validated.partial.mp4');
    await writeFile(temp, 'validated bytes');
    const controller = new AbortController();
    controller.abort();
    let linkCalled = false;
    const operations = {
      link: async () => {
        linkCalled = true;
        throw Object.assign(new Error('hard links are unsupported'), { code: 'ENOTSUP' });
      },
    };
    try {
      await expect(publishOutput(temp, target, false, operations as never, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
      expect(linkCalled).toBe(false);
      await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(temp, 'utf8')).toBe('validated bytes');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
