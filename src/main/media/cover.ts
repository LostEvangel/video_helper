import { lstat, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CoverResult } from '../../shared/contracts.js';
import { extractFrameFromProbe, expectedDisplayAspectRatio, frameInterval } from './frame.js';
import { MediaError, MAX_FRAME_STDOUT_BYTES, runMedia } from './process.js';
import { resolveMediaTool } from './tools.js';
import { probeMediaWithSignal, type MediaProbeInfo, type MediaProbeStream } from './probe.js';
import { publishOutput, type PublishOperations } from './publish.js';
import { readMp4ChapterReferences } from './mp4-chapters.js';

type SaveVideoCoverRequest = { path: string; time: number; output: string; replace: boolean };
type ExportVideoFrameRequest = { path: string; time: number; output: string };

const IGNORED_FORMAT_TAGS = new Set(['encoder', 'major_brand', 'minor_version', 'compatible_brands']);
const IGNORED_STREAM_TAGS = new Set(['encoder']);

function samePath(left: string, right: string): boolean {
  const first = path.resolve(left);
  const second = path.resolve(right);
  return process.platform === 'win32' ? first.toLocaleLowerCase('en-US') === second.toLocaleLowerCase('en-US') : first === second;
}

function fileExtension(value: string): string {
  return path.extname(value).toLocaleLowerCase('en-US');
}

function requireMp4Input(filePath: string): void {
  if (fileExtension(filePath) !== '.mp4') {
    throw new MediaError('COVER_REQUIRES_MP4', 'Embedding a cover is supported for MP4 inputs only. MKV files can still be previewed and exported as JPG.');
  }
}

function requireMp4Output(filePath: string): void {
  if (fileExtension(filePath) !== '.mp4') {
    throw new MediaError('INVALID_OUTPUT_EXTENSION', 'Choose an .mp4 output path for an embedded cover.');
  }
}

async function assertRegularInput(filePath: string): Promise<void> {
  try {
    const info = await lstat(filePath);
    if (!info.isFile()) throw new MediaError('INPUT_UNAVAILABLE', 'The selected video is not a regular file.');
  } catch (error) {
    if (error instanceof MediaError) throw error;
    throw new MediaError('INPUT_UNAVAILABLE', `The selected video could not be read: ${filePath}.`, { cause: error });
  }
}

async function assertOutputPath(target: string, replace: boolean): Promise<void> {
  try {
    const info = await lstat(target);
    if (!info.isFile()) throw new MediaError('OUTPUT_NOT_FILE', 'The selected output exists but is not a regular file.');
    if (!replace) throw new MediaError('OUTPUT_EXISTS', 'The selected output already exists. Choose another name or explicitly replace it.');
  } catch (error) {
    if (error instanceof MediaError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new MediaError('OUTPUT_UNAVAILABLE', `The selected output path could not be checked: ${target}.`, { cause: error });
    }
  }
}

function unsupportedStream(stream: MediaProbeStream): MediaError {
  return new MediaError('UNSUPPORTED_STREAM', `MP4 cover writing cannot safely preserve stream ${stream.index} (${stream.codecType ?? 'unknown'}/${stream.codecName ?? 'unknown'}). The original video was left unchanged.`);
}

