import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AppSettings, AppServices, Inspection, InputSource, OutputMode, Preview, PreviewCancellation, TaskView } from '../shared/contracts.js';
import { FileTaskStore } from './download/store.js';
import { TaskRunner, type MergeRequest } from './download/runner.js';
import { inspectInput, selectManifest } from './hls/inspect.js';
import { localizeManifest } from './hls/localize.js';
import { mergeVideo } from './media/merge.js';
import { exportVideoFrame, saveVideoCover } from './media/cover.js';
import { extractFrame } from './media/frame.js';
import { probeVideoWithSignal } from './media/probe.js';
import { IpcAppError } from './ipc.js';
import { createPluginService } from './plugin/service.js';

export interface RuntimeServices extends AppServices {
  subscribeTasks(listener: (tasks: TaskView[]) => void): () => void;
  getCompletedTaskOutput(taskId: string): Promise<string>;
  shutdown(): Promise<void>;
}

type PersistedSettings = AppSettings & { version: 1; cacheRoots: string[] };
export type ServiceOptions = {
  userDataDir?: string;
  defaultCacheDir?: string;
  pluginDirectory?: string;
  mergeVideo?: (request: MergeRequest) => Promise<void>;
  extractFrame?: (path: string, time: number, signal: AbortSignal) => Promise<{ jpeg: Buffer; time: number }>;
};

const DEFAULT_NETWORK_CONCURRENCY = 4;
const MAX_INSPECTIONS = 64;

function notReady(feature: string): Promise<never> {
  return Promise.reject(new IpcAppError('SERVICE_NOT_READY', `${feature} 尚未就绪，请稍后重试。`));
}

function isAbsolutePath(value: string): boolean {
  return path.isAbsolute(value) || path.win32.isAbsolute(value);
}

