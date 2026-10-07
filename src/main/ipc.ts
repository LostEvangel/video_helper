import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type {
  AppError,
  AppSettings,
  AppServices,
  FileSelection,
  InputSource,
  OutputMode,
  PluginStatus,
  Result,
  TaskControl,
} from '../shared/contracts.js';

const MAX_TEXT_LENGTH = 16_384;
const MAX_PATH_LENGTH = 32_767;
const MAX_ID_LENGTH = 256;
const CONTROL_ACTIONS = new Set<TaskControl>(['pause', 'resume', 'cancel', 'retry', 'clear']);
const OUTPUT_MODES = new Set<OutputMode>(['copy-mp4', 'copy-mkv', 'transcode-mp4']);

export type SelectionPurpose = 'input' | 'media' | 'output' | 'directory' | 'cache';

export class IpcAppError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'IpcAppError';
    this.code = code;
  }
}

export class FileSelectionRegistry {
  private readonly selections = new Map<string, { purpose: SelectionPurpose; path: string }>();

  issue(purpose: SelectionPurpose, selectedPath: string): FileSelection {
    const absolutePath = normalizeSelectedPath(selectedPath);
    if (!absolutePath) throw new IpcAppError('INVALID_SELECTION', 'The file chooser returned an invalid path.');
    const token = randomUUID();
    this.selections.set(token, { purpose, path: absolutePath });
    return { token, path: absolutePath, name: path.basename(absolutePath) };
  }

  resolve(token: unknown, purpose: SelectionPurpose): string | undefined {
    if (typeof token !== 'string' || token.length > MAX_ID_LENGTH) return undefined;
    const selected = this.selections.get(token);
    return selected?.purpose === purpose ? selected.path : undefined;
  }

  matches(token: unknown, purpose: SelectionPurpose, candidatePath: unknown): boolean {
    const selectedPath = this.resolve(token, purpose);
    const normalizedCandidate = typeof candidatePath === 'string' ? normalizeSelectedPath(candidatePath) : undefined;
    return Boolean(selectedPath && normalizedCandidate && pathKey(selectedPath) === pathKey(normalizedCandidate));
  }
}

export type IpcEvent = {
  sender: unknown;
  senderFrame?: { url?: string } | null;
};

export type IpcHandler = (event: IpcEvent, payload: unknown) => Promise<unknown> | unknown;
export type IpcHandlers = Record<string, IpcHandler>;
export interface IpcMainRegistrar {
  removeHandler(channel: string): void;
  handle(channel: string, listener: (event: IpcEvent, payload: unknown) => Promise<Result<unknown>>): void;
}

export interface IpcDependencies {
  services: AppServices;
  selections: FileSelectionRegistry;
  security: {
    webContents: unknown;
    mainFrame: unknown;
    trustedPageUrl: string;
  };
  chooseInputFile?: () => Promise<string | undefined>;
  chooseMediaFile?: () => Promise<string | undefined>;
  chooseOutputFile?: () => Promise<string | undefined>;
  chooseCoverOutputFile?: (sourcePath: string) => Promise<string | undefined>;
  chooseFrameOutputFile?: (sourcePath: string) => Promise<string | undefined>;
  chooseOutputDirectory?: () => Promise<string | undefined>;
  chooseCacheDirectory?: () => Promise<string | undefined>;
  openOutputDirectory?: (selectedPath: string) => Promise<void>;
  getCompletedTaskOutput?: (taskId: string) => Promise<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new IpcAppError('INVALID_ARGUMENT', `${label} must be an object.`);
  return value;
}

function requireText(value: unknown, label: string, maxLength = MAX_TEXT_LENGTH): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    throw new IpcAppError('INVALID_ARGUMENT', `${label} must be a non-empty string of at most ${maxLength} characters.`);
  }
  return value;
}

function requireIdentifier(value: unknown, label: string): string {
  return requireText(value, label, MAX_ID_LENGTH);
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new IpcAppError('INVALID_ARGUMENT', `${label} must be a boolean.`);
  return value;
}

function requireFiniteNumber(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) {
    throw new IpcAppError('INVALID_ARGUMENT', `${label} must be a finite number greater than or equal to ${minimum}.`);
  }
  return value;
}

function requireAbsolutePath(value: unknown, label: string): string {
  const rawPath = requireText(value, label, MAX_PATH_LENGTH);
  if (!path.isAbsolute(rawPath) && !path.win32.isAbsolute(rawPath)) {
    throw new IpcAppError('INVALID_ARGUMENT', `${label} must be an absolute local path.`);
  }
  return normalizeSelectedPath(rawPath)!;
}

