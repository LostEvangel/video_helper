import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppServices, DesktopApi, VideoInfo } from '../src/shared/contracts.js';
import { PreviewController } from '../src/renderer/preview.js';
import { createServices } from '../src/main/services.js';
import { createIpcHandlers, registerIpcHandlers, FileSelectionRegistry, type IpcEvent, type IpcMainRegistrar } from '../src/main/ipc.js';

const mocks = vi.hoisted(() => ({
  api: undefined as unknown,
  ipcInvoke: vi.fn(),
  probeVideoWithSignal: vi.fn(),
}));

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (_name: string, api: unknown) => { mocks.api = api; },
  },
  ipcRenderer: {
    invoke: mocks.ipcInvoke,
    on: vi.fn(),
    removeListener: vi.fn(),
  },
}));

vi.mock('../src/main/media/probe.js', () => ({
  probeVideoWithSignal: mocks.probeVideoWithSignal,
}));

import '../src/main/preload.js';

type ProbeJob = { path: string; signal: AbortSignal };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((complete, fail) => { resolve = complete; reject = fail; });
  return { promise, resolve, reject };
}

function createBridgeHarness() {
  const selectedPath = 'C:\\media\\cover.mp4';
  const webContents = { id: 7 };
  const mainFrame = { url: 'file:///app/index.html' };
  const event: IpcEvent = { sender: webContents, senderFrame: mainFrame };
  const selections = new FileSelectionRegistry();
  const services = createServices();
  const cancelSpy = vi.spyOn(services, 'cancelPreview');
  const handlers = createIpcHandlers({
    services,
    selections,
    security: { webContents, mainFrame, trustedPageUrl: 'file:///app/index.html' },
    chooseMediaFile: async () => selectedPath,
  });
  const registered = new Map<string, (requestEvent: IpcEvent, payload: unknown) => Promise<unknown>>();
  const registrar: IpcMainRegistrar = {
    removeHandler: vi.fn(),
    handle: (channel, listener) => { registered.set(channel, listener); },
  };
  registerIpcHandlers(registrar, handlers);

  const route = (channel: string, payload?: unknown): Promise<unknown> => {
    const handler = registered.get(channel);
    if (!handler) throw new Error(`No registered handler for ${channel}.`);
    return handler(event, payload);
  };

  return { api: mocks.api as DesktopApi, selectedPath, services, cancelSpy, route };
}

describe('preload preview cancellation bridge', () => {
  beforeEach(() => {
    mocks.ipcInvoke.mockReset();
    mocks.probeVideoWithSignal.mockReset();
  });

  it('routes an old session cancel without aborting the newer probe, then cancels the active page probe', async () => {
    const jobs: ProbeJob[] = [];
    mocks.probeVideoWithSignal.mockImplementation((filePath: string, signal: AbortSignal) => new Promise<VideoInfo>((_resolve, reject) => {
      jobs.push({ path: filePath, signal });
      signal.addEventListener('abort', () => reject(Object.assign(new Error('probe cancelled'), { name: 'AbortError' })), { once: true });
    }));

    const harness = createBridgeHarness();
    const { api, selectedPath, services, cancelSpy, route } = harness;
    mocks.ipcInvoke.mockImplementation((channel: string, payload: unknown) => route(channel, payload));
    const selected = await api.chooseMediaFile();
    expect(selected?.path).toBe(selectedPath);

    const cancelGate = deferred<void>();
    let shouldDelayNextCancel = true;
    let heldPayload: unknown;
    let heldCancel: Promise<unknown> | undefined;
    let releaseHeldCancel: (() => void) | undefined;
    mocks.ipcInvoke.mockImplementation((channel: string, payload: unknown) => {
      if (channel === 'service:cancel-preview' && shouldDelayNextCancel) {
        shouldDelayNextCancel = false;
        heldPayload = payload;
        heldCancel = cancelGate.promise.then(() => route(channel, payload));
        releaseHeldCancel = () => cancelGate.resolve(undefined);
        return heldCancel;
      }
      return route(channel, payload);
    });

    const controller = new PreviewController(api as Pick<AppServices, 'probe' | 'preview' | 'cancelPreview'>);
    let oldProbe: Promise<unknown> = Promise.resolve();
    let currentProbe: Promise<unknown> = Promise.resolve();
    try {
      const oldSession = controller.beginSession(selectedPath);
      oldProbe = controller.probe(oldSession).catch(() => undefined);
      expect(jobs).toHaveLength(1);

      const currentSession = controller.beginSession(selectedPath);
      currentProbe = controller.probe(currentSession).catch(() => undefined);
      expect(jobs).toHaveLength(2);
      expect(jobs[0]?.signal.aborted).toBe(true);
      expect(jobs[1]?.signal.aborted).toBe(false);

      releaseHeldCancel?.();
      await heldCancel;
      expect(heldPayload).toMatchObject({ path: selectedPath, sessionId: oldSession.sessionId });
      expect(cancelSpy).toHaveBeenCalledWith({ path: selectedPath, sessionId: oldSession.sessionId });
      expect(jobs[1]?.signal.aborted).toBe(false);

      controller.unmount();
      expect(cancelSpy).toHaveBeenCalledWith({ path: selectedPath, sessionId: currentSession.sessionId });
      expect(jobs[1]?.signal.aborted).toBe(true);
    } finally {
      releaseHeldCancel?.();
      await heldCancel?.catch(() => undefined);
      controller.unmount();
      await services.shutdown();
      await Promise.all([oldProbe, currentProbe]);
    }
  });
});
