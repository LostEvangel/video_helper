import { useEffect, useState } from 'react';
import type { AppSettings } from '../shared/contracts.js';
import PluginManager from './PluginManager.js';

type Notice = { code: string; message: string };

function noticeFrom(error: unknown): Notice {
  if (error && typeof error === 'object') {
    const candidate = error as { code?: unknown; message?: unknown };
    return {
      code: typeof candidate.code === 'string' ? candidate.code : 'REQUEST_FAILED',
      message: typeof candidate.message === 'string' ? candidate.message : '无法保存设置，请稍后重试。',
    };
  }
  return { code: 'REQUEST_FAILED', message: '无法保存设置，请稍后重试。' };
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  useEffect(() => {
    let active = true;
    void window.videoHelper.getSettings().then((value) => {
      if (active) setSettings(value);
    }).catch((error) => {
      if (active) setNotice(noticeFrom(error));
    });
    return () => { active = false; };
  }, []);

  async function chooseCacheDirectory() {
    setBusy(true);
    setNotice(null);
    try {
      const selection = await window.videoHelper.chooseCacheDirectory();
      if (selection && settings) setSettings({ ...settings, cacheDir: selection.path });
    } catch (error) {
      setNotice(noticeFrom(error));
    } finally {
      setBusy(false);
    }
  }

  async function saveSettings() {
    if (!settings) return;
    setBusy(true);
    setNotice(null);
    try {
      const saved = await window.videoHelper.updateSettings(settings);
      setSettings(saved);
      setNotice({ code: 'SAVED', message: '设置已保存，新设置会应用于之后创建的任务。' });
    } catch (error) {
      setNotice(noticeFrom(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="page-content settings-page">
      <div className="page-heading compact-heading">
        <div><div className="eyebrow"><span className="eyebrow-line" />偏好设置</div><h1>调整下载行为</h1><p>网络并发数仅对新任务生效；正在运行的任务会保留创建时的设置。</p></div>
        <div className="heading-icon settings-heading-icon" aria-hidden="true">⚙</div>
      </div>

      {!settings ? <section className="panel settings-panel"><p>正在读取设置…</p></section> : <section className="panel settings-panel">
        <div className="settings-group">
          <label className="field-label" htmlFor="network-concurrency">每个任务的网络并发数
            <select id="network-concurrency" value={settings.networkConcurrency} disabled={busy} onChange={(event) => setSettings({ ...settings, networkConcurrency: Number(event.target.value) })}>
              {Array.from({ length: 8 }, (_, index) => index + 1).map((value) => <option key={value} value={value}>{value} 个并发请求</option>)}
            </select>
          </label>
          <p className="settings-hint">可设置 1–8 个请求，默认值为 4。下载队列仍按顺序执行，一次只处理一个任务。</p>
        </div>

        <div className="settings-group">
          <label className="checkbox-row"><input type="checkbox" checked={settings.keepCache} disabled={busy} onChange={(event) => setSettings({ ...settings, keepCache: event.target.checked })} /><span>默认保留下载缓存</span></label>
          <p className="settings-hint">关闭后，视频成功发布时会清理该任务的临时文件；失败或暂停的任务仍会保留已下载资源，方便重试。</p>
        </div>

        <div className="settings-group">
          <div className="field-label">缓存文件夹</div>
          <div className="cache-directory-row"><div className="cache-directory-value" title={settings.cacheDir}>{settings.cacheDir}</div><button className="secondary-button" type="button" onClick={() => void chooseCacheDirectory()} disabled={busy}>选择文件夹</button></div>
          <p className="settings-hint">更改后，新任务会使用新文件夹；已有任务仍会从原缓存位置恢复。</p>
        </div>

        {notice && <div className={`notice${notice.code === 'SAVED' ? ' success' : ''}`} role="status"><span className="notice-code">{notice.code}</span><span>{notice.message}</span></div>}
        <div className="settings-actions"><button className="primary-button" type="button" onClick={() => void saveSettings()} disabled={busy}>{busy ? '正在保存…' : '保存设置'}</button></div>
      </section>}
      <div className="settings-plugin-section">
        <div className="settings-group-heading"><span className="eyebrow"><span className="eyebrow-line" />Windows 集成</span><h2>缩略图插件</h2></div>
        <p className="settings-hint">安装主程序后不会注册缩略图处理器。如需在文件资源管理器中读取内嵌封面，请在此启用。也可通过独立 ZIP 在其他电脑上安装插件。</p>
        <PluginManager compact />
      </div>
    </section>
  );
}