function requireHttpUrl(value: unknown, label: string): string {
  const rawUrl = requireText(value, label, MAX_TEXT_LENGTH);
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Unsupported protocol');
  } catch {
    throw new IpcAppError('INVALID_ARGUMENT', `${label} must be a valid HTTP or HTTPS URL.`);
  }
  return rawUrl;
}

function normalizeInputSource(value: unknown, token: unknown, selections: FileSelectionRegistry): InputSource {
  const source = requireRecord(value, 'source');
  if (source.kind === 'url') return { kind: 'url', url: requireHttpUrl(source.url, 'source.url') };
  if (source.kind !== 'file') throw new IpcAppError('INVALID_ARGUMENT', 'source.kind must be url or file.');

  const selectedPath = requireAbsolutePath(source.path, 'source.path');
  if (!selections.matches(token, 'input', selectedPath)) {
    throw new IpcAppError('UNAUTHORIZED_FILE', 'Choose the playlist file in the application before inspecting it.');
  }
  if (source.baseUrl !== undefined) {
    return { kind: 'file', path: selectedPath, baseUrl: requireHttpUrl(source.baseUrl, 'source.baseUrl') };
  }
  return { kind: 'file', path: selectedPath };
}

function normalizeSelectedPath(selectedPath: string): string | undefined {
  if (typeof selectedPath !== 'string' || selectedPath.trim().length === 0 || selectedPath.length > MAX_PATH_LENGTH) {
    return undefined;
  }
  if (!path.isAbsolute(selectedPath) && !path.win32.isAbsolute(selectedPath)) return undefined;
  return path.isAbsolute(selectedPath) ? path.resolve(selectedPath) : path.win32.normalize(selectedPath);
}

