import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { exportVideoFrame, saveVideoCover } from '../../src/main/media/cover.js';
import { expectedDisplayAspectRatio, extractFrame, extractFrameFromProbe } from '../../src/main/media/frame.js';
import * as probeApi from '../../src/main/media/probe.js';
import { probeMediaWithSignal } from '../../src/main/media/probe.js';
import { runMedia } from '../../src/main/media/process.js';
import { readMp4ChapterReferences } from '../../src/main/media/mp4-chapters.js';

const workspace = process.cwd();
const bundledBin = path.join(workspace, '.tools', 'ffmpeg-essentials', 'ffmpeg-8.1.2-essentials_build', 'bin');
const candidateFfmpeg = path.join(bundledBin, 'ffmpeg.exe');
const candidateFfprobe = path.join(bundledBin, 'ffprobe.exe');
const priorFfmpeg = process.env.FFMPEG_PATH;
const priorFfprobe = process.env.FFPROBE_PATH;
let root = '';
let mediaDirectory = '';
let sourcePath = '';
let attachedPath = '';
let texturedPath = '';
let texturedAttachedPath = '';
let mkvPath = '';
let audioOnlyPath = '';
let anamorphicPath = '';
let multiVideoPath = '';
let chapterSourcePath = '';
let longSeekPath = '';
let nonzeroStartTsPath = '';
let nonzeroStartMp4Path = '';
let audioLeadTsPath = '';
const mediaSignal = new AbortController().signal;

async function runFfmpeg(args: string[]): Promise<void> {
  await runMedia(candidateFfmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args], mediaSignal);
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  hash.update(await readFile(filePath));
  return hash.digest('hex');
}

async function streamCopiedEmbeddedCover(filePath: string): Promise<Buffer> {
  const probe = await probeMediaWithSignal(filePath, mediaSignal);
  const covers = probe.streams.filter((stream) => stream.disposition.attached_pic === 1);
  expect(covers).toHaveLength(1);
  expect(covers[0]?.codecName).toBe('mjpeg');
  const { stdout } = await runMedia(candidateFfmpeg, [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-protocol_whitelist', 'file,crypto,data', '-i', filePath,
    '-map', `0:${covers[0]!.index}`, '-frames:v', '1', '-c:v', 'copy', '-f', 'image2pipe', 'pipe:1',
  ], mediaSignal);
  return stdout;
}

async function dominantColor(jpeg: Buffer, label: string): Promise<string> {
  const framePath = path.join(mediaDirectory, `${label}.jpg`);
  await writeFile(framePath, jpeg, { flag: 'wx' });
  const { stdout } = await runMedia(candidateFfmpeg, [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-i', framePath,
    '-vf', 'scale=1:1:flags=area', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
  ], mediaSignal);
  expect(stdout.length).toBeGreaterThanOrEqual(3);
  const [red, green, blue] = stdout;
  if (red! > green! * 1.4 && red! > blue! * 1.4) return 'red';
  if (green! > red! * 1.4 && green! > blue! * 1.4) return 'green';
  if (blue! > red! * 1.4 && blue! > green! * 1.4) return 'blue';
  return 'mixed';
}

async function firstOutputPtsRelativeToVideo(
  probe: Awaited<ReturnType<typeof probeMediaWithSignal>>,
  requestedTime: number,
): Promise<number> {
  const video = probe.mainVideo;
  if (!video) throw new Error('The fixture has no main video stream.');
  const formatStartTime = probe.startTime ?? video.startTime ?? 0;
  const videoStartTime = video.startTime ?? formatStartTime;
  const seekOffset = requestedTime + videoStartTime - formatStartTime;
  const { stdout } = await runMedia(candidateFfmpeg, [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-copyts', '-seek_timestamp', '1',
    '-ss', seekOffset.toFixed(9), '-i', probe.path,
    '-map', `0:${video.index}`,
    '-vf', "scale=w='trunc(iw*sar/2)*2':h=ih:flags=lanczos,setsar=1,showinfo",
    '-frames:v', '1', '-f', 'framecrc', 'pipe:1',
  ], mediaSignal);
  const output = stdout.toString('utf8');
  const timeBase = /^#tb\s+\d+:\s+(\d+)\/(\d+)$/m.exec(output);
  const frame = /^\s*0,\s*(-?\d+),/m.exec(output);
  if (!timeBase || !frame) throw new Error(`FFmpeg did not report a frame PTS: ${output}`);
  const numerator = Number(timeBase[1]);
  const denominator = Number(timeBase[2]);
  const pts = Number(frame[1]);
  return pts * numerator / denominator - videoStartTime;
}

