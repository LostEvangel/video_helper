import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { TaskView } from '../shared/contracts.js';
import { createIpcHandlers, FileSelectionRegistry, isTrustedPageUrl, registerIpcHandlers } from './ipc.js';
import { createServices, terminateChildProcesses, type RuntimeServices } from './services.js';
import { configureMediaToolRuntime } from './media/tools.js';

let services: RuntimeServices;
const selections = new FileSelectionRegistry();
let mainWindow: BrowserWindow | undefined;
let unsubscribeTasks: (() => void) | undefined;
let shutdownStarted = false;

if (!app.isPackaged) {
  const developmentUserData = path.join(app.getAppPath(), '.tools', 'electron-user-data');
  mkdirSync(developmentUserData, { recursive: true });
  app.setPath('userData', developmentUserData);
}

configureMediaToolRuntime({
  packaged: app.isPackaged,
  resourcesPath: (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath,
});

services = createServices({
  userDataDir: app.getPath('userData'),
  pluginDirectory: app.isPackaged
    ? path.join((process as NodeJS.Process & { resourcesPath: string }).resourcesPath, 'thumbnail')
    : path.join(app.getAppPath(), 'native', 'thumbnail', 'dist'),
});

function getTrustedPageUrl(): string {
  const developmentUrl = process.env.VITE_DEV_SERVER_URL;
  if (developmentUrl && !app.isPackaged) {
    const parsed = new URL(developmentUrl);
    if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.port !== '5173' || parsed.pathname !== '/') {
      throw new Error('VITE_DEV_SERVER_URL must point to the local 127.0.0.1:5173 development server.');
    }
    return parsed.href;
  }
  return pathToFileURL(path.join(app.getAppPath(), 'dist', 'renderer', 'index.html')).href;
}

function getWindow(): BrowserWindow {
  if (!mainWindow || mainWindow.isDestroyed()) throw new Error('The application window is not available.');
  return mainWindow;
}

function inputPicker(): Promise<string | undefined> {
  return showFilePicker({
    title: '选择 HLS 播放列表',
    filters: [{ name: 'HLS 播放列表', extensions: ['m3u8', 'm3u'] }],
  });
}

function mediaPicker(): Promise<string | undefined> {
  return showFilePicker({
    title: '选择视频',
    filters: [{ name: '视频', extensions: ['mp4', 'mkv', 'mov', 'avi', 'webm', 'm4v'] }],
  });
}

async function showFilePicker(options: { title: string; filters: Electron.FileFilter[] }): Promise<string | undefined> {
  const result = await dialog.showOpenDialog(getWindow(), {
    ...options,
    properties: ['openFile'],
  });
  return result.canceled ? undefined : result.filePaths[0];
}

async function outputPicker(): Promise<string | undefined> {
  const result = await dialog.showSaveDialog(getWindow(), {
    title: '选择输出文件',
    defaultPath: 'video.mp4',
    filters: [
      { name: 'MP4 视频', extensions: ['mp4'] },
      { name: 'MKV 视频', extensions: ['mkv'] },
    ],
  });
  return result.canceled ? undefined : result.filePath;
}

async function coverOutputPicker(sourcePath: string): Promise<string | undefined> {
  const stem = path.basename(sourcePath, path.extname(sourcePath));
  const result = await dialog.showSaveDialog(getWindow(), {
    title: '另存封面视频',
    defaultPath: path.join(path.dirname(sourcePath), `${stem}_封面.mp4`),
    filters: [{ name: 'MP4 视频', extensions: ['mp4'] }],
  });
  return result.canceled ? undefined : result.filePath;
}

async function frameOutputPicker(sourcePath: string): Promise<string | undefined> {
  const stem = path.basename(sourcePath, path.extname(sourcePath));
  const result = await dialog.showSaveDialog(getWindow(), {
    title: '导出封面 JPG',
    defaultPath: path.join(path.dirname(sourcePath), `${stem}_封面.jpg`),
    filters: [{ name: 'JPEG 图片', extensions: ['jpg', 'jpeg'] }],
  });
  return result.canceled ? undefined : result.filePath;
}

async function directoryPicker(): Promise<string | undefined> {
  const result = await dialog.showOpenDialog(getWindow(), {
    title: '选择文件夹',
    properties: ['openDirectory', 'createDirectory'],
  });
  return result.canceled ? undefined : result.filePaths[0];
}

