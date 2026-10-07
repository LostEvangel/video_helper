import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { link, mkdir, rm, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Resource } from '../../shared/contracts.js';

const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000] as const;

export class DownloadError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable = false, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DownloadError';
    this.code = code;
    this.retryable = retryable;
  }
}

export type DownloadedResource = {
  bytes: number;
  sha256: string;
  etag?: string;
  lastModified?: string;
  notModified?: boolean;
};

export type ConditionalValidators = { etag?: string; lastModified?: string };
export type DownloadOptions = {
  wait?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  createWriteStream?: (partPath: string) => NodeJS.WritableStream;
};

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new DOMException('The download was aborted.', 'AbortError');
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function ensureRange(resource: Resource): void {
  const range = resource.range;
  if (!range) return;
  if (!Number.isSafeInteger(range.offset) || range.offset < 0
    || !Number.isSafeInteger(range.length) || range.length <= 0
    || !Number.isSafeInteger(range.offset + range.length)) {
    throw new DownloadError('INVALID_RANGE', 'The requested byte range is invalid.');
  }
}

function hasFile(filePath: string): Promise<boolean> {
  return stat(filePath).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
}

async function waitForRetry(delay: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw abortError(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delay);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(abortError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function contentLength(response: Response): number | undefined {
  const header = response.headers.get('content-length');
  if (header === null) return undefined;
  if (!/^\d+$/.test(header)) throw new DownloadError('INVALID_LENGTH', 'The server returned an invalid Content-Length.');
  const length = Number(header);
  if (!Number.isSafeInteger(length)) throw new DownloadError('INVALID_LENGTH', 'The server returned an invalid Content-Length.');
  return length;
}

type StreamResult = { bytes: number; sha256: string; sourceBytes: number };

async function saveSelectedStream(
  source: NodeJS.ReadableStream,
  partPath: string,
  selection: { skip: number; length?: number; expectedSourceLength?: number; expectedOutputLength?: number },
  output: NodeJS.WritableStream = createWriteStream(partPath, { flags: 'wx' }),
  signal?: AbortSignal,
): Promise<StreamResult> {
  const hash = createHash('sha256');
  let bytes = 0;
  let sourceBytes = 0;
  const transform = new Transform({
    transform(chunk: Buffer | string, _encoding, callback) {
      const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const chunkStart = sourceBytes;
      sourceBytes += input.length;
      const left = Math.max(0, selection.skip - chunkStart);
      const start = Math.min(input.length, left);
      const available = input.length - start;
      const remaining = selection.length === undefined ? available : Math.max(0, selection.length - bytes);
      const output = input.subarray(start, start + Math.min(available, remaining));
      if (selection.expectedSourceLength !== undefined && sourceBytes > selection.expectedSourceLength) {
        callback(new DownloadError('INVALID_LENGTH', 'The response body exceeded its declared Content-Length.'));
        return;
      }
      if (output.length > 0) {
        bytes += output.length;
        hash.update(output);
      }
      callback(null, output);
    },
    flush(callback) {
      if (selection.expectedSourceLength !== undefined && sourceBytes !== selection.expectedSourceLength) {
        callback(new DownloadError('NETWORK_ERROR', 'The response body ended before its declared Content-Length.', true));
        return;
      }
      if (selection.expectedOutputLength !== undefined && bytes !== selection.expectedOutputLength) {
        callback(new DownloadError('INVALID_RANGE', 'The response did not contain the complete requested byte range.'));
        return;
      }
      callback();
    },
  });

  await pipeline(source, transform, output, { signal });
  return { bytes, sha256: hash.digest('hex'), sourceBytes };
}

function mapStatus(status: number): DownloadError {
  if (status === 401 || status === 403) return new DownloadError('ACCESS_DENIED', 'The resource server denied access.');
  if (status === 404) return new DownloadError('RESOURCE_NOT_FOUND', 'The resource was not found.');
  if (status === 502 || status === 503 || status === 504 || status === 408) {
    return new DownloadError('HTTP_RETRYABLE', `The resource server returned HTTP ${status}.`, true);
  }
  if (status === 416) return new DownloadError('INVALID_RANGE', 'The resource server rejected the requested byte range.');
  return new DownloadError('HTTP_ERROR', `The resource server returned HTTP ${status}.`);
}

function makeRequestSignal(parent: AbortSignal): { signal: AbortSignal; timedOut: () => boolean; dispose: () => void } {
  const controller = new AbortController();
  let timeout = false;
  const onAbort = () => controller.abort(parent.reason ?? new DOMException('The download was aborted.', 'AbortError'));
  if (parent.aborted) onAbort();
  else parent.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    timeout = true;
    controller.abort(new DOMException('The request timed out.', 'TimeoutError'));
  }, REQUEST_TIMEOUT_MS);
  return {
    signal: controller.signal,
    timedOut: () => timeout,
    dispose: () => {
      clearTimeout(timer);
      parent.removeEventListener('abort', onAbort);
    },
  };
}

