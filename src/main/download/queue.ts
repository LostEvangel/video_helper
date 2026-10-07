import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { DownloadManifest, Resource, TaskView } from '../../shared/contracts.js';
import { DownloadError, downloadResourceWithMetadata } from './resource.js';

const MAX_CONCURRENT_RESOURCES = 4;

export type ResourceDownloadResult = { bytes: number; sha256: string; etag?: string; lastModified?: string };
export type RunDownloadOptions = {
  networkConcurrency?: number;
  completed?: ReadonlySet<string>;
  validators?: Readonly<Record<string, { etag?: string; lastModified?: string }>>;
  onResourceComplete?: (resource: Resource, result: ResourceDownloadResult, destination: string) => void | boolean | Promise<void | boolean>;
};

export function resourceCachePath(cacheDir: string, resourceId: string): string {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(resourceId)) {
    throw new DownloadError('INVALID_RESOURCE_ID', 'A resource has an invalid cache identifier.');
  }
  const root = path.resolve(cacheDir);
  const target = path.resolve(root, `${resourceId}.bin`);
  if (path.dirname(target) !== root) throw new DownloadError('INVALID_RESOURCE_ID', 'A resource cache path is invalid.');
  return target;
}

export async function runDownload(
  manifest: DownloadManifest,
  cacheDir: string,
  signal: AbortSignal,
  onProgress: (view: TaskView) => void,
  options: RunDownloadOptions = {},
): Promise<void> {
  const requestedConcurrency = options.networkConcurrency ?? MAX_CONCURRENT_RESOURCES;
  if (!Number.isInteger(requestedConcurrency) || requestedConcurrency < 1 || requestedConcurrency > 8) {
    throw new DownloadError('INVALID_CONCURRENCY', 'Network concurrency must be an integer from 1 through 8.');
  }
  const resources = manifest.resources;
  await mkdir(cacheDir, { recursive: true });
  let completed = resources.reduce((count, resource) => count + (options.completed?.has(resource.id) ? 1 : 0), 0);
  let transferredBytes = 0;
  const startedAt = Date.now();
  const publishProgress = () => onProgress({
    id: manifest.id,
    state: 'downloading',
    completed,
    total: resources.length,
    bytesPerSecond: transferredBytes / Math.max(0.001, (Date.now() - startedAt) / 1_000),
  });
  publishProgress();
  if (resources.length === 0) return;

  const controller = new AbortController();
  const abortFromParent = () => controller.abort(signal.reason);
  if (signal.aborted) abortFromParent();
  else signal.addEventListener('abort', abortFromParent, { once: true });
  const taskSignal = controller.signal;
  let next = 0;
  let firstFailure: unknown;

  const worker = async () => {
    while (true) {
      if (taskSignal.aborted) return;
      const index = next;
      next += 1;
      if (index >= resources.length) return;
      const resource = resources[index]!;
      if (options.completed?.has(resource.id)) continue;
      const destination = resourceCachePath(cacheDir, resource.id);
      try {
        const result = await downloadResourceWithMetadata(resource, destination, taskSignal, options.validators?.[resource.id]);
        if (taskSignal.aborted) {
          await rm(destination, { force: true }).catch(() => {});
          return;
        }
        const accepted = await options.onResourceComplete?.(resource, result, destination);
        if (accepted === false) {
          await rm(destination, { force: true }).catch(() => {});
          throw new DownloadError('COMPLETION_NOT_ACCEPTED', 'The resource completion was not durably accepted.');
        }
        if (taskSignal.aborted) {
          if (accepted !== true) await rm(destination, { force: true }).catch(() => {});
          return;
        }
        completed += 1;
        transferredBytes += result.bytes;
        publishProgress();
      } catch (error) {
        if (!firstFailure) firstFailure = error;
        if (!taskSignal.aborted) controller.abort(error);
        return;
      }
    }
  };

  try {
    const workers = Array.from({ length: Math.min(requestedConcurrency, resources.length) }, () => worker());
    await Promise.all(workers);
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('The download was aborted.', 'AbortError');
    if (firstFailure) throw firstFailure;
    publishProgress();
  } finally {
    signal.removeEventListener('abort', abortFromParent);
  }
}