async function cacheDirectoryPicker(): Promise<string | undefined> {
  const result = await dialog.showOpenDialog(getWindow(), {
    title: '选择下载缓存文件夹',
    properties: ['openDirectory', 'createDirectory'],
  });
  return result.canceled ? undefined : result.filePaths[0];
}

function registerIpc(window: BrowserWindow, trustedPageUrl: string): void {
  const handlers = createIpcHandlers({
    services,
    selections,
    security: {
      webContents: window.webContents,
      mainFrame: window.webContents.mainFrame,
      trustedPageUrl,
    },
    chooseInputFile: inputPicker,
    chooseMediaFile: mediaPicker,
    chooseOutputFile: outputPicker,
    chooseCoverOutputFile: coverOutputPicker,
    chooseFrameOutputFile: frameOutputPicker,
    chooseOutputDirectory: directoryPicker,
    chooseCacheDirectory: cacheDirectoryPicker,
    getCompletedTaskOutput: (taskId) => services.getCompletedTaskOutput(taskId),
    openOutputDirectory: async (selectedPath) => {
      const failure = await shell.openPath(selectedPath);
      if (failure) throw Object.assign(new Error(failure), { code: 'OPEN_DIRECTORY_FAILED' });
    },
  });

  registerIpcHandlers({
    removeHandler: (channel) => ipcMain.removeHandler(channel),
    handle: (channel, listener) => ipcMain.handle(channel, (event, payload) => listener(event, payload)),
  }, handlers);
}

function registerWindowGuards(window: BrowserWindow, trustedPageUrl: string): void {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, targetUrl) => {
    if (!isTrustedPageUrl(targetUrl, trustedPageUrl)) event.preventDefault();
  });
}

function sendTaskUpdate(window: BrowserWindow, tasks: TaskView[]): void {
  if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('tasks:changed', tasks);
}

async function createWindow(): Promise<void> {
  const trustedPageUrl = getTrustedPageUrl();
  const window = new BrowserWindow({
    width: 1_180,
    height: 780,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: 'Video Helper',
    backgroundColor: '#f5f7fb',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  mainWindow = window;
  registerIpc(window, trustedPageUrl);
  registerWindowGuards(window, trustedPageUrl);
  unsubscribeTasks?.();
  unsubscribeTasks = services.subscribeTasks((tasks) => sendTaskUpdate(window, tasks));

  window.once('ready-to-show', () => window.show());
  window.on('closed', () => {
    unsubscribeTasks?.();
    unsubscribeTasks = undefined;
    for (const channel of [
      'dialog:input-file', 'dialog:media-file', 'dialog:output-file', 'dialog:cover-output-file',
      'dialog:frame-output-file', 'dialog:output-directory', 'dialog:cache-directory',
      'filesystem:open-output-directory', 'filesystem:open-selected-file-directory', 'filesystem:open-task-output-directory',
      'service:inspect', 'service:start', 'service:list-tasks', 'service:get-settings', 'service:update-settings', 'service:get-task-output',
      'service:control', 'service:probe', 'service:preview', 'service:cancel-preview', 'service:save-cover',
      'service:export-frame', 'service:plugin-status', 'service:change-plugin',
    ]) ipcMain.removeHandler(channel);
    if (mainWindow === window) mainWindow = undefined;
  });

  if (trustedPageUrl.startsWith('http:')) await window.loadURL(trustedPageUrl);
  else await window.loadFile(path.join(app.getAppPath(), 'dist', 'renderer', 'index.html'));
}

async function saveState(): Promise<void> {
  const tasks = await services.listTasks();
  const directory = app.getPath('userData');
  const target = path.join(directory, 'state.json');
  const temporary = `${target}.${randomUUID()}.tmp`;
  const state = { version: 1, savedAt: new Date().toISOString(), tasks };
  await mkdir(directory, { recursive: true });
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx' });
  await rename(temporary, target);
}

async function shutdown(): Promise<void> {
  try {
    await services.shutdown();
    await terminateChildProcesses();
    await saveState();
  } catch (error) {
    console.error('Could not finish saving application state during shutdown.', error);
  } finally {
    app.quit();
  }
}

app.on('before-quit', (event) => {
  if (shutdownStarted) return;
  event.preventDefault();
  shutdownStarted = true;
  void shutdown();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});

void app.whenReady().then(createWindow).catch((error: unknown) => {
  console.error('Video Helper failed to start.', error);
  app.quit();
});