function parseMp4TrackId(stream: MediaProbeStream): number | undefined {
  if (!stream.id || !/^0x[0-9a-f]+$/i.test(stream.id)) return undefined;
  const id = Number.parseInt(stream.id.slice(2), 16);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

async function identifyChapterCarrier(
  filePath: string,
  probe: MediaProbeInfo,
  signal: AbortSignal,
): Promise<MediaProbeStream> {
  if (probe.chapters.length === 0) {
    throw new MediaError('UNSUPPORTED_STREAM', 'An MP4 data stream cannot be preserved because FFprobe found no matching chapter metadata. The original video was left unchanged.');
  }
  const references = await readMp4ChapterReferences(filePath, signal);
  if (references.chapterTrackIds.length !== 1) {
    throw new MediaError('UNSUPPORTED_STREAM', 'The MP4 chapter reference is missing or ambiguous. The original video was left unchanged.');
  }
  const chapterTrackId = references.chapterTrackIds[0]!;
  const matches = probe.streams.filter((stream) => parseMp4TrackId(stream) === chapterTrackId);
  if (matches.length !== 1) {
    throw new MediaError('UNSUPPORTED_STREAM', 'The MP4 chapter track reference does not match exactly one FFprobe stream. The original video was left unchanged.');
  }
  const carrier = matches[0]!;
  if (carrier.disposition.attached_pic === 1
    || carrier.codecType !== 'data'
    || carrier.codecName !== 'bin_data'
    || carrier.codecTagString !== 'text'
    || carrier.tags?.handler_name !== 'SubtitleHandler'
    || typeof carrier.tags.language !== 'string'
    || carrier.tags.language.length === 0) {
    throw unsupportedStream(carrier);
  }
  return carrier;
}

function requireSupportedStreams(probe: MediaProbeInfo, chapterCarrier?: MediaProbeStream): MediaProbeStream[] {
  const streams = probe.streams.filter((stream) => stream.disposition.attached_pic !== 1);
  const unsupported = streams.filter((stream) => stream.index !== chapterCarrier?.index
    && (!['video', 'audio', 'subtitle'].includes(stream.codecType ?? '') || !stream.codecName));
  if (unsupported.length) {
    throw unsupportedStream(unsupported[0]!);
  }
  return streams.filter((stream) => stream.index !== chapterCarrier?.index);
}

function streamSignature(stream: MediaProbeStream): string {
  return JSON.stringify([
    stream.codecType, stream.codecName, stream.codecTagString, stream.profile, stream.width, stream.height,
    stream.sampleRate, stream.channels, stream.channelLayout, stream.pixelFormat,
  ]);
}

function metadataMissing(source: Record<string, string> | undefined, output: Record<string, string> | undefined, ignored: Set<string>): string | undefined {
  const outputEntries = new Map(Object.entries(output ?? {}).map(([key, value]) => [key.toLocaleLowerCase('en-US'), value]));
  for (const [key, value] of Object.entries(source ?? {})) {
    const normalizedKey = key.toLocaleLowerCase('en-US');
    if (!ignored.has(normalizedKey) && outputEntries.get(normalizedKey) !== value) return key;
  }
  return undefined;
}

function chapterTimeBaseTick(timeBase: string | undefined): number {
  const match = timeBase && /^(\d+)\/(\d+)$/.exec(timeBase);
  if (!match) throw new MediaError('CHAPTERS_NOT_PRESERVED', 'The MP4 output did not report a usable chapter time base. The original video was left unchanged.');
  const numerator = Number(match[1]);
  const denominator = Number(match[2]);
  const tick = numerator / denominator;
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || numerator <= 0 || denominator <= 0 || !Number.isFinite(tick) || tick <= 0) {
    throw new MediaError('CHAPTERS_NOT_PRESERVED', 'The MP4 output reported an invalid chapter time base. The original video was left unchanged.');
  }
  return tick;
}

