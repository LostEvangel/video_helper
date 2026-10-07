export class HlsError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'HlsError';
    this.code = code;
  }
}

export type HlsAttributes = Record<string, string>;

export type MasterVariant = {
  attributes: HlsAttributes;
  uri: string;
};

export type MasterAudio = {
  attributes: HlsAttributes;
};

export type MasterPlaylist = {
  kind: 'master';
  lines: string[];
  variants: MasterVariant[];
  audio: MasterAudio[];
};

export type MediaMap = {
  lineIndex: number;
  uri: string;
  attributes: HlsAttributes;
  range?: { offset: number; length: number };
};

export type MediaKey = {
  lineIndex: number;
  attributes: HlsAttributes;
  uri?: string;
};

export type MediaSegment = {
  lineIndex: number;
  rangeLineIndex?: number;
  uri: string;
  duration: number;
  title: string;
  sequence: number;
  range?: { offset: number; length: number };
};

export type MediaPlaylist = {
  kind: 'media';
  lines: string[];
  mediaSequence: number;
  hasEndList: boolean;
  duration: number;
  segments: MediaSegment[];
  maps: MediaMap[];
  keys: MediaKey[];
};

export type HlsPlaylist = MasterPlaylist | MediaPlaylist;

function invalid(message: string): never {
  throw new HlsError('INVALID_PLAYLIST', message);
}

/** Parse an HLS attribute list without splitting commas that occur inside quoted values. */
export function parseAttributeList(input: string): HlsAttributes {
  const attributes: HlsAttributes = {};
  let index = 0;

  while (index < input.length) {
    while (input[index] === ',' || /\s/.test(input[index] ?? '')) index += 1;
    if (index >= input.length) break;

    const nameStart = index;
    while (index < input.length && input[index] !== '=' && input[index] !== ',') index += 1;
    const name = input.slice(nameStart, index).trim();
    if (!name || input[index] !== '=') invalid('An HLS attribute is missing its name or value.');
    index += 1;
    while (/\s/.test(input[index] ?? '')) index += 1;

    let value = '';
    if (input[index] === '"') {
      index += 1;
      let closed = false;
      while (index < input.length) {
        const character = input[index] ?? '';
        if (character === '\\' && index + 1 < input.length) {
          value += input[index + 1] ?? '';
          index += 2;
          continue;
        }
        if (character === '"') {
          index += 1;
          closed = true;
          break;
        }
        value += character;
        index += 1;
      }
      if (!closed) invalid(`The ${name} HLS attribute has an unclosed quoted value.`);
      while (/\s/.test(input[index] ?? '')) index += 1;
      if (index < input.length && input[index] !== ',') invalid(`Unexpected text after the ${name} HLS attribute.`);
    } else {
      const valueStart = index;
      while (index < input.length && input[index] !== ',') index += 1;
      value = input.slice(valueStart, index).trim();
      if (!value) invalid(`The ${name} HLS attribute has an empty value.`);
    }

    if (Object.hasOwn(attributes, name)) invalid(`The ${name} HLS attribute is repeated.`);
    attributes[name] = value;
    if (input[index] === ',') index += 1;
  }

  return attributes;
}

