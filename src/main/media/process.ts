import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { registerChildProcess } from '../services.js';

export const MAX_MEDIA_STDOUT_BYTES = 8 * 1024 * 1024;
export const MAX_FRAME_STDOUT_BYTES = 32 * 1024 * 1024;
export const MAX_MEDIA_STDERR_BYTES = 256 * 1024;
const KILL_GRACE_MS = 1_000;

export class MediaError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'MediaError';
    this.code = code;
  }
}

export type MediaProcessResult = { stdout: Buffer; stderr: string };
export type MediaRunOptions = {
  /** A larger cap is intended only for bounded image-pipe extraction. */
  maxStdoutBytes?: number;
  overflowCode?: string;
  overflowMessage?: string;
};

function abortError(signal: AbortSignal): DOMException {
  const reason = signal.reason;
  if (reason instanceof DOMException && reason.name === 'AbortError') return reason;
  return new DOMException('The media operation was cancelled.', 'AbortError');
}

function stderrTail(chunks: Buffer[], length: number): string {
  return Buffer.concat(chunks, length).toString('utf8').trim();
}

function commandName(binary: string): string {
  return path.basename(binary);
}

/** Runs FFmpeg/FFprobe with bounded captured output and process-backed cancellation. */
export function runMedia(binary: string, args: string[], signal: AbortSignal, options: MediaRunOptions = {}): Promise<MediaProcessResult> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  const maxStdoutBytes = options.maxStdoutBytes ?? MAX_MEDIA_STDOUT_BYTES;
  if (!Number.isSafeInteger(maxStdoutBytes) || maxStdoutBytes < 1 || maxStdoutBytes > MAX_FRAME_STDOUT_BYTES) {
    return Promise.reject(new MediaError('INVALID_MEDIA_LIMIT', `Captured media output must be between 1 byte and ${MAX_FRAME_STDOUT_BYTES} bytes.`));
  }

  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(binary, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      reject(new MediaError('MEDIA_TOOL_START_FAILED', `Could not start ${commandName(binary)}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }));
      return;
    }

    const stdoutChunks: Buffer[] = [];
    let stdoutLength = 0;
    let stderrChunks: Buffer[] = [];
    let stderrLength = 0;
    let stdoutOverflow = false;
    let abortRequested = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let unregister = () => {};

    const cleanup = () => {
      if (killTimer) clearTimeout(killTimer);
      signal.removeEventListener('abort', onAbort);
      unregister();
    };
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      action();
    };
    const forceKill = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try {
        child.kill('SIGKILL');
      } catch {
        // The process may have exited between the state check and kill.
      }
    };
    const requestKill = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try {
        child.kill('SIGTERM');
      } catch {
        // The process may have exited between the state check and kill.
      }
      killTimer ??= setTimeout(forceKill, KILL_GRACE_MS);
    };
    const onAbort = () => {
      abortRequested = true;
      requestKill();
    };

    try {
      unregister = registerChildProcess(child);
    } catch (error) {
      try { child.kill('SIGKILL'); } catch { /* Ignore a spawn that already exited. */ }
      settle(() => reject(new MediaError('MEDIA_TOOL_START_FAILED', `Could not register ${commandName(binary)} for shutdown.`, { cause: error })));
      return;
    }

    child.stdout?.on('data', (value: Buffer | string) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      if (stdoutLength + chunk.length > maxStdoutBytes) {
        stdoutOverflow = true;
        requestKill();
        return;
      }
      stdoutChunks.push(chunk);
      stdoutLength += chunk.length;
    });
    child.stderr?.on('data', (value: Buffer | string) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      stderrChunks.push(chunk);
      stderrLength += chunk.length;
      while (stderrLength > MAX_MEDIA_STDERR_BYTES && stderrChunks.length > 0) {
        const excess = stderrLength - MAX_MEDIA_STDERR_BYTES;
        const first = stderrChunks[0]!;
        if (first.length <= excess) {
          stderrChunks.shift();
          stderrLength -= first.length;
        } else {
          stderrChunks[0] = first.subarray(excess);
          stderrLength -= excess;
        }
      }
    });

    child.once('error', (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (abortRequested || signal.aborted) {
        settle(() => reject(abortError(signal)));
      } else if (code === 'ENOENT') {
        settle(() => reject(new MediaError('MEDIA_TOOL_UNAVAILABLE', `Could not find ${commandName(binary)}. Check the FFmpeg/FFprobe installation or development PATH.`, { cause: error })));
      } else {
        settle(() => reject(new MediaError('MEDIA_TOOL_START_FAILED', `Could not start ${commandName(binary)}: ${error.message}`, { cause: error })));
      }
    });

    child.once('close', (code, exitSignal) => {
      const stderr = stderrTail(stderrChunks, stderrLength);
      if (abortRequested || signal.aborted) {
        settle(() => reject(abortError(signal)));
        return;
      }
      if (stdoutOverflow) {
        settle(() => reject(new MediaError(
          options.overflowCode ?? 'MEDIA_OUTPUT_TOO_LARGE',
          options.overflowMessage ?? `${commandName(binary)} produced more than ${maxStdoutBytes / (1024 * 1024)} MB of stdout; the operation was stopped.`,
        )));
        return;
      }
      if (code !== 0) {
        const status = code === null ? `signal ${exitSignal ?? 'unknown'}` : `exit code ${code}`;
        const detail = stderr ? ` ${stderr.slice(-4_000)}` : '';
        settle(() => reject(new MediaError('MEDIA_PROCESS_FAILED', `${commandName(binary)} failed with ${status}.${detail}`, { cause: new Error(stderr || status) })));
        return;
      }
      settle(() => resolve({ stdout: Buffer.concat(stdoutChunks, stdoutLength), stderr }));
    });

    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}