function streamSignature(stream: { codec_type?: string; codec_name?: string; profile?: string; width?: number; height?: number; sample_rate?: string; channels?: number; channel_layout?: string }): string {
  return JSON.stringify([
    stream.codec_type, stream.codec_name, stream.profile, stream.width, stream.height,
    stream.sample_rate, stream.channels, stream.channel_layout,
  ]);
}

beforeAll(async () => {
  process.env.FFMPEG_PATH = candidateFfmpeg;
  process.env.FFPROBE_PATH = candidateFfprobe;
  const ffmpegVersion = await runMedia(candidateFfmpeg, ['-version'], mediaSignal);
  expect(ffmpegVersion.stdout.toString('utf8')).toContain('8.1.2-essentials_build');
  root = await mkdtemp(path.join(os.tmpdir(), 'video helper 封面整合-'));
  mediaDirectory = path.join(root, '測試 media 與空格');
  await mkdir(mediaDirectory);
  sourcePath = path.join(mediaDirectory, '三色 測試片.mp4');
  attachedPath = path.join(mediaDirectory, '已有舊封面.mp4');
  texturedPath = path.join(mediaDirectory, '紋理多色測試片.mp4');
  texturedAttachedPath = path.join(mediaDirectory, '已有舊封面的紋理影片.mp4');
  mkvPath = path.join(mediaDirectory, '預覽限定.mkv');
  audioOnlyPath = path.join(mediaDirectory, '沒有影像.mp4');
  anamorphicPath = path.join(mediaDirectory, '非方形像素.mp4');
  multiVideoPath = path.join(mediaDirectory, '雙視訊軌.mp4');
  chapterSourcePath = path.join(mediaDirectory, '含 MP4 章節參照.mp4');
  longSeekPath = path.join(mediaDirectory, '取消解碼測試.mp4');
  nonzeroStartTsPath = path.join(mediaDirectory, '非零時間戳.ts');
  nonzeroStartMp4Path = path.join(mediaDirectory, '非零時間戳.mp4');
  audioLeadTsPath = path.join(mediaDirectory, '視訊起點晚於格式.ts');
  const subtitlePath = path.join(mediaDirectory, '字幕 來源.srt');
  const oldCoverPath = path.join(mediaDirectory, '舊封面.jpg');
  const chapterMetadataPath = path.join(mediaDirectory, '章節.ffmeta');
  await writeFile(subtitlePath, '1\n00:00:00,000 --> 00:00:05,800\nmetadata and subtitle survive\n', 'utf8');
  await writeFile(chapterMetadataPath, [
    ';FFMETADATA1',
    'title=Chapter carrier fixture',
    '[CHAPTER]',
    'TIMEBASE=1/1000',
    'START=0',
    'END=1000',
    'title=Opening fixture',
    '[CHAPTER]',
    'TIMEBASE=1/1000',
    'START=1000',
    'END=2000',
    'title=Ending fixture',
    '',
  ].join('\n'), 'utf8');

  await runFfmpeg([
    '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=10:d=2',
    '-f', 'lavfi', '-i', 'color=c=green:s=320x180:r=10:d=2',
    '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=10:d=2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=6',
    '-f', 'srt', '-i', subtitlePath,
    '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0,setpts=PTS-STARTPTS[v]',
    '-map', '[v]', '-map', '3:a:0', '-map', '4:s:0', '-t', '6',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '10', '-c:a', 'aac', '-c:s', 'mov_text',
    '-metadata', 'title=封面整合測試', '-metadata', 'comment=保持原始 metadata', '-movflags', '+faststart', sourcePath,
  ]);
  await runFfmpeg([
    '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=10:d=1',
    '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=10:d=1',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=2',
    '-f', 'ffmetadata', '-i', chapterMetadataPath,
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0,setpts=PTS-STARTPTS[v]',
    '-map', '[v]', '-map', '2:a:0', '-map_metadata', '3', '-map_chapters', '3',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '10', '-c:a', 'aac', '-t', '2', '-movflags', '+faststart', chapterSourcePath,
  ]);
  await runFfmpeg(['-f', 'lavfi', '-i', 'color=c=yellow:s=320x180:d=1', '-frames:v', '1', oldCoverPath]);
  await runFfmpeg([
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=10:duration=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-t', '2', '-metadata', 'title=紋理封面位元組測試', '-movflags', '+faststart', texturedPath,
  ]);
  await runFfmpeg([
    '-i', texturedPath, '-i', oldCoverPath,
    '-map', '0', '-map', '1:v:0', '-c', 'copy', '-c:v:1', 'mjpeg', '-disposition:v:1', 'attached_pic',
    '-movflags', '+faststart', texturedAttachedPath,
  ]);
  await runFfmpeg([
    '-i', sourcePath, '-i', oldCoverPath,
    '-map', '0', '-map', '1:v:0', '-c', 'copy', '-c:v:1', 'mjpeg', '-disposition:v:1', 'attached_pic',
    '-movflags', '+faststart', attachedPath,
  ]);
  await runFfmpeg(['-i', sourcePath, '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', mkvPath]);
  await runFfmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'aac', '-t', '1', audioOnlyPath]);
  await runFfmpeg([
    '-f', 'lavfi', '-i', 'color=c=purple:s=320x180:r=10:d=1', '-vf', 'setsar=4/3',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-metadata:s:v:0', 'rotate=0', anamorphicPath,
  ]);
  await runFfmpeg([
    '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=10:d=2',
    '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=10:d=2',
    '-map', '0:v:0', '-map', '1:v:0', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-t', '2', multiVideoPath,
  ]);
  await runFfmpeg([
    '-f', 'lavfi', '-i', 'color=c=blue:s=1280x720:r=30:d=60',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '1800', '-keyint_min', '1800', '-sc_threshold', '0',
    '-pix_fmt', 'yuv420p', '-t', '60', longSeekPath,
  ]);
  await runFfmpeg([
    '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=10:d=1',
    '-c:v', 'libx264', '-tune', 'zerolatency', '-bf', '0', '-g', '10', '-keyint_min', '10', '-sc_threshold', '0',
    '-pix_fmt', 'yuv420p', '-t', '1', '-output_ts_offset', '5', '-f', 'mpegts', nonzeroStartTsPath,
  ]);
  await runFfmpeg([
    '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=10:d=1',
    '-c:v', 'libx264', '-tune', 'zerolatency', '-bf', '0', '-g', '10', '-keyint_min', '10', '-sc_threshold', '0',
    '-pix_fmt', 'yuv420p', '-t', '1', '-output_ts_offset', '6.4', '-movflags', '+faststart', nonzeroStartMp4Path,
  ]);
  await runFfmpeg([
    '-itsoffset', '0.4', '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=10:d=1',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=1.4',
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-tune', 'zerolatency', '-bf', '0', '-g', '10', '-keyint_min', '10',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-t', '1.4', '-output_ts_offset', '5', '-f', 'mpegts', audioLeadTsPath,
  ]);
});

