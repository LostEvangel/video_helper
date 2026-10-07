import { open, lstat, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { OutputMode } from '../../shared/contracts.js';
import { parsePlaylist, HlsError } from '../hls/parse.js';
import { probeVideoWithSignal } from './probe.js';
import { MediaError, runMedia } from './process.js';
import { resolveMediaTool } from './tools.js';
import { publishOutput } from './publish.js';

export type MergeVideoInput = {
  video: string;
  audio?: string;
  output: string;
  mode: OutputMode;
  expectedDuration: number;
};

function isWindowsDrivePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value);
}

function assertLocalReference(uri: string): void {
  const reference = uri.trim();
  if (reference.startsWith('//') || reference.startsWith('\\\\') || /^https?:/i.test(reference)) {
    throw new MediaError('UNSAFE_INPUT', 'The localized HLS playlist still contains a network reference; only complete local resources may be merged.');
  }
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(reference)?.[1]?.toLowerCase();
  if (scheme && !isWindowsDrivePath(reference) && !['file', 'data', 'crypto'].includes(scheme)) {
    throw new MediaError('UNSAFE_INPUT', `The localized HLS playlist uses the unsupported ${scheme}: protocol.`);
  }
}

async function readLocalPlaylist(playlistPath: string): Promise<string> {
  let text: string;
  try {
    text = await readFile(playlistPath, 'utf8');
  } catch (error) {
    throw new MediaError('LOCAL_PLAYLIST_UNAVAILABLE', `The localized HLS playlist could not be read: ${playlistPath}.`, { cause: error });
  }

  let parsed;
  try {
    parsed = parsePlaylist(text);
  } catch (error) {
    if (error instanceof HlsError) throw new MediaError(error.code, error.message, { cause: error });
    throw error;
  }
  if (parsed.kind !== 'media') throw new MediaError('INVALID_MEDIA_PLAYLIST', 'A selected local HLS input must be a media playlist, not a master playlist.');
  if (!parsed.hasEndList) throw new MediaError('INCOMPLETE_PLAYLIST', 'The selected HLS playlist has no ENDLIST tag and may still be changing.');

  for (const segment of parsed.segments) assertLocalReference(segment.uri);
  for (const map of parsed.maps) assertLocalReference(map.uri);
  for (const key of parsed.keys) if (key.uri) assertLocalReference(key.uri);
  // Catch URI-bearing extension tags that the parser deliberately preserves verbatim.
  if (/(?:https?:)?\/\/[^\s"',]+/i.test(text)) {
    throw new MediaError('UNSAFE_INPUT', 'The localized HLS playlist still contains an external network address.');
  }
  return text;
}

async function assertTargetDoesNotExist(target: string): Promise<void> {
  try {
    await lstat(target);
    throw new MediaError('OUTPUT_EXISTS', 'The selected output already exists. Choose another name before merging.');
  } catch (error) {
    if (error instanceof MediaError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new MediaError('OUTPUT_UNAVAILABLE', `The selected output path could not be checked: ${target}.`, { cause: error });
    }
  }
}

function mergeArguments(input: MergeVideoInput, tempPath: string): string[] {
  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-protocol_whitelist', 'file,crypto,data',
    '-allowed_extensions', 'ALL', '-allowed_segment_extensions', 'ALL', '-extension_picky', '0',
    '-i', input.video,
  ];
  if (input.audio) args.push('-protocol_whitelist', 'file,crypto,data', '-allowed_extensions', 'ALL', '-allowed_segment_extensions', 'ALL', '-extension_picky', '0', '-i', input.audio);
  args.push('-map', '0:v:0');
  args.push('-map', input.audio ? '1:a:0' : '0:a:0?');

  if (input.mode === 'transcode-mp4') args.push('-c:v', 'libx264', '-c:a', 'aac');
  else args.push('-c', 'copy');

  if (input.mode === 'copy-mp4' || input.mode === 'transcode-mp4') args.push('-movflags', '+faststart', '-f', 'mp4');
  else args.push('-f', 'matroska');
  args.push('-y', tempPath);
  return args;
}

function actionableProcessError(error: unknown, mode: OutputMode): unknown {
  if (!(error instanceof MediaError) || error.code !== 'MEDIA_PROCESS_FAILED') return error;
  if (mode === 'transcode-mp4' && /unknown encoder|encoder .* not found|not found.*encoder/i.test(error.message)) {
    return new MediaError('ENCODER_UNAVAILABLE', 'This FFmpeg build does not include the required H.264 or AAC encoder. The downloaded resources were retained.', { cause: error });
  }
  if (mode === 'copy-mp4') {
    return new MediaError('MEDIA_PROCESS_FAILED', `${error.message} If the source codecs do not fit MP4, retry with copy-MKV or explicitly select H.264/AAC MP4 transcoding. No automatic transcoding was performed.`, { cause: error });
  }
  return error;
}

/** Merges complete localized HLS playlists, verifies the result, then publishes it. */
export async function mergeVideo(input: MergeVideoInput, signal: AbortSignal): Promise<string> {
  if (!Number.isFinite(input.expectedDuration) || input.expectedDuration <= 0) {
    throw new MediaError('INVALID_EXPECTED_DURATION', 'The selected playlist does not contain a usable positive duration.');
  }
  await readLocalPlaylist(input.video);
  if (input.audio) await readLocalPlaylist(input.audio);

  const target = path.resolve(input.output);
  await assertTargetDoesNotExist(target);

  const inputInfo = await probeVideoWithSignal(input.video, signal);
  const expectAudio = input.audio !== undefined || inputInfo.streams.some((stream) => stream.kind === 'audio');
  const extension = input.mode === 'copy-mkv' ? '.mkv' : '.mp4';
  const tempPath = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.partial${extension}`);
  let ownsTemp = false;
  let verifiedTemp = false;

  try {
    try {
      const reservation = await open(tempPath, 'wx');
      await reservation.close();
      ownsTemp = true;
    } catch (error) {
      throw new MediaError('MERGE_TEMP_UNAVAILABLE', 'A temporary output could not be created beside the selected destination.', { cause: error });
    }

    const binary = resolveMediaTool('ffmpeg');
    try {
      await runMedia(binary, mergeArguments(input, tempPath), signal);
    } catch (error) {
      throw actionableProcessError(error, input.mode);
    }

    const outputInfo = await probeVideoWithSignal(tempPath, signal);
    if (!outputInfo.streams.some((stream) => stream.kind === 'video' && !stream.attachedPicture)) {
      throw new MediaError('OUTPUT_MISSING_VIDEO', 'The merged output does not contain a main video stream.');
    }
    if (expectAudio && !outputInfo.streams.some((stream) => stream.kind === 'audio')) {
      throw new MediaError('OUTPUT_MISSING_AUDIO', 'The merged output does not contain the selected audio stream. The downloaded resources were retained.');
    }
    const tolerance = Math.max(1, input.expectedDuration * 0.01);
    if (Math.abs(outputInfo.duration - input.expectedDuration) > tolerance) {
      throw new MediaError('DURATION_MISMATCH', `The merged output duration (${outputInfo.duration.toFixed(3)} s) differs from the playlist duration (${input.expectedDuration.toFixed(3)} s) by more than ${tolerance.toFixed(3)} s. The downloaded resources were retained.`);
    }

    verifiedTemp = true;
    await publishOutput(tempPath, target, false, {}, signal);
    ownsTemp = false;
    return target;
  } catch (error) {
    if (ownsTemp && !verifiedTemp) await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}
