import { MediaError, MAX_FRAME_STDOUT_BYTES, runMedia } from './process.js';
import { resolveMediaTool } from './tools.js';
import { probeMediaWithSignal, type MediaProbeInfo, type MediaProbeStream } from './probe.js';

const DEFAULT_FRAME_INTERVAL = 1 / 30;

function rational(value: string | undefined): number | undefined {
  if (!value || value === 'N/A') return undefined;
  const match = /^\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))(?:[/:]([+-]?(?:\d+(?:\.\d*)?|\.\d+)))?\s*$/.exec(value);
  if (!match) return undefined;
  const numerator = Number(match[1]);
  const denominator = match[2] === undefined ? 1 : Number(match[2]);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return undefined;
  const result = numerator / denominator;
  return Number.isFinite(result) ? result : undefined;
}

export function frameInterval(stream: MediaProbeStream): number {
  const rate = rational(stream.averageFrameRate) ?? rational(stream.realFrameRate);
  return rate !== undefined && rate > 0 ? 1 / rate : DEFAULT_FRAME_INTERVAL;
}

export function expectedDisplayAspectRatio(stream: MediaProbeStream): number {
  const width = stream.width;
  const height = stream.height;
  if (!width || !height) throw new MediaError('INVALID_MEDIA_INFO', 'FFprobe did not report the main video dimensions.');
  const sampleAspectRatio = rational(stream.sampleAspectRatio) ?? 1;
  let aspect = width * sampleAspectRatio / height;
  const rotation = stream.sideData?.find((item) => item.type === 'Display Matrix' && item.rotation !== undefined)?.rotation ?? 0;
  if (Math.abs(Math.round(rotation / 90) % 2) === 1) aspect = 1 / aspect;
  return aspect;
}

function assertValidTime(time: number, duration: number): void {
  if (!Number.isFinite(time) || time < 0 || time > duration) {
    throw new MediaError('INVALID_TIME', `Choose a finite time from 0 through ${duration.toFixed(3)} seconds.`);
  }
}

function showInfoTime(stderr: string): number | undefined {
  const values = [...stderr.matchAll(/\bpts_time:([+-]?(?:\d+\.?\d*|\.\d+))/g)]
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value));
  // FFmpeg may feed one extra frame into the filter before the output-frame limit
  // stops encoding. The first timestamp is the frame that was written to stdout.
  return values[0];
}

function isJpeg(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8
    && buffer[buffer.length - 2] === 0xff && buffer[buffer.length - 1] === 0xd9;
}

function parseFrameFilter(): string {
  // Square the pixels while preserving the frame's displayed proportions, then log the decoded PTS.
  // FFmpeg applies any container display rotation before this output filter.
  return "scale=w='trunc(iw*sar/2)*2':h=ih:flags=lanczos,setsar=1,showinfo";
}

async function extractAtTime(
  path: string,
  mainVideo: MediaProbeStream,
  seekTime: number,
  videoStartTime: number,
  signal: AbortSignal,
): Promise<{ jpeg: Buffer; time: number } | undefined> {
  const binary = resolveMediaTool('ffmpeg');
  let stdout: Buffer;
  let stderr: string;
  try {
    ({ stdout, stderr } = await runMedia(binary, [
      '-hide_banner', '-loglevel', 'info', '-nostdin', '-copyts', '-seek_timestamp', '1',
      '-ss', seekTime.toFixed(9), '-protocol_whitelist', 'file,crypto,data', '-i', path,
      '-map', `0:${mainVideo.index}`,
      '-vf', parseFrameFilter(),
      '-frames:v', '1', '-q:v', '2', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1',
    ], signal, {
      maxStdoutBytes: MAX_FRAME_STDOUT_BYTES,
      overflowCode: 'FRAME_TOO_LARGE',
      overflowMessage: `The decoded JPEG frame is larger than ${MAX_FRAME_STDOUT_BYTES / (1024 * 1024)} MB; choose another time or a lower-resolution source.`,
    }));
  } catch (error) {
    if (error instanceof MediaError && error.code === 'MEDIA_PROCESS_FAILED'
      && /No filtered frames for output stream|Nothing was written into output file|Could not open encoder before EOF/i.test(error.message)) {
      return undefined;
    }
    throw error;
  }
  if (stdout.length === 0) return undefined;
  if (!isJpeg(stdout)) throw new MediaError('INVALID_FRAME', 'FFmpeg returned a truncated or invalid JPEG frame.');
  const actualTime = showInfoTime(stderr);
  if (actualTime === undefined) throw new MediaError('FRAME_TIME_UNAVAILABLE', 'FFmpeg decoded a frame but did not report its presentation time.');
  return { jpeg: stdout, time: actualTime - videoStartTime };
}

async function extractFromProbe(
  path: string,
  time: number,
  probe: MediaProbeInfo,
  signal: AbortSignal,
): Promise<{ jpeg: Buffer; time: number }> {
  const mainVideo = probe.mainVideo;
  if (!mainVideo) throw new MediaError('NO_VIDEO_STREAM', 'The selected file does not contain a main video stream.');
  assertValidTime(time, probe.duration);

  const formatStartTime = probe.startTime ?? mainVideo.startTime ?? 0;
  const videoStartTime = mainVideo.startTime ?? formatStartTime;
  const seekAtMediaTime = (mediaTime: number) => mediaTime + videoStartTime - formatStartTime;

  const first = await extractAtTime(path, mainVideo, seekAtMediaTime(time), videoStartTime, signal);
  if (first) return first;

  const interval = frameInterval(mainVideo);
  if (time < probe.duration - interval - 1e-6) {
    throw new MediaError('FRAME_UNAVAILABLE', 'FFmpeg could not decode a video frame at the selected time. Try a nearby time.');
  }

  const fallbackTime = Math.max(0, probe.duration - interval);
  const fallback = await extractAtTime(path, mainVideo, seekAtMediaTime(fallbackTime), videoStartTime, signal);
  if (fallback) return fallback;
  throw new MediaError('FRAME_UNAVAILABLE', 'The video has no decodable final frame at its end boundary.');
}

/** Extracts one JPEG from the selected main video stream and reports the decoded frame's PTS. */
export async function extractFrame(
  path: string,
  time: number,
  signal: AbortSignal,
): Promise<{ jpeg: Buffer; time: number }> {
  const probe = await probeMediaWithSignal(path, signal);
  return extractFromProbe(path, time, probe, signal);
}

/** Internal shared path so cover writing uses one probe for validation and extraction. */
export async function extractFrameFromProbe(
  path: string,
  time: number,
  probe: MediaProbeInfo,
  signal: AbortSignal,
): Promise<{ jpeg: Buffer; time: number }> {
  return extractFromProbe(path, time, probe, signal);
}
