import { describe, expect, it, vi } from 'vitest';
import type { Preview, PreviewRequest } from '../src/shared/contracts.js';
import { formatTime, parseTime } from '../src/renderer/time.js';
import { PreviewController } from '../src/renderer/preview.js';
import { createServices } from '../src/main/services.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

describe('cover time input', () => {
  it('parses a millisecond timestamp', () => {
    expect(parseTime('00:01:23.450')).toBe(83.45);
  });

  it.each(['00:61:00.000', '', 'NaN', '00:00:60.000', '0:00:00.000', '00:00:00.00'])('rejects invalid timestamp %j', (value) => {
    expect(() => parseTime(value)).toThrow();
  });

  it('formats a timestamp with millisecond precision', () => {
    expect(formatTime(83.45)).toBe('00:01:23.450');
  });
});

describe('cover preview ordering', () => {
  it('survives StrictMode setup-cleanup-setup and cancels on the final unmount', async () => {
    const active = deferred<Preview>();
    const preview = vi.fn((_request: PreviewRequest) => active.promise);
    const cancelPreview = vi.fn().mockResolvedValue(undefined);
    const controller = new PreviewController({
      probe: vi.fn(),
      preview,
      cancelPreview,
    });

    controller.mount();
    controller.unmount();
    controller.mount();
    await Promise.resolve();

    const session = controller.beginSession('C:\\media\\clip.mp4');
    const request = controller.request('C:\\media\\clip.mp4', 1, session);
    expect(preview).toHaveBeenCalledTimes(1);
    controller.unmount();
    const requestId = preview.mock.calls[0]?.[0].requestId;
    expect(cancelPreview).toHaveBeenCalledWith({ path: 'C:\\media\\clip.mp4', requestId });
    expect(cancelPreview).toHaveBeenCalledWith({ path: 'C:\\media\\clip.mp4', sessionId: session.sessionId });
    active.resolve({ requestId: requestId!, imageUrl: 'data:image/jpeg;base64,frame', time: 1 });
    await expect(request).resolves.toBeUndefined();
    await Promise.resolve();
    await expect(controller.request('C:\\media\\clip.mp4', 2, session)).resolves.toBeUndefined();
    expect(preview).toHaveBeenCalledTimes(1);
  });

  it('does not send an unowned path-only cancel when no renderer request is active', async () => {
    const cancelPreview = vi.fn().mockResolvedValue(undefined);
    const controller = new PreviewController({ probe: vi.fn(), preview: vi.fn(), cancelPreview });
    const session = controller.beginSession('C:\\media\\clip.mp4');

    controller.cancel(session.path);

    expect(cancelPreview).not.toHaveBeenCalled();
    controller.cancelSession(session);
    expect(cancelPreview).toHaveBeenCalledWith({ path: session.path, sessionId: session.sessionId });
  });

  it('ignores a delayed cancel from the previous same-path session', async () => {
    const staleFrame = deferred<{ jpeg: Buffer; time: number }>();
    const latestFrame = deferred<{ jpeg: Buffer; time: number }>();
    const cancelGate = deferred<void>();
    const signals: AbortSignal[] = [];
    const services = createServices({
      extractFrame: vi.fn((_path, time, signal) => {
        signals.push(signal);
        return time === 1 ? staleFrame.promise : latestFrame.promise;
      }),
    });
    const delayedCancel = vi.fn(async (request: { path: string; requestId?: number; sessionId?: number }) => {
      await cancelGate.promise;
      await services.cancelPreview(request);
    });
    const controller = new PreviewController({
      probe: vi.fn(),
      preview: (request) => services.preview(request),
      cancelPreview: delayedCancel,
    });
    const path = 'C:\\media\\clip.mp4';
    const firstSession = controller.beginSession(path);
    const staleRequest = controller.request(path, 1, firstSession);
    const latestSession = controller.beginSession(path);
    const latestRequest = controller.request(path, 2, latestSession);
    expect(signals[1]?.aborted).toBe(false);

    cancelGate.resolve();
    await Promise.all(delayedCancel.mock.results.map((result) => result.value));
    expect(signals[1]?.aborted).toBe(false);

    staleFrame.resolve({ jpeg: Buffer.from('old'), time: 1 });
    latestFrame.resolve({ jpeg: Buffer.from('new'), time: 2 });
    await expect(staleRequest).resolves.toBeUndefined();
    await expect(latestRequest).resolves.toMatchObject({ requestId: expect.any(Number), time: 2 });
    await services.shutdown();
  });

  it('does not let an earlier request replace a later preview', async () => {
    const first = deferred<Preview>();
    const second = deferred<Preview>();
    const preview = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const controller = new PreviewController({
      probe: vi.fn(),
      preview,
      cancelPreview: vi.fn().mockResolvedValue(undefined),
    });
    const currentSession = controller.beginSession('C:\\media\\clip.mp4');
    const visible: Preview[] = [];

    const firstRequest = controller.request('C:\\media\\clip.mp4', 1, currentSession).then((value) => {
      if (value) visible.push(value);
    });
    const secondRequest = controller.request('C:\\media\\clip.mp4', 2, currentSession).then((value) => {
      if (value) visible.push(value);
    });
    second.resolve({ requestId: 2, imageUrl: 'data:image/jpeg;base64,second', time: 2 });
    await secondRequest;
    first.resolve({ requestId: 1, imageUrl: 'data:image/jpeg;base64,first', time: 1 });
    await firstRequest;

    expect(visible.map((item) => item.imageUrl)).toEqual(['data:image/jpeg;base64,second']);
    controller.dispose();
  });

  it('aborts superseded extraction in main and ignores a stale cancellation id', async () => {
    const first = deferred<{ jpeg: Buffer; time: number }>();
    const second = deferred<{ jpeg: Buffer; time: number }>();
    const signals: AbortSignal[] = [];
    const services = createServices({
      extractFrame: vi.fn((_path, time, signal) => {
        signals.push(signal);
        return time === 1 ? first.promise : second.promise;
      }),
    });

    const staleRequest = services.preview({ path: 'C:\\media\\first.mp4', time: 1, requestId: 101, sessionId: 501 }).then(
      () => undefined,
      () => undefined,
    );
    const latestRequest = services.preview({ path: 'C:\\media\\first.mp4', time: 2, requestId: 102, sessionId: 502 });
    expect(signals[0]?.aborted).toBe(true);

    await services.cancelPreview({ path: 'C:\\media\\first.mp4', requestId: 101 });
    expect(signals[1]?.aborted).toBe(false);
    await services.cancelPreview({ path: 'C:\\media\\first.mp4', sessionId: 501 });
    expect(signals[1]?.aborted).toBe(false);
    second.resolve({ jpeg: Buffer.from('jpeg'), time: 2.004 });
    await expect(latestRequest).resolves.toMatchObject({
      requestId: 102,
      imageUrl: `data:image/jpeg;base64,${Buffer.from('jpeg').toString('base64')}`,
      time: 2.004,
    });
    first.resolve({ jpeg: Buffer.from('old'), time: 1 });
    await staleRequest;
    expect(signals[0]?.aborted).toBe(true);
    await services.shutdown();
  });
});