async function downloadOnce(
  resource: Resource,
  partPath: string,
  signal: AbortSignal,
  validators: ConditionalValidators,
  options: DownloadOptions,
): Promise<DownloadedResource> {
  ensureRange(resource);
  if (signal.aborted) throw abortError(signal);

  if (resource.source.kind === 'file') {
    const fileStat = await stat(resource.source.value).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') throw new DownloadError('SOURCE_NOT_FOUND', 'The local source file no longer exists.');
      throw error;
    });
    const range = resource.range;
    const offset = range?.offset ?? 0;
    const expectedOutputLength = range?.length ?? fileStat.size;
    if (offset + expectedOutputLength > fileStat.size) {
      throw new DownloadError('INVALID_RANGE', 'The requested byte range exceeds the local file length.');
    }
    const input = createReadStream(resource.source.value, range
      ? { start: offset, end: offset + range.length - 1 }
      : undefined);
    let result: StreamResult;
    try {
      result = await saveSelectedStream(input, partPath, {
        skip: 0,
        expectedSourceLength: expectedOutputLength,
        expectedOutputLength,
      }, options.createWriteStream?.(partPath), signal);
    } catch (error) {
      if (signal.aborted) throw abortError(signal);
      if (error instanceof DownloadError) throw error;
      throw new DownloadError('LOCAL_IO_ERROR', 'The local source could not be read or copied.', false, { cause: error });
    }
    return { bytes: result.bytes, sha256: result.sha256 };
  }

  const requestSignal = makeRequestSignal(signal);
  try {
    let url: URL;
    try {
      url = new URL(resource.source.value);
    } catch {
      throw new DownloadError('INVALID_RESOURCE_URL', 'The resource URL is invalid.');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new DownloadError('UNSUPPORTED_FORMAT', `Resource protocol ${url.protocol} is not supported.`);
    }
    const headers = new Headers();
    if (resource.range) headers.set('range', `bytes=${resource.range.offset}-${resource.range.offset + resource.range.length - 1}`);
    if (validators.etag) headers.set('if-none-match', validators.etag);
    else if (validators.lastModified) headers.set('if-modified-since', validators.lastModified);
    const response = await fetch(url.href, { headers, signal: requestSignal.signal, redirect: 'follow' });
    if (response.status === 304) {
      if (!validators.etag && !validators.lastModified) throw new DownloadError('HTTP_ERROR', 'The server returned an unexpected not-modified response.');
      return {
        bytes: 0,
        sha256: '',
        notModified: true,
        ...(response.headers.get('etag') ? { etag: response.headers.get('etag')! } : {}),
        ...(response.headers.get('last-modified') ? { lastModified: response.headers.get('last-modified')! } : {}),
      };
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw mapStatus(response.status);
    }
    if (!response.body) throw new DownloadError('NETWORK_ERROR', 'The resource server returned an empty response body.', true);
    const length = contentLength(response);
    let selection: { skip: number; length?: number; expectedSourceLength?: number; expectedOutputLength?: number };
    if (resource.range && response.status === 206) {
      const value = response.headers.get('content-range');
      const match = value && /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value);
      const start = resource.range.offset;
      const end = start + resource.range.length - 1;
      if (!match || Number(match[1]) !== start || Number(match[2]) !== end || Number(match[3]) <= end) {
        throw new DownloadError('INVALID_RANGE', 'The server returned an invalid Content-Range.');
      }
      if (length !== undefined && length !== resource.range.length) {
        throw new DownloadError('INVALID_RANGE', 'The ranged response length does not match the requested range.');
      }
      selection = { skip: 0, length: resource.range.length, expectedSourceLength: resource.range.length, expectedOutputLength: resource.range.length };
    } else if (resource.range && response.status === 200) {
      if (length !== undefined && resource.range.offset + resource.range.length > length) {
        throw new DownloadError('INVALID_RANGE', 'The requested byte range exceeds the resource length.');
      }
      selection = {
        skip: resource.range.offset,
        length: resource.range.length,
        expectedOutputLength: resource.range.length,
        ...(length === undefined ? {} : { expectedSourceLength: length }),
      };
    } else if (response.status === 206) {
      throw new DownloadError('INVALID_RANGE', 'The server returned a byte range that was not requested.');
    } else {
      selection = length === undefined
        ? { skip: 0 }
        : { skip: 0, expectedSourceLength: length, expectedOutputLength: length };
    }
    const result = await saveSelectedStream(
      response.body as unknown as NodeJS.ReadableStream,
      partPath,
      selection,
      options.createWriteStream?.(partPath),
      requestSignal.signal,
    );
    return {
      bytes: result.bytes,
      sha256: result.sha256,
      ...(response.headers.get('etag') ? { etag: response.headers.get('etag')! } : {}),
      ...(response.headers.get('last-modified') ? { lastModified: response.headers.get('last-modified')! } : {}),
    };
  } catch (error) {
    if (signal.aborted) throw abortError(signal);
    if (requestSignal.timedOut()) throw new DownloadError('NETWORK_ERROR', 'The resource request timed out.', true, { cause: error });
    if (error instanceof DownloadError) throw error;
    if (isAbortError(error)) throw error;
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
    if (code && ['ENOSPC', 'EDQUOT', 'EACCES', 'EPERM', 'EROFS', 'EBADF', 'EMFILE', 'ENFILE'].includes(code)) {
      throw new DownloadError('DISK_ERROR', 'The downloaded resource could not be written to disk.', false, { cause: error });
    }
    throw new DownloadError('NETWORK_ERROR', 'The resource response was interrupted.', true, { cause: error });
  } finally {
    requestSignal.dispose();
  }
}

