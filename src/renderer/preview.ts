import type { AppServices, Preview, PreviewSession, VideoInfo } from '../shared/contracts.js';

type PreviewBridge = Pick<AppServices, 'probe' | 'preview' | 'cancelPreview'>;
type ActiveRequest = { path: string; requestId: number; sessionId: number; generation: number };

let nextRequestId = 0;

function allocateRequestId(): number {
  if (nextRequestId >= Number.MAX_SAFE_INTEGER) nextRequestId = 0;
  nextRequestId += 1;
  return nextRequestId;
}

export class PreviewController {
  private generation = 0;
  private lifecycleGeneration = 0;
  private active: ActiveRequest | undefined;
  private session: PreviewSession | undefined;
  private disposed = false;

  constructor(private readonly bridge: PreviewBridge = window.videoHelper) {}

  beginSession(filePath: string): PreviewSession {
    const previous = this.session;
    if (previous) this.cancelSession(previous);
    const session = { path: filePath, sessionId: allocateRequestId() };
    this.session = session;
    return session;
  }

  async probe(session: PreviewSession): Promise<VideoInfo | undefined> {
    if (this.disposed || this.session !== session) return undefined;
    let info: VideoInfo;
    try {
      info = await this.bridge.probe(session.path, session.sessionId);
    } catch (error) {
      throw error;
    }
    if (this.disposed || this.session !== session) return undefined;
    return info;
  }

  async request(filePath: string, time: number, session = this.session): Promise<Preview | undefined> {
    if (this.disposed || !session || session !== this.session || session.path !== filePath) {
      return undefined;
    }

    const previous = this.active;
    if (previous) this.cancelActive(previous);
    const generation = ++this.generation;
    const requestId = allocateRequestId();
    const active = { path: filePath, requestId, sessionId: session.sessionId, generation };
    this.active = active;

    try {
      const preview = await this.bridge.preview({ path: filePath, time, requestId, sessionId: session.sessionId });
      if (this.disposed || this.active !== active || generation !== this.generation) return undefined;
      this.active = undefined;
      return preview;
    } catch (error) {
      if (this.disposed || this.active !== active || generation !== this.generation) return undefined;
      this.active = undefined;
      throw error;
    }
  }

  mount(): void {
    if (!this.disposed) this.lifecycleGeneration += 1;
  }

  unmount(): void {
    const session = this.session;
    if (session) this.cancelSession(session);
    else this.cancel();
    const lifecycleGeneration = ++this.lifecycleGeneration;
    queueMicrotask(() => {
      if (this.lifecycleGeneration === lifecycleGeneration) this.dispose();
    });
  }

  cancel(filePath?: string): void {
    const active = this.active;
    if (active && (filePath === undefined || active.path === filePath)) {
      this.generation += 1;
      this.active = undefined;
      this.cancelActive(active);
    }
  }

  cancelSession(session: PreviewSession): void {
    if (this.session === session) {
      this.session = undefined;
      this.generation += 1;
    }
    const active = this.active;
    if (active?.sessionId === session.sessionId) {
      this.active = undefined;
      this.generation += 1;
      this.cancelActive(active);
    }
    void this.bridge.cancelPreview({ path: session.path, sessionId: session.sessionId }).catch(() => {});
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    const active = this.active;
    this.active = undefined;
    if (active) this.cancelActive(active);
    const session = this.session;
    this.session = undefined;
    if (session) void this.bridge.cancelPreview({ path: session.path, sessionId: session.sessionId }).catch(() => {});
  }

  private cancelActive(active: ActiveRequest): void {
    void this.bridge.cancelPreview({ path: active.path, requestId: active.requestId }).catch(() => {});
  }
}
