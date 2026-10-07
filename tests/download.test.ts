import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DownloadManifest, Resource, TaskView } from '../src/shared/contracts.js';
import { inspectInput, selectManifest } from '../src/main/hls/inspect.js';
import { parsePlaylist } from '../src/main/hls/parse.js';
import { resolveResource } from '../src/main/hls/resolve.js';
import { downloadResource } from '../src/main/download/resource.js';
import { runDownload } from '../src/main/download/queue.js';
import { FileTaskStore } from '../src/main/download/store.js';
import { TaskRunner } from '../src/main/download/runner.js';
import { makeServer, waitForRequestCount, waitForResponseCount, withResourceId } from './helpers/server.js';
import type { TaskRecord, TaskStore } from '../src/main/download/store.js';

const directories: string[] = [];
const servers: Array<{ close(): Promise<void> }> = [];
const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'video-helper-download-'));
  directories.push(directory);
  return directory;
}

async function makeManifest(directory: string, body = Buffer.from('local segment')): Promise<DownloadManifest> {
  const playlist = path.join(directory, 'source.m3u8');
  await writeFile(path.join(directory, 'segment.bin'), body);
  await writeFile(playlist, '#EXTM3U\n#EXTINF:1,\nsegment.bin\n#EXT-X-ENDLIST\n');
  const inspection = await inspectInput({ kind: 'file', path: playlist });
  const variant = inspection.variants[0];
  if (!variant) throw new Error('Local fixture did not produce a variant.');
  return selectManifest(inspection.id, variant.id);
}

async function makeRemoteManifest(directory: string, baseUrl: string): Promise<DownloadManifest> {
  const playlist = path.join(directory, 'remote-source.m3u8');
  await writeFile(playlist, '#EXTM3U\n#EXTINF:1,\nfast\n#EXTINF:1,\nslow\n#EXT-X-ENDLIST\n');
  const inspection = await inspectInput({ kind: 'file', path: playlist, baseUrl });
  const variant = inspection.variants[0];
  if (!variant) throw new Error('Remote fixture did not produce a variant.');
  return selectManifest(inspection.id, variant.id);
}

function legacyResource(role: Resource['role'], sourceValue: string): Resource {
  const source = sourceValue.startsWith('file:')
    ? { kind: 'file' as const, value: fileURLToPath(sourceValue) }
    : { kind: 'file' as const, value: path.win32.normalize(sourceValue) };
  const identity = JSON.stringify([role, source.kind, source.value, null]);
  return { id: `${role}-${digest(identity)}`, source, role };
}

function resourcesForLocalSnapshot(snapshot: DownloadManifest['snapshots'][number]): Resource[] {
  const context = { source: snapshot.source, ...(snapshot.baseUrl === undefined ? {} : { baseUrl: snapshot.baseUrl }) };
  const parsed = parsePlaylist(snapshot.text, (uri) => {
    const locator = resolveResource(uri, context);
    return `${locator.kind}:${locator.value}`;
  });
  if (parsed.kind !== 'media') throw new Error('Legacy child fixture must be a media playlist.');
  return [
    ...parsed.keys.flatMap((key) => key.uri ? [legacyResource('key', resolveResource(key.uri, context).value)] : []),
    ...parsed.maps.map((map) => legacyResource('init', resolveResource(map.uri, context).value)),
    ...parsed.segments.map((segment) => legacyResource('segment', resolveResource(segment.uri, context).value)),
  ];
}

