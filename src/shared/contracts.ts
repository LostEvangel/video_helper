export type InputSource = { kind: 'url'; url: string } | { kind: 'file'; path: string; baseUrl?: string };
export type Locator = { kind: 'url' | 'file'; value: string };
export type Resource = {
  id: string;
  source: Locator;
  role: 'segment' | 'key' | 'init';
  range?: { offset: number; length: number };
};
export type Variant = { id: string; label: string; uri: Locator };
export type AudioTrack = { id: string; label: string; uri?: Locator; groupId: string };
export type Inspection = {
  id: string;
  variants: Variant[];
  audioTracks: AudioTrack[];
  duration?: number;
  segmentCount?: number;
  example?: string;
};
export type DownloadManifest = {
  id: string;
  resources: Resource[];
  videoText: string;
  audioText?: string;
  duration: number;
  snapshotHash: string;
  snapshots: { source: Locator; text: string; baseUrl?: string }[];
};
export type TaskState = 'queued' | 'downloading' | 'paused' | 'merging' | 'completed' | 'failed' | 'cancelled';
export type TaskView = {
  id: string;
  state: TaskState;
  completed: number;
  total: number;
  bytesPerSecond: number;
  output?: string;
  error?: string;
};
export type AppSettings = {
  networkConcurrency: number;
  keepCache: boolean;
  cacheDir: string;
};
export type StreamInfo = {
  index: number;
  kind: 'video' | 'audio' | 'subtitle' | 'other';
  codec: string;
  attachedPicture: boolean;
};
export type VideoInfo = { path: string; duration: number; width: number; height: number; streams: StreamInfo[] };
export type Preview = { requestId: number; imageUrl: string; time: number };
export type PreviewSession = { path: string; sessionId: number };
export type PreviewRequest = { path: string; time: number; requestId: number; sessionId: number };
export type PreviewCancellation = { path: string; requestId?: number; sessionId?: number };
export type CoverResult = { output: string; embedded: boolean; nativeDisplay: 'unverified' };
export type PluginStatus = {
  installed: boolean;
  active: boolean;
  conflict: boolean;
  cleanupDeferred?: boolean;
  version?: string;
  message?: string;
};
export type AppError = { code: string; message: string };
export type Result<T> = { ok: true; value: T } | { ok: false; error: AppError };
export type FileSelection = { token: string; path: string; name: string };
export type OutputMode = 'copy-mp4' | 'copy-mkv' | 'transcode-mp4';
export type TaskControl = 'pause' | 'resume' | 'cancel' | 'retry' | 'clear';
export type RouteId = 'download' | 'library' | 'plugin' | 'settings' | 'cover';

export interface AppServices {
  inspect(source: InputSource): Promise<Inspection>;
  start(request: {
    inspectionId: string;
    variantId: string;
    audioId?: string;
    output: string;
    outputMode: OutputMode;
    keepCache: boolean;
  }): Promise<TaskView>;
  listTasks(): Promise<TaskView[]>;
  control(request: { id: string; action: TaskControl; outputMode?: OutputMode }): Promise<void>;
  getSettings(): Promise<AppSettings>;
  updateSettings(settings: AppSettings): Promise<AppSettings>;
  probe(path: string, requestId: number): Promise<VideoInfo>;
  preview(request: PreviewRequest): Promise<Preview>;
  cancelPreview(request: PreviewCancellation): Promise<void>;
  saveCover(request: { path: string; time: number; output: string; replace: boolean }): Promise<CoverResult>;
  exportFrame(request: { path: string; time: number; output: string }): Promise<void>;
  pluginStatus(): Promise<PluginStatus>;
  changePlugin(action: 'enable' | 'disable'): Promise<PluginStatus>;
}

export interface DesktopApi extends AppServices {
  chooseInputFile(): Promise<FileSelection | null>;
  chooseMediaFile(): Promise<FileSelection | null>;
  chooseOutputFile(): Promise<FileSelection | null>;
  chooseCoverOutputFile(path: string): Promise<FileSelection | null>;
  chooseFrameOutputFile(path: string): Promise<FileSelection | null>;
  chooseOutputDirectory(): Promise<FileSelection | null>;
  chooseCacheDirectory(): Promise<FileSelection | null>;
  openOutputDirectory(directoryToken: string): Promise<void>;
  openSelectedFileDirectory(path: string, purpose: 'media' | 'output'): Promise<void>;
  openTaskOutputDirectory(taskId: string): Promise<void>;
  getTaskOutput(taskId: string): Promise<FileSelection>;
  onTasksChanged(listener: (tasks: TaskView[]) => void): () => void;
}

declare global {
  interface Window {
    videoHelper: DesktopApi;
  }
}