async function verifyCopiedStreams(
  source: MediaProbeInfo,
  output: MediaProbeInfo,
  expectedStreams: MediaProbeStream[],
  sourceChapterCarrier: MediaProbeStream | undefined,
  outputPath: string,
  signal: AbortSignal,
): Promise<void> {
  let outputChapterCarrier: MediaProbeStream | undefined;
  if (sourceChapterCarrier) {
    const generatedCarrier = await identifyChapterCarrier(outputPath, output, signal);
    outputChapterCarrier = generatedCarrier;
    const extraDataStreams = output.streams.filter((stream) => stream.disposition.attached_pic !== 1
      && stream.codecType === 'data' && stream.index !== generatedCarrier.index);
    if (extraDataStreams.length > 0) throw unsupportedStream(extraDataStreams[0]!);
    if (generatedCarrier.codecType !== sourceChapterCarrier.codecType
      || generatedCarrier.codecName !== sourceChapterCarrier.codecName
      || generatedCarrier.codecTagString !== sourceChapterCarrier.codecTagString) {
      throw new MediaError('STREAM_PRESERVATION_FAILED', 'The MP4 output did not recreate the original chapter carrier format. The original video was left unchanged.');
    }
    const carrierMetadata = metadataMissing(sourceChapterCarrier.tags, generatedCarrier.tags, IGNORED_STREAM_TAGS);
    if (carrierMetadata) {
      throw new MediaError('METADATA_NOT_PRESERVED', `The MP4 muxer did not preserve chapter-carrier metadata “${carrierMetadata}”. The original video was left unchanged.`);
    }
  }

  const outputStreams = output.streams.filter((stream) => stream.disposition.attached_pic !== 1
    && stream.index !== outputChapterCarrier?.index);
  if (outputStreams.length !== expectedStreams.length
    || outputStreams.some((stream, index) => streamSignature(stream) !== streamSignature(expectedStreams[index]!))) {
    throw new MediaError('STREAM_PRESERVATION_FAILED', 'The MP4 output did not preserve every original non-cover stream unchanged. The original video was left unchanged.');
  }

  for (let index = 0; index < expectedStreams.length; index += 1) {
    const missing = metadataMissing(expectedStreams[index]?.tags, outputStreams[index]?.tags, IGNORED_STREAM_TAGS);
    if (missing) {
      throw new MediaError('METADATA_NOT_PRESERVED', `The MP4 muxer did not preserve stream metadata “${missing}”. The original video was left unchanged.`);
    }
  }

  const missingFormatTag = metadataMissing(source.tags, output.tags, IGNORED_FORMAT_TAGS);
  if (missingFormatTag) {
    throw new MediaError('METADATA_NOT_PRESERVED', `The MP4 muxer did not preserve metadata “${missingFormatTag}”. The original video was left unchanged.`);
  }

  if (output.chapters.length !== source.chapters.length) {
    throw new MediaError('CHAPTERS_NOT_PRESERVED', 'The MP4 output did not preserve all original chapters. The original video was left unchanged.');
  }
  for (let index = 0; index < source.chapters.length; index += 1) {
    const originalChapter = source.chapters[index];
    const outputChapter = output.chapters[index];
    const missing = metadataMissing(originalChapter?.tags, outputChapter?.tags, IGNORED_STREAM_TAGS);
    if (missing) {
      throw new MediaError('CHAPTERS_NOT_PRESERVED', `The MP4 muxer did not preserve chapter metadata “${missing}”. The original video was left unchanged.`);
    }
    if (originalChapter?.startTime === undefined || originalChapter.endTime === undefined
      || outputChapter?.startTime === undefined || outputChapter.endTime === undefined) {
      throw new MediaError('CHAPTERS_NOT_PRESERVED', 'The MP4 output did not report every chapter boundary. The original video was left unchanged.');
    }
    const tolerance = Math.max(chapterTimeBaseTick(originalChapter.timeBase), chapterTimeBaseTick(outputChapter.timeBase)) + 1e-9;
    if (Math.abs(outputChapter.startTime - originalChapter.startTime) > tolerance
      || Math.abs(outputChapter.endTime - originalChapter.endTime) > tolerance) {
      throw new MediaError('CHAPTERS_NOT_PRESERVED', `The MP4 output changed chapter ${index + 1} boundaries by more than one chapter time-base tick. The original video was left unchanged.`);
    }
    if (outputChapter.tags?.title !== originalChapter.tags?.title) {
      throw new MediaError('CHAPTERS_NOT_PRESERVED', `The MP4 output changed chapter ${index + 1} title. The original video was left unchanged.`);
    }
  }

  const originalVideo = source.mainVideo;
  const outputVideo = output.mainVideo;
  if (!originalVideo || !outputVideo) throw new MediaError('OUTPUT_MISSING_VIDEO', 'The output does not contain the original main video stream.');
  const interval = frameInterval(originalVideo);
  if (Math.abs(output.duration - source.duration) > interval + 0.001) {
    throw new MediaError('OUTPUT_DURATION_CHANGED', `The MP4 cover output changed the duration by more than one video frame interval (${interval.toFixed(4)} s). The original video was left unchanged.`);
  }
}