afterAll(async () => {
  if (priorFfmpeg === undefined) delete process.env.FFMPEG_PATH;
  else process.env.FFMPEG_PATH = priorFfmpeg;
  if (priorFfprobe === undefined) delete process.env.FFPROBE_PATH;
  else process.env.FFPROBE_PATH = priorFfprobe;
  if (root) await rm(root, { recursive: true, force: true });
});

describe('cover frame extraction and publication', () => {
  it('extracts requested red, green, and blue time segments from the main video stream', async () => {
    for (const [time, color] of [[0.5, 'red'], [2.5, 'green'], [4.5, 'blue']] as const) {
      const result = await extractFrame(sourcePath, time, mediaSignal);
      expect(result.jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
      expect(await dominantColor(result.jpeg, `preview-${time}`)).toBe(color);
      expect(Math.abs(result.time - time)).toBeLessThanOrEqual(0.101);
    }
  }, 30_000);

  it('rejects non-finite, negative, and beyond-duration times, and returns a decodable final frame at the end boundary', async () => {
    for (const time of [Number.NaN, Number.POSITIVE_INFINITY, -0.01, 6.01]) {
      await expect(extractFrame(sourcePath, time, mediaSignal)).rejects.toMatchObject({ code: 'INVALID_TIME' });
    }
    const finalFrame = await extractFrame(sourcePath, 6, mediaSignal);
    expect(finalFrame.jpeg.length).toBeGreaterThan(4);
    expect(finalFrame.jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(finalFrame.jpeg.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]));
    expect(finalFrame.time).toBeLessThan(6);
    expect(await dominantColor(finalFrame.jpeg, 'preview-end')).toBe('blue');
  }, 30_000);

  it('seeks and reports frame time relative to a nonzero MPEG-TS start timestamp', async () => {
    const probe = await probeMediaWithSignal(nonzeroStartTsPath, mediaSignal);
    expect(probe.startTime).toBeGreaterThan(0);
    expect(probe.mainVideo?.startTime).toBeCloseTo(probe.startTime!, 3);
    const duration = probe.duration;
    const frame = await extractFrame(nonzeroStartTsPath, 0.5, mediaSignal);
    expect(frame.time).toBeCloseTo(await firstOutputPtsRelativeToVideo(probe, 0.5), 6);
    expect(frame.time).toBeCloseTo(0.5, 3);
    expect(await dominantColor(frame.jpeg, 'nonzero-ts-middle')).toBe('red');

    const finalFrame = await extractFrame(nonzeroStartTsPath, duration, mediaSignal);
    expect(finalFrame.time).toBeCloseTo(await firstOutputPtsRelativeToVideo(probe, 0.9), 6);
    expect(finalFrame.time).toBeCloseTo(0.9, 3);
    expect(finalFrame.time).toBeLessThan(duration);
    expect(finalFrame.time).toBeGreaterThanOrEqual(duration - 0.201);
    expect(await dominantColor(finalFrame.jpeg, 'nonzero-ts-end')).toBe('red');
  }, 30_000);

  it('normalizes nonzero MP4 starts and seeks relative to video when format timestamps start earlier', async () => {
    const mp4Probe = await probeMediaWithSignal(nonzeroStartMp4Path, mediaSignal);
    expect(mp4Probe.startTime).toBeCloseTo(6.4, 3);
    expect(mp4Probe.mainVideo?.startTime).toBeCloseTo(6.4, 3);
    const mp4Frame = await extractFrame(nonzeroStartMp4Path, 0.5, mediaSignal);
    expect(mp4Frame.time).toBeCloseTo(await firstOutputPtsRelativeToVideo(mp4Probe, 0.5), 6);
    expect(mp4Frame.time).toBeCloseTo(0.5, 3);
    expect(await dominantColor(mp4Frame.jpeg, 'nonzero-mp4-middle')).toBe('red');
    const mp4CoverOutput = path.join(mediaDirectory, '非零時間戳加封面.mp4');
    await saveVideoCover({ path: nonzeroStartMp4Path, time: 0.5, output: mp4CoverOutput, replace: false }, mediaSignal);
    const publishedMp4Cover = await probeMediaWithSignal(mp4CoverOutput, mediaSignal);
    expect(publishedMp4Cover.streams.filter((stream) => stream.disposition.attached_pic)).toHaveLength(1);

    const offsetProbe = await probeMediaWithSignal(audioLeadTsPath, mediaSignal);
    expect(offsetProbe.startTime).toBeDefined();
    expect(offsetProbe.mainVideo?.startTime).toBeDefined();
    expect(offsetProbe.mainVideo!.startTime!).toBeGreaterThan(offsetProbe.startTime! + 0.3);
    const offsetFrame = await extractFrame(audioLeadTsPath, 0.5, mediaSignal);
    expect(offsetFrame.time).toBeCloseTo(await firstOutputPtsRelativeToVideo(offsetProbe, 0.5), 6);
    expect(offsetFrame.time).toBeCloseTo(0.5, 3);
    expect(await dominantColor(offsetFrame.jpeg, 'audio-lead-ts-middle')).toBe('red');
  }, 30_000);

  it('ignores an existing attached picture when previewing and replaces it with exactly one selected cover', async () => {
    const oldProbe = await probeMediaWithSignal(attachedPath, mediaSignal);
    expect(oldProbe.streams.filter((stream) => stream.disposition.attached_pic).length).toBe(1);
    const preview = await extractFrame(attachedPath, 2.5, mediaSignal);
    expect(await dominantColor(preview.jpeg, 'preview-excludes-old-cover')).toBe('green');

    const sourceHash = await hashFile(attachedPath);
    const output = path.join(mediaDirectory, '新的 藍色封面.mp4');
    const result = await saveVideoCover({ path: attachedPath, time: 4.5, output, replace: false }, mediaSignal);
    expect(result).toEqual({ output, embedded: true, nativeDisplay: 'unverified' });
    expect(await hashFile(attachedPath)).toBe(sourceHash);
    const source = await probeMediaWithSignal(attachedPath, mediaSignal);
    const written = await probeMediaWithSignal(output, mediaSignal);
    const covers = written.streams.filter((stream) => stream.disposition.attached_pic);
    expect(covers).toHaveLength(1);
    expect(covers[0]?.codecName).toBe('mjpeg');
    expect([covers[0]?.width, covers[0]?.height]).toEqual([source.mainVideo?.width, source.mainVideo?.height]);
    expect(await dominantColor((await extractFrame(output, 4.5, mediaSignal)).jpeg, 'written-main-video')).toBe('blue');
    const sourceStreams = source.streams.filter((stream) => !stream.disposition.attached_pic);
    const outputStreams = written.streams.filter((stream) => !stream.disposition.attached_pic);
    expect(outputStreams.map(streamSignature)).toEqual(sourceStreams.map(streamSignature));
    expect(written.streams.filter((stream) => stream.codecType === 'subtitle' && !stream.disposition.attached_pic)).toHaveLength(1);
    expect(written.tags?.title).toBe(source.tags?.title);
    expect(written.tags?.comment).toBe(source.tags?.comment);
    expect(Math.abs(written.duration - source.duration)).toBeLessThanOrEqual(0.101);
  }, 60_000);

  it('preserves the exact textured JPEG bytes on save and existing-cover replacement', async () => {
    const sourceHash = await hashFile(texturedPath);
    const output = path.join(mediaDirectory, '紋理封面 另存.mp4');
    const expected = (await extractFrame(texturedPath, 0.7, mediaSignal)).jpeg;
    expect(await dominantColor(expected, 'textured-cover-expected')).toBe('mixed');

    await saveVideoCover({ path: texturedPath, time: 0.7, output, replace: false }, mediaSignal);
    expect(await hashFile(texturedPath)).toBe(sourceHash);
    expect(await streamCopiedEmbeddedCover(output)).toEqual(expected);

    const previousOutputHash = await hashFile(texturedAttachedPath);
    const replacementExpected = (await extractFrame(texturedAttachedPath, 1.3, mediaSignal)).jpeg;
    await saveVideoCover({ path: texturedAttachedPath, time: 1.3, output: texturedAttachedPath, replace: true }, mediaSignal);
    expect(await hashFile(texturedAttachedPath)).not.toBe(previousOutputHash);
    expect(await streamCopiedEmbeddedCover(texturedAttachedPath)).toEqual(replacementExpected);
  }, 60_000);

  it('reconstructs only the MP4 chapter carrier and preserves its chapters, other tracks, metadata, and exact selected JPEG', async () => {
    const source = await probeMediaWithSignal(chapterSourcePath, mediaSignal);
    const sourceCarrier = source.streams.filter((stream) => stream.codecType === 'data');
    expect(sourceCarrier).toHaveLength(1);
    expect(sourceCarrier[0]).toMatchObject({ codecName: 'bin_data', codecTagString: 'text', id: '0x3' });
    expect(sourceCarrier[0]?.tags).toMatchObject({ language: 'eng', handler_name: 'SubtitleHandler' });
    expect((await readMp4ChapterReferences(chapterSourcePath, mediaSignal)).chapterTrackIds).toEqual([3]);
    expect(source.chapters.map((chapter) => chapter.tags?.title)).toEqual(['Opening fixture', 'Ending fixture']);

    const sourceHash = await hashFile(chapterSourcePath);
    const expectedJpeg = (await extractFrame(chapterSourcePath, 1.5, mediaSignal)).jpeg;
    const output = path.join(mediaDirectory, '章節影片的新封面.mp4');
    await saveVideoCover({ path: chapterSourcePath, time: 1.5, output, replace: false }, mediaSignal);
    expect(await hashFile(chapterSourcePath)).toBe(sourceHash);

    const written = await probeMediaWithSignal(output, mediaSignal);
    const writtenCarrier = written.streams.filter((stream) => stream.codecType === 'data' && !stream.disposition.attached_pic);
    expect(writtenCarrier).toHaveLength(1);
    expect(writtenCarrier[0]).toMatchObject({ codecName: 'bin_data', codecTagString: 'text' });
    expect(writtenCarrier[0]?.tags).toMatchObject({ language: 'eng', handler_name: 'SubtitleHandler' });
    expect(written.chapters.map((chapter) => chapter.tags?.title)).toEqual(['Opening fixture', 'Ending fixture']);
    expect(written.chapters).toHaveLength(source.chapters.length);
    for (const [index, original] of source.chapters.entries()) {
      const actual = written.chapters[index]!;
      expect(actual.startTime).toBeCloseTo(original.startTime!, 3);
      expect(actual.endTime).toBeCloseTo(original.endTime!, 3);
    }
    expect(written.streams.filter((stream) => stream.disposition.attached_pic)).toHaveLength(1);
    expect(written.streams.filter((stream) => !stream.disposition.attached_pic && stream.codecType !== 'data').map(streamSignature))
      .toEqual(source.streams.filter((stream) => !stream.disposition.attached_pic && stream.codecType !== 'data').map(streamSignature));
    expect(written.tags?.title).toBe(source.tags?.title);
    expect(await streamCopiedEmbeddedCover(output)).toEqual(expectedJpeg);

    const attachedHash = await hashFile(output);
    const replacementJpeg = (await extractFrame(output, 0.5, mediaSignal)).jpeg;
    await saveVideoCover({ path: output, time: 0.5, output, replace: true }, mediaSignal);
    expect(await hashFile(output)).not.toBe(attachedHash);
    const replaced = await probeMediaWithSignal(output, mediaSignal);
    expect(replaced.streams.filter((stream) => stream.codecType === 'data' && !stream.disposition.attached_pic)).toHaveLength(1);
    expect(replaced.chapters.map((chapter) => chapter.tags?.title)).toEqual(['Opening fixture', 'Ending fixture']);
    expect(replaced.streams.filter((stream) => stream.disposition.attached_pic)).toHaveLength(1);
    expect(await streamCopiedEmbeddedCover(output)).toEqual(replacementJpeg);
  }, 60_000);

  it('supports in-place replacement with rollback on a failed publish, and refuses same-name output without replace', async () => {
    const before = await readFile(sourcePath);
    await expect(saveVideoCover({ path: sourcePath, time: 0.5, output: sourcePath, replace: false }, mediaSignal))
      .rejects.toMatchObject({ code: 'OUTPUT_EXISTS' });
    expect(await readFile(sourcePath)).toEqual(before);

    const { rename } = await import('node:fs/promises');
    let failFinalMove = true;
    const operations = {
      rename: async (from: string, to: string) => {
        if (failFinalMove && path.resolve(to) === path.resolve(sourcePath) && path.resolve(from) !== path.resolve(sourcePath)) {
          failFinalMove = false;
          throw Object.assign(new Error('injected final publication failure'), { code: 'EIO' });
        }
        await rename(from, to);
      },
    };
    await expect(saveVideoCover({ path: sourcePath, time: 0.5, output: sourcePath, replace: true }, mediaSignal, operations))
      .rejects.toMatchObject({ code: 'PUBLISH_FAILED' });
    expect(await readFile(sourcePath)).toEqual(before);
    expect((await readdir(mediaDirectory)).some((name) => name.endsWith('.backup'))).toBe(false);
  }, 60_000);

  it('replaces an existing embedded picture, exports a safe standalone JPG, and preserves Unicode paths', async () => {
    const initial = await saveVideoCover({
      path: attachedPath, time: 0.5, output: attachedPath, replace: true,
    }, mediaSignal);
    expect(initial.embedded).toBe(true);
    const replacedProbe = await probeMediaWithSignal(attachedPath, mediaSignal);
    expect(replacedProbe.streams.filter((stream) => stream.disposition.attached_pic)).toHaveLength(1);
    expect(await dominantColor((await extractFrame(attachedPath, 0.5, mediaSignal)).jpeg, 'replacement-main-video')).toBe('red');

    const jpgPath = path.join(mediaDirectory, '匯出的 紅色畫面.jpg');
    await exportVideoFrame({ path: attachedPath, time: 0.5, output: jpgPath }, mediaSignal);
    const jpg = await readFile(jpgPath);
    expect(jpg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(await dominantColor(jpg, 'exported-jpg')).toBe('red');
    await expect(exportVideoFrame({ path: attachedPath, time: 0.5, output: jpgPath }, mediaSignal))
      .rejects.toMatchObject({ code: 'OUTPUT_EXISTS' });
    expect(await readFile(jpgPath)).toEqual(jpg);
  }, 60_000);

  it('allows MKV preview and JPG export while refusing MP4 cover embedding, and reports files without video', async () => {
    const preview = await extractFrame(mkvPath, 2.5, mediaSignal);
    expect(await dominantColor(preview.jpeg, 'mkv-preview')).toBe('green');
    const jpgPath = path.join(mediaDirectory, 'mkv-export.jpg');
    await exportVideoFrame({ path: mkvPath, time: 2.5, output: jpgPath }, mediaSignal);
    expect(await readFile(jpgPath)).toBeTruthy();
    await expect(saveVideoCover({
      path: mkvPath, time: 2.5, output: path.join(mediaDirectory, 'invalid-mkv-cover.mp4'), replace: false,
    }, mediaSignal)).rejects.toMatchObject({ code: 'COVER_REQUIRES_MP4' });
    await expect(extractFrame(audioOnlyPath, 0.5, mediaSignal)).rejects.toMatchObject({ code: 'NO_VIDEO_STREAM' });
  }, 60_000);

  it('keeps a non-square-pixel source at its displayed proportions in the extracted JPEG', async () => {
    const source = await probeMediaWithSignal(anamorphicPath, mediaSignal);
    expect(source.mainVideo?.sampleAspectRatio).toBe('4:3');
    const frame = await extractFrame(anamorphicPath, 0.5, mediaSignal);
    const jpegPath = path.join(mediaDirectory, '非方形像素輸出.jpg');
    await writeFile(jpegPath, frame.jpeg, { flag: 'wx' });
    const jpeg = await probeMediaWithSignal(jpegPath, mediaSignal);
    const sourceAspect = expectedDisplayAspectRatio(source.mainVideo!);
    const jpegAspect = jpeg.mainVideo!.width! / jpeg.mainVideo!.height!;
    expect(Math.abs(jpegAspect - sourceAspect) / sourceAspect, JSON.stringify({ source: source.mainVideo, jpeg: jpeg.mainVideo, sourceAspect, jpegAspect })).toBeLessThanOrEqual(0.01);
  }, 30_000);

  it('preserves every non-attached video stream when the MP4 has more than one video track', async () => {
    const source = await probeMediaWithSignal(multiVideoPath, mediaSignal);
    expect(source.streams.filter((stream) => stream.codecType === 'video' && !stream.disposition.attached_pic)).toHaveLength(2);
    const output = path.join(mediaDirectory, '雙視訊軌加封面.mp4');
    await saveVideoCover({ path: multiVideoPath, time: 0.5, output, replace: false }, mediaSignal);
    const result = await probeMediaWithSignal(output, mediaSignal);
    expect(result.streams.filter((stream) => stream.codecType === 'video' && !stream.disposition.attached_pic).map(streamSignature))
      .toEqual(source.streams.filter((stream) => stream.codecType === 'video' && !stream.disposition.attached_pic).map(streamSignature));
    expect(result.streams.filter((stream) => stream.disposition.attached_pic)).toHaveLength(1);
  }, 60_000);

  it('explicitly refuses a non-cover data stream rather than silently dropping it', async () => {
    const source = await probeMediaWithSignal(sourcePath, mediaSignal);
    const unchanged = await hashFile(sourcePath);
    const fakeDataTrack = {
      index: Math.max(...source.streams.map((stream) => stream.index)) + 1,
      codecType: 'data',
      codecName: 'bin_data',
      disposition: { attached_pic: 0 },
      sideData: [],
    };
    const spy = vi.spyOn(probeApi, 'probeMediaWithSignal').mockResolvedValueOnce({
      ...source,
      streams: [...source.streams, fakeDataTrack],
    });
    const output = path.join(mediaDirectory, '不支援的資料流.mp4');
    try {
      await expect(saveVideoCover({ path: sourcePath, time: 0.5, output, replace: false }, mediaSignal))
        .rejects.toMatchObject({ code: 'UNSUPPORTED_STREAM' });
      expect(await hashFile(sourcePath)).toBe(unchanged);
      await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      spy.mockRestore();
    }
  }, 30_000);

  it('refuses chapter-like data unless its referenced track ID and carrier metadata match exactly', async () => {
    const source = await probeMediaWithSignal(chapterSourcePath, mediaSignal);
    const carrier = source.streams.find((stream) => stream.codecType === 'data');
    if (!carrier) throw new Error('The chapter fixture has no generated MP4 chapter carrier.');
    const sourceHash = await hashFile(chapterSourcePath);
    const unreferencedData = {
      index: Math.max(...source.streams.map((stream) => stream.index)) + 1,
      id: '0x99',
      codecType: 'data',
      codecName: 'bin_data',
      disposition: { attached_pic: 0 },
      sideData: [],
    };
    const unreferencedText = { ...unreferencedData, codecTagString: 'text' };
    const { codecTagString: _codecTagString, ...carrierWithoutTag } = carrier;
    const cases: typeof source.streams[] = [
      [...source.streams, unreferencedData],
      [...source.streams, unreferencedText],
      source.streams.map((stream) => stream.index === carrier.index ? carrierWithoutTag : stream),
    ];

    for (const [index, streams] of cases.entries()) {
      const spy = vi.spyOn(probeApi, 'probeMediaWithSignal').mockResolvedValueOnce({ ...source, streams });
      const output = path.join(mediaDirectory, `不支援的章節資料流-${index}.mp4`);
      try {
        await expect(saveVideoCover({ path: chapterSourcePath, time: 0.5, output, replace: false }, mediaSignal))
          .rejects.toMatchObject({ code: 'UNSUPPORTED_STREAM' });
        expect(await hashFile(chapterSourcePath)).toBe(sourceHash);
        await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        spy.mockRestore();
      }
    }
  }, 30_000);

  it('cancels extraction and enforces the per-frame 32 MB stdout ceiling', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(extractFrame(sourcePath, 0.5, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });

    const longProbe = await probeMediaWithSignal(longSeekPath, mediaSignal);
    const activeController = new AbortController();
    const extraction = extractFrameFromProbe(longSeekPath, 59, longProbe, activeController.signal);
    setTimeout(() => activeController.abort(), 25);
    await expect(extraction).rejects.toMatchObject({ name: 'AbortError' });

    const frameLimit = 32 * 1024 * 1024;
    await expect(runMedia(process.execPath, ['-e', `process.stdout.write(Buffer.alloc(${frameLimit + 1}))`], mediaSignal, {
      maxStdoutBytes: frameLimit,
      overflowCode: 'FRAME_TOO_LARGE',
      overflowMessage: 'The decoded frame exceeds the 32 MB JPEG limit.',
    })).rejects.toMatchObject({ code: 'FRAME_TOO_LARGE' });
  }, 30_000);
});
