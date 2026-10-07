import { contextBridge, ipcRenderer } from 'electron';
import type {
  AppError,
  AppServices,
  DesktopApi,
  FileSelection,
  InputSource,
  Result,
  TaskView,
} from '../shared/contracts.js';

type ServiceValue<Method extends keyof AppServices> = Awaited<ReturnType<AppServices[Method]>>;

function desktopApiError(error: AppError): AppError & { name: 'DesktopApiError' } {
  return { name: 'DesktopApiError', code: error.code, message: error.message };
}

async function invoke<T>(channel: string, payload?: unknown): Promise<T> {
  const result = await ipcRenderer.invoke(channel, payload) as Result<T>;
  if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') {
    throw desktopApiError({ code: 'INVALID_RESPONSE', message: '应用程序返回了无效结果。' });
  }
  if (!result.ok) throw desktopApiError(result.error);
  return result.value;
}

function pathKey(filePath: string): string {
  return filePath.replaceAll('/', '\\').replace(/\\+$/, '').toLocaleLowerCase('en-US');
}

const fileTokens = new Map<string, string>();
const mediaTokens = new Map<string, string>();
const outputTokens = new Map<string, string>();
const directoryTokens = new Map<string, string>();
const cacheTokens = new Map<string, string>();

function directoryFor(filePath: string): string {
  const separator = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  return separator > 0 ? filePath.slice(0, separator) : filePath;
}

function outputSelectionToken(filePath: string): string | undefined {
  return selectedToken(outputTokens, filePath) ?? directoryTokens.get(pathKey(directoryFor(filePath)));
}

async function choose(channel: string, tokens: Map<string, string>): Promise<FileSelection | null> {
  const selected = await invoke<FileSelection | null>(channel);
  if (selected) tokens.set(pathKey(selected.path), selected.token);
  return selected;
}

async function chooseMediaOutput(channel: string, filePath: string): Promise<FileSelection | null> {
  const selected = await invoke<FileSelection | null>(channel, {
    path: filePath,
    fileToken: selectedToken(mediaTokens, filePath),
  });
  if (selected) outputTokens.set(pathKey(selected.path), selected.token);
  return selected;
}

function selectedToken(tokens: Map<string, string>, filePath: string): string | undefined {
  return tokens.get(pathKey(filePath));
}

const api: DesktopApi = {
  chooseInputFile: () => choose('dialog:input-file', fileTokens),
  chooseMediaFile: () => choose('dialog:media-file', mediaTokens),
  chooseOutputFile: () => choose('dialog:output-file', outputTokens),
  chooseCoverOutputFile: (filePath) => chooseMediaOutput('dialog:cover-output-file', filePath),
  chooseFrameOutputFile: (filePath) => chooseMediaOutput('dialog:frame-output-file', filePath),
  chooseOutputDirectory: () => choose('dialog:output-directory', directoryTokens),
  chooseCacheDirectory: () => choose('dialog:cache-directory', cacheTokens),
  openOutputDirectory: (directoryToken) => invoke('filesystem:open-output-directory', { directoryToken }),
  openSelectedFileDirectory: (filePath, purpose) => invoke('filesystem:open-selected-file-directory', {
    path: filePath,
    purpose,
    fileToken: selectedToken(purpose === 'media' ? mediaTokens : outputTokens, filePath),
  }),
  openTaskOutputDirectory: (taskId) => invoke('filesystem:open-task-output-directory', { taskId }),
  getTaskOutput: async (taskId) => {
    const selection = await invoke<FileSelection>('service:get-task-output', { taskId });
    mediaTokens.set(pathKey(selection.path), selection.token);
    return selection;
  },
  inspect: (source: InputSource) => invoke<ServiceValue<'inspect'>>(
    'service:inspect',
    {
      source,
      fileToken: source.kind === 'file' ? selectedToken(fileTokens, source.path) : undefined,
    },
  ),
  start: (request) => invoke<ServiceValue<'start'>>('service:start', {
    request,
    outputToken: outputSelectionToken(request.output),
  }),
  listTasks: () => invoke<ServiceValue<'listTasks'>>('service:list-tasks'),
  control: (request) => invoke<void>('service:control', { request }),
  getSettings: () => invoke<ServiceValue<'getSettings'>>('service:get-settings'),
  updateSettings: (settings) => invoke<ServiceValue<'updateSettings'>>('service:update-settings', {
    settings,
    cacheToken: cacheTokens.get(pathKey(settings.cacheDir)),
  }),
  probe: (filePath, requestId) => invoke<ServiceValue<'probe'>>('service:probe', {
    path: filePath,
    requestId,
    fileToken: selectedToken(mediaTokens, filePath),
  }),
  preview: (request) => invoke<ServiceValue<'preview'>>('service:preview', {
    request,
    fileToken: selectedToken(mediaTokens, request.path),
  }),
  cancelPreview: (request) => invoke<void>('service:cancel-preview', {
    requestId: request.requestId,
    path: request.path,
    sessionId: request.sessionId,
    fileToken: selectedToken(mediaTokens, request.path),
  }),
  saveCover: (request) => invoke<ServiceValue<'saveCover'>>('service:save-cover', {
    request,
    fileToken: selectedToken(mediaTokens, request.path),
    outputToken: selectedToken(outputTokens, request.output),
  }),
  exportFrame: (request) => invoke<void>('service:export-frame', {
    request,
    fileToken: selectedToken(mediaTokens, request.path),
    outputToken: selectedToken(outputTokens, request.output),
  }),
  pluginStatus: () => invoke<ServiceValue<'pluginStatus'>>('service:plugin-status'),
  changePlugin: (action) => invoke<ServiceValue<'changePlugin'>>('service:change-plugin', { action }),
  onTasksChanged: (listener: (tasks: TaskView[]) => void) => {
    const handle = (_event: Electron.IpcRendererEvent, tasks: TaskView[]) => listener(tasks);
    ipcRenderer.on('tasks:changed', handle);
    return () => ipcRenderer.removeListener('tasks:changed', handle);
  },
};

contextBridge.exposeInMainWorld('videoHelper', api);
