import { useEffect, useMemo, useState } from 'react';
import type { AudioTrack, Inspection, OutputMode, TaskView } from '../shared/contracts.js';

type Notice = { code: string; message: string };
type InputMode = 'url' | 'file';

type DownloadPageProps = {
  tasks: TaskView[];
  onTasksUpdated(): Promise<void>;
  onChooseVideo(path: string): void;
};

function noticeFrom(error: unknown): Notice {
  if (error && typeof error === 'object') {
    const candidate = error as { code?: unknown; message?: unknown };
    return {
      code: typeof candidate.code === 'string' ? candidate.code : 'REQUEST_FAILED',
      message: typeof candidate.message === 'string' ? candidate.message : '操作失败，请稍后重试。',
    };
  }
  return { code: 'REQUEST_FAILED', message: '操作失败，请稍后重试。' };
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B/s';
  if (bytes < 1_024) return `${Math.round(bytes)} B/s`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB/s`;
  return `${(bytes / 1_048_576).toFixed(1)} MB/s`;
}

function taskStateLabel(task: TaskView): string {
  const labels: Record<TaskView['state'], string> = {
    queued: '排队中', downloading: '正在下载', paused: '已暂停', merging: '正在合并并验证',
    completed: '已完成', failed: '失败', cancelled: '已取消',
  };
  return labels[task.state];
}

function safeFilename(value: string): string | undefined {
  const trimmed = value.trim().replace(/[. ]+$/g, '');
  if (!trimmed || trimmed === '.' || trimmed === '..' || /[<>:"/\\|?*\u0000-\u001f]/.test(trimmed)) return undefined;
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(trimmed)) return undefined;
  return trimmed.replace(/\.(?:mp4|mkv)$/i, '');
}

function outputPath(directory: string, filename: string, mode: OutputMode): string | undefined {
  const stem = safeFilename(filename);
  if (!stem) return undefined;
  const extension = mode === 'copy-mkv' ? '.mkv' : '.mp4';
  return `${directory.replace(/[\\/]+$/, '')}\\${stem}${extension}`;
}

function Icon({ name }: { name: 'film' | 'folder' | 'arrow' | 'check' }) {
  const paths = {
    film: 'M4 4h16v16H4zM4 9h16M4 15h16M9 4v5m6-5v5m-6 6v5m6-5v5',
    folder: 'M3 6.5h7l2 2h9v9.8A1.7 1.7 0 0 1 19.3 20H4.7A1.7 1.7 0 0 1 3 18.3V6.5Z',
    arrow: 'M5 12h14m-6-6 6 6-6 6',
    check: 'm5 12 4 4L19 6',
  } as const;
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={paths[name]} /></svg>;
}

function TaskCard({
  task,
  onRefresh,
  onChooseVideo,
  runTaskAction,
  busy,
}: {
  task: TaskView;
  onRefresh(): Promise<void>;
  onChooseVideo(path: string): void;
  runTaskAction: (task: TaskView, action: 'pause' | 'resume' | 'cancel' | 'retry' | 'clear', outputMode?: OutputMode) => Promise<void>;
  busy: boolean;
}) {
  const progress = task.total > 0 ? Math.min(100, (task.completed / task.total) * 100) : task.state === 'completed' ? 100 : 0;

  async function openFolder() {
    try {
      await window.videoHelper.openTaskOutputDirectory(task.id);
    } catch (error) {
      window.dispatchEvent(new CustomEvent('video-helper-task-error', { detail: noticeFrom(error) }));
    }
  }

  async function chooseVideo() {
    try {
      const selection = await window.videoHelper.getTaskOutput(task.id);
      onChooseVideo(selection.path);
    } catch (error) {
      window.dispatchEvent(new CustomEvent('video-helper-task-error', { detail: noticeFrom(error) }));
    }
  }

  return (
    <article className={`task-card task-${task.state}`} aria-label={`下载任务 ${taskStateLabel(task)}`}>
      <div className="task-card-top">
        <div className="task-status"><span className="task-state-dot" /><strong>{taskStateLabel(task)}</strong></div>
        <span className="task-speed">{task.state === 'downloading' ? formatBytes(task.bytesPerSecond) : `任务 ${task.id.slice(0, 8)}`}</span>
      </div>
      <div className="task-output" title={task.output}>{task.output ?? '尚未创建输出路径'}</div>
      <div className="task-progress-track" aria-label={`已完成 ${Math.round(progress)}%`}><span style={{ width: `${progress}%` }} /></div>
      <div className="task-card-meta">
        <span>{task.state === 'merging' ? '正在验证并发布视频' : `${task.completed} / ${task.total} 个资源`}</span>
        <span>{task.total > 0 ? `${Math.round(progress)}%` : ''}</span>
      </div>
      {task.error && <div className="task-error" role="alert">{task.error}</div>}
      <div className="task-actions">
        {(task.state === 'queued' || task.state === 'downloading') && <>
          <button className="secondary-button" type="button" onClick={() => void runTaskAction(task, 'pause')} disabled={busy}>暂停</button>
          <button className="text-button danger-text" type="button" onClick={() => void runTaskAction(task, 'cancel')} disabled={busy}>取消</button>
        </>}
        {task.state === 'paused' && <>
          <button className="secondary-button" type="button" onClick={() => void runTaskAction(task, 'resume')} disabled={busy}>继续</button>
          <button className="text-button danger-text" type="button" onClick={() => void runTaskAction(task, 'cancel')} disabled={busy}>取消</button>
        </>}
        {(task.state === 'failed' || task.state === 'cancelled') && <>
          <button className="secondary-button" type="button" onClick={() => void runTaskAction(task, 'retry', 'copy-mp4')} disabled={busy}>重试 MP4</button>
          <button className="secondary-button" type="button" onClick={() => void runTaskAction(task, 'retry', 'copy-mkv')} disabled={busy}>重试 MKV</button>
          <button className="secondary-button" type="button" onClick={() => void runTaskAction(task, 'retry', 'transcode-mp4')} disabled={busy}>转码 MP4</button>
        </>}
        {task.state === 'completed' && <>
          <button className="secondary-button" type="button" onClick={() => void openFolder()} disabled={busy}><Icon name="folder" />打开文件夹</button>
          <button className="primary-button" type="button" onClick={() => void chooseVideo()} disabled={busy}>设置封面<Icon name="arrow" /></button>
        </>}
        {['completed', 'failed', 'cancelled', 'paused'].includes(task.state) && <button className="text-button" type="button" onClick={() => void runTaskAction(task, 'clear')} disabled={busy}>清除任务</button>}
      </div>
    </article>
  );
}

export default function DownloadPage({ tasks, onTasksUpdated, onChooseVideo }: DownloadPageProps) {
  const [inputMode, setInputMode] = useState<InputMode>('url');
  const [url, setUrl] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [inputFile, setInputFile] = useState<{ path: string; name: string } | null>(null);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [variantId, setVariantId] = useState('');
  const [audioId, setAudioId] = useState('');
  const [outputDirectory, setOutputDirectory] = useState<{ token: string; path: string } | null>(null);
  const [filename, setFilename] = useState('video');
  const [outputMode, setOutputMode] = useState<OutputMode>('copy-mp4');
  const [keepCache, setKeepCache] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void window.videoHelper.getSettings().then((settings) => {
      if (active) setKeepCache(settings.keepCache);
    }).catch(() => {});
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const handleTaskError = (event: Event) => setNotice((event as CustomEvent<Notice>).detail);
    window.addEventListener('video-helper-task-error', handleTaskError);
    return () => window.removeEventListener('video-helper-task-error', handleTaskError);
  }, []);

  const selectedVariant = useMemo(() => inspection?.variants.find((variant) => variant.id === variantId), [inspection, variantId]);
  const output = outputDirectory ? outputPath(outputDirectory.path, filename, outputMode) : undefined;
  const canStart = Boolean(inspection && selectedVariant && output && !busy);

  function invalidateInspection() {
    setInspection(null);
    setVariantId('');
    setAudioId('');
    setNotice(null);
  }

  async function inspectSource() {
    const source = inputMode === 'url'
      ? (url.trim() ? { kind: 'url' as const, url: url.trim() } : null)
      : inputFile
        ? { kind: 'file' as const, path: inputFile.path, ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}) }
        : null;
    if (!source) {
      setNotice({ code: 'INPUT_REQUIRED', message: '请输入播放列表网址，或先选择本地 m3u8 文件。' });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const result = await window.videoHelper.inspect(source);
      setInspection(result);
      setVariantId(result.variants[0]?.id ?? '');
      setAudioId('');
      setNotice({ code: 'READY', message: `已解析出 ${result.variants.length} 种清晰度。` });
    } catch (error) {
      setInspection(null);
      setVariantId('');
      setAudioId('');
      setNotice(noticeFrom(error));
    } finally {
      setBusy(false);
    }
  }

  async function choosePlaylist() {
    setBusy(true);
    setNotice(null);
    try {
      const selection = await window.videoHelper.chooseInputFile();
      if (selection) {
        setInputFile({ path: selection.path, name: selection.name });
        invalidateInspection();
      }
    } catch (error) {
      setNotice(noticeFrom(error));
    } finally {
      setBusy(false);
    }
  }

  async function chooseOutputDirectory() {
    setBusy(true);
    setNotice(null);
    try {
      const selection = await window.videoHelper.chooseOutputDirectory();
      if (selection) setOutputDirectory({ token: selection.token, path: selection.path });
    } catch (error) {
      setNotice(noticeFrom(error));
    } finally {
      setBusy(false);
    }
  }

  async function startDownload() {
    if (!inspection || !variantId || !output) {
      setNotice({ code: 'OUTPUT_REQUIRED', message: '请选择清晰度、输出文件夹和有效的文件名。' });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      await window.videoHelper.start({
        inspectionId: inspection.id,
        variantId,
        ...(audioId ? { audioId } : {}),
        output,
        outputMode,
        keepCache,
      });
      await onTasksUpdated();
      setNotice({ code: 'QUEUED', message: '下载任务已加入队列。' });
    } catch (error) {
      setNotice(noticeFrom(error));
    } finally {
      setBusy(false);
    }
  }

  async function runTaskAction(task: TaskView, action: 'pause' | 'resume' | 'cancel' | 'retry' | 'clear', retryMode?: OutputMode) {
    setBusyTaskId(task.id);
    setNotice(null);
    try {
      await window.videoHelper.control({ id: task.id, action, ...(retryMode ? { outputMode: retryMode } : {}) });
      await onTasksUpdated();
    } catch (error) {
      setNotice(noticeFrom(error));
    } finally {
      setBusyTaskId(null);
    }
  }

  function audioLabel(track: AudioTrack): string {
    return track.label || track.groupId;
  }

  return (
    <section className="page-content download-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow"><span className="eyebrow-line" />下载工作区</div>
          <h1>将播放列表保存为视频</h1>
          <p>输入完整的 HLS 播放列表，选择清晰度和音轨，再将视频保存到本地文件夹。</p>
        </div>
        <div className="heading-art" aria-hidden="true"><div className="art-ring ring-one" /><div className="art-ring ring-two" /><div className="art-center"><Icon name="film" /></div></div>
      </div>

      <div className="download-grid">
        <section className="panel source-panel">
          <div className="panel-heading"><div className="step-number">01</div><div><h2>添加播放列表</h2><p>输入网络地址，或从本地打开 m3u8 文件</p></div></div>
          <div className="input-tabs" role="tablist" aria-label="播放列表来源">
            <button type="button" role="tab" aria-selected={inputMode === 'url'} className={inputMode === 'url' ? 'selected' : ''} onClick={() => { setInputMode('url'); invalidateInspection(); }}>网络地址</button>
            <button type="button" role="tab" aria-selected={inputMode === 'file'} className={inputMode === 'file' ? 'selected' : ''} onClick={() => { setInputMode('file'); invalidateInspection(); }}>本地文件</button>
          </div>
          {inputMode === 'url' ? <label className="field-label" htmlFor="playlist-url">播放列表网址
            <input id="playlist-url" value={url} onChange={(event) => { setUrl(event.target.value); invalidateInspection(); }} placeholder="https://example.com/video/index.m3u8" autoComplete="url" spellCheck={false} />
          </label> : <div className="file-picker-row">
            <div className={`file-drop${inputFile ? ' has-file' : ''}`}><span className="file-icon"><Icon name="film" /></span><span><strong>{inputFile?.name ?? '选择本地 m3u8 文件'}</strong><small>{inputFile ? inputFile.path : '支持 .m3u8 和 .m3u'}</small></span></div>
            <button type="button" className="secondary-button" onClick={() => void choosePlaylist()} disabled={busy}>浏览文件</button>
          </div>}
          {inputMode === 'file' && <label className="field-label base-url-field" htmlFor="base-url">基础网址 <span className="optional-label">选填</span>
            <input id="base-url" value={baseUrl} onChange={(event) => { setBaseUrl(event.target.value); invalidateInspection(); }} placeholder="https://example.com/videos/" autoComplete="url" spellCheck={false} />
            <small className="field-hint">用于解析本地播放列表中的网络分片；目录地址请保留末尾斜杠。</small>
          </label>}

          {inspection && <div className="selection-fields">
            <label className="field-label" htmlFor="variant-select">清晰度
              <select id="variant-select" value={variantId} onChange={(event) => { setVariantId(event.target.value); setAudioId(''); }}>
                {inspection.variants.map((variant) => <option key={variant.id} value={variant.id}>{variant.label}</option>)}
              </select>
            </label>
            {inspection.audioTracks.length > 0 && <label className="field-label" htmlFor="audio-select">音轨
              <select id="audio-select" value={audioId} onChange={(event) => setAudioId(event.target.value)}>
                <option value="">自动选择默认音轨</option>
                {inspection.audioTracks.map((track) => <option key={track.id} value={track.id}>{audioLabel(track)}</option>)}
              </select>
            </label>}
            {inspection.duration !== undefined && <div className="inspection-summary">约 {Math.floor(inspection.duration / 60)} 分 {Math.round(inspection.duration % 60)} 秒 · {inspection.segmentCount ?? 0} 个片段</div>}
          </div>}

          {notice && <div className={`notice${notice.code === 'READY' || notice.code === 'QUEUED' ? ' success' : ''}`} role="status"><span className="notice-code">{notice.code}</span><span>{notice.message}</span></div>}
          <div className="panel-actions">
            <span className="privacy-note"><span className="lock-icon">◆</span> 在桌面程序中解析和下载</span>
            <button className="primary-button" type="button" onClick={() => void inspectSource()} disabled={busy}>{busy ? '正在处理…' : '解析播放列表'}<Icon name="arrow" /></button>
          </div>
        </section>

        <section className="panel output-panel">
          <div className="panel-heading"><div className="step-number step-muted">02</div><div><h2>输出设置</h2><p>选择视频名称、格式和保存位置</p></div></div>
          <label className="field-label" htmlFor="output-filename">文件名
            <input id="output-filename" value={filename} onChange={(event) => setFilename(event.target.value)} placeholder="video" spellCheck={false} />
          </label>
          <label className="field-label" htmlFor="output-mode">输出格式
            <select id="output-mode" value={outputMode} onChange={(event) => setOutputMode(event.target.value as OutputMode)}>
              <option value="copy-mp4">MP4 · 原始码流</option>
              <option value="copy-mkv">MKV · 原始码流</option>
              <option value="transcode-mp4">MP4 · H.264/AAC 转码</option>
            </select>
          </label>
          <div className="output-location">
            <span className="folder-icon"><Icon name="folder" /></span>
            <div className="output-copy"><strong>{outputDirectory?.path ?? '尚未选择文件夹'}</strong><small>{output ? `将输出为 ${output.split(/[\\/]/).at(-1)}` : '选择本地输出文件夹'}</small></div>
          </div>
          <button className="secondary-button folder-button" type="button" onClick={() => void chooseOutputDirectory()} disabled={busy}><Icon name="folder" />选择文件夹</button>
          <label className="checkbox-row"><input type="checkbox" checked={keepCache} onChange={(event) => setKeepCache(event.target.checked)} /><span>完成后保留下载缓存</span></label>
          <div className="divider" />
          <div className="service-state"><span className="state-symbol"><Icon name="check" /></span><div><strong>仅显示实际任务状态</strong><p>视频下载完成并成功发布后，任务才会标记为完成；不会覆盖已有文件。</p></div></div>
          <button className="primary-button start-download-button" type="button" onClick={() => void startDownload()} disabled={!canStart}>{busy ? '正在处理…' : '加入下载队列'}<Icon name="arrow" /></button>
        </section>
      </div>

      <section className="task-list-section">
        <div className="task-list-heading"><div><div className="eyebrow"><span className="eyebrow-line" />下载队列</div><h2>任务进度</h2></div><span className="task-count">{tasks.length} 个任务</span></div>
        {tasks.length === 0 ? <div className="empty-task-state"><span className="empty-task-icon"><Icon name="film" /></span><strong>当前没有下载任务</strong><p>解析播放列表后，可在此管理下载、暂停和重试。</p></div> : <div className="task-list">
          {tasks.map((task) => <TaskCard key={task.id} task={task} onRefresh={onTasksUpdated} onChooseVideo={onChooseVideo} runTaskAction={runTaskAction} busy={busyTaskId === task.id} />)}
        </div>}
      </section>
    </section>
  );
}
