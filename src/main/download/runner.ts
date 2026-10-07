import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import type { DownloadManifest, Locator, OutputMode, Resource, TaskControl, TaskView } from '../../shared/contracts.js';
import { parsePlaylist } from '../hls/parse.js';
import { resolveResource } from '../hls/resolve.js';
import { runDownload, resourceCachePath } from './queue.js';
import { DownloadError, downloadResourceWithMetadata, sha256File } from './resource.js';
import type { TaskRecord, TaskStore } from './store.js';

export type MergeRequest = {
  manifest: DownloadManifest;
  cacheDir: string;
  output: string;
  outputMode: OutputMode;
  signal: AbortSignal;
};

export type TaskRunnerOptions = {
  cacheRoot: string;
  cacheRoots?: string[];
  store: TaskStore;
  merge?: (request: MergeRequest) => Promise<void>;
};
export type EnqueueOptions = { networkConcurrency?: number; outputMode?: OutputMode; cacheRoot?: string };

type CompletedResource = NonNullable<TaskRecord['completed'][string]>;
type OutcomeWaiter = (view: TaskView) => void;

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLocaleLowerCase('en-US') === b.toLocaleLowerCase('en-US') : a === b;
}

function taskError(error: unknown): { code: string; message: string } {
  if (error instanceof DownloadError) return { code: error.code, message: redactSensitiveUrls(error.message) };
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return { code: error.code, message: redactSensitiveUrls(error instanceof Error ? error.message : String(error)) };
  }
  return { code: 'DOWNLOAD_FAILED', message: redactSensitiveUrls(error instanceof Error ? error.message : 'The task failed.') };
}

function redactSensitiveUrls(message: string): string {
  return message.replace(/https?:\/\/[^\s"'<>`]+/gi, (value) => {
    const punctuation = /[.,;:!?]+$/.exec(value)?.[0] ?? '';
    const candidate = punctuation ? value.slice(0, -punctuation.length) : value;
    try {
      const url = new URL(candidate);
      url.username = '';
      url.password = '';
      url.search = '';
      url.hash = '';
      return `${url.href}${punctuation}`;
    } catch {
      return '[redacted URL]';
    }
  });
}

function snapshotHash(manifest: DownloadManifest): string {
  return createHash('sha256')
    .update(JSON.stringify(manifest.snapshots.map((snapshot) => [snapshot.source, snapshot.baseUrl ?? null, snapshot.text])))
    .digest('hex');
}

function sameLocator(left: Locator, right: Locator): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'file') return samePath(left.value, right.value);
  try {
    const a = new URL(left.value);
    const b = new URL(right.value);
    a.hash = '';
    b.hash = '';
    return a.href === b.href;
  } catch {
    return left.value === right.value;
  }
}

function requireHttpUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DownloadError('UNSAFE_SNAPSHOT_GRAPH', 'A saved remote playlist has invalid URL provenance.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new DownloadError('UNSAFE_SNAPSHOT_GRAPH', 'A saved remote playlist no longer has HTTP(S) URL provenance.');
  }
}