function pathKey(selectedPath: string): string {
  const normalized = selectedPath.replaceAll('/', '\\').replace(/\\+$/, '');
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function requireSettings(value: unknown): AppSettings {
  const input = requireRecord(value, 'settings');
  const networkConcurrency = requireFiniteNumber(input.networkConcurrency, 'settings.networkConcurrency', 1);
  if (!Number.isInteger(networkConcurrency) || networkConcurrency > 8) {
    throw new IpcAppError('INVALID_ARGUMENT', 'settings.networkConcurrency must be an integer from 1 through 8.');
  }
  return {
    networkConcurrency,
    keepCache: requireBoolean(input.keepCache, 'settings.keepCache'),
    cacheDir: requireAbsolutePath(input.cacheDir, 'settings.cacheDir'),
  };
}

export function isTrustedPageUrl(actualUrl: unknown, trustedPageUrl: string): boolean {
  if (typeof actualUrl !== 'string') return false;
  try {
    const actual = new URL(actualUrl);
    const trusted = new URL(trustedPageUrl);
    if (actual.protocol === 'file:' && trusted.protocol === 'file:') {
      return pathKey(decodeURIComponent(actual.pathname)) === pathKey(decodeURIComponent(trusted.pathname));
    }
    const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
    return actual.protocol === 'http:' && trusted.protocol === 'http:'
      && loopbackHosts.has(actual.hostname)
      && actual.origin === trusted.origin
      && actual.pathname === trusted.pathname;
  } catch {
    return false;
  }
}

function requireTrustedSender(event: IpcEvent, dependencies: IpcDependencies): void {
  if (event.sender !== dependencies.security.webContents || event.senderFrame !== dependencies.security.mainFrame) {
    throw new IpcAppError('UNTRUSTED_SENDER', 'This request did not come from the application main window.');
  }
  if (!isTrustedPageUrl(event.senderFrame?.url, dependencies.security.trustedPageUrl)) {
    throw new IpcAppError('UNTRUSTED_SENDER', 'This request did not come from the trusted local application page.');
  }
}

function requireFileToken(
  value: unknown,
  purpose: SelectionPurpose,
  token: unknown,
  selections: FileSelectionRegistry,
): string {
  const selectedPath = requireAbsolutePath(value, 'path');
  if (!selections.matches(token, purpose, selectedPath)) {
    throw new IpcAppError('UNAUTHORIZED_FILE', 'Choose this file in the application before using it.');
  }
  return selectedPath;
}

function requireOutputToken(
  value: unknown,
  token: unknown,
  selections: FileSelectionRegistry,
): string {
  const selectedPath = requireAbsolutePath(value, 'output');
  if (selections.matches(token, 'output', selectedPath)) return selectedPath;
  const selectedDirectory = selections.resolve(token, 'directory');
  const filename = path.win32.basename(selectedPath);
  const parent = path.win32.isAbsolute(selectedPath) ? path.win32.dirname(selectedPath) : path.dirname(selectedPath);
  if (!selectedDirectory || pathKey(selectedDirectory) !== pathKey(parent)
    || filename === '.' || filename === '..' || filename.length === 0) {
    throw new IpcAppError('UNAUTHORIZED_OUTPUT', 'Choose the output path in the application before continuing.');
  }
  return selectedPath;
}

function requirePluginAction(value: unknown): 'enable' | 'disable' {
  if (value !== 'enable' && value !== 'disable') {
    throw new IpcAppError('INVALID_ARGUMENT', 'action must be enable or disable.');
  }
  return value;
}

function isResult(value: unknown): value is Result<unknown> {
  return isRecord(value) && typeof value.ok === 'boolean';
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

function toAppError(error: unknown): AppError {
  if (error instanceof IpcAppError) return { code: error.code, message: redactSensitiveUrls(error.message).slice(0, 2_000) };
  if (isRecord(error) && typeof error.code === 'string' && typeof error.message === 'string') {
    return { code: error.code.slice(0, 128), message: redactSensitiveUrls(error.message).slice(0, 2_000) };
  }
  return { code: 'INTERNAL_ERROR', message: 'The application could not complete this request.' };
}

export function createIpcHandlers(dependencies: IpcDependencies): IpcHandlers {
  const handlers: IpcHandlers = {
    'dialog:input-file': async () => {
      const selectedPath = await dependencies.chooseInputFile?.();
      return selectedPath ? dependencies.selections.issue('input', selectedPath) : null;
    },
    'dialog:media-file': async () => {
      const selectedPath = await dependencies.chooseMediaFile?.();
      return selectedPath ? dependencies.selections.issue('media', selectedPath) : null;
    },
    'dialog:output-file': async () => {
      const selectedPath = await dependencies.chooseOutputFile?.();
      return selectedPath ? dependencies.selections.issue('output', selectedPath) : null;
    },
    'dialog:cover-output-file': async (_event, payload) => {
      const input = requireRecord(payload, 'payload');
      const sourcePath = requireFileToken(input.path, 'media', input.fileToken, dependencies.selections);
      if (!dependencies.chooseCoverOutputFile) throw new IpcAppError('SERVICE_NOT_READY', '封面视频另存功能尚未就绪。');
      const selectedPath = await dependencies.chooseCoverOutputFile(sourcePath);
      return selectedPath ? dependencies.selections.issue('output', selectedPath) : null;
    },
    'dialog:frame-output-file': async (_event, payload) => {
      const input = requireRecord(payload, 'payload');
      const sourcePath = requireFileToken(input.path, 'media', input.fileToken, dependencies.selections);
      if (!dependencies.chooseFrameOutputFile) throw new IpcAppError('SERVICE_NOT_READY', 'JPG 导出功能尚未就绪。');
      const selectedPath = await dependencies.chooseFrameOutputFile(sourcePath);
      return selectedPath ? dependencies.selections.issue('output', selectedPath) : null;
    },
    'dialog:output-directory': async () => {
      const selectedPath = await dependencies.chooseOutputDirectory?.();
      return selectedPath ? dependencies.selections.issue('directory', selectedPath) : null;
    },
    'dialog:cache-directory': async () => {
      const selectedPath = await dependencies.chooseCacheDirectory?.();
      return selectedPath ? dependencies.selections.issue('cache', selectedPath) : null;
    },
    'filesystem:open-output-directory': async (_event, payload) => {
      const input = requireRecord(payload, 'payload');
      const token = requireIdentifier(input.directoryToken, 'directoryToken');
      const selectedPath = dependencies.selections.resolve(token, 'directory');
      if (!selectedPath) throw new IpcAppError('UNAUTHORIZED_DIRECTORY', 'Choose an output folder in the application first.');
      if (!dependencies.openOutputDirectory) throw new IpcAppError('SERVICE_NOT_READY', 'Opening folders is not available yet.');
      await dependencies.openOutputDirectory(selectedPath);
    },
    'filesystem:open-selected-file-directory': async (_event, payload) => {
      const input = requireRecord(payload, 'payload');
      const purpose = input.purpose;
      if (purpose !== 'media' && purpose !== 'output') throw new IpcAppError('INVALID_ARGUMENT', 'purpose must be media or output.');
      const selectedPath = requireFileToken(input.path, purpose, input.fileToken, dependencies.selections);
      if (!dependencies.openOutputDirectory) throw new IpcAppError('SERVICE_NOT_READY', 'Opening folders is not available yet.');
      const directory = path.win32.isAbsolute(selectedPath) ? path.win32.dirname(selectedPath) : path.dirname(selectedPath);
      await dependencies.openOutputDirectory(directory);
    },
    'filesystem:open-task-output-directory': async (_event, payload) => {
      const input = requireRecord(payload, 'payload');
      const taskId = requireIdentifier(input.taskId, 'taskId');
      if (!dependencies.getCompletedTaskOutput || !dependencies.openOutputDirectory) {
        throw new IpcAppError('SERVICE_NOT_READY', 'Opening a completed task folder is not available yet.');
      }
      const output = requireAbsolutePath(await dependencies.getCompletedTaskOutput(taskId), 'task output');
      const directory = path.win32.isAbsolute(output) ? path.win32.dirname(output) : path.dirname(output);
      await dependencies.openOutputDirectory(directory);
    },
    'service:inspect': async (_event, payload) => {
      const input = requireRecord(payload, 'payload');
      const source = normalizeInputSource(input.source, input.fileToken, dependencies.selections);
      return dependencies.services.inspect(source);
    },
    'service:start': async (_event, payload) => {
      const input = requireRecord(payload, 'payload');
      const request = requireRecord(input.request, 'request');
      const normalized = {
        inspectionId: requireIdentifier(request.inspectionId, 'inspectionId'),
        variantId: requireIdentifier(request.variantId, 'variantId'),
        ...(request.audioId === undefined ? {} : { audioId: requireIdentifier(request.audioId, 'audioId') }),
        output: requireOutputToken(request.output, input.outputToken, dependencies.selections),
        outputMode: (() => {
          if (typeof request.outputMode !== 'string' || !OUTPUT_MODES.has(request.outputMode as OutputMode)) {
            throw new IpcAppError('INVALID_ARGUMENT', 'outputMode must be a supported output mode.');
          }
          return request.outputMode as OutputMode;
        })(),
        keepCache: requireBoolean(request.keepCache, 'keepCache'),
      };
      return dependencies.services.start(normalized);
    },
    'service:list-tasks': async () => dependencies.services.listTasks(),
    'service:get-settings': async () => dependencies.services.getSettings(),
    'service:update-settings': async (_event, payload) => {
      const input = requireRecord(payload, 'payload');
      const settings = requireSettings(input.settings);
      const current = await dependencies.services.getSettings();
      if (pathKey(settings.cacheDir) !== pathKey(current.cacheDir)
        && !dependencies.selections.matches(input.cacheToken, 'cache', settings.cacheDir)) {
        throw new IpcAppError('UNAUTHORIZED_DIRECTORY', 'Choose the cache folder in the application before saving it.');
      }
      return dependencies.services.updateSettings(settings);
    },
    'service:get-task-output': async (_event, payload) => {
      const input = requireRecord(payload, 'payload');
      const taskId = requireIdentifier(input.taskId, 'taskId');
      if (!dependencies.getCompletedTaskOutput) throw new IpcAppError('SERVICE_NOT_READY', 'Opening a completed task video is not available yet.');
      const output = requireAbsolutePath(await dependencies.getCompletedTaskOutput(taskId), 'task output');
      return dependencies.selections.issue('media', output);
    },
    'service:control': async (_event, payload) => {
      const input = requireRecord(payload, 'payload');
      const request = requireRecord(input.request, 'request');
      if (typeof request.action !== 'string' || !CONTROL_ACTIONS.has(request.action as TaskControl)) {
        throw new IpcAppError('INVALID_ARGUMENT', 'action must be a supported task control.');
      }
      let outputMode: OutputMode | undefined;
      if (request.outputMode !== undefined) {
        if (typeof request.outputMode !== 'string' || !OUTPUT_MODES.has(request.outputMode as OutputMode)) {
          throw new IpcAppError('INVALID_ARGUMENT', 'outputMode must be a supported output mode.');
        }
        outputMode = request.outputMode as OutputMode;
      }
      const normalized = {
        id: requireIdentifier(request.id, 'id'),
        action: request.action as TaskControl,
        ...(outputMode === undefined ? {} : { outputMode }),
      };
      return dependencies.services.control(normalized);
    },
    'service:probe': async (_event, payload) => {
      const input = requireRecord(payload, 'payload');
      const selectedPath = requireFileToken(input.path, 'media', input.fileToken, dependencies.selections);
      if (typeof input.requestId !== 'number' || !Number.isSafeInteger(input.requestId) || input.requestId < 0) {
        throw new IpcAppError('INVALID_ARGUMENT', 'requestId must be a non-negative safe integer.');
      }
      return dependencies.services.probe(selectedPath, input.requestId);
    },
    'service:preview': async (_event, payload) => {
      const input = requireRecord(payload, 'payload');
      const request = requireRecord(input.request, 'request');
      const selectedPath = requireFileToken(request.path, 'media', input.fileToken, dependencies.selections);
      const time = requireFiniteNumber(request.time, 'time');
      if (typeof request.sessionId !== 'number' || !Number.isSafeInteger(request.sessionId) || request.sessionId < 0) {
        throw new IpcAppError('INVALID_ARGUMENT', 'sessionId must be a non-negative safe integer.');
      }
      if (typeof request.requestId !== 'number' || !Number.isSafeInteger(request.requestId) || request.requestId < 0) {
        throw new IpcAppError('INVALID_ARGUMENT', 'requestId must be a non-negative safe integer.');
      }
      return dependencies.services.preview({ path: selectedPath, time, requestId: request.requestId, sessionId: request.sessionId });
    },
    'service:cancel-preview': async (_event, payload) => {
      const input = requireRecord(payload, 'payload');
      const selectedPath = requireFileToken(input.path, 'media', input.fileToken, dependencies.selections);
      let requestId: number | undefined;
      let sessionId: number | undefined;
      if (input.requestId !== undefined) {
        if (typeof input.requestId !== 'number' || !Number.isSafeInteger(input.requestId) || input.requestId < 0) {
          throw new IpcAppError('INVALID_ARGUMENT', 'requestId must be a non-negative safe integer.');
        }
        requestId = input.requestId;
      }
      if (input.sessionId !== undefined) {
        if (typeof input.sessionId !== 'number' || !Number.isSafeInteger(input.sessionId) || input.sessionId < 0) {
          throw new IpcAppError('INVALID_ARGUMENT', 'sessionId must be a non-negative safe integer.');
        }
        sessionId = input.sessionId;
      }
      if (requestId === undefined && sessionId === undefined) {
        throw new IpcAppError('INVALID_ARGUMENT', 'A preview requestId or sessionId is required to cancel media work.');
      }
      await dependencies.services.cancelPreview({
        path: selectedPath,
        ...(requestId === undefined ? {} : { requestId }),
        ...(sessionId === undefined ? {} : { sessionId }),
      });
    },
    'service:save-cover': async (_event, payload) => {
      const input = requireRecord(payload, 'payload');
      const request = requireRecord(input.request, 'request');
      const selectedPath = requireFileToken(request.path, 'media', input.fileToken, dependencies.selections);
      const output = request.replace === true && request.output === selectedPath
        ? selectedPath
        : requireOutputToken(request.output, input.outputToken, dependencies.selections);
      return dependencies.services.saveCover({
        path: selectedPath,
        time: requireFiniteNumber(request.time, 'time'),
        output,
        replace: requireBoolean(request.replace, 'replace'),
      });
    },
    'service:export-frame': async (_event, payload) => {
      const input = requireRecord(payload, 'payload');
      const request = requireRecord(input.request, 'request');
      const selectedPath = requireFileToken(request.path, 'media', input.fileToken, dependencies.selections);
      const output = requireOutputToken(request.output, input.outputToken, dependencies.selections);
      return dependencies.services.exportFrame({
        path: selectedPath,
        time: requireFiniteNumber(request.time, 'time'),
        output,
      });
    },
    'service:plugin-status': async () => dependencies.services.pluginStatus() as Promise<PluginStatus>,
    'service:change-plugin': async (_event, payload) => {
      const input = requireRecord(payload, 'payload');
      return dependencies.services.changePlugin(requirePluginAction(input.action));
    },
  };

  return Object.fromEntries(Object.entries(handlers).map(([channel, handler]) => [
    channel,
    async (event: IpcEvent, payload: unknown) => {
      requireTrustedSender(event, dependencies);
      return handler(event, payload);
    },
  ]));
}

export async function dispatchIpc(
  handlers: IpcHandlers,
  channel: string,
  event: IpcEvent,
  payload: unknown,
): Promise<Result<unknown>> {
  if (!Object.hasOwn(handlers, channel)) {
    return { ok: false, error: { code: 'UNKNOWN_CHANNEL', message: 'This application request is not supported.' } };
  }
  const handler = handlers[channel];
  if (!handler) return { ok: false, error: { code: 'UNKNOWN_CHANNEL', message: 'This application request is not supported.' } };
  try {
    const value = await handler(event, payload);
    if (isResult(value)) return value;
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: toAppError(error) };
  }
}

export function registerIpcHandlers(registrar: IpcMainRegistrar, handlers: IpcHandlers): void {
  for (const channel of Object.keys(handlers)) {
    registrar.removeHandler(channel);
    registrar.handle(channel, (event, payload) => dispatchIpc(handlers, channel, event, payload));
  }
}
