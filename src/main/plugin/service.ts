import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { PluginStatus } from '../../shared/contracts.js';

const THUMBNAIL_CLSID = '{c74c4f7e-ec39-44e4-9daa-78d6509384eb}';
const MAX_OUTPUT_CHARS = 256 * 1024;

type PluginManifest = { clsid: string; version: string; dllFile: string; sha256: string };
type PluginChild = {
  stdout: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown } | null;
  stderr: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown } | null;
  once(event: 'error', listener: (error: Error) => void): unknown;
  once(event: 'close', listener: (code: number | null) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
};
type SpawnPluginProcess = (command: string, args: string[], options: SpawnOptions) => PluginChild;

export type PluginServiceOptions = {
  pluginDirectory: string;
  powershellPath?: string;
  platform?: NodeJS.Platform;
  spawn?: SpawnPluginProcess;
  timeoutMs?: number;
};

type PluginService = {
  getPluginStatus(): Promise<PluginStatus>;
  changePlugin(action: 'enable' | 'disable'): Promise<PluginStatus>;
  notifyFileChanged(filePath: string): Promise<void>;
};

function pluginError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseManifest(source: string): PluginManifest {
  let value: unknown;
  try {
    value = JSON.parse(source.replace(/^\uFEFF/, ''));
  } catch {
    throw pluginError('PLUGIN_MANIFEST_INVALID', '无法读取缩略图插件 manifest.json。');
  }
  if (!isRecord(value) || typeof value.clsid !== 'string' || !/\{[0-9a-fA-F-]{36}\}/.test(value.clsid)
    || value.clsid.toLocaleLowerCase('en-US') !== THUMBNAIL_CLSID
    || typeof value.version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.version)
    || typeof value.dllFile !== 'string' || !/^[A-Za-z0-9._-]{1,128}\.dll$/.test(value.dllFile)
    || typeof value.sha256 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(value.sha256)) {
    throw pluginError('PLUGIN_MANIFEST_INVALID', '缩略图插件 manifest.json 字段不符合受支持的 x64 组件格式。');
  }
  return { clsid: value.clsid, version: value.version, dllFile: value.dllFile, sha256: value.sha256 };
}

function parseStatus(value: unknown, manifest: PluginManifest): PluginStatus {
  if (!isRecord(value) || typeof value.installed !== 'boolean' || typeof value.active !== 'boolean'
    || typeof value.conflict !== 'boolean' || typeof value.cleanupDeferred !== 'boolean'
    || value.version !== manifest.version || (value.message !== undefined && typeof value.message !== 'string')
    || (value.active && (!value.installed || value.conflict))) {
    throw pluginError('PLUGIN_STATUS_INVALID', '缩略图插件脚本报告的状态不一致，无法确认操作结果。');
  }
  return {
    installed: value.installed,
    active: value.active,
    conflict: value.conflict,
    cleanupDeferred: value.cleanupDeferred,
    version: manifest.version,
    ...(typeof value.message === 'string' ? { message: value.message } : {}),
  };
}

function lastJsonLine(output: string): unknown {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) throw pluginError('PLUGIN_OUTPUT_INVALID', '缩略图插件脚本未返回状态数据。');
  try {
    return JSON.parse(lines[lines.length - 1]!) as unknown;
  } catch {
    throw pluginError('PLUGIN_OUTPUT_INVALID', '缩略图插件脚本返回的状态数据不是有效 JSON。');
  }
}

function appendBounded(current: string, chunk: Buffer | string, child: PluginChild): string {
  const next = current + chunk.toString();
  if (next.length > MAX_OUTPUT_CHARS) {
    child.kill();
    throw pluginError('PLUGIN_OUTPUT_TOO_LARGE', '缩略图插件脚本的输出超过允许大小。');
  }
  return next;
}

