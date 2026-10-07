import { useEffect, useState } from 'react';
import type { PluginStatus } from '../shared/contracts.js';

type Notice = { code: string; message: string; success: boolean };

function errorNotice(error: unknown): Notice {
  if (error && typeof error === 'object') {
    const candidate = error as { code?: unknown; message?: unknown };
    return {
      code: typeof candidate.code === 'string' ? candidate.code : 'REQUEST_FAILED',
      message: typeof candidate.message === 'string' ? candidate.message : '无法读取缩略图插件状态。',
      success: false,
    };
  }
  return { code: 'REQUEST_FAILED', message: '无法读取缩略图插件状态。', success: false };
}

function statusLabel(status: PluginStatus | null): string {
  if (!status) return '正在读取插件状态…';
  if (status.active) return '已启用，Windows 正在使用此插件';
  if (status.conflict) return '已安装，但当前由其他缩略图处理器接管';
  if (status.installed) return '已注册，Windows 尚未启用';
  return status.cleanupDeferred ? '已停用，DLL 将在解除占用后清理' : '未安装（默认关闭）';
}

export default function PluginManager({ compact = false }: { compact?: boolean }) {
  const [status, setStatus] = useState<PluginStatus | null>(null);
  const [busy, setBusy] = useState(true);
  const [notice, setNotice] = useState<Notice | null>(null);

  async function refreshStatus() {
    setBusy(true);
    setNotice(null);
    try {
      setStatus(await window.videoHelper.pluginStatus());
    } catch (error) {
      setNotice(errorNotice(error));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void refreshStatus();
  }, []);

  async function change(action: 'enable' | 'disable') {
    setBusy(true);
    setNotice(null);
    try {
      const next = await window.videoHelper.changePlugin(action);
      setStatus(next);
      setNotice({
        code: next.conflict ? 'CONFLICT' : action === 'enable' ? 'ENABLED' : 'DISABLED',
        message: next.message ?? (next.conflict ? '插件已安装，但 Windows 当前使用其他处理器。' : action === 'enable' ? '缩略图插件已启用。' : '缩略图插件已停用。'),
        success: !next.conflict,
      });
    } catch (error) {
      setNotice(errorNotice(error));
      try { setStatus(await window.videoHelper.pluginStatus()); }
      catch { /* Keep the last confirmed state visible alongside the operation error. */ }
    } finally {
      setBusy(false);
    }
  }

  const message = status?.message ?? '即使关闭 Video Helper，插件仍会继续为文件资源管理器提供服务。只有点击“启用插件”后才会注册，并保留现有设置和其他处理器。';

  return (
    <section className={`panel plugin-panel${compact ? ' plugin-panel-compact' : ''}`} aria-busy={busy}>
      <div className="plugin-emblem" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2v4m0 12v4M2 12h4m12 0h4M5 5l2.8 2.8m8.4 8.4L19 19M19 5l-2.8 2.8m-8.4 8.4L5 19M8 8h8v8H8z" /></svg></div>
      <div className="plugin-copy">
        <span className="small-tag">可选组件 · {statusLabel(status)}</span>
        <h2>{compact ? '文件资源管理器缩略图插件' : '在文件资源管理器中显示内嵌封面'}</h2>
        <p>{message}</p>
        {status?.version && <p className="plugin-version">版本 {status.version}</p>}
      </div>
      {notice && <div className={`notice${notice.success ? ' success' : ''}`} role="status" aria-live="polite"><span className="notice-code">{notice.code}</span><span>{notice.message}</span></div>}
      <div className="plugin-actions">
        <button className="secondary-button" type="button" onClick={() => void refreshStatus()} disabled={busy}>重新检查</button>
        <button className="secondary-button" type="button" onClick={() => void change('disable')} disabled={busy || !status?.installed}>停用插件</button>
        <button className="primary-button" type="button" onClick={() => void change('enable')} disabled={busy || Boolean(status?.active)}>启用插件</button>
      </div>
      {!status?.installed && <p className="plugin-opt-in-note">安装主程序时不会自动注册此组件。启用后，还需要在 Windows 文件夹选项中开启缩略图显示。</p>}
    </section>
  );
}
