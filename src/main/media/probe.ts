import type { StreamInfo, VideoInfo } from '../../shared/contracts.js';
import { MediaError, runMedia } from './process.js';
import { resolveMediaTool } from './tools.js';

type ProbeDisposition = Record<string, number>;
type ProbeTags = Record<string, string>;

export type MediaProbeStream = {
  index: number;
  id?: string;
  codecType?: string;
  codecName?: string;
  codecTagString?: string;
  profile?: string;
  width?: number;
  height?: number;
  sampleRate?: string;
  channels?: number;
  channelLayout?: string;
  pixelFormat?: string;
  startTime?: number;
  duration?: number;
  averageFrameRate?: string;
  realFrameRate?: string;
  timeBase?: string;
  sampleAspectRatio?: string;
  displayAspectRatio?: string;
  disposition: ProbeDisposition;
  tags?: ProbeTags;
  sideData?: { type?: string; rotation?: number }[];
};

export type MediaProbeInfo = {
  path: string;
  duration: number;
  startTime?: number;
  formatName?: string;
  tags?: ProbeTags;
  chapters: { id?: number; timeBase?: string; startTime?: number; endTime?: number; tags?: ProbeTags }[];
  streams: MediaProbeStream[];
  mainVideo?: MediaProbeStream;
};

type RawProbeStream = {
  index?: number;
  id?: string;
  codec_type?: string;
  codec_name?: string;
  codec_tag_string?: string;
  profile?: string;
  width?: number;
  height?: number;
  sample_rate?: string;
  channels?: number;
  channel_layout?: string;
  pix_fmt?: string;
  start_time?: string;
  duration?: string;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  time_base?: string;
  sample_aspect_ratio?: string;
  display_aspect_ratio?: string;
  disposition?: ProbeDisposition;
  tags?: ProbeTags;
  side_data_list?: { side_data_type?: string; rotation?: number }[];
};

type RawProbeDocument = {
  streams?: RawProbeStream[];
  format?: { start_time?: string; duration?: string; format_name?: string; tags?: ProbeTags };
  chapters?: { id?: number; time_base?: string; start_time?: string; end_time?: string; tags?: ProbeTags }[];
};

function streamKind(type: string | undefined): StreamInfo['kind'] {
  if (type === 'video' || type === 'audio' || type === 'subtitle') return type;
  return 'other';
}

function positiveDuration(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const duration = Number(value);
  return Number.isFinite(duration) && duration >= 0 ? duration : undefined;
}

