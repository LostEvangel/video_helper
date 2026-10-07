import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { DownloadManifest } from '../src/shared/contracts.js';
import { inspectInput, selectManifest } from '../src/main/hls/inspect.js';
import { localizeManifest } from '../src/main/hls/localize.js';
import { parseAttributeList } from '../src/main/hls/parse.js';
import { resolveResource } from '../src/main/hls/resolve.js';
import { resourceCachePath } from '../src/main/download/queue.js';

const temporaryDirectories: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function tempDirectory(prefix = 'video-helper-hls-'): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function selectFixture(text: string): Promise<DownloadManifest> {
  const directory = await tempDirectory();
  const playlist = path.join(directory, 'fixture.m3u8');
  await writeFile(playlist, text, 'utf8');
  const inspection = await inspectInput({ kind: 'file', path: playlist });
  const firstVariant = inspection.variants[0];
  if (!firstVariant) throw new Error('Fixture did not produce a variant');
  return selectManifest(inspection.id, firstVariant.id);
}

async function readFixture(name: string): Promise<string> {
  return readFile(path.join(process.cwd(), 'tests', 'fixtures', 'hls', name), 'utf8');
}

async function serve(routes: Record<string, string | { status: number; location?: string; body?: string }>): Promise<string> {
  const server = createServer((request, response) => {
    const route = routes[request.url ?? '/'];
    if (route === undefined) {
      response.writeHead(404).end('missing');
      return;
    }
    if (typeof route === 'string') {
      response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }).end(route);
      return;
    }
    response.writeHead(route.status, route.location ? { location: route.location } : undefined);
    response.end(route.body ?? '');
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Local test server did not start');
  return `http://127.0.0.1:${address.port}`;
}

describe('HLS resource resolution', () => {
  it('uses an explicit base URL for relative segments beside a local playlist', () => {
    expect(resolveResource('parts/001.ts', {
      source: { kind: 'file', value: 'D:\\samples\\movie.m3u8' },
      baseUrl: 'https://example.com/videos/',
    })).toEqual({ kind: 'url', value: 'https://example.com/videos/parts/001.ts' });
  });

  it('checks Windows drive paths before interpreting a colon as a URL scheme', () => {
    expect(resolveResource('D:\\samples\\part.ts', {
      source: { kind: 'file', value: 'C:\\lists\\movie.m3u8' },
    })).toEqual({ kind: 'file', value: 'D:\\samples\\part.ts' });
  });

  it('rejects local path references from HTTP playlists while preserving local playlist references', () => {
    const remote = { source: { kind: 'url' as const, value: 'https://example.test/list.m3u8' } };
    const local = { source: { kind: 'file' as const, value: 'D:\\lists\\movie.m3u8' } };
    for (const reference of [
      'file:///C:/private/secret.ts',
      'D:\\private\\secret.ts',
      '\\\\server\\share\\secret.ts',
    ]) {
      expect(() => resolveResource(reference, remote)).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_URI' }));
    }
    expect(resolveResource('D:\\samples\\part.ts', local)).toEqual({ kind: 'file', value: 'D:\\samples\\part.ts' });
    expect(resolveResource('file:///D:/samples/part.ts', local)).toEqual({ kind: 'file', value: 'D:\\samples\\part.ts' });
    expect(resolveResource('segments/one.ts', {
      ...local,
      baseUrl: 'https://cdn.example.test/video/',
    })).toEqual({ kind: 'url', value: 'https://cdn.example.test/video/segments/one.ts' });
  });

  it('resolves local relative paths beside the playlist and protocol-relative URLs against a URL base', () => {
    expect(resolveResource('parts/001.ts', {
      source: { kind: 'file', value: 'D:\\samples\\movie.m3u8' },
    })).toEqual({ kind: 'file', value: 'D:\\samples\\parts\\001.ts' });
    expect(resolveResource('//cdn.example.test/v/part.ts?sig=a%2Cb', {
      source: { kind: 'url', value: 'https://origin.example.test/path/list.m3u8' },
    })).toEqual({ kind: 'url', value: 'https://cdn.example.test/v/part.ts?sig=a%2Cb' });
  });

  it('uses a local playlist base URL and reuses it when localizing protocol-relative resources', async () => {
    const directory = await tempDirectory();
    const baseUrl = 'https://example.com/videos/';
    const playlist = path.join(directory, 'explicit-base.m3u8');
    await writeFile(playlist, await readFixture('explicit-base.m3u8'), 'utf8');
    const inspection = await inspectInput({ kind: 'file', path: playlist, baseUrl });
    const variant = inspection.variants[0];
    if (!variant) throw new Error('Fixture did not produce a variant');
    const manifest = await selectManifest(inspection.id, variant.id);
    expect(manifest.resources[0]?.source).toEqual({
      kind: 'url', value: 'https://example.com/videos/parts/one.ts?token=preserved',
    });
    expect(manifest.snapshots[0]?.baseUrl).toBe(baseUrl);
    const cache = path.join(directory, 'cache');
    const localized = await localizeManifest(manifest, cache);
    expect(await readFile(localized.video, 'utf8')).toContain(path.basename(resourceCachePath(cache, manifest.resources[0]!.id)));

    await writeFile(playlist, await readFixture('protocol-relative.m3u8'), 'utf8');
    const protocolInspection = await inspectInput({ kind: 'file', path: playlist, baseUrl });
    const protocolVariant = protocolInspection.variants[0];
    if (!protocolVariant) throw new Error('Protocol-relative fixture did not produce a variant');
    const protocolManifest = await selectManifest(protocolInspection.id, protocolVariant.id);
    expect(protocolManifest.resources[0]?.source).toEqual({
      kind: 'url', value: 'https://cdn.example.test/v/one.ts?token=relative',
    });
  });

  it('keeps query parameters when resolving against the playlist URL', () => {
    expect(resolveResource('../seg.ts?token=a%2Cb', {
      source: { kind: 'url', value: 'https://example.com/a/b/list.m3u8?manifest=1' },
    })).toEqual({ kind: 'url', value: 'https://example.com/a/seg.ts?token=a%2Cb' });
  });
});

