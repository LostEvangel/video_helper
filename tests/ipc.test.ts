import { describe, expect, it, vi } from 'vitest';
import type { AppServices, Preview, VideoInfo } from '../src/shared/contracts.js';
import { createIpcHandlers, dispatchIpc, FileSelectionRegistry, registerIpcHandlers, type IpcEvent } from '../src/main/ipc.js';

function makeHarness() {
  const webContents = { id: 7 };
  const mainFrame = { url: 'file:///app/index.html' };
  const trustedEvent: IpcEvent = { sender: webContents, senderFrame: mainFrame };
  const probe = vi.fn<AppServices['probe']>().mockResolvedValue({
    path: 'C:\\media\\clip.mp4',
    duration: 12,
    width: 1920,
    height: 1080,
    streams: [],
  } satisfies VideoInfo);
  const preview = vi.fn<AppServices['preview']>().mockResolvedValue({
    requestId: 1,
    imageUrl: 'data:image/jpeg;base64,',
    time: 1,
  } satisfies Preview);
  const services = {
    inspect: vi.fn<AppServices['inspect']>(),
    start: vi.fn<AppServices['start']>().mockResolvedValue({
      id: 'task-1', state: 'queued', completed: 0, total: 1, bytesPerSecond: 0,
    }),
    listTasks: vi.fn<AppServices['listTasks']>(),
    control: vi.fn<AppServices['control']>(),
    getSettings: vi.fn<AppServices['getSettings']>().mockResolvedValue({
      networkConcurrency: 4,
      keepCache: false,
      cacheDir: 'C:\\cache',
    }),
    updateSettings: vi.fn<AppServices['updateSettings']>(),
    probe,
    preview,
    cancelPreview: vi.fn<AppServices['cancelPreview']>().mockResolvedValue(undefined),
    saveCover: vi.fn<AppServices['saveCover']>(),
    exportFrame: vi.fn<AppServices['exportFrame']>(),
    pluginStatus: vi.fn<AppServices['pluginStatus']>(),
    changePlugin: vi.fn<AppServices['changePlugin']>(),
  } as AppServices;
  const selections = new FileSelectionRegistry();
  const media = selections.issue('media', 'C:\\media\\clip.mp4');
  const openedDirectory = vi.fn();
  const chooseCoverOutputFile = vi.fn().mockResolvedValue('C:\\media\\clip_封面.mp4');
  const chooseFrameOutputFile = vi.fn().mockResolvedValue('C:\\media\\clip_封面.jpg');
  const getCompletedTaskOutput = vi.fn().mockResolvedValue('C:\\output\\rendered.mp4');
  const handlers = createIpcHandlers({
    services,
    selections,
    security: { webContents, mainFrame, trustedPageUrl: 'file:///app/index.html' },
    chooseCoverOutputFile,
    chooseFrameOutputFile,
    getCompletedTaskOutput,
    openOutputDirectory: openedDirectory,
  });

  return { handlers, trustedEvent, services, selections, media, webContents, mainFrame, openedDirectory, getCompletedTaskOutput, chooseCoverOutputFile, chooseFrameOutputFile };
}