function optionalFinite(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseDocument(path: string, stdout: Buffer): MediaProbeInfo {
  let document: RawProbeDocument;
  try {
    document = JSON.parse(stdout.toString('utf8')) as RawProbeDocument;
  } catch (error) {
    throw new MediaError('INVALID_MEDIA_INFO', 'FFprobe returned invalid JSON while reading the video.', { cause: error });
  }

  const rawStreams = Array.isArray(document.streams) ? document.streams : [];
  const streams: MediaProbeStream[] = rawStreams.map((stream, position) => {
    if (stream.index !== undefined && !Number.isInteger(stream.index)) {
      throw new MediaError('INVALID_MEDIA_INFO', 'FFprobe returned an invalid stream index.');
    }
    const disposition = stream.disposition && typeof stream.disposition === 'object' ? stream.disposition : {};
    const sideData = Array.isArray(stream.side_data_list)
      ? stream.side_data_list.map((item) => ({
        ...(typeof item.side_data_type === 'string' ? { type: item.side_data_type } : {}),
        ...(typeof item.rotation === 'number' && Number.isFinite(item.rotation) ? { rotation: item.rotation } : {}),
      }))
      : [];
    return {
      index: stream.index ?? position,
      ...(typeof stream.id === 'string' ? { id: stream.id } : {}),
      ...(typeof stream.codec_type === 'string' ? { codecType: stream.codec_type } : {}),
      ...(typeof stream.codec_name === 'string' ? { codecName: stream.codec_name } : {}),
      ...(typeof stream.codec_tag_string === 'string' ? { codecTagString: stream.codec_tag_string } : {}),
      ...(typeof stream.profile === 'string' ? { profile: stream.profile } : {}),
      ...(Number.isFinite(stream.width) ? { width: stream.width } : {}),
      ...(Number.isFinite(stream.height) ? { height: stream.height } : {}),
      ...(typeof stream.sample_rate === 'string' ? { sampleRate: stream.sample_rate } : {}),
      ...(Number.isFinite(stream.channels) ? { channels: stream.channels } : {}),
      ...(typeof stream.channel_layout === 'string' ? { channelLayout: stream.channel_layout } : {}),
      ...(typeof stream.pix_fmt === 'string' ? { pixelFormat: stream.pix_fmt } : {}),
      ...(optionalFinite(stream.start_time) === undefined ? {} : { startTime: optionalFinite(stream.start_time)! }),
      ...(positiveDuration(stream.duration) === undefined ? {} : { duration: positiveDuration(stream.duration)! }),
      ...(typeof stream.avg_frame_rate === 'string' ? { averageFrameRate: stream.avg_frame_rate } : {}),
      ...(typeof stream.r_frame_rate === 'string' ? { realFrameRate: stream.r_frame_rate } : {}),
      ...(typeof stream.time_base === 'string' ? { timeBase: stream.time_base } : {}),
      ...(typeof stream.sample_aspect_ratio === 'string' ? { sampleAspectRatio: stream.sample_aspect_ratio } : {}),
      ...(typeof stream.display_aspect_ratio === 'string' ? { displayAspectRatio: stream.display_aspect_ratio } : {}),
      disposition: { ...disposition },
      ...(stream.tags && typeof stream.tags === 'object' ? { tags: { ...stream.tags } } : {}),
      sideData,
    };
  });

  const mainVideo = streams.find((stream) => stream.codecType === 'video' && stream.disposition.attached_pic !== 1);
  const streamDurations = streams
    .filter((stream) => stream.disposition.attached_pic !== 1)
    .map((stream) => stream.duration)
    .filter((duration): duration is number => duration !== undefined);
  const duration = positiveDuration(document.format?.duration) ?? (streamDurations.length ? Math.max(...streamDurations) : 0);
  const startTime = optionalFinite(document.format?.start_time);
  const chapters = Array.isArray(document.chapters) ? document.chapters.map((chapter) => ({
    ...(Number.isInteger(chapter.id) ? { id: chapter.id } : {}),
    ...(typeof chapter.time_base === 'string' ? { timeBase: chapter.time_base } : {}),
    ...(optionalFinite(chapter.start_time) === undefined ? {} : { startTime: optionalFinite(chapter.start_time)! }),
    ...(optionalFinite(chapter.end_time) === undefined ? {} : { endTime: optionalFinite(chapter.end_time)! }),
    ...(chapter.tags && typeof chapter.tags === 'object' ? { tags: { ...chapter.tags } } : {}),
  })) : [];

  return {
    path,
    duration,
    ...(startTime === undefined ? {} : { startTime }),
    ...(typeof document.format?.format_name === 'string' ? { formatName: document.format.format_name } : {}),
    ...(document.format?.tags && typeof document.format.tags === 'object' ? { tags: { ...document.format.tags } } : {}),
    chapters,
    streams,
    ...(mainVideo ? { mainVideo } : {}),
  };
}

function videoInfoFromProbe(probe: MediaProbeInfo): VideoInfo {
  const mainVideo = probe.mainVideo;
  if (!mainVideo) throw new MediaError('NO_VIDEO_STREAM', 'The selected file does not contain a main video stream.');
  if (!Number.isFinite(probe.duration) || probe.duration <= 0) {
    throw new MediaError('INVALID_MEDIA_INFO', 'FFprobe did not report a usable positive video duration.');
  }
  if (!Number.isFinite(mainVideo.width) || !Number.isFinite(mainVideo.height)) {
    throw new MediaError('INVALID_MEDIA_INFO', 'FFprobe did not report the main video dimensions.');
  }
  const width = mainVideo.width as number;
  const height = mainVideo.height as number;
  const streams: StreamInfo[] = probe.streams.map((stream) => ({
    index: stream.index,
    kind: streamKind(stream.codecType),
    codec: stream.codecName || 'unknown',
    attachedPicture: stream.disposition.attached_pic === 1,
  }));
  return {
    path: probe.path,
    duration: probe.duration,
    width,
    height,
    streams,
  };
}

export async function probeMediaWithSignal(path: string, signal: AbortSignal): Promise<MediaProbeInfo> {
  const binary = resolveMediaTool('ffprobe');
  const args = [
    '-v', 'error',
    '-protocol_whitelist', 'file,crypto,data',
  ];
  if (path.toLocaleLowerCase('en-US').endsWith('.m3u8')) {
    args.push('-allowed_extensions', 'ALL', '-allowed_segment_extensions', 'ALL', '-extension_picky', '0');
  }
  args.push('-i', path, '-show_format', '-show_streams', '-show_chapters', '-of', 'json');
  const { stdout } = await runMedia(binary, args, signal);
  return parseDocument(path, stdout);
}

export async function probeVideoWithSignal(path: string, signal: AbortSignal): Promise<VideoInfo> {
  return videoInfoFromProbe(await probeMediaWithSignal(path, signal));
}

export function probeVideo(path: string): Promise<VideoInfo> {
  return probeVideoWithSignal(path, new AbortController().signal);
}
