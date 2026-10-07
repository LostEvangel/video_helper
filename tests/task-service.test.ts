import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServices } from '../src/main/services.js';
import { FileTaskStore } from '../src/main/download/store.js';
import { TaskRunner, type EnqueueOptions, type MergeRequest } from '../src/main/download/runner.js';

const temporaryDirectories: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'video-helper-service-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function localPlaylist(directory: string, name = '來源 清單.m3u8'): Promise<string> {
  const segment = path.join(directory, '分段一.ts');
  await writeFile(segment, 'local segment');
  const playlist = path.join(directory, name);
  await writeFile(playlist, `#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\n${path.basename(segment)}\n#EXT-X-ENDLIST\n`);
  return playlist;
}

async function playlistServer(endList: boolean): Promise<{ url: string; getSegmentRequests: () => number; getSegmentQueryRequests: () => number }> {
  let segmentRequests = 0;
  let segmentQueryRequests = 0;
  const server = createServer((request, response) => {
    if (request.url?.startsWith('/index.m3u8')) {
      response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      response.end(`#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nsegment.ts?token=secret\n${endList ? '#EXT-X-ENDLIST\n' : ''}`);
      return;
    }
    segmentRequests += 1;
    if (request.url?.includes('token=secret')) segmentQueryRequests += 1;
    response.writeHead(200, { 'content-length': '7' });
    response.end('segment');
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/index.m3u8?access=secret`,
    getSegmentRequests: () => segmentRequests,
    getSegmentQueryRequests: () => segmentQueryRequests,
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitForState(services: ReturnType<typeof createServices>, id: string, state: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const task = (await services.listTasks()).find((candidate) => candidate.id === id);
    if (task?.state === state) return task;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Task ${id} did not reach ${state}.`);
}

describe('real download task service', () => {
  it('rejects incomplete playlists and forged variants before any segment download', async () => {
    const directory = await tempDirectory();
    const remote = await playlistServer(false);
    const services = createServices({ userDataDir: path.join(directory, 'user-data') });

    const inspection = await services.inspect({ kind: 'url', url: remote.url });
    expect(new URL(inspection.variants[0]!.uri.value).search).toBe('');
    expect(inspection.variants[0]!.uri.value).not.toContain('secret');
    expect(inspection.example).toBe('segment.ts');
    await expect(services.start({
      inspectionId: inspection.id,
      variantId: inspection.variants[0]!.id,
      output: path.join(directory, 'incomplete.mp4'),
      outputMode: 'copy-mp4',
      keepCache: false,
    })).rejects.toMatchObject({ code: 'INCOMPLETE_PLAYLIST' });
    await expect(services.start({
      inspectionId: inspection.id,
      variantId: 'renderer-invented-variant',
      output: path.join(directory, 'forged.mp4'),
      outputMode: 'copy-mp4',
      keepCache: false,
    })).rejects.toMatchObject({ code: 'VARIANT_NOT_FOUND' });

    expect(remote.getSegmentRequests()).toBe(0);
    expect(await services.listTasks()).toEqual([]);
    await services.shutdown();
  });

  it('reports merging until the merge publisher has created the final output', async () => {
    const directory = await tempDirectory();
    const playlist = await localPlaylist(directory);
    const mergeEntered = deferred();
    const allowPublish = deferred();
    const services = createServices({
      userDataDir: path.join(directory, 'user-data'),
      mergeVideo: async ({ output }: MergeRequest) => {
        mergeEntered.resolve();
        await allowPublish.promise;
        await writeFile(output, 'published video', { flag: 'wx' });
      },
    });

    const inspection = await services.inspect({ kind: 'file', path: playlist });
    const started = await services.start({
      inspectionId: inspection.id,
      variantId: inspection.variants[0]!.id,
      output: path.join(directory, 'published.mp4'),
      outputMode: 'copy-mp4',
      keepCache: true,
    });
    await mergeEntered.promise;
    expect((await services.listTasks()).find((task) => task.id === started.id)?.state).toBe('merging');
    await expect(readFile(path.join(directory, 'published.mp4'))).rejects.toMatchObject({ code: 'ENOENT' });

    allowPublish.resolve();
    expect((await waitForState(services, started.id, 'completed')).state).toBe('completed');
    expect(await readFile(path.join(directory, 'published.mp4'), 'utf8')).toBe('published video');
    await services.shutdown();
  });

  it('downloads relative resources from a supplied base URL beside a local playlist', async () => {
    const directory = await tempDirectory();
    const playlist = await localPlaylist(directory);
    await writeFile(playlist, (await readFile(playlist, 'utf8')).replace('分段一.ts', '分段一.ts?token=secret'));
    const remote = await playlistServer(true);
    const baseUrl = new URL('./', remote.url).href;
    const services = createServices({
      userDataDir: path.join(directory, 'user-data'),
      mergeVideo: async ({ output }: MergeRequest) => writeFile(output, 'published video', { flag: 'wx' }),
    });
    const inspection = await services.inspect({ kind: 'file', path: playlist, baseUrl });
    expect(inspection.example).toBe('分段一.ts');
    const started = await services.start({
      inspectionId: inspection.id,
      variantId: inspection.variants[0]!.id,
      output: path.join(directory, 'base-url.mp4'),
      outputMode: 'copy-mp4',
      keepCache: true,
    });

    expect((await waitForState(services, started.id, 'completed')).state).toBe('completed');
    expect(remote.getSegmentRequests()).toBe(1);
    expect(remote.getSegmentQueryRequests()).toBe(1);
    expect(await readFile(path.join(directory, 'base-url.mp4'), 'utf8')).toBe('published video');
    await services.shutdown();
  });

  it('preserves enqueue order and old task cache roots when settings change', async () => {
    const directory = await tempDirectory();
    const playlist = await localPlaylist(directory);
    const mergeCalls: string[] = [];
    const firstEntered = deferred();
    const finishFirst = deferred();
    const secondEntered = deferred();
    const finishSecond = deferred();
    const services = createServices({
      userDataDir: path.join(directory, 'user-data'),
      mergeVideo: async ({ output }: MergeRequest) => {
        mergeCalls.push(output);
        if (mergeCalls.length === 1) {
          firstEntered.resolve();
          await finishFirst.promise;
        } else {
          secondEntered.resolve();
          await finishSecond.promise;
        }
        await writeFile(output, 'published video', { flag: 'wx' });
      },
    });

    const inspection = await services.inspect({ kind: 'file', path: playlist });
    const first = await services.start({
      inspectionId: inspection.id,
      variantId: inspection.variants[0]!.id,
      output: path.join(directory, 'first.mp4'),
      outputMode: 'copy-mp4',
      keepCache: true,
    });
    await firstEntered.promise;
    const originalCacheDirectory = (await new FileTaskStore(path.join(directory, 'user-data', 'tasks')).load(first.id))?.cacheDir;
    const newCacheDirectory = path.join(directory, '中文 長路徑 測試', 'cache');
    await services.updateSettings({ cacheDir: newCacheDirectory, keepCache: true, networkConcurrency: 6 });
    const second = await services.start({
      inspectionId: inspection.id,
      variantId: inspection.variants[0]!.id,
      output: path.join(directory, 'second.mp4'),
      outputMode: 'copy-mp4',
      keepCache: true,
    });
    const queued = await services.listTasks();
    expect(queued.map((task) => task.id)).toEqual([first.id, second.id]);
    expect(queued.map((task) => task.state)).toEqual(['merging', 'queued']);

    finishFirst.resolve();
    await secondEntered.promise;
    finishSecond.resolve();
    await Promise.all([waitForState(services, first.id, 'completed'), waitForState(services, second.id, 'completed')]);

    const store = new FileTaskStore(path.join(directory, 'user-data', 'tasks'));
    const [firstRecord, secondRecord] = await Promise.all([store.load(first.id), store.load(second.id)]);
    expect(firstRecord?.cacheDir).toBe(originalCacheDirectory);
    expect(firstRecord?.cacheDir).not.toContain('中文 長路徑');
    expect(secondRecord?.cacheDir).toContain(path.join('中文 長路徑 測試', 'cache'));
    expect(secondRecord?.networkConcurrency).toBe(6);
    expect(mergeCalls).toEqual([path.join(directory, 'first.mp4'), path.join(directory, 'second.mp4')]);
    await services.shutdown();
  });

  it('uses one captured settings snapshot when a settings save overlaps task enqueue', async () => {
    const directory = await tempDirectory();
    const playlist = await localPlaylist(directory);
    const services = createServices({
      userDataDir: path.join(directory, 'user-data'),
      mergeVideo: async ({ output }: MergeRequest) => writeFile(output, 'published video', { flag: 'wx' }),
    });
    const inspection = await services.inspect({ kind: 'file', path: playlist });
    const variant = inspection.variants[0];
    if (!variant) throw new Error('Local playlist fixture did not produce a selectable variant.');

    const originalEnqueue = TaskRunner.prototype.enqueue;
    const enqueueEntered = deferred();
    const releaseEnqueue = deferred();
    let capturedOptions: EnqueueOptions | undefined;
    const enqueueSpy = vi.spyOn(TaskRunner.prototype, 'enqueue').mockImplementation(async function (
      this: TaskRunner,
      manifest: Parameters<TaskRunner['enqueue']>[0],
      output: Parameters<TaskRunner['enqueue']>[1],
      keepCache: Parameters<TaskRunner['enqueue']>[2],
      options: EnqueueOptions = {},
    ) {
      if (options.networkConcurrency === undefined || options.cacheRoot === undefined) {
        throw new Error('Task enqueue did not receive a complete settings snapshot.');
      }
      capturedOptions = { networkConcurrency: options.networkConcurrency, cacheRoot: options.cacheRoot };
      enqueueEntered.resolve();
      await releaseEnqueue.promise;
      return originalEnqueue.call(this, manifest, output, keepCache, options);
    });
    const startPromise = services.start({
      inspectionId: inspection.id,
      variantId: variant.id,
      output: path.join(directory, 'overlap.mp4'),
      outputMode: 'copy-mp4',
      keepCache: true,
    });
    const newCacheDirectory = path.join(directory, 'new-settings-cache');

    try {
      await enqueueEntered.promise;
      const originalSettings = await services.getSettings();
      const update = services.updateSettings({
        ...originalSettings,
        cacheDir: newCacheDirectory,
        networkConcurrency: 6,
      });
      await update;
      releaseEnqueue.resolve();
      const started = await startPromise;
      await waitForState(services, started.id, 'completed');

      const record = await new FileTaskStore(path.join(directory, 'user-data', 'tasks')).load(started.id);
      expect(capturedOptions).toEqual({ networkConcurrency: originalSettings.networkConcurrency, cacheRoot: originalSettings.cacheDir });
      expect(record?.cacheDir).toBe(path.join(originalSettings.cacheDir, started.id));
      expect(record?.networkConcurrency).toBe(originalSettings.networkConcurrency);
      expect((await services.getSettings()).cacheDir).toBe(newCacheDirectory);
    } finally {
      releaseEnqueue.resolve();
      await startPromise.catch(() => {});
      enqueueSpy.mockRestore();
      await services.shutdown();
    }
  });
});