async function transfer(
  resource: Resource,
  destination: string,
  signal: AbortSignal,
  validators: ConditionalValidators = {},
  options: DownloadOptions = {},
): Promise<DownloadedResource> {
  const absoluteDestination = path.resolve(destination);
  const partPath = `${absoluteDestination}.part`;
  await mkdir(path.dirname(absoluteDestination), { recursive: true });
  if (await hasFile(absoluteDestination)) throw new DownloadError('OUTPUT_EXISTS', 'The destination already exists.');
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    if (signal.aborted) throw abortError(signal);
    await rm(partPath, { force: true });
    try {
      const result = await downloadOnce(resource, partPath, signal, validators, options);
      if (result.notModified) return result;
      if (signal.aborted) throw abortError(signal);
      try {
        await link(partPath, absoluteDestination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new DownloadError('OUTPUT_EXISTS', 'The destination already exists.');
        }
        throw error;
      }
      await unlink(partPath);
      return result;
    } catch (error) {
      await rm(partPath, { force: true }).catch(() => {});
      if (signal.aborted) throw abortError(signal);
      lastError = error;
      const retryable = error instanceof DownloadError && error.retryable;
      if (!retryable || attempt === RETRY_DELAYS_MS.length) throw error;
      await (options.wait ?? waitForRetry)(RETRY_DELAYS_MS[attempt]!, signal);
    }
  }
  throw lastError;
}

export async function downloadResourceWithMetadata(
  resource: Resource,
  destination: string,
  signal: AbortSignal,
  validators: ConditionalValidators = {},
  options: DownloadOptions = {},
): Promise<DownloadedResource> {
  return transfer(resource, destination, signal, validators, options);
}

export async function downloadResource(
  resource: Resource,
  destination: string,
  signal: AbortSignal,
  options: DownloadOptions = {},
): Promise<{ bytes: number; sha256: string }> {
  const result = await transfer(resource, destination, signal, {}, options);
  return { bytes: result.bytes, sha256: result.sha256 };
}

export async function sha256File(filePath: string, signal?: AbortSignal): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(filePath, signal ? { signal } : undefined)) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.length;
    hash.update(value);
  }
  return { bytes, sha256: hash.digest('hex') };
}
