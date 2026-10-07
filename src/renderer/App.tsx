import { useEffect, useState } from 'react';
import type { RouteId, TaskView } from '../shared/contracts.js';
import DownloadPage from './DownloadPage.js';
import CoverPage from './CoverPage.js';
import PluginManager from './PluginManager.js';
import SettingsPage from './SettingsPage.js';
import './App.css';
import './styles.css';

function Icon({ name }: { name: 'download' | 'library' | 'plugin' | 'folder' | 'arrow' | 'film' | 'spark' | 'settings' }) {
  const paths: Record<typeof name, string> = {
    download: 'M12 3v12m0 0 4-4m-4 4-4-4M5 20h14',
    library: 'M4 5.5 12 2l8 3.5v13L12 22l-8-3.5v-13ZM4 5.5l8 3.5 8-3.5M12 9v13',
    plugin: 'M12 2v4m0 12v4M2 12h4m12 0h4M5 5l2.8 2.8m8.4 8.4L19 19M19 5l-2.8 2.8m-8.4 8.4L5 19M8 8h8v8H8z',
    folder: 'M3 6.5h7l2 2h9v9.8A1.7 1.7 0 0 1 19.3 20H4.7A1.7 1.7 0 0 1 3 18.3V6.5Z',
    arrow: 'M5 12h14m-6-6 6 6-6 6',
    film: 'M4 4h16v16H4zM4 9h16M4 15h16M9 4v5m6-5v5m-6 6v5m6-5v5',
    spark: 'm12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3ZM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16Z',
    settings: 'M12 8.3a3.7 3.7 0 1 0 0 7.4 3.7 3.7 0 0 0 0-7.4ZM19.4 13.5l1.3 1-1.4 2.4-1.6-.5a7 7 0 0 1-1.2.7l-.3 1.7h-2.8l-.3-1.7a7 7 0 0 1-1.3-.7l-1.5.5-1.4-2.4 1.3-1a6.4 6.4 0 0 1 0-1.5l-1.3-1 1.4-2.4 1.5.5c.4-.3.8-.5 1.3-.7l.3-1.7h2.8l.3 1.7c.5.2.9.4 1.2.7l1.6-.5 1.4 2.4-1.3 1c.1.5.1 1 0 1.5Z',
  };
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={paths[name]} /></svg>;
}

function App() {
  const [route, setRoute] = useState<RouteId>('download');
  const [busy, setBusy] = useState(false);
  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [chosenVideo, setChosenVideo] = useState('');

  useEffect(() => {
    let active = true;
    const unsubscribe = window.videoHelper.onTasksChanged((next) => {
      if (active) setTasks(next);
    });
    void window.videoHelper.listTasks().then((next) => {
      if (active) setTasks(next);
    }).catch(() => {});
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  async function refreshTasks() {
    setBusy(true);
    try { setTasks(await window.videoHelper.listTasks()); }
    catch { /* The task list refresh is retried the next time the page loads. */ }
    finally { setBusy(false); }
  }

  async function refreshTasksFromDownload(): Promise<void> {
    setTasks(await window.videoHelper.listTasks());
  }

  const navItems: { id: RouteId; label: string; detail: string; icon: 'download' | 'library' | 'plugin' | 'settings' }[] = [
    { id: 'download', label: '下载视频', detail: '解析与输出', icon: 'download' },
    { id: 'library', label: '本地视频', detail: '信息与封面', icon: 'library' },
    { id: 'plugin', label: '缩略图插件', detail: 'Windows 文件资源管理器', icon: 'plugin' },
    { id: 'settings', label: '偏好设置', detail: '队列与缓存', icon: 'settings' },
  ];
  const currentLabel = route === 'cover' ? '设置封面' : navItems.find((item) => item.id === route)?.label;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-lockup">
          <div className="brand-mark"><Icon name="film" /></div>
          <div><div className="brand-name">Video Helper</div><div className="brand-caption">LOCAL MEDIA DESK</div></div>
        </div>
        <div className="nav-label">工作区</div>
        <nav aria-label="主导航">
          {navItems.map((item) => <button key={item.id} type="button" className={`nav-item${route === item.id ? ' is-active' : ''}`} onClick={() => setRoute(item.id)} aria-current={route === item.id ? 'page' : undefined}>
            <span className="nav-icon"><Icon name={item.icon} /></span><span className="nav-copy"><strong>{item.label}</strong><small>{item.detail}</small></span><span className="nav-chevron"><Icon name="arrow" /></span>
          </button>)}
        </nav>
        <div className="sidebar-bottom"><div className="local-card"><span className="local-dot" /><div><strong>本地处理</strong><small>媒体仅由桌面程序访问</small></div></div><div className="version-label">WINDOWS DESKTOP · 0.1</div></div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumb"><span>Video Helper</span><span className="crumb-slash">/</span><strong>{currentLabel}</strong></div>
          <div className="topbar-right"><button className="quiet-button" type="button" onClick={() => void refreshTasks()} disabled={busy}><span className="status-dot" />{tasks.length} 个任务</button><span className="avatar-mark">VH</span></div>
        </header>

        {route === 'download' && <DownloadPage tasks={tasks} onTasksUpdated={refreshTasksFromDownload} onChooseVideo={(path) => { setChosenVideo(path); setRoute('cover'); }} />}

        {route === 'settings' && <SettingsPage />}

        {(route === 'library' || route === 'cover') && <CoverPage
          initialPath={route === 'cover' ? chosenVideo : ''}
          onOpenPlugin={() => { setRoute('plugin'); }}
        />}

        {route === 'plugin' && <section className="page-content">
          <div className="page-heading compact-heading"><div><div className="eyebrow"><span className="eyebrow-line" />Windows 集成</div><h1>文件资源管理器缩略图插件</h1><p>使用可选的本地组件读取 MP4 内嵌封面。</p></div><div className="heading-icon plugin-heading-icon"><Icon name="plugin" /></div></div>
          <PluginManager />
        </section>}

        <footer className="main-footer"><span>VIDEO HELPER</span><span className="footer-separator">•</span><span>本地桌面工具</span><span className="footer-right">{busy ? '正在处理' : '已就绪'}</span></footer>
      </main>
    </div>
  );
}

export default App;
