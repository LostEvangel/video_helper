import { open } from 'node:fs/promises';
import { MediaError } from './process.js';

const MAX_BOX_COUNT = 10_000;
const MAX_CHAPTER_REFERENCES = 64;

type Box = { type: string; start: number; payloadStart: number; end: number };
type ReadMeter = { bytesRead: number; boxesRead: number };

export type Mp4ChapterReferences = {
  /** Distinct track IDs named by one or more `tref/chap` boxes. */
  chapterTrackIds: number[];
  /** Bytes read from the file, excluding filesystem metadata. Useful for bounded-reader checks. */
  bytesRead: number;
};

function malformed(detail: string): MediaError {
  return new MediaError('INVALID_MEDIA_INFO', `The MP4 chapter track references could not be safely validated: ${detail}`);
}

function throwIfAborted(signal: AbortSignal): void {
  signal.throwIfAborted();
}

async function readExact(
  handle: Awaited<ReturnType<typeof open>>,
  position: number,
  length: number,
  signal: AbortSignal,
  meter: ReadMeter,
): Promise<Buffer> {
  throwIfAborted(signal);
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  meter.bytesRead += bytesRead;
  if (bytesRead !== length) throw malformed('a box header or track reference is truncated');
  return buffer;
}

async function readBox(
  handle: Awaited<ReturnType<typeof open>>,
  start: number,
  parentEnd: number,
  isTopLevel: boolean,
  signal: AbortSignal,
  meter: ReadMeter,
): Promise<Box> {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(parentEnd) || start < 0 || parentEnd < start || parentEnd - start < 8) {
    throw malformed('a box header is incomplete');
  }
  const base = await readExact(handle, start, 8, signal, meter);
  const shortSize = base.readUInt32BE(0);
  const type = base.toString('ascii', 4, 8);
  if (!/^[\x20-\x7e]{4}$/.test(type)) throw malformed('a box has an invalid type');

  let headerSize = 8;
  let boxSize: number;
  if (shortSize === 1) {
    if (parentEnd - start < 16) throw malformed('an extended-size box header is truncated');
    const extended = await readExact(handle, start + 8, 8, signal, meter);
    const bigSize = extended.readBigUInt64BE(0);
    if (bigSize > BigInt(Number.MAX_SAFE_INTEGER)) throw malformed('an extended-size box exceeds the safe file offset limit');
    boxSize = Number(bigSize);
    headerSize = 16;
  } else if (shortSize === 0) {
    if (!isTopLevel || type !== 'mdat') throw malformed('a zero-sized box is unsupported in this layout');
    boxSize = parentEnd - start;
  } else {
    boxSize = shortSize;
  }

  if (type === 'uuid') headerSize += 16;
  if (boxSize < headerSize) throw malformed('a box size is smaller than its header');
  const end = start + boxSize;
  if (!Number.isSafeInteger(end) || end > parentEnd) throw malformed('a box extends beyond its parent');
  meter.boxesRead += 1;
  if (meter.boxesRead > MAX_BOX_COUNT) throw malformed('the file has too many boxes to inspect safely');
  return { type, start, payloadStart: start + headerSize, end };
}

async function childBoxes(
  handle: Awaited<ReturnType<typeof open>>,
  parent: Box,
  signal: AbortSignal,
  meter: ReadMeter,
): Promise<Box[]> {
  const boxes: Box[] = [];
  let offset = parent.payloadStart;
  while (offset < parent.end) {
    if (boxes.length >= MAX_BOX_COUNT) throw malformed('a container has too many child boxes');
    const box = await readBox(handle, offset, parent.end, false, signal, meter);
    if (box.end <= offset) throw malformed('a child box does not advance the container');
    boxes.push(box);
    offset = box.end;
  }
  if (offset !== parent.end) throw malformed('a container ends between box boundaries');
  return boxes;
}

async function readTrackId(
  handle: Awaited<ReturnType<typeof open>>,
  box: Box,
  signal: AbortSignal,
  meter: ReadMeter,
): Promise<number> {
  const payloadLength = box.end - box.payloadStart;
  if (payloadLength < 4) throw malformed('a track header is truncated');
  const prefixLength = Math.min(payloadLength, 24);
  const prefix = await readExact(handle, box.payloadStart, prefixLength, signal, meter);
  const version = prefix[0];
  const offset = version === 0 ? 12 : version === 1 ? 20 : -1;
  if (offset < 0 || prefix.length < offset + 4) throw malformed('a track header uses an unsupported version or is truncated');
  const id = prefix.readUInt32BE(offset);
  if (id === 0) throw malformed('a track has an invalid zero ID');
  return id;
}

