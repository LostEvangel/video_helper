import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPluginService, type PluginServiceOptions } from '../src/main/plugin/service.js';

const temporaryDirectories: string[] = [];
const manifest = {
  clsid: '{c74c4f7e-ec39-44e4-9daa-78d6509384eb}',
  version: '0.1.0',
  dllFile: 'VideoHelperThumbnail.dll',
  sha256: '308506b7434aa9c729332ed46dde294397062f6e604feb2623e6caadbb7ba2c1',
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryBundle(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'video-helper-plugin-service-'));
  temporaryDirectories.push(directory);
  const dllBytes = Buffer.from('test x64 thumbnail payload');
  const testManifest = { ...manifest, sha256: createHash('sha256').update(dllBytes).digest('hex') };
  await writeFile(path.join(directory, 'manifest.json'), `${JSON.stringify(testManifest)}\n`);
  await writeFile(path.join(directory, testManifest.dllFile), dllBytes);
  await writeFile(path.join(directory, 'install.ps1'), '# test script');
  await writeFile(path.join(directory, 'uninstall.ps1'), '# test script');
  return directory;
}

function childWith(stdoutText: string, code = 0, stderrText = ''): ReturnType<NonNullable<PluginServiceOptions['spawn']>> {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: () => boolean;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  queueMicrotask(() => {
    if (stdoutText) child.stdout.write(stdoutText);
    child.stdout.end();
    if (stderrText) child.stderr.write(stderrText);
    child.stderr.end();
    child.emit('close', code);
  });
  return child as unknown as ReturnType<NonNullable<PluginServiceOptions['spawn']>>;
}

function statusJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    installed: true,
    active: true,
    conflict: false,
    cleanupDeferred: false,
    version: manifest.version,
    message: 'ready',
    ...overrides,
  });
}

describe('thumbnail plugin main-process service', () => {
  it('uses the fixed status script and the bundle manifest version', async () => {
    const pluginDirectory = await temporaryBundle();
    const spawn = vi.fn<NonNullable<PluginServiceOptions['spawn']>>(() => childWith(statusJson()));
    const plugin = createPluginService({ pluginDirectory, powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', spawn });

    await expect(plugin.getPluginStatus()).resolves.toMatchObject({ installed: true, active: true, version: manifest.version });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]?.[1]).toEqual([
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(pluginDirectory, 'install.ps1'), '-Status',
    ]);
    expect(spawn.mock.calls[0]?.[2]).toMatchObject({ shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  });

  it('accepts installation when it is registered but a higher-precedence handler wins', async () => {
    const pluginDirectory = await temporaryBundle();
    const spawn = vi.fn<NonNullable<PluginServiceOptions['spawn']>>(() => childWith(statusJson({ active: false, conflict: true })));
    const plugin = createPluginService({ pluginDirectory, powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', spawn });

    await expect(plugin.changePlugin('enable')).resolves.toMatchObject({ installed: true, active: false, conflict: true });
    expect(spawn.mock.calls[0]?.[1]?.slice(-2)).toEqual([path.join(pluginDirectory, 'install.ps1'), '-Install']);
  });

  it('reports failure when PowerShell exits nonzero even if stdout claims success', async () => {
    const pluginDirectory = await temporaryBundle();
    const spawn = vi.fn<NonNullable<PluginServiceOptions['spawn']>>(() => childWith(statusJson(), 1, 'registry write failed'));
    const plugin = createPluginService({ pluginDirectory, powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', spawn });

    await expect(plugin.changePlugin('enable')).rejects.toMatchObject({ code: 'PLUGIN_SCRIPT_FAILED' });
  });

  it('does not report success when the installer exits zero without an installed status', async () => {
    const pluginDirectory = await temporaryBundle();
    const spawn = vi.fn<NonNullable<PluginServiceOptions['spawn']>>(() => childWith(statusJson({ installed: false, active: false })));
    const plugin = createPluginService({ pluginDirectory, powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', spawn });

    await expect(plugin.changePlugin('enable')).rejects.toMatchObject({ code: 'PLUGIN_INSTALL_INCOMPLETE' });
  });

  it('rejects internally inconsistent status data', async () => {
    const pluginDirectory = await temporaryBundle();
    const spawn = vi.fn<NonNullable<PluginServiceOptions['spawn']>>(() => childWith(statusJson({ installed: false, active: true })));
    const plugin = createPluginService({ pluginDirectory, powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', spawn });

    await expect(plugin.getPluginStatus()).rejects.toMatchObject({ code: 'PLUGIN_STATUS_INVALID' });
  });

  it('checks the bundled DLL against the manifest before launching PowerShell', async () => {
    const pluginDirectory = await temporaryBundle();
    await writeFile(path.join(pluginDirectory, manifest.dllFile), 'tampered payload');
    const spawn = vi.fn<NonNullable<PluginServiceOptions['spawn']>>(() => childWith(statusJson()));
    const plugin = createPluginService({ pluginDirectory, powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', spawn });

    await expect(plugin.getPluginStatus()).rejects.toMatchObject({ code: 'PLUGIN_HASH_MISMATCH' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('rejects a successful disable command if the installed registration remains', async () => {
    const pluginDirectory = await temporaryBundle();
    const spawn = vi.fn<NonNullable<PluginServiceOptions['spawn']>>(() => childWith(statusJson()));
    const plugin = createPluginService({ pluginDirectory, powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', spawn });

    await expect(plugin.changePlugin('disable')).rejects.toMatchObject({ code: 'PLUGIN_UNINSTALL_INCOMPLETE' });
  });

  it('passes an updated video path as a single argument to the fixed file refresh action', async () => {
    const pluginDirectory = await temporaryBundle();
    const spawn = vi.fn<NonNullable<PluginServiceOptions['spawn']>>(() => childWith(JSON.stringify({ ok: true, action: 'notify-file' })));
    const plugin = createPluginService({ pluginDirectory, powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', spawn });
    const videoPath = 'C:\\Videos\\a movie.mp4';

    await expect(plugin.notifyFileChanged(videoPath)).resolves.toBeUndefined();
    expect(spawn.mock.calls[0]?.[1]?.slice(-4)).toEqual(['-File', path.join(pluginDirectory, 'install.ps1'), '-NotifyFile', videoPath]);
    expect(spawn.mock.calls[0]?.[1]?.at(-1)).toBe(videoPath);
  });
});