async function makeLegacyRemoteToFileManifest(directory: string, parentReferences: 'file' | 'http' | 'effective-file-url'): Promise<{
  manifest: DownloadManifest;
  sourcePlaylistPaths: string[];
  remoteParentUrl: string;
  remoteParentText: string;
}> {
  const videoPlaylistPath = path.join(directory, 'legacy-video-child.m3u8');
  const audioPlaylistPath = path.join(directory, 'legacy-audio-child.m3u8');
  const videoKey = pathToFileURL(path.join(directory, 'video-key.bin')).href;
  const videoMap = 'Z:\\legacy\\video-init.mp4';
  const videoSegment = '\\\\legacy-server\\share\\video-segment.ts';
  const audioKey = '\\\\legacy-server\\share\\audio-key.bin';
  const audioMap = 'Y:\\legacy\\audio-init.mp4';
  const audioSegment = pathToFileURL(path.join(directory, 'audio-segment.aac')).href;
  const quoted = (value: string) => `URI="${value.replaceAll('\\', '\\\\')}"`;
  const videoText = [
    '#EXTM3U',
    `#EXT-X-KEY:METHOD=AES-128,${quoted(videoKey)}`,
    `#EXT-X-MAP:${quoted(videoMap)}`,
    '#EXTINF:1,', videoSegment,
    '#EXT-X-ENDLIST',
  ].join('\n');
  const audioText = [
    '#EXTM3U',
    `#EXT-X-KEY:METHOD=AES-128,${quoted(audioKey)}`,
    `#EXT-X-MAP:${quoted(audioMap)}`,
    '#EXTINF:1,', audioSegment,
    '#EXT-X-ENDLIST',
  ].join('\n');
  await writeFile(videoPlaylistPath, videoText, 'utf8');
  await writeFile(audioPlaylistPath, audioText, 'utf8');

  const videoChildUri = parentReferences === 'file'
    ? pathToFileURL(videoPlaylistPath).href
    : 'https://legacy.example/redirected/video.m3u8';
  const audioChildUri = parentReferences === 'file'
    ? pathToFileURL(audioPlaylistPath).href
    : 'https://legacy.example/redirected/audio.m3u8';
  const remoteParentUrl = 'https://legacy.example/root.m3u8';
  const remoteParentText = [
    '#EXTM3U',
    `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="legacy-audio",NAME="Legacy audio",DEFAULT=YES,AUTOSELECT=YES,URI="${audioChildUri}"`,
    '#EXT-X-STREAM-INF:BANDWIDTH=128000,AUDIO="legacy-audio"',
    videoChildUri,
  ].join('\n');
  const videoSnapshotSource = parentReferences === 'effective-file-url'
    ? { kind: 'url' as const, value: pathToFileURL(videoPlaylistPath).href }
    : { kind: 'file' as const, value: videoPlaylistPath };
  const audioSnapshotSource = parentReferences === 'effective-file-url'
    ? { kind: 'url' as const, value: pathToFileURL(audioPlaylistPath).href }
    : { kind: 'file' as const, value: audioPlaylistPath };
  const snapshots: DownloadManifest['snapshots'] = [
    { source: videoSnapshotSource, text: videoText },
    { source: audioSnapshotSource, text: audioText },
    { source: { kind: 'url', value: remoteParentUrl }, text: remoteParentText },
  ];
  const localSnapshots: DownloadManifest['snapshots'] = [
    { source: { kind: 'file', value: videoPlaylistPath }, text: videoText },
    { source: { kind: 'file', value: audioPlaylistPath }, text: audioText },
  ];
  const manifest: DownloadManifest = {
    id: randomUUID(),
    resources: [...resourcesForLocalSnapshot(localSnapshots[0]!), ...resourcesForLocalSnapshot(localSnapshots[1]!)],
    videoText,
    audioText,
    duration: 1,
    snapshotHash: digest(JSON.stringify(snapshots.map((snapshot) => [snapshot.source, snapshot.baseUrl ?? null, snapshot.text]))),
    snapshots,
  };
  return { manifest, sourcePlaylistPaths: [videoPlaylistPath, audioPlaylistPath], remoteParentUrl, remoteParentText };
}

function digest(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve: () => resolve() };
}

function holdTaskCachePreflight(runner: TaskRunner) {
  type RunnerInternals = {
    ensureTaskCacheDirectory(record: TaskRecord, create: boolean): Promise<string>;
  };
  const internals = runner as unknown as RunnerInternals;
  const original = internals.ensureTaskCacheDirectory.bind(runner);
  const entered = deferred();
  const release = deferred();
  let held = false;
  internals.ensureTaskCacheDirectory = async (record, create) => {
    if (!held) {
      held = true;
      entered.resolve();
      await release.promise;
    }
    return original(record, create);
  };
  return {
    entered,
    release,
    restore: () => { internals.ensureTaskCacheDirectory = original; },
  };
}

class CompletionBarrierStore implements TaskStore {
  readonly completionPersisted = deferred();
  readonly releaseCompletion = deferred();
  private blocked = false;

  constructor(private readonly inner: FileTaskStore) {}

  load(id: string): Promise<TaskRecord | undefined> { return this.inner.load(id); }
  list(): Promise<TaskRecord[]> { return this.inner.list(); }
  delete(id: string): Promise<void> { return this.inner.delete(id); }

  async save(record: TaskRecord): Promise<void> {
    await this.inner.save(record);
    if (!this.blocked && record.view.state === 'downloading' && Object.keys(record.completed).length > 0) {
      this.blocked = true;
      this.completionPersisted.resolve();
      await this.releaseCompletion.promise;
    }
  }
}

async function waitForRequestOrTask(server: ReturnType<typeof makeServer> extends Promise<infer T> ? T : never, count: number, task: Promise<TaskView>): Promise<void> {
  while (server.requests < count) {
    await Promise.race([
      new Promise<void>((resolve) => setImmediate(resolve)),
      task.then((view) => { throw new Error(`Task settled before request ${count}: ${view.state} ${view.error ?? ''}`); }),
    ]);
  }
}