async function readChapterTargetIds(
  handle: Awaited<ReturnType<typeof open>>,
  box: Box,
  signal: AbortSignal,
  meter: ReadMeter,
): Promise<number[]> {
  const payloadLength = box.end - box.payloadStart;
  if (payloadLength === 0 || payloadLength % 4 !== 0 || payloadLength / 4 > MAX_CHAPTER_REFERENCES) {
    throw malformed('a chap reference has an invalid or excessive track ID list');
  }
  const payload = await readExact(handle, box.payloadStart, payloadLength, signal, meter);
  const ids: number[] = [];
  const seen = new Set<number>();
  for (let offset = 0; offset < payload.length; offset += 4) {
    const id = payload.readUInt32BE(offset);
    if (id === 0 || seen.has(id)) throw malformed('a chap reference contains an invalid or repeated track ID');
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/** Reads only MP4 box headers, track headers, and bounded `tref/chap` payloads; media data is skipped by offset. */
export async function readMp4ChapterReferences(filePath: string, signal: AbortSignal): Promise<Mp4ChapterReferences> {
  throwIfAborted(signal);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  const meter: ReadMeter = { bytesRead: 0, boxesRead: 0 };
  try {
    handle = await open(filePath, 'r');
    const info = await handle.stat();
    if (!info.isFile() || !Number.isSafeInteger(info.size) || info.size < 8) throw malformed('the file has no complete MP4 box header');

    let offset = 0;
    let moov: Box | undefined;
    let boxCount = 0;
    while (offset < info.size) {
      throwIfAborted(signal);
      if (boxCount >= MAX_BOX_COUNT) throw malformed('the file has too many top-level boxes');
      const box = await readBox(handle, offset, info.size, true, signal, meter);
      if (box.type === 'moov') {
        if (moov) throw malformed('the file has multiple moov boxes');
        moov = box;
      }
      offset = box.end;
      boxCount += 1;
      if (box.type === 'mdat' && box.end === info.size) break;
    }
    if (offset !== info.size || !moov) throw malformed('the file has no complete moov box');

    const moovChildren = await childBoxes(handle, moov, signal, meter);
    const tracks = moovChildren.filter((box) => box.type === 'trak');
    if (tracks.length === 0) throw malformed('the moov box contains no tracks');
    const trackIds = new Set<number>();
    const referencedIds = new Set<number>();
    for (const track of tracks) {
      throwIfAborted(signal);
      const children = await childBoxes(handle, track, signal, meter);
      const headers = children.filter((box) => box.type === 'tkhd');
      const references = children.filter((box) => box.type === 'tref');
      if (headers.length !== 1 || references.length > 1) throw malformed('a track has a missing or ambiguous tkhd/tref layout');
      const trackId = await readTrackId(handle, headers[0]!, signal, meter);
      if (trackIds.has(trackId)) throw malformed('two tracks have the same track ID');
      trackIds.add(trackId);

      if (references.length === 1) {
        for (const reference of await childBoxes(handle, references[0]!, signal, meter)) {
          if (reference.type !== 'chap') continue;
          const ids = await readChapterTargetIds(handle, reference, signal, meter);
          if (ids.includes(trackId)) throw malformed('a track references itself as a chapter track');
          ids.forEach((id) => referencedIds.add(id));
        }
      }
    }

    for (const id of referencedIds) if (!trackIds.has(id)) throw malformed('a chap reference names a track that is absent from moov');
    return { chapterTrackIds: [...referencedIds].sort((left, right) => left - right), bytesRead: meter.bytesRead };
  } catch (error) {
    if (error instanceof MediaError) throw error;
    if (signal.aborted) throw signal.reason;
    throw new MediaError('INVALID_MEDIA_INFO', 'The MP4 chapter track references could not be safely validated.', { cause: error });
  } finally {
    await handle?.close().catch(() => {});
  }
}