function remuxArguments(source: MediaProbeInfo, sourceStreams: MediaProbeStream[], jpegPath: string, outputPath: string): string[] {
  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-protocol_whitelist', 'file,crypto,data', '-i', source.path,
    '-protocol_whitelist', 'file,crypto,data', '-i', jpegPath,
  ];
  for (const stream of sourceStreams) args.push('-map', `0:${stream.index}`);
  args.push('-map', '1:0', '-map_metadata', '0', '-map_chapters', '0', '-c', 'copy');
  const coverVideoIndex = sourceStreams.filter((stream) => stream.codecType === 'video').length;
  args.push(`-disposition:v:${coverVideoIndex}`, 'attached_pic');
  args.push('-movflags', '+faststart', '-f', 'mp4', '-n', outputPath);
  return args;
}

function remuxError(error: unknown): unknown {
  if (!(error instanceof MediaError) || error.code !== 'MEDIA_PROCESS_FAILED') return error;
  if (/could not find tag for codec|not currently supported in container|codec .* not supported|could not write header/i.test(error.message)) {
    return new MediaError('UNSUPPORTED_STREAM', `FFmpeg cannot preserve one of the selected video's streams in MP4. No stream was omitted and the original video was left unchanged. ${error.message}`, { cause: error });
  }
  return new MediaError('COVER_REMUX_FAILED', `FFmpeg could not write the embedded MP4 cover. The original video was left unchanged. ${error.message}`, { cause: error });
}

async function privateDirectory(target: string): Promise<string> {
  try {
    return await mkdtemp(path.join(path.dirname(target), '.video-helper-cover-'));
  } catch (error) {
    throw new MediaError('OUTPUT_DIRECTORY_UNAVAILABLE', 'A private temporary directory could not be created beside the selected output.', { cause: error });
  }
}

async function verifyCoverAspect(jpegPath: string, source: MediaProbeInfo, signal: AbortSignal): Promise<MediaProbeInfo> {
  const coverProbe = await probeMediaWithSignal(jpegPath, signal);
  if (!coverProbe.mainVideo?.width || !coverProbe.mainVideo.height) {
    throw new MediaError('INVALID_COVER_IMAGE', 'The extracted JPEG has no usable image dimensions.');
  }
  const expectedAspect = expectedDisplayAspectRatio(source.mainVideo!);
  const jpegAspect = coverProbe.mainVideo.width / coverProbe.mainVideo.height;
  if (Math.abs(jpegAspect - expectedAspect) / expectedAspect > 0.01) {
    throw new MediaError('COVER_ASPECT_MISMATCH', 'The extracted cover does not preserve the source video’s displayed aspect ratio.');
  }
  return coverProbe;
}

async function verifyEmbeddedCover(
  outputPath: string,
  jpeg: Buffer,
  expectedCover: MediaProbeInfo,
  signal: AbortSignal,
): Promise<MediaProbeInfo> {
  const result = await probeMediaWithSignal(outputPath, signal);
  const covers = result.streams.filter((stream) => stream.disposition.attached_pic === 1);
  if (covers.length !== 1 || covers[0]?.codecName !== 'mjpeg') {
    throw new MediaError('COVER_NOT_EMBEDDED', 'The MP4 output must contain exactly one JPEG attached-picture stream.');
  }
  const image = expectedCover.mainVideo;
  if (!image || covers[0]?.width !== image.width || covers[0]?.height !== image.height) {
    throw new MediaError('COVER_DIMENSIONS_MISMATCH', 'The embedded cover dimensions do not match the extracted JPEG.');
  }
  const binary = resolveMediaTool('ffmpeg');
  const extracted = await runMedia(binary, [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-protocol_whitelist', 'file,crypto,data', '-i', outputPath,
    '-map', `0:${covers[0].index}`, '-frames:v', '1', '-c:v', 'copy', '-f', 'image2pipe', 'pipe:1',
  ], signal, {
    maxStdoutBytes: MAX_FRAME_STDOUT_BYTES,
    overflowCode: 'FRAME_TOO_LARGE',
    overflowMessage: 'The embedded JPEG exceeds the 32 MB image limit.',
  });
  if (!extracted.stdout.equals(jpeg)) {
    throw new MediaError('COVER_CONTENT_MISMATCH', 'The image stored in the MP4 differs from the selected frame.');
  }
  return result;
}

