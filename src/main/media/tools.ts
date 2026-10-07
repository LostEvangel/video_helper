import path from 'node:path';

export type MediaTool = 'ffmpeg' | 'ffprobe';

type MediaToolRuntime = {
  packaged: boolean;
  resourcesPath?: string;
};

let runtime: MediaToolRuntime = { packaged: false };

/** Selects bundled binaries in packaged builds and explicit overrides or PATH in development. */
export function configureMediaToolRuntime(next: MediaToolRuntime): void {
  if (next.packaged) {
    if (typeof next.resourcesPath !== 'string' || !path.isAbsolute(next.resourcesPath)) {
      throw new Error('Packaged media tools require Electron resourcesPath to be an absolute path.');
    }
    runtime = { packaged: true, resourcesPath: path.resolve(next.resourcesPath) };
    return;
  }
  runtime = { packaged: false };
}

export function resolveMediaTool(tool: MediaTool): string {
  if (tool !== 'ffmpeg' && tool !== 'ffprobe') throw new Error(`Unsupported media tool: ${String(tool)}`);
  if (runtime.packaged) return path.join(runtime.resourcesPath!, 'bin', `${tool}.exe`);

  const override = process.env[tool === 'ffmpeg' ? 'FFMPEG_PATH' : 'FFPROBE_PATH'];
  return override || (process.platform === 'win32' ? `${tool}.exe` : tool);
}

export function resolvePackagedResource(...segments: string[]): string | undefined {
  return runtime.packaged ? path.join(runtime.resourcesPath!, ...segments) : undefined;
}

export function resetMediaToolRuntimeForTests(): void {
  runtime = { packaged: false };
}