function pathKey(value: string): string {
  const normalized = value.replaceAll('/', '\\').replace(/\\+$/, '');
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function validateSettings(input: AppSettings): AppSettings {
  if (!Number.isInteger(input.networkConcurrency) || input.networkConcurrency < 1 || input.networkConcurrency > 8) {
    throw new IpcAppError('INVALID_SETTINGS', 'Network concurrency must be an integer from 1 through 8.');
  }
  if (typeof input.keepCache !== 'boolean') throw new IpcAppError('INVALID_SETTINGS', 'Cache retention must be a boolean value.');
  if (typeof input.cacheDir !== 'string' || input.cacheDir.trim().length === 0 || input.cacheDir.length > 32_767 || !isAbsolutePath(input.cacheDir)) {
    throw new IpcAppError('INVALID_SETTINGS', 'The cache directory must be an absolute local path.');
  }
  return { networkConcurrency: input.networkConcurrency, keepCache: input.keepCache, cacheDir: path.resolve(input.cacheDir) };
}

function sanitizeLocator(locator: Inspection['variants'][number]['uri']): Inspection['variants'][number]['uri'] {
  if (locator.kind !== 'url') return locator;
  try {
    const parsed = new URL(locator.value);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return { kind: 'url', value: parsed.href };
  } catch {
    return { kind: 'url', value: '[invalid URL]' };
  }
}

function sanitizeExample(example: string): string {
  if (/^https?:/i.test(example)) return sanitizeLocator({ kind: 'url', value: example }).value;
  return example.replace(/[?#].*$/, '');
}

function publicInspection(inspection: Inspection): Inspection {
  return {
    ...inspection,
    variants: inspection.variants.map((variant) => ({ ...variant, uri: sanitizeLocator(variant.uri) })),
    audioTracks: inspection.audioTracks.map((track) => ({
      ...track,
      ...(track.uri === undefined ? {} : { uri: sanitizeLocator(track.uri) }),
    })),
    ...(inspection.example === undefined ? {} : { example: sanitizeExample(inspection.example) }),
  };
}

function extensionForMode(mode: OutputMode): string {
  return mode === 'copy-mkv' ? '.mkv' : '.mp4';
}

export function createServices(options: ServiceOptions = {}): RuntimeServices {
  const userDataDir = path.resolve(options.userDataDir ?? path.join(process.cwd(), '.video-helper-data'));
  const settingsPath = path.join(userDataDir, 'settings.json');
  const defaultCacheDir = path.resolve(options.defaultCacheDir ?? path.join(userDataDir, 'cache'));
  const plugin = createPluginService({
    pluginDirectory: options.pluginDirectory ?? path.resolve(process.cwd(), 'native', 'thumbnail', 'dist'),
  });
  let settingsPromise: Promise<PersistedSettings> | undefined;
  let runnerPromise: Promise<TaskRunner> | undefined;
  let updateTail: Promise<void> = Promise.resolve();
  let pollTimer: NodeJS.Timeout | undefined;
  let polling = false;
  let previousTaskSnapshot = '';
  const inspections = new Map<string, Inspection>();
  const taskListeners = new Set<(tasks: TaskView[]) => void>();
  let activePreview: { path: string; requestId: number; sessionId: number; controller: AbortController } | undefined;
  let activeProbe: { path: string; sessionId: number; controller: AbortController } | undefined;
  const activeMediaOperations = new Set<AbortController>();
  const extract = options.extractFrame ?? extractFrame;

  function cancelPreview(request: PreviewCancellation): void {
    if (activePreview && pathKey(activePreview.path) === pathKey(request.path)
      && ((request.requestId !== undefined && activePreview.requestId === request.requestId)
        || (request.sessionId !== undefined && activePreview.sessionId === request.sessionId))) {
      activePreview.controller.abort();
      activePreview = undefined;
    }
    if (request.sessionId !== undefined && activeProbe && pathKey(activeProbe.path) === pathKey(request.path)
      && activeProbe.sessionId === request.sessionId) {
      activeProbe.controller.abort();
      activeProbe = undefined;
    }
  }

  async function runMediaOperation<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    activeMediaOperations.add(controller);
    try {
      return await operation(controller.signal);
    } finally {
      activeMediaOperations.delete(controller);
    }
  }

  async function loadSettings(): Promise<PersistedSettings> {
    if (settingsPromise) return settingsPromise;
    settingsPromise = (async () => {
      try {
        const parsed = JSON.parse(await readFile(settingsPath, 'utf8')) as Partial<PersistedSettings>;
        if (parsed.version === 1 && typeof parsed.networkConcurrency === 'number'
          && Number.isInteger(parsed.networkConcurrency) && parsed.networkConcurrency >= 1 && parsed.networkConcurrency <= 8
          && typeof parsed.keepCache === 'boolean' && typeof parsed.cacheDir === 'string' && isAbsolutePath(parsed.cacheDir)) {
          const cacheDir = path.resolve(parsed.cacheDir);
          const cacheRoots = Array.isArray(parsed.cacheRoots)
            ? parsed.cacheRoots.filter((item): item is string => typeof item === 'string' && isAbsolutePath(item)).map((item) => path.resolve(item))
            : [];
          if (!cacheRoots.some((root) => pathKey(root) === pathKey(cacheDir))) cacheRoots.push(cacheDir);
          return { version: 1, networkConcurrency: parsed.networkConcurrency, keepCache: parsed.keepCache, cacheDir, cacheRoots };
        }
      } catch {
        // A missing or invalid preferences file uses safe defaults.
      }
      return {
        version: 1,
        networkConcurrency: DEFAULT_NETWORK_CONCURRENCY,
        keepCache: false,
        cacheDir: defaultCacheDir,
        cacheRoots: [defaultCacheDir],
      };
    })();
    return settingsPromise;
  }

  async function persistSettings(settings: PersistedSettings): Promise<void> {
    await mkdir(userDataDir, { recursive: true });
    const target = settingsPath;
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }

  async function ensureWritableCacheDirectory(directory: string): Promise<void> {
    const probe = path.join(directory, `.video-helper-write-test-${randomUUID()}`);
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(probe, '', { encoding: 'utf8', flag: 'wx' });
    } catch {
      throw new IpcAppError('CACHE_DIRECTORY_UNAVAILABLE', 'The selected cache directory could not be created or written.');
    } finally {
      await rm(probe, { force: true }).catch(() => {});
    }
  }

  async function getRunner(): Promise<TaskRunner> {
    if (!runnerPromise) {
      runnerPromise = (async () => {
        const settings = await loadSettings();
        const store = new FileTaskStore(path.join(userDataDir, 'tasks'));
        const merge = options.mergeVideo ?? (async (request: MergeRequest) => {
          const localized = await localizeManifest(request.manifest, request.cacheDir);
          await mergeVideo({
            video: localized.video,
            ...(localized.audio === undefined ? {} : { audio: localized.audio }),
            output: request.output,
            mode: request.outputMode,
            expectedDuration: request.manifest.duration,
          }, request.signal);
        });
        return new TaskRunner({ cacheRoot: settings.cacheDir, cacheRoots: settings.cacheRoots, store, merge });
      })();
    }
    return runnerPromise;
  }

  async function publishTaskSnapshot(force = false): Promise<void> {
    if (polling || taskListeners.size === 0) return;
    polling = true;
    try {
      const tasks = await (await getRunner()).listTasks();
      const snapshot = JSON.stringify(tasks);
      if (force || snapshot !== previousTaskSnapshot) {
        previousTaskSnapshot = snapshot;
        for (const listener of taskListeners) listener(tasks.map((task) => ({ ...task })));
      }
    } catch {
      // The next poll can retry a transient store failure without breaking the renderer bridge.
    } finally {
      polling = false;
    }
  }

  function ensureTaskPolling(): void {
    if (pollTimer) return;
    pollTimer = setInterval(() => { void publishTaskSnapshot(); }, 250);
    pollTimer.unref();
  }

  return {
    inspect: async (source: InputSource) => {
      const inspection = await inspectInput(source);
      inspections.set(inspection.id, inspection);
      while (inspections.size > MAX_INSPECTIONS) inspections.delete(inspections.keys().next().value!);
      return publicInspection(inspection);
    },
    start: async (request) => {
      const inspection = inspections.get(request.inspectionId);
      if (!inspection) throw new IpcAppError('INSPECTION_NOT_FOUND', 'This playlist inspection is no longer available. Inspect the playlist again.');
      if (!inspection.variants.some((variant) => variant.id === request.variantId)) {
        throw new IpcAppError('VARIANT_NOT_FOUND', 'The selected variant does not belong to this inspection.');
      }
      const manifest = await selectManifest(request.inspectionId, request.variantId, request.audioId);
      const extension = extensionForMode(request.outputMode);
      if (path.extname(request.output).toLocaleLowerCase('en-US') !== extension) {
        throw new IpcAppError('INVALID_OUTPUT_EXTENSION', `Choose a ${extension.toUpperCase()} filename for the selected output mode.`);
      }
      const settings = await loadSettings();
      const taskSettings = {
        outputMode: request.outputMode,
        networkConcurrency: settings.networkConcurrency,
        cacheRoot: settings.cacheDir,
      };
      const runner = await getRunner();
      const task = await runner.enqueue(manifest, request.output, request.keepCache, taskSettings);
      void publishTaskSnapshot(true);
      return task;
    },
    listTasks: async () => (await getRunner()).listTasks(),
    control: async (request) => {
      await (await getRunner()).control(request);
      void publishTaskSnapshot(true);
    },
    getSettings: async () => {
      const { networkConcurrency, keepCache, cacheDir } = await loadSettings();
      return { networkConcurrency, keepCache, cacheDir };
    },
    updateSettings: async (input) => {
      const update = updateTail.then(async () => {
        const requested = validateSettings(input);
        const current = await loadSettings();
        if (pathKey(requested.cacheDir) !== pathKey(current.cacheDir)) await ensureWritableCacheDirectory(requested.cacheDir);
        const cacheRoots = [...new Map([...current.cacheRoots, requested.cacheDir].map((root) => [pathKey(root), root])).values()];
        const next: PersistedSettings = { version: 1, ...requested, cacheRoots };
        await persistSettings(next);
        settingsPromise = Promise.resolve(next);
        if (runnerPromise) (await runnerPromise).setCacheRoot(requested.cacheDir);
        return requested;
      });
      updateTail = update.then(() => undefined, () => undefined);
      return update;
    },
    getCompletedTaskOutput: async (taskId: string) => {
      const task = (await (await getRunner()).listTasks()).find((item) => item.id === taskId);
      if (!task || task.state !== 'completed' || !task.output) {
        throw new IpcAppError('TASK_OUTPUT_UNAVAILABLE', 'Only a completed task can open its published video.');
      }
      return task.output;
    },
    probe: async (filePath, sessionId) => {
      activeProbe?.controller.abort();
      const controller = new AbortController();
      const job = { path: filePath, sessionId, controller };
      activeProbe = job;
      try {
        const result = await probeVideoWithSignal(filePath, controller.signal);
        if (activeProbe !== job) throw new IpcAppError('PREVIEW_SUPERSEDED', '此视频信息请求已被较新的选择替代。');
        return result;
      } catch (error) {
        throw error;
      } finally {
        if (activeProbe === job) activeProbe = undefined;
      }
    },
    preview: async (request): Promise<Preview> => {
      activeProbe?.controller.abort();
      activeProbe = undefined;
      activePreview?.controller.abort();
      const controller = new AbortController();
      const job = { path: request.path, requestId: request.requestId, sessionId: request.sessionId, controller };
      activePreview = job;
      try {
        const frame = await extract(request.path, request.time, controller.signal);
        controller.signal.throwIfAborted();
        if (activePreview !== job) throw new IpcAppError('PREVIEW_SUPERSEDED', '此预览已被较新的时间替代。');
        return {
          requestId: request.requestId,
          imageUrl: `data:image/jpeg;base64,${frame.jpeg.toString('base64')}`,
          time: frame.time,
        };
      } catch (error) {
        throw error;
      } finally {
        if (activePreview === job) activePreview = undefined;
      }
    },
    cancelPreview: async (request) => cancelPreview(request),
    saveCover: async (request) => {
      const result = await runMediaOperation((signal) => saveVideoCover(request, signal));
      if (process.platform === 'win32') {
        try { await plugin.notifyFileChanged(result.output); }
        catch { console.warn('Windows did not accept the thumbnail refresh notification for the saved cover.'); }
      }
      return result;
    },
    exportFrame: (request) => runMediaOperation((signal) => exportVideoFrame(request, signal)),
    pluginStatus: () => plugin.getPluginStatus(),
    changePlugin: (action) => plugin.changePlugin(action),
    subscribeTasks: (listener) => {
      taskListeners.add(listener);
      ensureTaskPolling();
      void publishTaskSnapshot(true);
      return () => {
        taskListeners.delete(listener);
        if (taskListeners.size === 0 && pollTimer) {
          clearInterval(pollTimer);
          pollTimer = undefined;
        }
      };
    },
    shutdown: async () => {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = undefined;
      activePreview?.controller.abort();
      activePreview = undefined;
      activeProbe?.controller.abort();
      activeProbe = undefined;
      for (const controller of activeMediaOperations) controller.abort();
      taskListeners.clear();
      if (runnerPromise) await (await runnerPromise).shutdown();
    },
  };
}

const childProcesses = new Set<ChildProcess>();

export function registerChildProcess(child: ChildProcess): () => void {
  childProcesses.add(child);
  const remove = () => childProcesses.delete(child);
  child.once('close', remove);
  child.once('error', remove);
  return remove;
}

export async function terminateChildProcesses(timeoutMs = 2_000): Promise<void> {
  const running = [...childProcesses].filter((child) => child.exitCode === null && child.signalCode === null);
  if (running.length === 0) return;

  for (const child of running) {
    try {
      child.kill('SIGTERM');
    } catch {
      // The process may have exited between the state check and kill.
    }
  }

  const closed = Promise.all(running.map((child) => new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once('close', () => resolve());
    child.once('error', () => resolve());
  })));
  await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))]);

  for (const child of running) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    try {
      child.kill('SIGKILL');
    } catch {
      // Ignore a process that exited during shutdown.
    }
  }
  await Promise.allSettled(running.map((child) => new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once('close', () => resolve());
    child.once('error', () => resolve());
    setTimeout(resolve, 1_000);
  })));
  childProcesses.clear();
}