async function waitForCount(values: readonly unknown[], count: number, label: string): Promise<void> {
  for (let attempt = 0; attempt < 100 && values.length < count; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  if (values.length < count) await new Promise<void>((resolve) => nativeSetTimeout(resolve, 50));
  if (values.length < count) throw new Error(`Expected ${count} ${label}; saw ${values.length}.`);
}

async function waitForTaskState(runner: TaskRunner, id: string, state: TaskView['state']): Promise<TaskView> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const current = (await runner.listTasks()).find((task) => task.id === id);
    if (current?.state === state) return current;
    if (current?.state === 'failed') throw new Error(`Task failed while waiting for ${state}: ${current.error ?? 'unknown failure'}`);
    await new Promise<void>((resolve) => nativeSetTimeout(resolve, 10));
  }
  throw new Error(`Task ${id} did not reach ${state}.`);
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('downloadResource', () => {
  it('streams bytes to a part file, atomically publishes it, and returns the content hash', async () => {
    const server = await makeServer({ data: 'streamed bytes', omitContentLength: true });
    servers.push(server);
    const directory = await tempDirectory();
    const target = path.join(directory, 'resource.bin');

    await expect(downloadResource(server.resource, target, new AbortController().signal))
      .resolves.toEqual({ bytes: 14, sha256: digest('streamed bytes') });
    expect(await readFile(target, 'utf8')).toBe('streamed bytes');
    await expect(access(`${target}.part`)).rejects.toThrow();
  });

  it('does not retry access denial', async () => {
    const server = await makeServer({ status: 403 });
    servers.push(server);
    const target = path.join(await tempDirectory(), 'forbidden.bin');

    await expect(downloadResource(server.resource, target, new AbortController().signal))
      .rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    expect(server.requests).toBe(1);
  });

  it('stops on a disk write error without retrying the resource request', async () => {
    const server = await makeServer({ data: 'disk failure' });
    servers.push(server);
    const target = path.join(await tempDirectory(), 'disk-error.bin');
    const delays: number[] = [];

    await expect(downloadResource(server.resource, target, new AbortController().signal, {
      wait: async (delayMs) => { delays.push(delayMs); },
      createWriteStream: () => new Writable({
        write(_chunk, _encoding, callback) {
          callback(Object.assign(new Error('disk full'), { code: 'ENOSPC' }));
        },
      }),
    })).rejects.toMatchObject({ code: 'DISK_ERROR' });

    expect(server.requests).toBe(1);
    expect(delays).toEqual([]);
    await expect(access(`${target}.part`)).rejects.toThrow();
  });

  it('retries a 503 after the specified 1, 2, and 4 second delays', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const server = await makeServer({ statusSequence: [503, 503, 503, 200], data: 'eventual success' });
    servers.push(server);
    const target = path.join(await tempDirectory(), 'retry.bin');
    const delays: number[] = [];
    const result = downloadResource(server.resource, target, new AbortController().signal, {
      wait: (delayMs, signal) => new Promise<void>((resolve, reject) => {
        delays.push(delayMs);
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        }, delayMs);
        const onAbort = () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          reject(signal.reason);
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    });

    await waitForRequestCount(server, 1);
    await waitForCount(delays, 1, 'retry delays');
    await vi.advanceTimersByTimeAsync(999);
    expect(server.requests).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await waitForRequestCount(server, 2);
    await waitForCount(delays, 2, 'retry delays');
    await vi.advanceTimersByTimeAsync(1_999);
    expect(server.requests).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    await waitForRequestCount(server, 3);
    await waitForCount(delays, 3, 'retry delays');
    await vi.advanceTimersByTimeAsync(3_999);
    expect(server.requests).toBe(3);
    await vi.advanceTimersByTimeAsync(1);

    await expect(result).resolves.toMatchObject({ sha256: digest('eventual success') });
    expect(server.requests).toBe(4);
    expect(delays).toEqual([1_000, 2_000, 4_000]);
  });

  it('requests a byte range and validates the returned Content-Range', async () => {
    const server = await makeServer({ data: '0123456789' });
    servers.push(server);
    const directory = await tempDirectory();
    const target = path.join(directory, 'range.bin');
    const ranged: Resource = { ...server.resource, range: { offset: 3, length: 4 } };

    await expect(downloadResource(ranged, target, new AbortController().signal))
      .resolves.toEqual({ bytes: 4, sha256: digest('3456') });
    expect(await readFile(target, 'utf8')).toBe('3456');
  });

  it('extracts a requested range when the server ignores Range and returns the full resource', async () => {
    const server = await makeServer({ data: '0123456789', ignoreRange: true });
    servers.push(server);
    const directory = await tempDirectory();
    const target = path.join(directory, 'ignored-range.bin');
    const ranged: Resource = { ...server.resource, range: { offset: 4, length: 3 } };

    await expect(downloadResource(ranged, target, new AbortController().signal))
      .resolves.toEqual({ bytes: 3, sha256: digest('456') });
    expect(await readFile(target, 'utf8')).toBe('456');
  });

  it('rejects an incorrect Content-Range without publishing a destination', async () => {
    const server = await makeServer({ data: '0123456789', wrongContentRange: true });
    servers.push(server);
    const directory = await tempDirectory();
    const target = path.join(directory, 'invalid-range.bin');
    const ranged: Resource = { ...server.resource, range: { offset: 2, length: 3 } };

    await expect(downloadResource(ranged, target, new AbortController().signal))
      .rejects.toMatchObject({ code: 'INVALID_RANGE' });
    await expect(access(target)).rejects.toThrow();
  });

  it('rejects truncated bodies and removes the incomplete part file', async () => {
    const server = await makeServer({ data: 'long enough body', truncateBytes: 4 });
    servers.push(server);
    const target = path.join(await tempDirectory(), 'truncated.bin');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const delays: number[] = [];
    const pending = downloadResource(server.resource, target, new AbortController().signal, {
      wait: (delayMs, signal) => new Promise<void>((resolve, reject) => {
        delays.push(delayMs);
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        }, delayMs);
        const onAbort = () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          reject(signal.reason);
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    }).then((value) => ({ value }), (error: unknown) => ({ error }));
    await waitForRequestCount(server, 1);
    await waitForCount(delays, 1, 'retry delays');
    await vi.advanceTimersByTimeAsync(1_000);
    await waitForRequestCount(server, 2);
    await waitForCount(delays, 2, 'retry delays');
    await vi.advanceTimersByTimeAsync(2_000);
    await waitForRequestCount(server, 3);
    await waitForCount(delays, 3, 'retry delays');
    await vi.advanceTimersByTimeAsync(4_000);
    await waitForRequestCount(server, 4);
    await waitForResponseCount(server, 4);
    expect(await pending).toMatchObject({ error: { code: 'NETWORK_ERROR' } });
    await expect(access(target)).rejects.toThrow();
    await expect(access(`${target}.part`)).rejects.toThrow();
    expect(server.requests).toBe(4);
  });

  it('stops an active request on abort and leaves no partial file', async () => {
    const server = await makeServer({ delayMs: 500 });
    servers.push(server);
    const target = path.join(await tempDirectory(), 'cancelled.bin');
    const controller = new AbortController();
    const pending = downloadResource(server.resource, target, controller.signal);
    await waitForRequestCount(server, 1);
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await expect(access(`${target}.part`)).rejects.toThrow();
  });
});