/** Validate every persisted relationship before verifySnapshotGraph can read a local snapshot or fetch a URL. */
function preflightSnapshotGraph(manifest: DownloadManifest): void {
  if (manifest.snapshots.length === 0) return;
  const selectedCount = manifest.audioText === undefined ? 1 : 2;
  if (manifest.snapshots.length < selectedCount) {
    throw new DownloadError('SOURCE_CHANGED', 'A selected playlist snapshot is missing.');
  }

  const childReferences: Locator[][] = [];
  try {
    for (const snapshot of manifest.snapshots) {
      if (snapshot.source.kind === 'url') requireHttpUrl(snapshot.source.value);
      else if (snapshot.source.kind !== 'file' || !path.isAbsolute(snapshot.source.value) && !path.win32.isAbsolute(snapshot.source.value)) {
        throw new DownloadError('UNSAFE_SNAPSHOT_GRAPH', 'A saved local playlist has invalid path provenance.');
      }
      if (snapshot.baseUrl !== undefined) requireHttpUrl(snapshot.baseUrl);

      const context = { source: snapshot.source, ...(snapshot.baseUrl === undefined ? {} : { baseUrl: snapshot.baseUrl }) };
      const parsed = parsePlaylist(snapshot.text, (uri) => {
        const locator = resolveResource(uri, context);
        return `${locator.kind}:${locator.value}`;
      });
      if (parsed.kind === 'master') {
        childReferences.push([
          ...parsed.variants.map((variant) => resolveResource(variant.uri, context)),
          ...parsed.audio.flatMap((audio) => audio.attributes.URI ? [resolveResource(audio.attributes.URI, context)] : []),
        ]);
      } else {
        // Resolve keys too: they do not participate in segment identity, but are still authority-bearing references.
        for (const key of parsed.keys) if (key.uri) resolveResource(key.uri, context);
        for (const map of parsed.maps) resolveResource(map.uri, context);
        for (const segment of parsed.segments) resolveResource(segment.uri, context);
        childReferences.push([]);
      }
    }
  } catch (error) {
    if (error instanceof DownloadError) throw error;
    throw new DownloadError('UNSAFE_SNAPSHOT_GRAPH', 'A saved playlist graph contains a reference that cannot be safely validated.', false, { cause: error });
  }

  // Legacy tasks store selected playlists first and their parents afterward. A local selected
  // snapshot is safe only when an explicitly local parent names that exact path. Otherwise an
  // old HTTP→file redirect can disguise a remote child as a local playlist before the first
  // source read. A URL locator itself must also remain HTTP(S), checked above, so an old
  // effective file: URL can never become the base for resumed relative references.
  const parentSnapshots = manifest.snapshots.slice(selectedCount);
  for (const selected of manifest.snapshots.slice(0, selectedCount)) {
    if (selected.source.kind !== 'file' || parentSnapshots.length === 0) continue;
    const explicitlyLocalChild = parentSnapshots.some((parent, index) => parent.source.kind === 'file'
      && childReferences[selectedCount + index]?.some((reference) => sameLocator(reference, selected.source)));
    if (!explicitlyLocalChild) {
      throw new DownloadError('UNSAFE_SNAPSHOT_GRAPH', 'A saved local playlist has no explicit local parent; inspect the source again before resuming.');
    }
  }
}

function graphResourceId(role: Resource['role'], source: Locator, range?: Resource['range']): string {
  const identity = JSON.stringify([role, source.kind, source.value, range ?? null]);
  return `${role}-${createHash('sha256').update(identity).digest('hex')}`;
}

