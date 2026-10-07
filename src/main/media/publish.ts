import { link, lstat, rename, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { MediaError, runMedia } from './process.js';
import { resolvePackagedResource } from './tools.js';

const PACKAGED_HELPER_RELATIVE_PATH = path.join('media-publish', 'no-replace-move.exe');
const DEVELOPMENT_HELPER_RELATIVE_PATH = path.join('.tools', 'media-publish', 'no-replace-move.exe');
const HELPER_PATH_ENV = 'MEDIA_PUBLISH_MOVE_HELPER_PATH';

export type PublishOperations = {
  rename?: (from: string, to: string) => Promise<void>;
  link?: typeof link;
  /** Test seam for exercising filesystems whose metadata reports no stable inode. */
  lstat?: (filePath: string) => Promise<Awaited<ReturnType<typeof lstat>>>;
};

async function fileStat(
  filePath: string,
  statPath: (filePath: string) => Promise<Awaited<ReturnType<typeof lstat>>> = lstat,
): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await statPath(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function isExistsError(error: unknown): boolean {
  return errorCode(error) === 'EEXIST';
}

function isUnsupportedLinkError(error: unknown): boolean {
  return ['EACCES', 'EPERM', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EINVAL'].includes(errorCode(error) ?? '');
}

function abortError(source: string, cause?: unknown): Error {
  const error = new Error(`Publishing was canceled before the atomic move. The verified temporary output remains at ${source}.`);
  error.name = 'AbortError';
  if (cause !== undefined) Object.assign(error, { cause });
  return error;
}

function absolutePath(value: string): string {
  // path.resolve normalizes the special \?\ prefix away, so preserve caller-provided
  // extended-length Windows paths for lstat, hard-link, and move operations.
  return value.startsWith('\\\\?\\') ? value : path.resolve(value);
}

/** Converts an absolute Windows path to the UTF-16 long-path form accepted by Win32. */
export function toExtendedWindowsPath(value: string): string {
  if (value.startsWith('\\\\?\\')) return value;
  const absolute = path.win32.resolve(value);
  if (absolute.startsWith('\\\\')) return `\\\\?\\UNC\\${absolute.slice(2)}`;
  if (/^[A-Za-z]:\\/.test(absolute)) return `\\\\?\\${absolute}`;
  throw new MediaError('INVALID_PUBLISH_PATH', `The native no-replace publisher requires an absolute Windows path: ${value}.`);
}

export function resolveNativePublisherPath(): string {
  const packagedPath = resolvePackagedResource(PACKAGED_HELPER_RELATIVE_PATH);
  if (packagedPath) return packagedPath;

  const configured = process.env[HELPER_PATH_ENV];
  if (configured) return path.resolve(configured);

  return path.resolve(process.cwd(), DEVELOPMENT_HELPER_RELATIVE_PATH);
}

async function moveNoReplace(source: string, destination: string, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortError(source, signal.reason);

  const helper = resolveNativePublisherPath();
  try {
    // The move itself is one short atomic Win32 operation. Check cancellation before
    // crossing that commit boundary; once launched, let the helper report its result.
    await runMedia(helper, [toExtendedWindowsPath(source), toExtendedWindowsPath(destination)], new AbortController().signal);
  } catch (error) {
    if (error instanceof MediaError && error.code === 'MEDIA_PROCESS_FAILED') {
      if (/failed with exit code 2\b/.test(error.message)) {
        throw new MediaError('OUTPUT_EXISTS', 'The selected output was created by another process before it could be published. Choose another name or explicitly replace it.', { cause: error });
      }
      if (/failed with exit code 3\b/.test(error.message)) {
        throw new MediaError('PUBLISH_TEMP_UNAVAILABLE', `The atomic move could not find its source file or destination directory. The verified temporary output remains at ${source}.`, { cause: error });
      }
      throw new MediaError('PUBLISH_FAILED', `The atomic no-replace move to ${destination} failed. The verified temporary output remains at ${source}. ${error.message}`, { cause: error });
    }
    if (error instanceof MediaError && error.code === 'MEDIA_TOOL_UNAVAILABLE') {
      throw new MediaError('PUBLISH_HELPER_UNAVAILABLE', `The no-replace publication helper is unavailable at ${helper}. Build it with scripts/build-publish-helper.mjs or include it at ${PACKAGED_HELPER_RELATIVE_PATH}.`, { cause: error });
    }
    if (error instanceof MediaError && error.code === 'MEDIA_TOOL_START_FAILED') {
      throw new MediaError('PUBLISH_HELPER_START_FAILED', `The no-replace publication helper could not start: ${helper}.`, { cause: error });
    }
    throw error;
  }
}

async function publishWithoutReplace(
  source: string,
  destination: string,
  signal?: AbortSignal,
  linkOperation: typeof link = link,
): Promise<void> {
  if (signal?.aborted) throw abortError(source, signal.reason);

  try {
    await linkOperation(source, destination);
    await unlink(source).catch(() => {});
    return;
  } catch (error) {
    if (isExistsError(error)) {
      throw new MediaError('OUTPUT_EXISTS', 'The selected output was created by another process before it could be published. Choose another name or explicitly replace it.', { cause: error });
    }
    if (!isUnsupportedLinkError(error)) {
      throw new MediaError('PUBLISH_FAILED', `The validated output could not be published to ${destination}. The verified temporary output remains at ${source}.`, { cause: error });
    }
  }

  await moveNoReplace(source, destination, signal);
}

/** Publishes a completed file without overwriting a target unless replacement was requested. */
export async function publishOutput(
  temp: string,
  target: string,
  replace: boolean,
  operations: PublishOperations = {},
  signal?: AbortSignal,
): Promise<void> {
  const source = absolutePath(temp);
  const destination = absolutePath(target);
  if (source === destination) throw new MediaError('INVALID_PUBLISH_PATH', 'The temporary output and target path must be different.');

  const statPath = operations.lstat ?? lstat;
  const sourceStat = await fileStat(source, statPath).catch((error) => {
    throw new MediaError('PUBLISH_TEMP_UNAVAILABLE', `The validated temporary output could not be read: ${source}.`, { cause: error });
  });
  if (!sourceStat?.isFile()) throw new MediaError('PUBLISH_TEMP_UNAVAILABLE', 'The validated temporary output is missing or is not a regular file.');

  const targetStat = await fileStat(destination, statPath).catch((error) => {
    throw new MediaError('PUBLISH_TARGET_UNAVAILABLE', `The selected output path could not be checked: ${destination}.`, { cause: error });
  });
  if (targetStat && !replace) throw new MediaError('OUTPUT_EXISTS', 'The selected output already exists. Choose another name or explicitly replace it.');
  if (targetStat && !targetStat.isFile()) throw new MediaError('OUTPUT_NOT_FILE', 'The selected output exists but is not a regular file.');

  const move = operations.rename ?? rename;
  if (targetStat) {
    const backup = `${destination}.${randomUUID()}.backup`;
    try {
      await move(destination, backup);
    } catch (error) {
      throw new MediaError('PUBLISH_FAILED', `The existing output could not be moved to a recoverable backup: ${destination}.`, { cause: error });
    }

    try {
      await move(source, destination);
    } catch (error) {
      try {
        await move(backup, destination);
      } catch (rollbackError) {
        throw new MediaError('PUBLISH_ROLLBACK_FAILED', `Publishing failed and the original file remains at its recoverable backup path: ${backup}.`, { cause: rollbackError });
      }
      throw new MediaError('PUBLISH_FAILED', `The new output could not be published; the original file was restored at ${destination}.`, { cause: error });
    }

    try {
      await rm(backup, { force: true });
    } catch (error) {
      throw new MediaError('PUBLISH_BACKUP_CLEANUP_FAILED', `The new output is published, but the previous-file backup could not be removed: ${backup}.`, { cause: error });
    }
    return;
  }

  await publishWithoutReplace(source, destination, signal, operations.link ?? link);
}