describe('HLS parsing and selection', () => {
  it('parses quoted attribute values containing commas', () => {
    expect(parseAttributeList('BANDWIDTH=400000,NAME="Main, 720p",CODECS="avc1.4d401f,mp4a.40.2"'))
      .toEqual({ BANDWIDTH: '400000', NAME: 'Main, 720p', CODECS: 'avc1.4d401f,mp4a.40.2' });
  });

  it('rejects an unfinished media playlist', async () => {
    await expect(selectFixture('#EXTM3U\n#EXTINF:2,\na.ts\n'))
      .rejects.toMatchObject({ code: 'INCOMPLETE_PLAYLIST' });
  });

  it('inspects a fixed local playlist and preserves sequence, discontinuity, and ENDLIST', async () => {
    const directory = await tempDirectory();
    const playlist = path.join(directory, 'movie.m3u8');
    await writeFile(playlist, await readFixture('sequence-discontinuity.m3u8'), 'utf8');
    const inspection = await inspectInput({ kind: 'file', path: playlist });
    const variant = inspection.variants[0];
    if (!variant) throw new Error('Fixture did not produce a variant');
    const manifest = await selectManifest(inspection.id, variant.id);
    expect(manifest.videoText).toContain('#EXT-X-MEDIA-SEQUENCE:41');
    expect(manifest.videoText).toContain('#EXT-X-DISCONTINUITY');
    expect(manifest.videoText).toContain('#EXT-X-ENDLIST');
    expect(manifest.duration).toBe(5);
    expect(inspection.segmentCount).toBe(2);
  });

  it('resolves nested local playlists and their segments from each playlist directory', async () => {
    const directory = await tempDirectory();
    await mkdir(path.join(directory, 'child'), { recursive: true });
    await writeFile(path.join(directory, 'master.m3u8'), await readFixture('local-master.m3u8'), 'utf8');
    await writeFile(path.join(directory, 'child', 'media.m3u8'), await readFixture('local-media.m3u8'), 'utf8');
    const inspection = await inspectInput({ kind: 'file', path: path.join(directory, 'master.m3u8') });
    const variant = inspection.variants[0];
    if (!variant) throw new Error('Fixture did not produce a variant');
    const manifest = await selectManifest(inspection.id, variant.id);
    expect(variant.uri.kind).toBe('file');
    expect(variant.uri.value).toBe(path.join(directory, 'child', 'media.m3u8'));
    expect(manifest.resources.map((resource) => resource.source.value)).toContain(path.join(directory, 'child', 'segments', 'one.ts'));
  });

  it('follows a master redirect and resolves children from the actual response URL', async () => {
    const base = await serve({
      '/start/master.m3u8': { status: 302, location: '/redirected/nested/master.m3u8' },
      '/redirected/nested/master.m3u8': await readFixture('remote-master.m3u8'),
      '/redirected/nested/media/list.m3u8': await readFixture('remote-media.m3u8'),
    });
    const inspection = await inspectInput({ kind: 'url', url: `${base}/start/master.m3u8` });
    const variant = inspection.variants[0];
    if (!variant) throw new Error('Fixture did not produce a variant');
    const manifest = await selectManifest(inspection.id, variant.id);
    expect(variant.uri).toEqual({ kind: 'url', value: `${base}/redirected/nested/media/list.m3u8` });
    expect(manifest.snapshots.some((snapshot) => snapshot.source.value === `${base}/redirected/nested/master.m3u8`
      && snapshot.text.includes('#EXT-X-STREAM-INF'))).toBe(true);
    expect(manifest.resources[0]?.source.value).toBe(`${base}/redirected/nested/media/segments/one.ts?sig=keep`);
  });

  it('rejects HTTP master variants that point to local file or drive playlists', async () => {
    const directory = await tempDirectory();
    const child = path.join(directory, 'local-child.m3u8');
    await writeFile(child, '#EXTM3U\n#EXTINF:1,\nsegment.ts\n#EXT-X-ENDLIST\n', 'utf8');
    const fileUri = pathToFileURL(child).href;
    const drivePath = path.win32.normalize(child);
    const base = await serve({
      '/file-child.m3u8': `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\n${fileUri}\n`,
      '/drive-child.m3u8': `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\n${drivePath}\n`,
    });
    await expect(inspectInput({ kind: 'url', url: `${base}/file-child.m3u8` })).rejects.toMatchObject({ code: 'UNSUPPORTED_URI' });
    await expect(inspectInput({ kind: 'url', url: `${base}/drive-child.m3u8` })).rejects.toMatchObject({ code: 'UNSUPPORTED_URI' });
  });

  it.each([
    ['segment', (localUri: string) => `#EXTINF:1,\n${localUri}\n#EXT-X-ENDLIST\n`, 'inspect'],
    ['AES-128 key', (localUri: string) => `#EXT-X-KEY:METHOD=AES-128,URI="${localUri}"\n#EXTINF:1,\nsegment.ts\n#EXT-X-ENDLIST\n`, 'select'],
    ['fMP4 map', (localUri: string) => `#EXT-X-MAP:URI="${localUri}"\n#EXTINF:1,\nsegment.ts\n#EXT-X-ENDLIST\n`, 'select'],
  ] as const)('rejects a remote media playlist with a local %s reference', async (_label, mediaText, rejectionStage) => {
    const directory = await tempDirectory();
    const localAsset = path.join(directory, 'secret.bin');
    await writeFile(localAsset, 'private local bytes', 'utf8');
    const localUri = pathToFileURL(localAsset).href;
    const base = await serve({ '/media.m3u8': `#EXTM3U\n${mediaText(localUri)}` });
    if (rejectionStage === 'inspect') {
      await expect(inspectInput({ kind: 'url', url: `${base}/media.m3u8` })).rejects.toMatchObject({ code: 'UNSUPPORTED_URI' });
      return;
    }
    const inspection = await inspectInput({ kind: 'url', url: `${base}/media.m3u8` });
    const variant = inspection.variants[0];
    if (!variant) throw new Error('Remote media playlist did not produce a variant.');
    await expect(selectManifest(inspection.id, variant.id)).rejects.toMatchObject({ code: 'UNSUPPORTED_URI' });
  });

  it('rejects a remote master audio rendition and an HTTP redirect that crosses to file:', async () => {
    const directory = await tempDirectory();
    const localChild = path.join(directory, 'private.m3u8');
    await writeFile(localChild, '#EXTM3U\n#EXTINF:1,\nsegment.ts\n#EXT-X-ENDLIST\n', 'utf8');
    const fileUri = pathToFileURL(localChild).href;
    const base = await serve({
      '/audio-master.m3u8': [
        '#EXTM3U',
        `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Private",URI="${fileUri}"`,
        '#EXT-X-STREAM-INF:BANDWIDTH=1000,AUDIO="aud"',
        'media.m3u8',
        '',
      ].join('\n'),
      '/media.m3u8': '#EXTM3U\n#EXTINF:1,\nsegment.ts\n#EXT-X-ENDLIST\n',
      '/redirect-file.m3u8': { status: 302, location: fileUri },
    });
    await expect(inspectInput({ kind: 'url', url: `${base}/audio-master.m3u8` })).rejects.toMatchObject({ code: 'UNSUPPORTED_URI' });
    await expect(inspectInput({ kind: 'url', url: `${base}/redirect-file.m3u8` })).rejects.toMatchObject({ code: 'PLAYLIST_FETCH_FAILED' });
  });

  it('discovers independent audio and selects the audio playlist associated with the chosen variant', async () => {
    const directory = await tempDirectory();
    await writeFile(path.join(directory, 'master.m3u8'), await readFixture('master-audio.m3u8'), 'utf8');
    await writeFile(path.join(directory, 'video.m3u8'), await readFixture('audio-video.m3u8'), 'utf8');
    await writeFile(path.join(directory, 'audio.m3u8'), await readFixture('audio-track.m3u8'), 'utf8');
    const inspection = await inspectInput({ kind: 'file', path: path.join(directory, 'master.m3u8') });
    const variant = inspection.variants[0];
    const audio = inspection.audioTracks[0];
    if (!variant || !audio) throw new Error('Audio fixture did not produce selectable streams');
    const manifest = await selectManifest(inspection.id, variant.id, audio.id);
    expect(manifest.audioText).toContain('#EXT-X-ENDLIST');
    expect(manifest.resources.some((resource) => resource.source.value.replaceAll('\\', '/').endsWith('audio/one.aac'))).toBe(true);
  });

  it('rejects recursion cycles and masters nested deeper than eight levels', async () => {
    const cycleText = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\n/master.m3u8\n';
    const base = await serve({ '/master.m3u8': cycleText });
    await expect(inspectInput({ kind: 'url', url: `${base}/master.m3u8` })).rejects.toMatchObject({ code: 'PLAYLIST_CYCLE' });

    const depthEightRoutes: Record<string, string> = {};
    for (let level = 0; level < 8; level += 1) {
      depthEightRoutes[`/${level}.m3u8`] = `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\n/${level + 1}.m3u8\n`;
    }
    depthEightRoutes['/8.m3u8'] = '#EXTM3U\n#EXTINF:1,\nseg.ts\n#EXT-X-ENDLIST\n';
    const depthEightBase = await serve(depthEightRoutes);
    expect((await inspectInput({ kind: 'url', url: `${depthEightBase}/0.m3u8` })).variants).toHaveLength(1);

    const tooDeepRoutes: Record<string, string> = {};
    for (let level = 0; level <= 8; level += 1) {
      tooDeepRoutes[`/${level}.m3u8`] = `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\n/${level + 1}.m3u8\n`;
    }
    tooDeepRoutes['/9.m3u8'] = '#EXTM3U\n#EXTINF:1,\nseg.ts\n#EXT-X-ENDLIST\n';
    const tooDeepBase = await serve(tooDeepRoutes);
    await expect(inspectInput({ kind: 'url', url: `${tooDeepBase}/0.m3u8` })).rejects.toMatchObject({ code: 'PLAYLIST_DEPTH_EXCEEDED' });
  });

  it('rejects unsupported encryption methods and keeps AES-128 keys and explicit IVs', async () => {
    await expect(selectFixture('#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key.bin"\n#EXTINF:1,\na.ts\n#EXT-X-ENDLIST\n'))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_ENCRYPTION' });

    const manifest = await selectFixture(await readFixture('aes-explicit-iv.m3u8'));
    expect(manifest.videoText).toContain('METHOD=AES-128');
    expect(manifest.videoText).toContain('IV=0x0000000000000000000000000000002A');
    expect(manifest.resources.some((resource) => resource.role === 'key')).toBe(true);
    const localized = await localizeManifest(manifest, await tempDirectory());
    expect(await readFile(localized.video, 'utf8')).toContain('IV=0x0000000000000000000000000000002A');
  });

  it('rejects low-latency resource tags whose URIs are not localized', async () => {
    await expect(selectFixture('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:1,\nseg.ts\n#EXT-X-RENDITION-REPORT:URI="other.m3u8",LAST-MSN=8\n#EXT-X-ENDLIST\n'))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_PLAYLIST_FEATURE' });
  });

  it('keeps MEDIA-SEQUENCE so implicit AES IVs retain the source segment numbers', async () => {
    const manifest = await selectFixture(await readFixture('aes-implicit-iv.m3u8'));
    expect(manifest.videoText).toContain('#EXT-X-MEDIA-SEQUENCE:700');
    expect(manifest.videoText).toContain('#EXT-X-KEY:METHOD=AES-128');
    expect(manifest.videoText).not.toContain('IV=');
    const localized = await localizeManifest(manifest, await tempDirectory());
    expect(await readFile(localized.video, 'utf8')).toContain('#EXT-X-MEDIA-SEQUENCE:700');
    expect(await readFile(localized.video, 'utf8')).not.toContain('IV=');
  });

  it('rejects encrypted byte ranges unless their compatibility is verified', async () => {
    await expect(selectFixture('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXT-X-BYTERANGE:8@0\n#EXTINF:1,\nmedia.mp4\n#EXT-X-ENDLIST\n'))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_ENCRYPTED_RANGE' });
  });

  it('rejects an implicit media range after a full segment of the same URI', async () => {
    await expect(selectFixture([
      '#EXTM3U',
      '#EXT-X-BYTERANGE:8@0', '#EXTINF:1,', 'movie.mp4',
      '#EXTINF:1,', 'movie.mp4',
      '#EXT-X-BYTERANGE:8', '#EXTINF:1,', 'movie.mp4',
      '#EXT-X-ENDLIST',
    ].join('\n'))).rejects.toMatchObject({ code: 'INVALID_PLAYLIST' });
  });

  it('rejects an implicit media range after a range of another URI', async () => {
    await expect(selectFixture([
      '#EXTM3U',
      '#EXT-X-BYTERANGE:8@0', '#EXTINF:1,', 'a.mp4',
      '#EXT-X-BYTERANGE:3@100', '#EXTINF:1,', 'b.mp4',
      '#EXT-X-BYTERANGE:4', '#EXTINF:1,', 'a.mp4',
      '#EXT-X-ENDLIST',
    ].join('\n'))).rejects.toMatchObject({ code: 'INVALID_PLAYLIST' });
  });

  it('keeps consecutive implicit ranges when URI aliases resolve to the same resource', async () => {
    const directory = await tempDirectory();
    const playlist = path.join(directory, 'aliases.m3u8');
    await writeFile(playlist, [
      '#EXTM3U',
      '#EXT-X-BYTERANGE:8@0', '#EXTINF:1,', 'segments/movie.mp4',
      '#EXT-X-BYTERANGE:8', '#EXTINF:1,', 'segments/./movie.mp4',
      '#EXT-X-ENDLIST',
    ].join('\n'), 'utf8');
    const inspection = await inspectInput({ kind: 'file', path: playlist });
    const variant = inspection.variants[0];
    if (!variant) throw new Error('Fixture did not produce a variant');
    const manifest = await selectManifest(inspection.id, variant.id);
    expect(manifest.resources.filter((resource) => resource.role === 'segment').map((resource) => resource.range)).toEqual([
      { offset: 0, length: 8 }, { offset: 8, length: 8 },
    ]);
  });

  it('rejects an implicit map range after a full media segment of the same URI', async () => {
    await expect(selectFixture([
      '#EXTM3U',
      '#EXT-X-MAP:URI="movie.mp4",BYTERANGE="8@0"',
      '#EXTINF:1,', 'movie.mp4',
      '#EXT-X-MAP:URI="movie.mp4",BYTERANGE="8"',
      '#EXTINF:1,', 'movie.mp4',
      '#EXT-X-ENDLIST',
    ].join('\n'))).rejects.toMatchObject({ code: 'INVALID_PLAYLIST' });
  });

  it('uses the immediately preceding media range for an implicit map range', async () => {
    const manifest = await selectFixture([
      '#EXTM3U',
      '#EXTINF:1,', '#EXT-X-BYTERANGE:32@128', 'movie.mp4',
      '#EXT-X-MAP:URI="movie.mp4",BYTERANGE="64"',
      '#EXTINF:1,', '#EXT-X-BYTERANGE:32', 'movie.mp4',
      '#EXT-X-ENDLIST',
    ].join('\n'));
    expect(manifest.resources.find((resource) => resource.role === 'init')?.range).toEqual({ offset: 160, length: 64 });
    expect(manifest.resources.find((resource) => resource.role === 'segment' && resource.range?.offset === 160)?.range)
      .toEqual({ offset: 160, length: 32 });
  });

  it('turns segment and fMP4 map ranges into separate local resources and removes range tags', async () => {
    const manifest = await selectFixture(await readFixture('fmp4-ranges.m3u8'));
    expect(manifest.resources.filter((resource) => resource.role === 'init').map((resource) => resource.range)).toEqual([
      { offset: 0, length: 64 }, { offset: 64, length: 64 },
    ]);
    expect(manifest.resources.filter((resource) => resource.role === 'segment').map((resource) => resource.range)).toEqual([
      { offset: 128, length: 32 }, { offset: 160, length: 32 },
    ]);

    const cache = await tempDirectory();
    const local = await localizeManifest(manifest, cache);
    const text = await readFile(local.video, 'utf8');
    expect(text).not.toContain('#EXT-X-BYTERANGE');
    expect(text).not.toContain('BYTERANGE=');
    expect(text.match(/#EXT-X-MAP:/g)).toHaveLength(2);
    expect(text).toContain('#EXT-X-DISCONTINUITY');
  });

  it('produces stable resource IDs that include role, URI, and byte range', async () => {
    const directory = await tempDirectory();
    const playlist = path.join(directory, 'stable.m3u8');
    await writeFile(playlist, await readFixture('fmp4-ranges.m3u8'), 'utf8');
    const firstInspection = await inspectInput({ kind: 'file', path: playlist });
    const secondInspection = await inspectInput({ kind: 'file', path: playlist });
    const firstVariant = firstInspection.variants[0];
    const secondVariant = secondInspection.variants[0];
    if (!firstVariant || !secondVariant) throw new Error('Fixture did not produce a variant');
    const first = await selectManifest(firstInspection.id, firstVariant.id);
    const second = await selectManifest(secondInspection.id, secondVariant.id);
    expect(first.resources.map(({ id }) => id)).toEqual(second.resources.map(({ id }) => id));
    expect(new Set(first.resources.map(({ id }) => id)).size).toBe(first.resources.length);
  });

  it('evicts parsed inspections after the same 64-entry limit used by services', async () => {
    const directory = await tempDirectory();
    const playlist = path.join(directory, 'bounded.m3u8');
    await writeFile(playlist, '#EXTM3U\n#EXTINF:1,\nsegment.ts\n#EXT-X-ENDLIST\n', 'utf8');
    const inspected = [] as Awaited<ReturnType<typeof inspectInput>>[];
    for (let index = 0; index < 65; index += 1) inspected.push(await inspectInput({ kind: 'file', path: playlist }));
    const first = inspected[0]!;
    const latest = inspected.at(-1)!;
    const firstVariant = first.variants[0];
    const latestVariant = latest.variants[0];
    if (!firstVariant || !latestVariant) throw new Error('Repeated local inspections did not produce variants.');
    await expect(selectManifest(first.id, firstVariant.id)).rejects.toMatchObject({ code: 'INSPECTION_NOT_FOUND' });
    await expect(selectManifest(latest.id, latestVariant.id)).resolves.toMatchObject({ resources: [{ role: 'segment' }] });
  });
});