function graphResourcesFromPlaylist(text: string, snapshot: DownloadManifest['snapshots'][number]): Resource[] {
  const context = { source: snapshot.source, ...(snapshot.baseUrl === undefined ? {} : { baseUrl: snapshot.baseUrl }) };
  const identity = (uri: string) => {
    const locator = resolveResource(uri, context);
    return `${locator.kind}:${locator.value}`;
  };
  const parsed = parsePlaylist(text, identity);
  if (parsed.kind !== 'media') throw new DownloadError('SOURCE_CHANGED', 'A saved media playlist no longer parses as a media playlist.');
  const resources: Resource[] = [];
  for (const key of parsed.keys) {
    if (!key.uri) continue;
    const source = resolveResource(key.uri, context);
    resources.push({ id: graphResourceId('key', source), source, role: 'key' });
  }
  for (const map of parsed.maps) {
    const source = resolveResource(map.uri, context);
    resources.push({ id: graphResourceId('init', source, map.range), source, role: 'init', ...(map.range ? { range: map.range } : {}) });
  }
  for (const segment of parsed.segments) {
    const source = resolveResource(segment.uri, context);
    resources.push({ id: graphResourceId('segment', source, segment.range), source, role: 'segment', ...(segment.range ? { range: segment.range } : {}) });
  }
  return resources;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export class TaskRunner {
  private cacheRoot: string;
  private readonly cacheRoots = new Set<string>();
  private readonly records = new Map<string, TaskRecord>();
  private readonly waiters = new Map<string, Set<OutcomeWaiter>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly resumeValidations = new Map<string, AbortController>();
  private readonly clearingTasks = new Set<string>();
  private readonly ready: Promise<void>;
  private queueRunning = false;
  private shuttingDown = false;
  private nextQueueOrder = 1;

  constructor(private readonly options: TaskRunnerOptions) {
    this.cacheRoot = path.resolve(options.cacheRoot);
    this.cacheRoots.add(this.cacheRoot);
    for (const root of options.cacheRoots ?? []) this.cacheRoots.add(path.resolve(root));
    this.ready = this.restore();
  }

  /** Changes the root for newly enqueued tasks while keeping prior task roots trusted. */
  setCacheRoot(cacheRoot: string): void {
    const root = path.resolve(cacheRoot);
    this.cacheRoots.add(root);
    this.cacheRoot = root;
  }

  async enqueue(manifest: DownloadManifest, output: string, keepCache: boolean, enqueueOptions: EnqueueOptions = {}): Promise<TaskView> {
    // Capture every task-level setting before waiting on restore or filesystem work. Settings may
    // change while this enqueue is in flight, but an individual task must use one coherent snapshot.
    const networkConcurrency = enqueueOptions.networkConcurrency ?? 4;
    const outputMode = enqueueOptions.outputMode ?? 'copy-mp4';
    const cacheRoot = path.resolve(enqueueOptions.cacheRoot ?? this.cacheRoot);
    if (!Number.isInteger(networkConcurrency) || networkConcurrency < 1 || networkConcurrency > 8) {
      throw new DownloadError('INVALID_CONCURRENCY', 'Network concurrency must be an integer from 1 through 8.');
    }
    await this.ready;
    if (this.shuttingDown) throw new DownloadError('TASK_RUNNER_SHUTTING_DOWN', 'The task runner is shutting down.');
    if (this.records.has(manifest.id)) throw new DownloadError('TASK_EXISTS', 'A task with this manifest id already exists.');
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(manifest.id)) throw new DownloadError('INVALID_TASK_ID', 'The manifest id cannot be used as a task id.');
    const absoluteOutput = path.resolve(output);
    if (await pathExists(absoluteOutput)) throw new DownloadError('OUTPUT_EXISTS', 'The selected output already exists.');
    const cacheDir = path.join(cacheRoot, manifest.id);
    const resolvedCache = await this.ensureCacheDirectory(cacheRoot, cacheDir, true);
    this.cacheRoots.add(cacheRoot);
    const record: TaskRecord = {
      manifest,
      view: { id: manifest.id, state: 'queued', completed: 0, total: manifest.resources.length, bytesPerSecond: 0, output: absoluteOutput },
      cacheDir: resolvedCache,
      output: absoluteOutput,
      keepCache,
      outputMode,
      networkConcurrency,
      completed: {},
      queueOrder: this.nextQueueOrder++,
    };
    this.records.set(manifest.id, record);
    await this.persist(record);
    this.kickQueue();
    return { ...record.view };
  }

  async start(manifest: DownloadManifest, output: string, keepCache: boolean, enqueueOptions: EnqueueOptions = {}): Promise<TaskView> {
    const queued = await this.enqueue(manifest, output, keepCache, enqueueOptions);
    const record = this.records.get(queued.id);
    return record ? this.waitForOutcome(record) : queued;
  }

  async control(request: { id: string; action: TaskControl; outputMode?: OutputMode }): Promise<void> {
    await this.ready;
    const record = this.records.get(request.id);
    if (!record) throw new DownloadError('TASK_NOT_FOUND', 'The download task does not exist.');
    if (request.outputMode) {
      record.outputMode = request.outputMode;
      if (request.action === 'retry') {
        const extension = request.outputMode === 'copy-mkv' ? '.mkv' : '.mp4';
        const base = path.basename(record.output, path.extname(record.output));
        record.output = path.join(path.dirname(record.output), `${base}${extension}`);
        record.view.output = record.output;
      }
    }

    switch (request.action) {
      case 'pause':
        if (this.resumeValidations.has(request.id) && record.view.state === 'paused') {
          this.resumeValidations.get(request.id)?.abort();
          return;
        }
        if (record.view.state === 'merging') throw new DownloadError('MERGE_CANNOT_PAUSE', 'The merge phase can only be cancelled.');
        if (record.view.state === 'queued' || record.view.state === 'downloading') {
          record.view.state = 'paused';
          record.view.bytesPerSecond = 0;
          await this.persist(record);
          this.controllers.get(request.id)?.abort();
          this.settle(record);
        }
        return;
      case 'cancel':
        if (record.view.state === 'queued' || record.view.state === 'downloading' || record.view.state === 'merging'
          || this.resumeValidations.has(request.id)) {
          record.view.state = 'cancelled';
          record.view.bytesPerSecond = 0;
          delete record.view.error;
          this.resumeValidations.get(request.id)?.abort();
          await this.persist(record);
          this.controllers.get(request.id)?.abort();
          this.settle(record);
        }
        return;
      case 'resume':
        if (record.view.state !== 'paused') return;
        await this.validateAndQueue(record);
        return;
      case 'retry':
        if (record.view.state !== 'failed' && record.view.state !== 'cancelled') return;
        await this.validateAndQueue(record);
        return;
      case 'clear':
        if (record.view.state === 'queued' || record.view.state === 'downloading' || record.view.state === 'merging'
          || this.resumeValidations.has(request.id) || this.clearingTasks.has(request.id)) {
          throw new DownloadError('TASK_ACTIVE', 'Pause or cancel the task before clearing it.');
        }
        this.clearingTasks.add(request.id);
        try {
          await this.removeTaskCache(record);
          await this.options.store.delete?.(request.id);
          this.records.delete(request.id);
          this.settle(record);
        } finally {
          this.clearingTasks.delete(request.id);
        }
        return;
    }
  }

  async listTasks(): Promise<TaskView[]> {
    await this.ready;
    return [...this.records.values()]
      .sort((a, b) => (a.queueOrder ?? 0) - (b.queueOrder ?? 0))
      .map((record) => ({ ...record.view }));
  }

  /** Stop active work at stable task boundaries and flush durable task records before app shutdown. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    await this.ready;
    for (const controller of this.resumeValidations.values()) controller.abort();
    const active = [...this.records.values()].filter((record) => record.view.state === 'downloading' || record.view.state === 'merging');
    await Promise.all(active.map((record) => this.control({
      id: record.manifest.id,
      action: record.view.state === 'merging' ? 'cancel' : 'pause',
    }).catch(() => {})));
    while (this.queueRunning || this.resumeValidations.size > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    await this.options.store.flush?.();
  }

  private async validateAndQueue(record: TaskRecord): Promise<void> {
    if (this.shuttingDown) throw new DownloadError('TASK_RUNNER_SHUTTING_DOWN', 'The task runner is shutting down.');
    if (this.clearingTasks.has(record.manifest.id)) {
      throw new DownloadError('TASK_ACTIVE', 'The task is being cleared.');
    }
    if (this.resumeValidations.has(record.manifest.id)) return;
    const priorState = record.view.state;
    const controller = new AbortController();
    this.resumeValidations.set(record.manifest.id, controller);
    try {
      const valid = await this.prepareForResume(record, controller.signal);
      if (!valid || controller.signal.aborted || record.view.state !== priorState
        || this.records.get(record.manifest.id) !== record) return;
      record.view.state = 'queued';
      record.view.bytesPerSecond = 0;
      delete record.view.error;
      await this.persist(record);
      if (controller.signal.aborted || record.view.state !== 'queued'
        || this.records.get(record.manifest.id) !== record) return;
      this.kickQueue();
    } finally {
      if (this.resumeValidations.get(record.manifest.id) === controller) {
        this.resumeValidations.delete(record.manifest.id);
      }
    }
  }

  private async restore(): Promise<void> {
    await mkdir(this.cacheRoot, { recursive: true });
    const records = await this.options.store.list();
    records.sort((a, b) => (a.queueOrder ?? 0) - (b.queueOrder ?? 0));
    for (const record of records) {
      const id = record.manifest.id;
      if (record.view.id !== id || !/^[A-Za-z0-9_-]{1,160}$/.test(id)) continue;
      this.records.set(id, record);
      this.nextQueueOrder = Math.max(this.nextQueueOrder, (record.queueOrder ?? 0) + 1);
      let changed = false;
      if (record.view.state === 'downloading' || record.view.state === 'merging') {
        record.view.state = 'paused';
        record.view.bytesPerSecond = 0;
        changed = true;
      }
      if (record.view.state === 'completed' && !record.keepCache) {
        if (changed) await this.persist(record);
        continue;
      }
      try {
        record.cacheDir = await this.ensureTaskCacheDirectory(record, true);
        await this.cleanPartialFiles(record.cacheDir);
        changed = await this.verifyCompletedCacheFiles(record) || changed;
      } catch (error) {
        record.view.state = 'failed';
        record.view.error = `${taskError(error).code}: ${taskError(error).message}`;
        record.view.bytesPerSecond = 0;
        changed = true;
      }
      if (changed) await this.persist(record);
    }
    this.kickQueue();
  }

  private async ensureCacheDirectory(cacheRoot: string, directory: string, create: boolean): Promise<string> {
    const root = path.resolve(cacheRoot);
    const target = path.resolve(directory);
    if (!isInside(root, target)) throw new DownloadError('INVALID_CACHE_PATH', 'The task cache path is outside the application cache root.');
    await mkdir(root, { recursive: true });
    const rootReal = await realpath(root);
    const relative = path.relative(root, target);
    const expectedReal = path.resolve(rootReal, relative);
    if (create) await mkdir(target, { recursive: true });
    const targetReal = await realpath(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') throw new DownloadError('INVALID_CACHE_PATH', 'The task cache directory does not exist.');
      throw error;
    });
    if (!isInside(rootReal, targetReal) || !samePath(expectedReal, targetReal)) {
      throw new DownloadError('INVALID_CACHE_PATH', 'The resolved task cache path is outside its assigned task directory.');
    }
    return targetReal;
  }

  private async ensureTaskCacheDirectory(record: TaskRecord, create: boolean): Promise<string> {
    for (const root of this.cacheRoots) {
      let rootReal: string;
      try {
        await mkdir(root, { recursive: true });
        rootReal = await realpath(root);
      } catch {
        continue;
      }
      if (samePath(record.cacheDir, path.join(rootReal, record.manifest.id))) {
        return this.ensureCacheDirectory(root, path.join(root, record.manifest.id), create);
      }
    }
    throw new DownloadError('INVALID_CACHE_PATH', 'The saved task cache path does not match its task id.');
  }

  private async cleanPartialFiles(cacheDir: string): Promise<void> {
    const names = await readdir(cacheDir);
    await Promise.all(names.filter((name) => name.endsWith('.part')).map((name) => rm(path.join(cacheDir, name), { force: true })));
  }

  private async verifyCompletedCacheFiles(record: TaskRecord, signal?: AbortSignal): Promise<boolean> {
    let changed = false;
    const resourceById = new Map(record.manifest.resources.map((resource) => [resource.id, resource]));
    for (const [id, completed] of Object.entries({ ...record.completed })) {
      const resource = resourceById.get(id);
      if (!resource) {
        delete record.completed[id];
        changed = true;
        continue;
      }
      const expectedPath = resourceCachePath(record.cacheDir, id);
      if (!samePath(completed.path, expectedPath)) {
        delete record.completed[id];
        changed = true;
        continue;
      }
      try {
        const actual = await sha256File(expectedPath, signal);
        if (actual.bytes !== completed.bytes || actual.sha256 !== completed.sha256) {
          await rm(expectedPath, { force: true });
          delete record.completed[id];
          changed = true;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        delete record.completed[id];
        changed = true;
      }
    }
    record.view.completed = Object.keys(record.completed).length;
    return changed;
  }

  private async verifySnapshotGraph(manifest: DownloadManifest, signal: AbortSignal): Promise<void> {
    if (snapshotHash(manifest) !== manifest.snapshotHash) {
      throw new DownloadError('SOURCE_CHANGED', 'The saved playlist snapshot data no longer matches its hash.');
    }
    preflightSnapshotGraph(manifest);
    const currentSnapshots: DownloadManifest['snapshots'] = [];
    for (const expected of manifest.snapshots) {
      if (expected.source.kind === 'file') {
        let text: string;
        try {
          text = await readFile(expected.source.value, { encoding: 'utf8', signal });
        } catch {
          if (signal.aborted) throw signal.reason ?? new DOMException('Resume validation was aborted.', 'AbortError');
          throw new DownloadError('SOURCE_CHANGED', 'A saved local playlist is no longer available.');
        }
        currentSnapshots.push({ source: expected.source, text, ...(expected.baseUrl === undefined ? {} : { baseUrl: expected.baseUrl }) });
        continue;
      }
      let response: Response;
      try {
        const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
        response = await fetch(expected.source.value, { redirect: 'follow', signal: requestSignal });
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? new DOMException('Resume validation was aborted.', 'AbortError');
        if (error instanceof DownloadError) throw error;
        throw new DownloadError('SOURCE_VALIDATE_FAILED', 'A saved remote playlist could not be checked.', true, { cause: error });
      }
      if (!response.ok) throw new DownloadError('SOURCE_VALIDATE_FAILED', `A saved remote playlist returned HTTP ${response.status}.`, response.status >= 500);
      const source: Locator = { kind: 'url', value: response.url || expected.source.value };
      let text: string;
      try {
        text = await response.text();
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? new DOMException('Resume validation was aborted.', 'AbortError');
        throw new DownloadError('SOURCE_VALIDATE_FAILED', 'A saved remote playlist response could not be read.', true, { cause: error });
      }
      currentSnapshots.push({ source, text, ...(expected.baseUrl === undefined ? {} : { baseUrl: expected.baseUrl }) });
    }
    if (JSON.stringify(currentSnapshots) !== JSON.stringify(manifest.snapshots)) {
      throw new DownloadError('SOURCE_CHANGED', 'The playlist content or its final resource locations have changed.');
    }

    const selectedSnapshots = [manifest.snapshots[0], ...(manifest.audioText === undefined ? [] : [manifest.snapshots[1]])];
    const selectedTexts = [manifest.videoText, ...(manifest.audioText === undefined ? [] : [manifest.audioText])];
    if (selectedSnapshots.some((snapshot) => !snapshot)) throw new DownloadError('SOURCE_CHANGED', 'A selected media playlist snapshot is missing.');
    const currentResources: Resource[] = [];
    try {
      selectedSnapshots.forEach((snapshot, index) => currentResources.push(...graphResourcesFromPlaylist(selectedTexts[index]!, snapshot!)));
    } catch (error) {
      if (error instanceof DownloadError && error.code === 'SOURCE_CHANGED') throw error;
      throw new DownloadError('SOURCE_CHANGED', 'A saved playlist no longer describes the same resource graph.', false, { cause: error });
    }
    const expectedResources = [...manifest.resources].map((resource) => JSON.stringify(resource)).sort();
    const actualResources = currentResources
      .filter((resource, index, all) => all.findIndex((candidate) => candidate.id === resource.id) === index)
      .map((resource) => JSON.stringify(resource)).sort();
    if (JSON.stringify(expectedResources) !== JSON.stringify(actualResources)) {
      throw new DownloadError('SOURCE_CHANGED', 'The saved playlist resource graph no longer matches its resources.');
    }
  }

  private async verifyCompletedSources(record: TaskRecord, signal: AbortSignal): Promise<void> {
    const resourceById = new Map(record.manifest.resources.map((resource) => [resource.id, resource]));
    for (const [id, completed] of Object.entries(record.completed)) {
      if (signal.aborted) throw signal.reason ?? new DOMException('Resume validation was aborted.', 'AbortError');
      const resource = resourceById.get(id);
      if (!resource) throw new DownloadError('SOURCE_CHANGED', 'A cached resource is missing from the saved manifest.');
      const safeCache = await this.ensureTaskCacheDirectory(record, false);
      const expectedPath = resourceCachePath(safeCache, id);
      if (!samePath(completed.path, expectedPath)) throw new DownloadError('SOURCE_CHANGED', 'A cached resource path is invalid.');
      const currentCache = await sha256File(expectedPath, signal).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (!currentCache || currentCache.bytes !== completed.bytes || currentCache.sha256 !== completed.sha256) {
        await rm(expectedPath, { force: true });
        delete record.completed[id];
        record.view.completed = Object.keys(record.completed).length;
        await this.persist(record);
        continue;
      }

      const checkPath = path.join(safeCache, `.validate-${randomUUID()}.bin`);
      try {
        const verified = await downloadResourceWithMetadata(resource, checkPath, signal, {
          ...(completed.etag ? { etag: completed.etag } : {}),
          ...(completed.lastModified ? { lastModified: completed.lastModified } : {}),
        });
        if (verified.notModified) continue;
        if (verified.bytes !== completed.bytes || verified.sha256 !== completed.sha256) {
          throw new DownloadError('SOURCE_CHANGED', 'A cached source resource has changed since it was downloaded.');
        }
        const refreshed: CompletedResource = {
          ...completed,
          ...(verified.etag ? { etag: verified.etag } : {}),
          ...(verified.lastModified ? { lastModified: verified.lastModified } : {}),
        };
        record.completed[id] = refreshed;
        await this.persist(record);
      } finally {
        await rm(checkPath, { force: true }).catch(() => {});
        await rm(`${checkPath}.part`, { force: true }).catch(() => {});
      }
    }
  }

  private async prepareForResume(record: TaskRecord, signal: AbortSignal): Promise<boolean> {
    try {
      record.cacheDir = await this.ensureTaskCacheDirectory(record, true);
      await this.verifySnapshotGraph(record.manifest, signal);
      const cacheChanged = await this.verifyCompletedCacheFiles(record, signal);
      if (cacheChanged) await this.persist(record);
      await this.verifyCompletedSources(record, signal);
      return true;
    } catch (error) {
      if (signal.aborted) return false;
      record.view.state = 'failed';
      record.view.bytesPerSecond = 0;
      const failure = taskError(error);
      record.view.error = `${failure.code}: ${failure.message}`;
      await this.persist(record);
      this.settle(record);
      throw error;
    }
  }

  private kickQueue(): void {
    if (this.queueRunning) return;
    this.queueRunning = true;
    void (async () => {
      try {
        while (true) {
          if (this.shuttingDown) break;
          const next = [...this.records.values()]
            .filter((record) => record.view.state === 'queued')
            .sort((a, b) => (a.queueOrder ?? 0) - (b.queueOrder ?? 0))[0];
          if (!next) break;
          await this.execute(next);
        }
      } finally {
        this.queueRunning = false;
        if (!this.shuttingDown && [...this.records.values()].some((record) => record.view.state === 'queued')) this.kickQueue();
      }
    })();
  }

  private preflightStillCurrent(record: TaskRecord, controller: AbortController): boolean {
    return !this.shuttingDown
      && !controller.signal.aborted
      && this.controllers.get(record.manifest.id) === controller
      && this.records.get(record.manifest.id) === record
      && record.view.state === 'queued';
  }

  private async stopClaimedPreflight(record: TaskRecord, controller: AbortController): Promise<void> {
    // Shutdown may have claimed a queued record without changing its visible state. Convert only
    // that still-claimed record to paused; explicit pause/cancel requests keep their own state.
    if (!this.shuttingDown || controller.signal.aborted
      || this.controllers.get(record.manifest.id) !== controller
      || this.records.get(record.manifest.id) !== record
      || record.view.state !== 'queued') return;
    record.view.state = 'paused';
    record.view.bytesPerSecond = 0;
    await this.persist(record);
    this.settle(record);
  }

  private async execute(record: TaskRecord): Promise<void> {
    if (record.view.state !== 'queued') return;
    const controller = new AbortController();
    this.controllers.set(record.view.id, controller);
    try {
      const outputExists = await pathExists(record.output);
      if (!this.preflightStillCurrent(record, controller)) {
        await this.stopClaimedPreflight(record, controller);
        return;
      }
      if (outputExists) throw new DownloadError('OUTPUT_EXISTS', 'The selected output already exists.');
      const cacheDir = await this.ensureTaskCacheDirectory(record, true);
      if (!this.preflightStillCurrent(record, controller)) {
        await this.stopClaimedPreflight(record, controller);
        return;
      }
      record.cacheDir = cacheDir;
      await this.cleanPartialFiles(record.cacheDir);
      if (!this.preflightStillCurrent(record, controller)) {
        await this.stopClaimedPreflight(record, controller);
        return;
      }
      for (const resource of record.manifest.resources) {
        if (record.completed[resource.id]) continue;
        const orphan = resourceCachePath(record.cacheDir, resource.id);
        await rm(orphan, { force: true });
        if (!this.preflightStillCurrent(record, controller)) {
          await this.stopClaimedPreflight(record, controller);
          return;
        }
      }
      record.view.state = 'downloading';
      delete record.view.error;
      record.view.completed = Object.keys(record.completed).length;
      record.view.total = record.manifest.resources.length;
      await this.persist(record);
      if (this.shuttingDown || controller.signal.aborted
        || this.controllers.get(record.manifest.id) !== controller
        || this.records.get(record.manifest.id) !== record
        || record.view.state !== 'downloading') return;

      await runDownload(record.manifest, record.cacheDir, controller.signal, (progress) => {
        if (record.view.state !== 'downloading') return;
        record.view = { ...progress, id: record.manifest.id, output: record.output };
        void this.persist(record);
      }, {
        networkConcurrency: record.networkConcurrency ?? 4,
        completed: new Set(Object.keys(record.completed)),
        validators: Object.fromEntries(Object.entries(record.completed).map(([id, entry]) => [id, {
          ...(entry.etag ? { etag: entry.etag } : {}),
          ...(entry.lastModified ? { lastModified: entry.lastModified } : {}),
        }])),
        onResourceComplete: async (resource, result, filePath) => {
          if (controller.signal.aborted || record.view.state !== 'downloading') return false;
          record.completed[resource.id] = {
            path: filePath,
            bytes: result.bytes,
            sha256: result.sha256,
            ...(result.etag ? { etag: result.etag } : {}),
            ...(result.lastModified ? { lastModified: result.lastModified } : {}),
          };
          record.view.completed = Object.keys(record.completed).length;
          await this.persist(record);
          return true;
        },
      });
      if (record.view.state !== 'downloading' || controller.signal.aborted) return;

      record.view.state = 'merging';
      record.view.bytesPerSecond = 0;
      await this.persist(record);
      if (!this.options.merge) throw new DownloadError('MERGER_NOT_READY', 'The media merge service is not available yet.');
      if (await pathExists(record.output)) throw new DownloadError('OUTPUT_EXISTS', 'The selected output already exists.');
      await this.options.merge({
        manifest: record.manifest,
        cacheDir: record.cacheDir,
        output: record.output,
        outputMode: record.outputMode,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (!(await pathExists(record.output))) throw new DownloadError('MERGE_OUTPUT_MISSING', 'The merge service finished without creating the selected output.');
      record.view.state = 'completed';
      record.view.completed = record.manifest.resources.length;
      record.view.bytesPerSecond = 0;
      delete record.view.error;
      await this.persist(record);
      if (!record.keepCache) await this.removeTaskCache(record);
    } catch (error) {
      if (this.currentState(record) !== 'paused' && this.currentState(record) !== 'cancelled') {
        const failure = taskError(error);
        record.view.state = 'failed';
        record.view.bytesPerSecond = 0;
        record.view.error = `${failure.code}: ${failure.message}`;
        await this.persist(record);
      }
    } finally {
      this.controllers.delete(record.view.id);
      this.settle(record);
    }
  }

  private async removeTaskCache(record: TaskRecord): Promise<void> {
    const candidate = path.resolve(record.cacheDir);
    if (!(await pathExists(candidate))) return;
    const safeCache = await this.ensureTaskCacheDirectory(record, false);
    await rm(safeCache, { recursive: true, force: true });
  }

  private async persist(record: TaskRecord): Promise<void> {
    await this.options.store.save({
      ...record,
      view: { ...record.view },
      manifest: structuredClone(record.manifest),
      completed: Object.fromEntries(Object.entries(record.completed).map(([id, item]) => [id, { ...item }])),
    });
  }

  private currentState(record: TaskRecord): TaskView['state'] {
    return (record.view as TaskView).state;
  }

  private waitForOutcome(record: TaskRecord): Promise<TaskView> {
    if (record.view.state === 'paused' || record.view.state === 'failed' || record.view.state === 'cancelled' || record.view.state === 'completed') {
      return Promise.resolve({ ...record.view });
    }
    return new Promise((resolve) => {
      const waiters = this.waiters.get(record.view.id) ?? new Set<OutcomeWaiter>();
      waiters.add((view) => resolve({ ...view }));
      this.waiters.set(record.view.id, waiters);
    });
  }

  private settle(record: TaskRecord): void {
    if (record.view.state !== 'paused' && record.view.state !== 'failed' && record.view.state !== 'cancelled' && record.view.state !== 'completed') return;
    const waiters = this.waiters.get(record.view.id);
    if (!waiters) return;
    this.waiters.delete(record.view.id);
    for (const resolve of waiters) resolve({ ...record.view });
  }
}