/** Embeds one accurately selected JPEG in MP4, validates the remux, then safely publishes it. */
export async function saveVideoCover(
  request: SaveVideoCoverRequest,
  signal: AbortSignal,
  publishOperations: PublishOperations = {},
): Promise<CoverResult> {
  if (typeof request.path !== 'string' || typeof request.output !== 'string' || request.path.length === 0 || request.output.length === 0) {
    throw new MediaError('INVALID_PATH', 'Select a video and an MP4 output path.');
  }
  requireMp4Input(request.path);
  requireMp4Output(request.output);
  const input = path.resolve(request.path);
  const target = path.resolve(request.output);
  if (samePath(input, target) && !request.replace) {
    throw new MediaError('OUTPUT_EXISTS', 'The selected output is the source video. Enable explicit replacement to replace it.');
  }
  signal.throwIfAborted();
  await assertRegularInput(input);
  await assertOutputPath(target, request.replace);

  const source = await probeMediaWithSignal(input, signal);
  if (!source.mainVideo) throw new MediaError('NO_VIDEO_STREAM', 'The selected file does not contain a main video stream.');
  if (!source.formatName?.split(',').some((name) => ['mp4', 'mov', 'm4a', '3gp', '3g2', 'mj2'].includes(name))) {
    throw new MediaError('COVER_REQUIRES_MP4', 'The selected file is not an MP4-family video. MKV files can still be previewed and exported as JPG.');
  }
  const sourceChapterCarrier = source.chapters.length > 0
    ? await identifyChapterCarrier(input, source, signal)
    : undefined;
  const sourceStreams = requireSupportedStreams(source, sourceChapterCarrier);
  const extracted = await extractFrameFromProbe(input, request.time, source, signal);
  const workingDirectory = await privateDirectory(target);
  const jpegPath = path.join(workingDirectory, 'selected-frame.jpg');
  const temporaryOutput = path.join(workingDirectory, 'validated-cover.mp4');
  try {
    await writeFile(jpegPath, extracted.jpeg, { flag: 'wx' });
    const coverInfo = await verifyCoverAspect(jpegPath, source, signal);
    const binary = resolveMediaTool('ffmpeg');
    try {
      await runMedia(binary, remuxArguments(source, sourceStreams, jpegPath, temporaryOutput), signal);
    } catch (error) {
      throw remuxError(error);
    }

    const outputInfo = await verifyEmbeddedCover(temporaryOutput, extracted.jpeg, coverInfo, signal);
    await verifyCopiedStreams(source, outputInfo, sourceStreams, sourceChapterCarrier, temporaryOutput, signal);
    await publishOutput(temporaryOutput, target, request.replace, publishOperations, signal);
    return { output: target, embedded: true, nativeDisplay: 'unverified' };
  } finally {
    await rm(workingDirectory, { recursive: true, force: true }).catch(() => {});
  }
}

/** Exports the same JPEG frame used by cover embedding without overwriting an existing file. */
export async function exportVideoFrame(request: ExportVideoFrameRequest, signal: AbortSignal): Promise<void> {
  if (typeof request.path !== 'string' || typeof request.output !== 'string' || request.path.length === 0 || request.output.length === 0) {
    throw new MediaError('INVALID_PATH', 'Select a video and a JPG output path.');
  }
  const extension = fileExtension(request.output);
  if (extension !== '.jpg' && extension !== '.jpeg') {
    throw new MediaError('INVALID_OUTPUT_EXTENSION', 'Choose a .jpg or .jpeg output path.');
  }
  const input = path.resolve(request.path);
  const target = path.resolve(request.output);
  signal.throwIfAborted();
  await assertRegularInput(input);
  await assertOutputPath(target, false);
  const probe = await probeMediaWithSignal(input, signal);
  const extracted = await extractFrameFromProbe(input, request.time, probe, signal);
  const workingDirectory = await privateDirectory(target);
  const temporaryJpeg = path.join(workingDirectory, 'selected-frame.jpg');
  try {
    await writeFile(temporaryJpeg, extracted.jpeg, { flag: 'wx' });
    await publishOutput(temporaryJpeg, target, false, {}, signal);
  } finally {
    await rm(workingDirectory, { recursive: true, force: true }).catch(() => {});
  }
}