describe('runDownload', () => {
  it('keeps each task at four concurrent resource requests or fewer', async () => {
    const server = await makeServer({ delayMs: 25 });
    servers.push(server);
    const resources = Array.from({ length: 9 }, (_, index) => withResourceId(server.resource, `resource-${index}`));
    const manifest = { resources } as DownloadManifest;
    const progress: TaskView[] = [];

    await runDownload(manifest, await tempDirectory(), new AbortController().signal, (view) => progress.push(view));

    expect(server.requests).toBe(9);
    expect(server.maxConcurrent).toBeLessThanOrEqual(4);
    expect(progress.at(-1)?.completed).toBe(9);
  });
});

describe('TaskStore and TaskRunner', () => {
  it('serializes task records atomically and can list and reload them', async () => {
    const directory = await tempDirectory();
    const store = new FileTaskStore(directory);
    const manifest = await makeManifest(directory);
    const record = {
      manifest,
      view: { id: manifest.id, state: 'paused', completed: 0, total: 1, bytesPerSecond: 0 } satisfies TaskView,
      cacheDir: path.join(directory, 'cache', manifest.id),
      output: path.join(directory, 'output.mp4'),
      keepCache: true,
      outputMode: 'copy-mp4' as const,
      completed: {},
    };

    await Promise.all([store.save(record), store.save({ ...record, view: { ...record.view, error: 'saved' } })]);
    const loaded = await store.load(manifest.id);
    expect(loaded?.view.error).toBe('saved');
    expect(await store.list()).toHaveLength(1);
    expect((await readdir(directory)).some((name) => name.endsWith('.tmp'))).toBe(false);
  });

  it('marks interrupted work paused, removes stale parts, and verifies saved cache hashes on restart', async () => {
    const directory = await tempDirectory();
    const cacheRoot = path.join(directory, 'cache');
    const store = new FileTaskStore(path.join(directory, 'tasks'));
    const manifest = await makeManifest(directory);
    const cacheDir = path.join(cacheRoot, manifest.id);
    await mkdir(cacheDir, { recursive: true });
    const part = path.join(cacheDir, 'unfinished.part');
    const cached = path.join(cacheDir, 'segment.bin');
    await writeFile(part, 'partial');
    await writeFile(cached, 'tampered');
    await store.save({
      manifest,
      view: { id: manifest.id, state: 'downloading', completed: 1, total: 1, bytesPerSecond: 0 },
      cacheDir,
      output: path.join(directory, 'output.mp4'),
      keepCache: true,
      outputMode: 'copy-mp4',
      completed: { [manifest.resources[0]!.id]: { path: cached, bytes: 5, sha256: digest('valid') } },
    });

    const runner = new TaskRunner({ cacheRoot, store, merge: async () => {} });
    const [restored] = await runner.listTasks();
    expect(restored?.state).toBe('paused');
    await expect(access(part)).rejects.toThrow();
    expect(await store.load(manifest.id)).toMatchObject({ completed: {} });
  });

  it('rejects a saved cache path that points at another task directory', async () => {
    const directory = await tempDirectory();
    const cacheRoot = path.join(directory, 'cache');
    const manifest = await makeManifest(directory);
    const otherCache = path.join(cacheRoot, 'other-task');
    await mkdir(otherCache, { recursive: true });
    await writeFile(path.join(otherCache, 'preserve.bin'), 'other task cache');
    const store = new FileTaskStore(path.join(directory, 'tasks'));
    await store.save({
      manifest,
      view: { id: manifest.id, state: 'downloading', completed: 0, total: 1, bytesPerSecond: 0 },
      cacheDir: otherCache,
      output: path.join(directory, 'output.mp4'),
      keepCache: true,
      outputMode: 'copy-mp4',
      completed: {},
    });

    const runner = new TaskRunner({ cacheRoot, store });
    expect((await runner.listTasks()).find((task) => task.id === manifest.id)).toMatchObject({ state: 'failed', error: expect.stringContaining('INVALID_CACHE_PATH') });
    expect(await readFile(path.join(otherCache, 'preserve.bin'), 'utf8')).toBe('other task cache');
  });

  it.each(['pause', 'cancel'] as const)('preserves %s requested during claimed-task cache preflight', async (action) => {
    const directory = await tempDirectory();
    const manifest = await makeManifest(directory);
    const mergeCalls: string[] = [];
    const runner = new TaskRunner({
      cacheRoot: path.join(directory, 'cache'),
      store: new FileTaskStore(path.join(directory, 'tasks')),
      merge: async ({ output }) => { mergeCalls.push(output); },
    });
    await runner.listTasks();
    const preflight = holdTaskCachePreflight(runner);
    const started = runner.start(manifest, path.join(directory, 'output.mp4'), true);

    try {
      await preflight.entered.promise;
      expect((await runner.listTasks()).find((task) => task.id === manifest.id)?.state).toBe('queued');
      await runner.control({ id: manifest.id, action });
      preflight.release.resolve();

      const result = await started;
      await runner.shutdown(); // Wait for the claimed queue item and its final persistence to drain.
      expect(result.state).toBe(action === 'pause' ? 'paused' : 'cancelled');
      expect((await runner.listTasks()).find((task) => task.id === manifest.id)?.state).toBe(result.state);
      expect(mergeCalls).toEqual([]);
    } finally {
      preflight.release.resolve();
      await started.catch(() => {});
      preflight.restore();
      await runner.shutdown();
    }
  });

  it('pauses a claimed queued task instead of downloading it when shutdown begins during preflight', async () => {
    const server = await makeServer({ data: 'remote bytes' });
    servers.push(server);
    const directory = await tempDirectory();
    const manifest: DownloadManifest = {
      id: randomUUID(), resources: [server.resource], videoText: '', duration: 1,
      snapshotHash: digest('[]'), snapshots: [],
    };
    const runner = new TaskRunner({
      cacheRoot: path.join(directory, 'cache'),
      store: new FileTaskStore(path.join(directory, 'tasks')),
    });
    await runner.listTasks();
    const preflight = holdTaskCachePreflight(runner);
    const started = runner.start(manifest, path.join(directory, 'output.mp4'), true);

    try {
      await preflight.entered.promise;
      const shutdown = runner.shutdown();
      preflight.release.resolve();
      await shutdown;

      expect((await started).state).toBe('paused');
      expect((await runner.listTasks()).find((task) => task.id === manifest.id)?.state).toBe('paused');
      expect(server.requests).toBe(0);
    } finally {
      preflight.release.resolve();
      await started.catch(() => {});
      preflight.restore();
      await runner.shutdown();
    }
  });

  it('retains completed cache after pause and resumes by downloading unfinished resources', async () => {
    const server = await makeServer({ delayMs: (pathname) => pathname.includes('slow') ? 500 : 0, data: 'remote bytes' });
    servers.push(server);
    const directory = await tempDirectory();
    const cacheRoot = path.join(directory, 'cache');
    const store = new FileTaskStore(path.join(directory, 'tasks'));
    const manifest = await makeRemoteManifest(directory, new URL('/', server.resource.source.value).href);
    const runner = new TaskRunner({ cacheRoot, store, merge: async ({ output: pathToOutput }) => writeFile(pathToOutput, 'merged', { flag: 'wx' }) });
    const output = path.join(directory, 'output.mp4');
    const started = runner.start(manifest, output, true);
    await waitForRequestOrTask(server, 1, started);
    await waitForResponseCount(server, 1);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const current = await store.load(manifest.id);
      if (Object.keys(current?.completed ?? {}).length === 1) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const [initial] = await runner.listTasks();
    if (!initial) throw new Error('Task was not created.');
    await runner.control({ id: initial.id, action: 'pause' });
    const paused = await started;

    expect(paused.state).toBe('paused');
    const saved = await store.load(paused.id);
    expect(Object.keys(saved?.completed ?? {})).toHaveLength(1);
    const requestsAtPause = server.requests;
    await runner.control({ id: paused.id, action: 'resume' });
    const resumed = await waitForTaskState(runner, paused.id, 'completed');
    expect(resumed.state).toBe('completed');
    expect(server.requests - requestsAtPause).toBe(2);
    await runner.shutdown();
  });

  it.each(['pause', 'cancel'] as const)('keeps a durably completed cache file after %s races its save acknowledgement', async (action) => {
    const server = await makeServer({ data: 'accepted resource' });
    servers.push(server);
    const directory = await tempDirectory();
    const manifest: DownloadManifest = {
      id: randomUUID(), resources: [server.resource], videoText: '', duration: 1,
      snapshotHash: digest('[]'), snapshots: [],
    };
    const inner = new FileTaskStore(path.join(directory, 'tasks'));
    const store = new CompletionBarrierStore(inner);
    const runner = new TaskRunner({ cacheRoot: path.join(directory, 'cache'), store });
    const started = runner.start(manifest, path.join(directory, 'output.mp4'), true);

    try {
      await store.completionPersisted.promise;
      const durable = await inner.load(manifest.id);
      const completed = durable?.completed[server.resource.id];
      expect(completed).toBeDefined();
      if (!completed) throw new Error('Completion was not durably saved before the barrier.');

      await runner.control({ id: manifest.id, action });
      const stopped = await inner.load(manifest.id);
      expect(stopped?.view.state).toBe(action === 'pause' ? 'paused' : 'cancelled');
      expect(stopped?.completed[server.resource.id]?.path).toBe(completed.path);
      expect(await readFile(completed.path, 'utf8')).toBe('accepted resource');
    } finally {
      store.releaseCompletion.resolve();
    }

    await started;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const durable = await inner.load(manifest.id);
    const completed = durable?.completed[server.resource.id];
    expect(durable?.view.state).toBe(action === 'pause' ? 'paused' : 'cancelled');
    expect(completed).toBeDefined();
    if (!completed) throw new Error('The stopped task lost its durable completion.');
    expect(await readFile(completed.path, 'utf8')).toBe('accepted resource');
    expect(durable?.view.completed).toBe(1);
  });

  it('cancels and deduplicates a resume while remote snapshot validation is held', async () => {
    const playlistPath = '/playlist.m3u8';
    const segmentPath = '/segment.bin';
    const playlist = '#EXTM3U\n#EXTINF:1,\nsegment.bin\n#EXT-X-ENDLIST\n';
    const validationEntered = deferred();
    const duplicateValidationEntered = deferred();
    const releaseValidation = deferred();
    let holdValidation = false;
    let validationRequests = 0;
    const server = await makeServer({
      dataByPath: { [playlistPath]: playlist, [segmentPath]: 'segment bytes' },
      beforeRespond: async (pathname) => {
        if (!holdValidation || pathname !== playlistPath) return;
        validationRequests += 1;
        if (validationRequests === 1) validationEntered.resolve();
        else duplicateValidationEntered.resolve();
        await releaseValidation.promise;
      },
    });
    servers.push(server);
    const directory = await tempDirectory();
    const inspection = await inspectInput({ kind: 'url', url: new URL(playlistPath, server.resource.source.value).href });
    const variant = inspection.variants[0];
    if (!variant) throw new Error('Remote playlist fixture did not produce a media variant.');
    const manifest = await selectManifest(inspection.id, variant.id);
    const cacheRoot = path.join(directory, 'cache');
    const store = new FileTaskStore(path.join(directory, 'tasks'));
    await store.save({
      manifest,
      view: { id: manifest.id, state: 'paused', completed: 0, total: manifest.resources.length, bytesPerSecond: 0 },
      cacheDir: path.join(cacheRoot, manifest.id),
      output: path.join(directory, 'output.mp4'),
      keepCache: true,
      outputMode: 'copy-mp4',
      completed: {},
    });
    const runner = new TaskRunner({
      cacheRoot,
      store,
      merge: async ({ output }) => writeFile(output, 'merged', { flag: 'wx' }),
    });
    await runner.listTasks();
    holdValidation = true;

    const firstResume = runner.control({ id: manifest.id, action: 'resume' });
    const duplicateResume = runner.control({ id: manifest.id, action: 'resume' });
    try {
      await validationEntered.promise;
      const duplicateResult = await Promise.race([
        duplicateResume.then(() => 'ignored' as const, () => 'rejected' as const),
        duplicateValidationEntered.promise.then(() => 'started' as const),
      ]);

      await runner.control({ id: manifest.id, action: 'cancel' });
      releaseValidation.resolve();
      await Promise.allSettled([firstResume, duplicateResume]);
      for (let attempt = 0; attempt < 500; attempt += 1) {
        const state = (await runner.listTasks()).find((task) => task.id === manifest.id)?.state;
        if (state === 'completed' || state === 'cancelled' || state === 'failed') break;
        await new Promise<void>((resolve) => nativeSetTimeout(resolve, 10));
      }

      expect(duplicateResult).toBe('ignored');
      expect((await runner.listTasks()).find((task) => task.id === manifest.id)?.state).toBe('cancelled');
      expect(server.requestPaths.filter((pathname) => pathname === segmentPath)).toHaveLength(0);
    } finally {
      releaseValidation.resolve();
      await Promise.allSettled([firstResume, duplicateResume]);
    }
  });

  it('rejects clear during held resume validation and stays cleared after cancellation', async () => {
    const playlistPath = '/clear-playlist.m3u8';
    const segmentPath = '/clear-segment.bin';
    const playlist = '#EXTM3U\n#EXTINF:1,\nclear-segment.bin\n#EXT-X-ENDLIST\n';
    const validationEntered = deferred();
    const releaseValidation = deferred();
    let holdValidation = false;
    const server = await makeServer({
      dataByPath: { [playlistPath]: playlist, [segmentPath]: 'segment bytes' },
      beforeRespond: async (pathname) => {
        if (!holdValidation || pathname !== playlistPath) return;
        validationEntered.resolve();
        await releaseValidation.promise;
      },
    });
    servers.push(server);
    const directory = await tempDirectory();
    const inspection = await inspectInput({ kind: 'url', url: new URL(playlistPath, server.resource.source.value).href });
    const variant = inspection.variants[0];
    if (!variant) throw new Error('Remote playlist fixture did not produce a media variant.');
    const manifest = await selectManifest(inspection.id, variant.id);
    const cacheRoot = path.join(directory, 'cache');
    const cacheDir = path.join(cacheRoot, manifest.id);
    const store = new FileTaskStore(path.join(directory, 'tasks'));
    await store.save({
      manifest,
      view: { id: manifest.id, state: 'paused', completed: 0, total: manifest.resources.length, bytesPerSecond: 0 },
      cacheDir,
      output: path.join(directory, 'output.mp4'),
      keepCache: true,
      outputMode: 'copy-mp4',
      completed: {},
    });
    const runner = new TaskRunner({
      cacheRoot,
      store,
      merge: async ({ output }) => writeFile(output, 'merged', { flag: 'wx' }),
    });
    await runner.listTasks();
    holdValidation = true;
    const resuming = runner.control({ id: manifest.id, action: 'resume' });

    try {
      await validationEntered.promise;
      await expect(runner.control({ id: manifest.id, action: 'clear' })).rejects.toMatchObject({ code: 'TASK_ACTIVE' });
      expect((await runner.listTasks()).find((task) => task.id === manifest.id)?.state).toBe('paused');
      expect(await store.load(manifest.id)).toBeDefined();

      await runner.control({ id: manifest.id, action: 'cancel' });
      releaseValidation.resolve();
      await resuming;
      expect((await runner.listTasks()).find((task) => task.id === manifest.id)?.state).toBe('cancelled');

      await runner.control({ id: manifest.id, action: 'clear' });
      expect((await runner.listTasks()).some((task) => task.id === manifest.id)).toBe(false);
      expect(await store.load(manifest.id)).toBeUndefined();
      await expect(access(cacheDir)).rejects.toThrow();
      expect(server.requestPaths.filter((pathname) => pathname === segmentPath)).toHaveLength(0);
    } finally {
      releaseValidation.resolve();
      await Promise.allSettled([resuming]);
      const remaining = (await runner.listTasks()).find((task) => task.id === manifest.id);
      if (remaining) {
        if (remaining.state === 'queued' || remaining.state === 'downloading' || remaining.state === 'merging') {
          await runner.control({ id: manifest.id, action: 'cancel' }).catch(() => {});
        }
        await runner.control({ id: manifest.id, action: 'clear' }).catch(() => {});
      }
    }
  });

  it('redownloads a completed resource whose saved cache hash no longer matches', async () => {
    const server = await makeServer({ data: 'remote bytes' });
    servers.push(server);
    const directory = await tempDirectory();
    const cacheRoot = path.join(directory, 'cache');
    const manifest = await makeRemoteManifest(directory, new URL('/', server.resource.source.value).href);
    const first = manifest.resources[0]!;
    const cacheDir = path.join(cacheRoot, manifest.id);
    const cachedPath = path.join(cacheDir, `${first.id}.bin`);
    await mkdir(cacheDir, { recursive: true });
    await writeFile(cachedPath, 'tampered bytes');
    const store = new FileTaskStore(path.join(directory, 'tasks'));
    await store.save({
      manifest,
      view: { id: manifest.id, state: 'paused', completed: 1, total: manifest.resources.length, bytesPerSecond: 0 },
      cacheDir,
      output: path.join(directory, 'output.mp4'),
      keepCache: true,
      outputMode: 'copy-mp4',
      completed: { [first.id]: { path: cachedPath, bytes: 12, sha256: digest('remote bytes') } },
    });
    const runner = new TaskRunner({
      cacheRoot,
      store,
      merge: async ({ output }) => writeFile(output, 'merged', { flag: 'wx' }),
    });

    await runner.control({ id: manifest.id, action: 'resume' });
    await waitForTaskState(runner, manifest.id, 'completed');

    expect(server.requests).toBe(2);
    expect(await readFile(cachedPath, 'utf8')).toBe('remote bytes');
    expect(Object.keys((await store.load(manifest.id))?.completed ?? {})).toHaveLength(2);
  });

  it.each(['file', 'http', 'effective-file-url'] as const)(
    'preflights legacy remote-parent → local-child snapshots before any local read or fetch (%s parent references)',
    async (parentReferences) => {
      const directory = await tempDirectory();
      const { manifest, sourcePlaylistPaths, remoteParentUrl, remoteParentText } =
        await makeLegacyRemoteToFileManifest(directory, parentReferences);
      const protectedPaths = new Set(sourcePlaylistPaths.map((value) => path.resolve(value)));
      const localReads: string[] = [];
      const originalReadFile = (await import('node:fs/promises')).readFile;
      vi.doMock('node:fs/promises', async (importOriginal) => {
        const actual = await importOriginal<typeof import('node:fs/promises')>();
        return {
          ...actual,
          readFile: async (...args: Parameters<typeof actual.readFile>) => {
            const filePath = args[0];
            if (typeof filePath === 'string' && protectedPaths.has(path.resolve(filePath))) localReads.push(filePath);
            return originalReadFile(...args as Parameters<typeof originalReadFile>);
          },
        };
      });
      vi.resetModules();
      const { TaskRunner: IsolatedTaskRunner } = await import('../src/main/download/runner.js');

      let stored: TaskRecord = {
        manifest,
        view: { id: manifest.id, state: 'paused', completed: 0, total: manifest.resources.length, bytesPerSecond: 0 },
        cacheDir: path.join(directory, 'cache', manifest.id),
        output: path.join(directory, 'output.mp4'),
        keepCache: true,
        outputMode: 'copy-mp4',
        completed: {},
      };
      const store: TaskStore = {
        load: async () => structuredClone(stored),
        list: async () => [structuredClone(stored)],
        save: async (record) => { stored = structuredClone(record); },
      };
      const remoteFetches: string[] = [];
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        remoteFetches.push(String(input));
        return new Response(remoteParentText, { status: 200 });
      });
      const runner = new IsolatedTaskRunner({ cacheRoot: path.join(directory, 'cache'), store });
      await runner.listTasks();
      (runner as unknown as { kickQueue(): void }).kickQueue = () => {};

      try {
        await expect(runner.control({ id: manifest.id, action: 'resume' }))
          .rejects.toMatchObject({ code: 'UNSAFE_SNAPSHOT_GRAPH' });
        expect(localReads).toEqual([]);
        expect(remoteFetches).toEqual([]);
        expect((await runner.listTasks()).find((task) => task.id === manifest.id)?.state).toBe('failed');
      } finally {
        await runner.shutdown();
        vi.doUnmock('node:fs/promises');
        vi.resetModules();
      }
    },
  );

  it('resumes a local master that selects HTTP media and keeps its network resources', async () => {
    const playlistPath = '/local-master-child.m3u8';
    const segmentPath = '/local-master-segment.bin';
    const server = await makeServer({
      dataByPath: {
        [playlistPath]: '#EXTM3U\n#EXTINF:1,\nlocal-master-segment.bin\n#EXT-X-ENDLIST\n',
        [segmentPath]: 'remote segment bytes',
      },
    });
    servers.push(server);
    const directory = await tempDirectory();
    const rootPath = path.join(directory, 'local-master.m3u8');
    const childUrl = new URL(playlistPath, server.resource.source.value).href;
    await writeFile(rootPath, `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=128000\n${childUrl}\n`, 'utf8');
    const inspection = await inspectInput({ kind: 'file', path: rootPath });
    const variant = inspection.variants[0];
    if (!variant) throw new Error('Local master fixture did not produce a variant.');
    const manifest = await selectManifest(inspection.id, variant.id);
    expect(manifest.snapshots.map(({ source }) => source.kind)).toEqual(['url', 'file']);
    const cacheRoot = path.join(directory, 'cache');
    const store = new FileTaskStore(path.join(directory, 'tasks'));
    await store.save({
      manifest,
      view: { id: manifest.id, state: 'paused', completed: 0, total: manifest.resources.length, bytesPerSecond: 0 },
      cacheDir: path.join(cacheRoot, manifest.id),
      output: path.join(directory, 'output.mp4'),
      keepCache: true,
      outputMode: 'copy-mp4',
      completed: {},
    });
    const runner = new TaskRunner({
      cacheRoot,
      store,
      merge: async ({ output }) => writeFile(output, 'merged', { flag: 'wx' }),
    });

    await runner.control({ id: manifest.id, action: 'resume' });
    const result = await waitForTaskState(runner, manifest.id, 'completed');
    expect(result.state).toBe('completed');
    expect(server.requestPaths.filter((pathname) => pathname === playlistPath)).toHaveLength(2);
    expect(server.requestPaths.filter((pathname) => pathname === segmentPath)).toHaveLength(1);
    await runner.shutdown();
  });

  it('detects changed playlist snapshots before resuming and leaves original inputs in place', async () => {
    const directory = await tempDirectory();
    const manifest = await makeManifest(directory, Buffer.from('original segment'));
    const store = new FileTaskStore(path.join(directory, 'tasks'));
    const cacheRoot = path.join(directory, 'cache');
    const record = {
      manifest,
      view: { id: manifest.id, state: 'paused' as const, completed: 0, total: manifest.resources.length, bytesPerSecond: 0 },
      cacheDir: path.join(cacheRoot, manifest.id),
      output: path.join(directory, 'output.mp4'),
      keepCache: true,
      outputMode: 'copy-mp4' as const,
      completed: {},
    };
    await store.save(record);
    await writeFile(path.join(directory, 'source.m3u8'), '#EXTM3U\n#EXTINF:2,\nsegment.bin\n#EXT-X-ENDLIST\n');
    const runner = new TaskRunner({ cacheRoot, store, merge: async () => {} });

    await expect(runner.control({ id: manifest.id, action: 'resume' })).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
    expect(await readFile(path.join(directory, 'segment.bin'), 'utf8')).toBe('original segment');
    expect((await runner.listTasks()).find((task) => task.id === manifest.id)?.state).toBe('failed');
  });

  it('cancels an active transfer, preserves completed resources, and does not fake merge success', async () => {
    const server = await makeServer({ delayMs: 500 });
    servers.push(server);
    const directory = await tempDirectory();
    const manifest: DownloadManifest = {
      id: randomUUID(), resources: [server.resource], videoText: '', duration: 1,
      snapshotHash: digest('[]'), snapshots: [],
    };
    const store = new FileTaskStore(path.join(directory, 'tasks'));
    const runner = new TaskRunner({ cacheRoot: path.join(directory, 'cache'), store });
    const started = runner.start(manifest, path.join(directory, 'output.mp4'), true);
    await waitForRequestOrTask(server, 1, started);
    const task = (await runner.listTasks())[0];
    if (!task) throw new Error('Task was not created.');
    await runner.control({ id: task.id, action: 'cancel' });
    expect((await started).state).toBe('cancelled');
    const saved = await store.load(task.id);
    expect(saved?.completed).toEqual({});
    expect(saved?.view.error).toBeUndefined();
    await expect(access(path.join(saved!.cacheDir, `${server.resource.id}.bin.part`))).rejects.toThrow();
  });

  it('refuses to overwrite an existing output path', async () => {
    const directory = await tempDirectory();
    const manifest = await makeManifest(directory);
    const store = new FileTaskStore(path.join(directory, 'tasks'));
    const output = path.join(directory, 'existing.mp4');
    await writeFile(output, 'keep me');
    const runner = new TaskRunner({
      cacheRoot: path.join(directory, 'cache'), store,
      merge: async ({ output: pathToOutput }) => writeFile(pathToOutput, 'merged', { flag: 'wx' }),
    });

    await expect(runner.start(manifest, output, false)).rejects.toMatchObject({ code: 'OUTPUT_EXISTS' });
    expect(await readFile(output, 'utf8')).toBe('keep me');
  });
});