describe('restricted desktop IPC', () => {
  it('rejects unknown channels without calling a service', async () => {
    const harness = makeHarness();

    const result = await dispatchIpc(harness.handlers, 'service:unknown', harness.trustedEvent, {});

    expect(result).toMatchObject({ ok: false, error: { code: 'UNKNOWN_CHANNEL' } });
    expect(harness.services.probe).not.toHaveBeenCalled();
  });

  it('registers the same Result envelope that preload invoke expects', async () => {
    const harness = makeHarness();
    const registered = new Map<string, (event: IpcEvent, payload: unknown) => Promise<unknown>>();
    const ipcMain = {
      removeHandler: vi.fn(),
      handle: vi.fn((channel: string, listener: (event: IpcEvent, payload: unknown) => Promise<unknown>) => {
        registered.set(channel, listener);
      }),
    };

    registerIpcHandlers(ipcMain, harness.handlers);
    const probeResult = await registered.get('service:probe')!(harness.trustedEvent, {
      path: harness.media.path,
      requestId: 31,
      fileToken: harness.media.token,
    });
    expect(harness.services.probe).toHaveBeenCalledWith(harness.media.path, 31);

    expect(probeResult).toEqual({
      ok: true,
      value: {
        path: 'C:\\media\\clip.mp4',
        duration: 12,
        width: 1920,
        height: 1080,
        streams: [],
      },
    });

    harness.services.pluginStatus = vi.fn<AppServices['pluginStatus']>().mockRejectedValue(
      Object.assign(new Error('Plugin integration is not ready.'), { code: 'SERVICE_NOT_READY' }),
    );
    const pluginResult = await registered.get('service:plugin-status')!(harness.trustedEvent, undefined);
    expect(pluginResult).toEqual({
      ok: false,
      error: { code: 'SERVICE_NOT_READY', message: 'Plugin integration is not ready.' },
    });
  });

  it('does not dispatch inherited object property names as IPC channels', async () => {
    const harness = makeHarness();

    const result = await dispatchIpc(harness.handlers, 'constructor', harness.trustedEvent, {});

    expect(result).toMatchObject({ ok: false, error: { code: 'UNKNOWN_CHANNEL' } });
  });

  it('rejects a sender outside the main window before calling a service', async () => {
    const harness = makeHarness();
    const event: IpcEvent = { sender: { id: 8 }, senderFrame: harness.mainFrame };

    const result = await dispatchIpc(harness.handlers, 'service:probe', event, {
      path: harness.media.path,
      fileToken: harness.media.token,
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'UNTRUSTED_SENDER' } });
    expect(harness.services.probe).not.toHaveBeenCalled();
  });

  it('rejects IPC from a non-local page inside the main window', async () => {
    const harness = makeHarness();
    const event: IpcEvent = {
      sender: harness.webContents,
      senderFrame: { url: 'https://attacker.invalid/' },
    };

    const result = await dispatchIpc(harness.handlers, 'service:probe', event, {
      path: harness.media.path,
      fileToken: harness.media.token,
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'UNTRUSTED_SENDER' } });
    expect(harness.services.probe).not.toHaveBeenCalled();
  });

  it('rejects non-finite preview times before calling a service', async () => {
    const harness = makeHarness();

    const result = await dispatchIpc(harness.handlers, 'service:preview', harness.trustedEvent, {
      request: { path: harness.media.path, time: Number.NaN, requestId: 1, sessionId: 2 },
      fileToken: harness.media.token,
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    expect(harness.services.preview).not.toHaveBeenCalled();
  });

  it('does not route arbitrary shell arguments into any service', async () => {
    const harness = makeHarness();

    const result = await dispatchIpc(harness.handlers, 'shell:exec', harness.trustedEvent, {
      command: 'powershell.exe',
      args: ['-Command', 'Start-Process calc.exe'],
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'UNKNOWN_CHANNEL' } });
    expect(harness.services.probe).not.toHaveBeenCalled();
    expect(harness.services.preview).not.toHaveBeenCalled();
  });

  it('rejects a file path without a matching picker token', async () => {
    const harness = makeHarness();

    const result = await dispatchIpc(harness.handlers, 'service:probe', harness.trustedEvent, {
      path: 'C:\\private\\secret.mp4',
      fileToken: harness.media.token,
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED_FILE' } });
    expect(harness.services.probe).not.toHaveBeenCalled();
  });

  it('uses media authority for MP4 and JPG output dialogs and returns output tokens', async () => {
    const harness = makeHarness();
    const cover = await dispatchIpc(harness.handlers, 'dialog:cover-output-file', harness.trustedEvent, {
      path: harness.media.path,
      fileToken: harness.media.token,
    });
    expect(cover).toMatchObject({ ok: true, value: { path: 'C:\\media\\clip_封面.mp4' } });
    expect(harness.chooseCoverOutputFile).toHaveBeenCalledWith(harness.media.path);
    const coverSelection = cover.ok ? cover.value as { token: string; path: string } : undefined;
    expect(coverSelection && harness.selections.matches(coverSelection.token, 'output', coverSelection.path)).toBe(true);

    const frame = await dispatchIpc(harness.handlers, 'dialog:frame-output-file', harness.trustedEvent, {
      path: harness.media.path,
      fileToken: harness.media.token,
    });
    expect(frame).toMatchObject({ ok: true, value: { path: 'C:\\media\\clip_封面.jpg' } });
    expect(harness.chooseFrameOutputFile).toHaveBeenCalledWith(harness.media.path);
    const frameSelection = frame.ok ? frame.value as { token: string; path: string } : undefined;
    expect(frameSelection && harness.selections.matches(frameSelection.token, 'output', frameSelection.path)).toBe(true);
  });

  it('opens only the parent of a file backed by the matching output token', async () => {
    const harness = makeHarness();
    const output = harness.selections.issue('output', 'C:\\media\\clip_封面.mp4');
    const opened = await dispatchIpc(harness.handlers, 'filesystem:open-selected-file-directory', harness.trustedEvent, {
      path: output.path,
      purpose: 'output',
      fileToken: output.token,
    });
    expect(opened).toEqual({ ok: true, value: undefined });
    expect(harness.openedDirectory).toHaveBeenCalledWith('C:\\media');

    const rejected = await dispatchIpc(harness.handlers, 'filesystem:open-selected-file-directory', harness.trustedEvent, {
      path: 'C:\\private\\secret.mp4',
      purpose: 'output',
      fileToken: output.token,
    });
    expect(rejected).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED_FILE' } });
  });

  it('cancels a preview only through the selected media capability', async () => {
    const harness = makeHarness();
    const result = await dispatchIpc(harness.handlers, 'service:cancel-preview', harness.trustedEvent, {
      path: harness.media.path,
      requestId: 42,
      sessionId: 19,
      fileToken: harness.media.token,
    });
    expect(result).toEqual({ ok: true, value: undefined });
    expect(harness.services.cancelPreview).toHaveBeenCalledWith({ path: harness.media.path, requestId: 42, sessionId: 19 });

    const unownedCancel = await dispatchIpc(harness.handlers, 'service:cancel-preview', harness.trustedEvent, {
      path: harness.media.path,
      fileToken: harness.media.token,
    });
    expect(unownedCancel).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });

    const rejected = await dispatchIpc(harness.handlers, 'service:cancel-preview', harness.trustedEvent, {
      path: 'C:\\private\\secret.mp4',
      requestId: 43,
      fileToken: harness.media.token,
    });
    expect(rejected).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED_FILE' } });
  });

  it('allows a generated filename only inside the selected output directory', async () => {
    const harness = makeHarness();
    const directory = harness.selections.issue('directory', 'C:\\output');
    const result = await dispatchIpc(harness.handlers, 'service:start', harness.trustedEvent, {
      request: {
        inspectionId: 'inspection-1',
        variantId: 'variant-1',
        output: 'C:\\output\\movie.mp4',
        outputMode: 'copy-mp4',
        keepCache: false,
      },
      outputToken: directory.token,
    });

    expect(result).toMatchObject({ ok: true });
    expect(harness.services.start).toHaveBeenCalledWith({
      inspectionId: 'inspection-1', variantId: 'variant-1', output: 'C:\\output\\movie.mp4', outputMode: 'copy-mp4', keepCache: false,
    });
  });

  it('does not let a selected output directory authorize a path traversal', async () => {
    const harness = makeHarness();
    const directory = harness.selections.issue('directory', 'C:\\output');
    const result = await dispatchIpc(harness.handlers, 'service:start', harness.trustedEvent, {
      request: {
        inspectionId: 'inspection-1', variantId: 'variant-1', output: 'C:\\output\\..\\outside.mp4',
        outputMode: 'copy-mp4', keepCache: false,
      },
      outputToken: directory.token,
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED_OUTPUT' } });
    expect(harness.services.start).not.toHaveBeenCalled();
  });

  it('derives a completed-video picker token and opened folder from the task id', async () => {
    const harness = makeHarness();
    const result = await dispatchIpc(harness.handlers, 'service:get-task-output', harness.trustedEvent, { taskId: 'task-1' });
    expect(result).toMatchObject({ ok: true, value: { path: 'C:\\output\\rendered.mp4' } });
    const selection = result.ok ? result.value as { token: string; path: string } : undefined;
    expect(selection && harness.selections.matches(selection.token, 'media', selection.path)).toBe(true);
    expect(harness.getCompletedTaskOutput).toHaveBeenCalledWith('task-1');

    const opened = await dispatchIpc(harness.handlers, 'filesystem:open-task-output-directory', harness.trustedEvent, { taskId: 'task-1' });
    expect(opened).toEqual({ ok: true, value: undefined });
    expect(harness.openedDirectory).toHaveBeenCalledWith('C:\\output');
  });

  it('returns a plain structured error with URL credentials and query values redacted', async () => {
    const harness = makeHarness();
    harness.services.pluginStatus = vi.fn<AppServices['pluginStatus']>().mockRejectedValue(Object.assign(
      new Error('Could not read https://account:secret@example.test/video.m3u8?token=secret.'),
      { code: 'PLUGIN_READ_FAILED' },
    ));

    const result = await dispatchIpc(harness.handlers, 'service:plugin-status', harness.trustedEvent, undefined);
    expect(result).toEqual({
      ok: false,
      error: { code: 'PLUGIN_READ_FAILED', message: 'Could not read https://example.test/video.m3u8.' },
    });
  });
});