export function formatAttributeList(attributes: HlsAttributes): string {
  return Object.entries(attributes).map(([name, value]) => {
    const serialized = name === 'URI' || !/^[A-Za-z0-9._-]+$/.test(value)
      ? `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
      : value;
    return `${name}=${serialized}`;
  }).join(',');
}

type PreviousMediaRange = { uri: string; end: number };

function parseByteRange(value: string, previous: PreviousMediaRange | undefined, uri: string): { offset: number; length: number } {
  const match = /^(\d+)(?:@(\d+))?$/.exec(value.trim());
  if (!match) invalid('An HLS byte range must have the form length[@offset].');
  const length = Number(match[1]);
  const explicitOffset = match[2] === undefined ? undefined : Number(match[2]);
  const offset = explicitOffset ?? (previous?.uri === uri ? previous.end : undefined);
  if (!Number.isSafeInteger(length) || length <= 0 || offset === undefined || !Number.isSafeInteger(offset) || offset < 0) {
    invalid('An HLS byte range has an invalid length or cannot infer its offset.');
  }
  const end = offset + length;
  if (!Number.isSafeInteger(end)) invalid('An HLS byte range exceeds the supported file size.');
  return { offset, length };
}

function parseMedia(lines: string[], resourceIdentity: (uri: string) => string): MediaPlaylist {
  let mediaSequence = 0;
  let hasEndList = false;
  let pendingDuration: { duration: number; title: string } | undefined;
  let pendingRange: { value: string; lineIndex: number } | undefined;
  let activeMethod: string | undefined;
  const segments: MediaSegment[] = [];
  const maps: MediaMap[] = [];
  const keys: MediaKey[] = [];
  let previousMediaRange: PreviousMediaRange | undefined;
  let duration = 0;

  for (let lineIndex = 1; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? '';
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      const parsed = Number(line.slice(line.indexOf(':') + 1));
      if (!Number.isSafeInteger(parsed) || parsed < 0) invalid('EXT-X-MEDIA-SEQUENCE must be a non-negative integer.');
      mediaSequence = parsed;
      continue;
    }
    if (line === '#EXT-X-ENDLIST') {
      hasEndList = true;
      continue;
    }
    if (line.startsWith('#EXT-X-KEY:')) {
      const attributes = parseAttributeList(line.slice(line.indexOf(':') + 1));
      const method = attributes.METHOD;
      if (!method) invalid('EXT-X-KEY is missing its METHOD attribute.');
      if (method === 'NONE') {
        activeMethod = undefined;
        keys.push({ lineIndex, attributes });
        continue;
      }
      if (method !== 'AES-128' || (attributes.KEYFORMAT !== undefined && attributes.KEYFORMAT !== 'identity')) {
        throw new HlsError('UNSUPPORTED_ENCRYPTION', `The HLS encryption method ${method} is not supported.`);
      }
      if (!attributes.URI) invalid('AES-128 EXT-X-KEY is missing its URI attribute.');
      if (attributes.IV !== undefined && !/^0x[0-9a-fA-F]{32}$/.test(attributes.IV)) {
        invalid('An AES-128 EXT-X-KEY IV must contain exactly 128 bits in hexadecimal form.');
      }
      activeMethod = method;
      keys.push({ lineIndex, attributes, uri: attributes.URI });
      continue;
    }
    if (line.startsWith('#EXT-X-SESSION-KEY:')) {
      throw new HlsError('UNSUPPORTED_ENCRYPTION', 'EXT-X-SESSION-KEY encryption is not supported by this HLS workflow.');
    }
    if (line.startsWith('#EXT-X-PART:') || line.startsWith('#EXT-X-PRELOAD-HINT:') || line.startsWith('#EXT-X-RENDITION-REPORT:')) {
      throw new HlsError('UNSUPPORTED_PLAYLIST_FEATURE', 'Low-latency HLS playlist features are not supported.');
    }
    if (line.startsWith('#EXT-X-MAP:')) {
      const attributes = parseAttributeList(line.slice(line.indexOf(':') + 1));
      const uri = attributes.URI;
      if (!uri) invalid('EXT-X-MAP is missing its URI attribute.');
      let range: { offset: number; length: number } | undefined;
      if (attributes.BYTERANGE !== undefined) {
        range = parseByteRange(attributes.BYTERANGE, previousMediaRange, resourceIdentity(uri));
        if (activeMethod === 'AES-128') {
          throw new HlsError('UNSUPPORTED_ENCRYPTED_RANGE', 'AES-128 encrypted initialization byte ranges are not supported without verified sample coverage.');
        }
      }
      maps.push({ lineIndex, uri, attributes, ...(range === undefined ? {} : { range }) });
      continue;
    }
    if (line.startsWith('#EXT-X-BYTERANGE:')) {
      if (pendingRange !== undefined) invalid('An HLS segment has more than one pending BYTERANGE tag.');
      pendingRange = { value: line.slice(line.indexOf(':') + 1).trim(), lineIndex };
      continue;
    }
    if (line.startsWith('#EXTINF:')) {
      if (pendingDuration) invalid('An HLS segment is missing its media URI.');
      const value = line.slice(line.indexOf(':') + 1);
      const comma = value.indexOf(',');
      const durationText = comma === -1 ? value : value.slice(0, comma);
      const parsed = Number(durationText);
      if (!Number.isFinite(parsed) || parsed < 0) invalid('EXTINF must contain a finite non-negative duration.');
      pendingDuration = { duration: parsed, title: comma === -1 ? '' : value.slice(comma + 1) };
      continue;
    }
    if (line && !line.startsWith('#')) {
      if (!pendingDuration) invalid('A media URI does not have a preceding EXTINF tag.');
      const identity = resourceIdentity(line);
      let range: { offset: number; length: number } | undefined;
      if (pendingRange !== undefined) {
        if (activeMethod === 'AES-128') {
          throw new HlsError('UNSUPPORTED_ENCRYPTED_RANGE', 'AES-128 encrypted media byte ranges are not supported without verified sample coverage.');
        }
        range = parseByteRange(pendingRange.value, previousMediaRange, identity);
      }
      segments.push({
        lineIndex,
        ...(pendingRange === undefined ? {} : { rangeLineIndex: pendingRange.lineIndex }),
        uri: line,
        duration: pendingDuration.duration,
        title: pendingDuration.title,
        sequence: mediaSequence + segments.length,
        ...(range === undefined ? {} : { range }),
      });
      duration += pendingDuration.duration;
      previousMediaRange = range === undefined ? undefined : { uri: identity, end: range.offset + range.length };
      pendingDuration = undefined;
      pendingRange = undefined;
    }
  }

  if (pendingDuration || pendingRange !== undefined) invalid('The final HLS segment is missing its media URI.');
  if (segments.length === 0) invalid('The HLS media playlist contains no segments.');
  return { kind: 'media', lines, mediaSequence, hasEndList, duration, segments, maps, keys };
}

function parseMaster(lines: string[]): MasterPlaylist {
  const variants: MasterVariant[] = [];
  const audio: MasterAudio[] = [];
  let pendingAttributes: HlsAttributes | undefined;

  for (let lineIndex = 1; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? '';
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      if (pendingAttributes) invalid('An EXT-X-STREAM-INF entry is missing its playlist URI.');
      pendingAttributes = parseAttributeList(line.slice(line.indexOf(':') + 1));
      continue;
    }
    if (line.startsWith('#EXT-X-SESSION-KEY:')) {
      throw new HlsError('UNSUPPORTED_ENCRYPTION', 'EXT-X-SESSION-KEY encryption is not supported by this HLS workflow.');
    }
    if (line.startsWith('#EXT-X-MEDIA:')) {
      const attributes = parseAttributeList(line.slice(line.indexOf(':') + 1));
      if (attributes.TYPE === 'AUDIO') audio.push({ attributes });
      continue;
    }
    if (line && !line.startsWith('#') && pendingAttributes) {
      variants.push({ attributes: pendingAttributes, uri: line });
      pendingAttributes = undefined;
    }
  }

  if (pendingAttributes) invalid('An EXT-X-STREAM-INF entry is missing its playlist URI.');
  if (variants.length === 0) invalid('The HLS master playlist contains no selectable variants.');
  return { kind: 'master', lines, variants, audio };
}

export function parsePlaylist(input: string, resourceIdentity: (uri: string) => string = (uri) => uri): HlsPlaylist {
  const normalized = input.replace(/^\uFEFF/, '').replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const lines = normalized.split('\n').map((line) => line.trim());
  const firstLine = lines.find((line) => line.length > 0);
  if (firstLine !== '#EXTM3U') invalid('The playlist does not start with #EXTM3U.');

  const hasMaster = lines.some((line) => line.startsWith('#EXT-X-STREAM-INF:'));
  if (hasMaster) {
    if (lines.some((line) => line.startsWith('#EXTINF:'))) invalid('A playlist cannot mix master and media entries.');
    return parseMaster(lines);
  }
  if (!lines.some((line) => line.startsWith('#EXTINF:') || line.startsWith('#EXT-X-TARGETDURATION:') || line.startsWith('#EXT-X-MEDIA-SEQUENCE:'))) {
    invalid('The HLS playlist contains neither a master variant nor media segments.');
  }
  return parseMedia(lines, resourceIdentity);
}
