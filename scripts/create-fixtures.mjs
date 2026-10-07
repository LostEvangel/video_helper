import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(process.env.MEDIA_FIXTURE_ROOT ?? path.join(workspace, 'tests', 'generated', 'media-merge'));
const ffmpeg = process.env.FFMPEG_PATH ?? 'ffmpeg';
const maxStderrBytes = 256 * 1024;

function run(args, label, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { ...(cwd === undefined ? {} : { cwd }), shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = Buffer.alloc(0);
    child.stderr.on('data', (chunk) => {
      stderr = Buffer.concat([stderr, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      if (stderr.length > maxStderrBytes) stderr = stderr.subarray(stderr.length - maxStderrBytes);
    });
    child.once('error', (error) => reject(new Error(`${label}: could not start ${ffmpeg}: ${error.message}`, { cause: error })));
    child.once('close', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const tail = stderr.toString('utf8').trim();
      reject(new Error(`${label}: FFmpeg exited ${code ?? `after ${signal}`}.${tail ? `\n${tail}` : ''}`));
    });
  });
}

function sourceVideo(audio = true) {
  const args = ['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24'];
  if (audio) args.push('-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000');
  return args;
}

function commonVideo(audio = true) {
  const args = [...sourceVideo(audio), '-t', '6', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '48', '-keyint_min', '48', '-sc_threshold', '0'];
  if (audio) args.push('-c:a', 'aac', '-b:a', '96k');
  return args;
}

function hlsArgs(directory, { fmp4 = false, audio = true, encrypted = false } = {}) {
  const args = [
    ...commonVideo(audio),
    '-f', 'hls',
    '-hls_time', '2',
    '-hls_playlist_type', 'vod',
    '-hls_flags', 'independent_segments',
    '-hls_segment_filename', path.join(directory, fmp4 ? 'segment-%03d.m4s' : 'segment-%03d.mpegts'),
  ];
  if (fmp4) args.push('-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4');
  if (encrypted) args.push('-hls_key_info_file', path.join(directory, 'key-info.txt'));
  args.push(path.join(directory, 'video.m3u8'));
  return args;
}

async function main() {
  await rm(root, { recursive: true, force: true });
  const mediaRoot = path.join(root, '測試 media');
  const ts = path.join(mediaRoot, 'ts playlist');
  const fmp4 = path.join(mediaRoot, 'fmp4 playlist');
  const split = path.join(mediaRoot, 'independent audio');
  const aes = path.join(mediaRoot, 'aes playlist');
  const silent = path.join(mediaRoot, 'video only');
  const cover = path.join(mediaRoot, 'cover probe');
  for (const directory of [ts, fmp4, path.join(split, 'video'), path.join(split, 'audio'), aes, silent, cover]) {
    await mkdir(directory, { recursive: true });
  }

  const base = path.join(mediaRoot, 'six seconds h264 aac.mp4');
  await run([
    ...commonVideo(true), '-movflags', '+faststart', '-y', base,
  ], 'Generate the six-second H.264/AAC base video');
  await run(hlsArgs(ts), 'Generate MPEG-TS HLS');
  await run(hlsArgs(fmp4, { fmp4: true }), 'Generate fMP4 HLS', fmp4);
  await readFile(path.join(fmp4, 'init.mp4'));

  await run([
    ...commonVideo(false), '-an', '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod',
    '-hls_flags', 'independent_segments', '-hls_segment_filename', path.join(split, 'video', 'segment-%03d.mpegts'),
    path.join(split, 'video', 'video.m3u8'),
  ], 'Generate independent video HLS');
  await run([
    '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000', '-t', '6', '-vn', '-c:a', 'aac', '-b:a', '96k',
    '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_segment_filename', path.join(split, 'audio', 'segment-%03d.aac'),
    path.join(split, 'audio', 'audio.m3u8'),
  ], 'Generate independent audio HLS');

  const key = Buffer.from('0123456789abcdef', 'ascii');
  await writeFile(path.join(aes, 'key.bin'), key);
  await writeFile(path.join(aes, 'key-info.txt'), `key.bin\n${path.join(aes, 'key.bin')}\n`);
  await run(hlsArgs(aes, { encrypted: true }), 'Generate AES-128 HLS');

  await run([
    ...commonVideo(false), '-an', '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod',
    '-hls_segment_filename', path.join(silent, 'segment-%03d.mpegts'), path.join(silent, 'video.m3u8'),
  ], 'Generate video-only HLS');

  const coverImage = path.join(cover, 'cover.jpg');
  await run(['-f', 'lavfi', '-i', 'color=c=red:s=64x64', '-frames:v', '1', '-y', coverImage], 'Generate attached-picture probe image');
  await run([
    '-i', base, '-i', coverImage, '-map', '0:v:0', '-map', '0:a:0?', '-map', '1:v:0', '-c', 'copy',
    '-disposition:v:1', 'attached_pic', '-y', path.join(cover, 'attached-cover.mp4'),
  ], 'Generate MP4 with attached picture');

  process.stdout.write(`${JSON.stringify({ root, ffmpeg, fixtures: ['ts', 'fmp4', 'independent-audio', 'aes-128', 'video-only', 'attached-picture'] })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