function createFixedPowerShellService(options: PluginServiceOptions): PluginService {
  const pluginDirectory = path.resolve(options.pluginDirectory);
  const platform = options.platform ?? process.platform;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const spawnProcess = options.spawn ?? (nodeSpawn as unknown as SpawnPluginProcess);
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const powershellPath = path.resolve(options.powershellPath ?? path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));

  async function readManifest(): Promise<PluginManifest> {
    if (platform !== 'win32') throw pluginError('PLUGIN_UNSUPPORTED_PLATFORM', 'Windows 缩略图插件仅支持 Windows 10/11 x64。');
    if (!path.win32.isAbsolute(powershellPath)) throw pluginError('PLUGIN_POWERSHELL_UNAVAILABLE', 'Windows PowerShell 的固定安装路径无效。');
    const manifestPath = path.join(pluginDirectory, 'manifest.json');
    try {
      const manifest = parseManifest(await readFile(manifestPath, 'utf8'));
      const dllPath = path.resolve(pluginDirectory, manifest.dllFile);
      const bundlePrefix = pluginDirectory.endsWith(path.sep) ? pluginDirectory : `${pluginDirectory}${path.sep}`;
      if (!dllPath.startsWith(bundlePrefix)) throw pluginError('PLUGIN_MANIFEST_INVALID', '缩略图插件 DLL 路径位于组件目录之外。');
      const dll = await readFile(dllPath);
      const actualHash = createHash('sha256').update(dll).digest('hex');
      if (actualHash.toLocaleLowerCase('en-US') !== manifest.sha256.toLocaleLowerCase('en-US')) {
        throw pluginError('PLUGIN_HASH_MISMATCH', '缩略图插件 DLL 的 SHA-256 与 manifest.json 不一致。');
      }
      return manifest;
    } catch (error) {
      if (isRecord(error) && typeof error.code === 'string' && error.code.startsWith('PLUGIN_')) throw error;
      throw pluginError('PLUGIN_BUNDLE_UNAVAILABLE', '找不到完整的缩略图插件组件；请修复或重新安装 Video Helper。');
    }
  }

  function getScriptPath(fileName: 'install.ps1' | 'uninstall.ps1'): string {
    if (path.basename(fileName) !== fileName) throw pluginError('PLUGIN_SCRIPT_UNAVAILABLE', '缩略图插件脚本路径无效。');
    const scriptPath = path.resolve(pluginDirectory, fileName);
    const bundlePrefix = pluginDirectory.endsWith(path.sep) ? pluginDirectory : `${pluginDirectory}${path.sep}`;
    if (!scriptPath.startsWith(bundlePrefix)) throw pluginError('PLUGIN_SCRIPT_UNAVAILABLE', '缩略图插件脚本位于组件目录之外。');
    return scriptPath;
  }

  async function runScript(scriptPath: string, scriptArgs: string[]): Promise<unknown> {
    if (platform !== 'win32') throw pluginError('PLUGIN_UNSUPPORTED_PLATFORM', 'Windows 缩略图插件仅支持 Windows 10/11 x64。');
    const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...scriptArgs];
    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      let overflowError: (Error & { code: string }) | undefined;
      let timer: NodeJS.Timeout | undefined;
      const finish = (error?: Error, result?: unknown) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (error) reject(error);
        else resolve(result);
      };
      let child: PluginChild;
      try {
        child = spawnProcess(powershellPath, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (error) {
        finish(pluginError('PLUGIN_PROCESS_START_FAILED', `无法启动缩略图插件管理进程：${error instanceof Error ? error.message : String(error)}`));
        return;
      }
      child.stdout?.on('data', (chunk) => {
        try { stdout = appendBounded(stdout, chunk, child); }
        catch (error) { overflowError = error as Error & { code: string }; }
      });
      child.stderr?.on('data', (chunk) => {
        try { stderr = appendBounded(stderr, chunk, child); }
        catch (error) { overflowError = error as Error & { code: string }; }
      });
      child.once('error', (error) => finish(pluginError('PLUGIN_PROCESS_START_FAILED', `无法启动缩略图插件管理进程：${error.message}`)));
      child.once('close', (code) => {
        if (overflowError) { finish(overflowError); return; }
        if (code !== 0) {
          const detail = stderr.trim() || stdout.trim() || `PowerShell exited with code ${String(code)}.`;
          finish(pluginError('PLUGIN_SCRIPT_FAILED', `缩略图插件操作失败：${detail}`));
          return;
        }
        try { finish(undefined, lastJsonLine(stdout)); }
        catch (error) { finish(error as Error); }
      });
      timer = setTimeout(() => {
        child.kill();
        finish(pluginError('PLUGIN_SCRIPT_TIMEOUT', '缩略图插件管理超时，请稍后检查插件状态。'));
      }, timeoutMs);
      timer.unref();
    });
  }

  async function getPluginStatus(): Promise<PluginStatus> {
    const manifest = await readManifest();
    const output = await runScript(getScriptPath('install.ps1'), ['-Status']);
    return parseStatus(output, manifest);
  }

  async function changePlugin(action: 'enable' | 'disable'): Promise<PluginStatus> {
    if (action !== 'enable' && action !== 'disable') throw pluginError('INVALID_PLUGIN_ACTION', '缩略图插件操作无效。');
    const manifest = await readManifest();
    const scriptName = action === 'enable' ? 'install.ps1' : 'uninstall.ps1';
    const args = action === 'enable' ? ['-Install'] : [];
    const output = await runScript(getScriptPath(scriptName), args);
    const status = parseStatus(output, manifest);
    if (action === 'enable' && !status.installed) {
      throw pluginError('PLUGIN_INSTALL_INCOMPLETE', '安装脚本结束后，Windows 注册表中没有显示插件已安装。');
    }
    if (action === 'disable' && status.installed) {
      throw pluginError('PLUGIN_UNINSTALL_INCOMPLETE', '卸载脚本结束后，Windows 注册表中仍显示插件已安装。');
    }
    return status;
  }

  async function notifyFileChanged(filePath: string): Promise<void> {
    if (typeof filePath !== 'string' || !path.win32.isAbsolute(filePath) || filePath.includes('\0')) {
      throw pluginError('INVALID_PLUGIN_FILE', '缩略图更新通知需要有效的绝对文件路径。');
    }
    const output = await runScript(getScriptPath('install.ps1'), ['-NotifyFile', path.win32.normalize(filePath)]);
    if (!isRecord(output) || output.ok !== true || output.action !== 'notify-file') {
      throw pluginError('PLUGIN_NOTIFICATION_FAILED', 'Windows 未确认指定视频的缩略图更新通知。');
    }
  }

  return { getPluginStatus, changePlugin, notifyFileChanged };
}

export function createPluginService(options: PluginServiceOptions): PluginService {
  return createFixedPowerShellService(options);
}

export type { PluginService };
