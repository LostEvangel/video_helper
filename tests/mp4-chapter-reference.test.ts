import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readMp4ChapterReferences } from '../src/main/media/mp4-chapters.js';

let root = '';

async function fixture(name: string, contents: Buffer): Promise<string> {
  if (!root) root = await mkdtemp(path.join(os.tmpdir(), 'video-helper-mp4-atoms-'));
  const filePath = path.join(root, name);
  await writeFile(filePath, contents);
  return filePath;
}

function box(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(header.length + payload.length, 0);
  header.write(type, 4, 4, 'ascii');
  return Buffer.concat([header, payload]);
}

function extendedBox(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(16);
  header.writeUInt32BE(1, 0);
  header.write(type, 4, 4, 'ascii');
  header.writeBigUInt64BE(BigInt(header.length + payload.length), 8);
  return Buffer.concat([header, payload]);
}

function trackHeader(id: number, version: 0 | 1 = 0): Buffer {
  const payload = Buffer.alloc(version === 0 ? 24 : 32);
  payload[0] = version;
  payload.writeUInt32BE(id, version === 0 ? 12 : 20);
  return box('tkhd', payload);
}

function track(id: number, children: Buffer[], extended = false, version: 0 | 1 = 0): Buffer {
  const payload = Buffer.concat([trackHeader(id, version), ...children]);
  return extended ? extendedBox('trak', payload) : box('trak', payload);
}

function chapterFile(options: {
  referenceIds?: number[];
  referencePayload?: Buffer;
  moovExtended?: boolean;
  chapterTrackExtended?: boolean;
  videoHeaderVersion?: 0 | 1;
  includeChapterTrack?: boolean;
  extraTopLevel?: Buffer[];
} = {}): Buffer {
  const ids = options.referenceIds ?? [2];
  const refPayload = options.referencePayload ?? Buffer.concat(ids.map((id) => {
    const value = Buffer.alloc(4);
    value.writeUInt32BE(id);
    return value;
  }));
  const videoTrack = track(1, [box('tref', box('chap', refPayload))], false, options.videoHeaderVersion ?? 0);
  const chapterTrack = track(2, [], options.chapterTrackExtended);
  const tracks = [videoTrack, ...(options.includeChapterTrack === false ? [] : [chapterTrack])];
  const moovPayload = Buffer.concat(tracks);
  const moov = options.moovExtended ? extendedBox('moov', moovPayload) : box('moov', moovPayload);
  const ftyp = box('ftyp', Buffer.from('isom\0\0\0\0', 'binary'));
  const mdat = box('mdat', Buffer.alloc(512 * 1024, 0xa5));
  return Buffer.concat([ftyp, ...(options.extraTopLevel ?? []), mdat, moov]);
}

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe('bounded MP4 chapter-reference reader', () => {
  it('matches tref/chap track IDs and skips a large mdat without reading it', async () => {
    const contents = chapterFile({ moovExtended: true, chapterTrackExtended: true, videoHeaderVersion: 1 });
    const filePath = await fixture('valid-extended.mp4', contents);
    const result = await readMp4ChapterReferences(filePath, new AbortController().signal);
    expect(result.chapterTrackIds).toEqual([2]);
    expect(result.bytesRead).toBeLessThan(1024);
    expect(result.bytesRead).toBeLessThan(contents.length / 100);
  });

  it.each([
    ['short top-level header', Buffer.from([0, 0, 0, 8, 0x66])],
    ['box smaller than its header', Buffer.from([0, 0, 0, 7, 0x6d, 0x6f, 0x6f, 0x76])],
    ['truncated extended-size header', Buffer.from([0, 0, 0, 1, 0x6d, 0x6f, 0x6f, 0x76])],
    ['extended size overflows safe offsets', (() => {
      const value = Buffer.alloc(16);
      value.writeUInt32BE(1, 0);
      value.write('moov', 4, 4, 'ascii');
      value.writeBigUInt64BE(BigInt(Number.MAX_SAFE_INTEGER) + 1n, 8);
      return value;
    })()],
    ['child box crosses the moov boundary', (() => {
      const childHeader = Buffer.alloc(8);
      childHeader.writeUInt32BE(100, 0);
      childHeader.write('trak', 4, 4, 'ascii');
      return Buffer.concat([box('ftyp', Buffer.alloc(0)), box('moov', childHeader)]);
    })()],
    ['unsupported zero-sized child box', (() => {
      const childHeader = Buffer.alloc(8);
      childHeader.writeUInt32BE(0, 0);
      childHeader.write('trak', 4, 4, 'ascii');
      return Buffer.concat([box('ftyp', Buffer.alloc(0)), box('moov', childHeader)]);
    })()],
    ['chap reference has a partial track ID', chapterFile({ referencePayload: Buffer.from([0, 0, 0, 2, 0]) })],
    ['chap reference names a missing track', chapterFile({ referenceIds: [9] })],
    ['chapter reference is duplicated inside one chap box', chapterFile({ referenceIds: [2, 2] })],
  ])('rejects %s', async (label, contents) => {
    const filePath = await fixture(`${label.replaceAll(' ', '-')}.mp4`, contents);
    await expect(readMp4ChapterReferences(filePath, new AbortController().signal))
      .rejects.toMatchObject({ code: 'INVALID_MEDIA_INFO' });
  });

  it('rejects multiple moov boxes and pre-cancelled reads', async () => {
    const moov = box('moov', track(1, []));
    const duplicateMoovPath = await fixture('duplicate-moov.mp4', Buffer.concat([box('ftyp', Buffer.alloc(0)), moov, moov]));
    await expect(readMp4ChapterReferences(duplicateMoovPath, new AbortController().signal))
      .rejects.toMatchObject({ code: 'INVALID_MEDIA_INFO' });

    const cancelled = new AbortController();
    cancelled.abort();
    await expect(readMp4ChapterReferences(duplicateMoovPath, cancelled.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
  });
});
