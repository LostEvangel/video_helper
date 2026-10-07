import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import type { Preview, PreviewSession, VideoInfo } from '../shared/contracts.js';
import { PreviewController } from './preview.js';
import { formatTime, parseTime } from './time.js';

type CoverPageProps = { initialPath?: string; onOpenPlugin?: () => void };
type Notice = { code: string; message: string };
type LockedFrame = { path: string; preview: Preview };
type OutputNotice = { message: string; path: string; purpose: 'media' | 'output' };

function errorNotice(error: unknown): Notice {
  if (error && typeof error === 'object') {
    const candidate = error as { code?: unknown; message?: unknown };
    return {
      code: typeof candidate.code === 'string' ? candidate.code : 'REQUEST_FAILED',
      message: typeof candidate.message === 'string' ? candidate.message : '操作失败，请稍后重试。',
    };
  }
  return { code: 'REQUEST_FAILED', message: '操作失败，请稍后重试。' };
}

function fileName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() || filePath;
}

function formatDuration(seconds: number): string {
  return formatTime(seconds);
}

function Icon({ name }: { name: 'film' | 'folder' | 'arrow' | 'refresh' | 'minus' | 'plus' | 'plugin' }) {
  const paths: Record<typeof name, string> = {
    film: 'M4 4h16v16H4zM4 9h16M4 15h16M9 4v5m6-5v5m-6 6v5m6-5v5',
    folder: 'M3 6.5h7l2 2h9v9.8A1.7 1.7 0 0 1 19.3 20H4.7A1.7 1.7 0 0 1 3 18.3V6.5Z',
    arrow: 'M5 12h14m-6-6 6 6-6 6',
    refresh: 'M20 7v5h-5M4 17v-5h5m-3.5-2a7 7 0 0 1 12-2L20 12M4 12l2.5 4a7 7 0 0 0 12-2',
    minus: 'M5 12h14',
    plus: 'M12 5v14M5 12h14',
    plugin: 'M12 2v4m0 12v4M2 12h4m12 0h4M5 5l2.8 2.8m8.4 8.4L19 19M19 5l-2.8 2.8m-8.4 8.4L5 19M8 8h8v8H8z',
  };
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={paths[name]} /></svg>;
}

function CoverPage({ initialPath, onOpenPlugin }: CoverPageProps) {
  const controllerRef = useRef<PreviewController | null>(null);
  if (!controllerRef.current) controllerRef.current = new PreviewController();
  const controller = controllerRef.current;
  const [filePath, setFilePath] = useState(initialPath ?? '');
  const [video, setVideo] = useState<VideoInfo | null>(null);
  const [displayedPreview, setDisplayedPreview] = useState<Preview | null>(null);
  const [displayedPreviewPath, setDisplayedPreviewPath] = useState<string | null>(null);
  const [successfulPreview, setSuccessfulPreview] = useState<Preview | null>(null);
  const [successfulPreviewPath, setSuccessfulPreviewPath] = useState<string | null>(null);
  const [lockedFrame, setLockedFrame] = useState<LockedFrame | null>(null);
  const [draftTime, setDraftTime] = useState(0);
  const [timeText, setTimeText] = useState('00:00:00.000');
  const [timeError, setTimeError] = useState<string | null>(null);
  const [previewMatchesTime, setPreviewMatchesTime] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [selectingVideo, setSelectingVideo] = useState(false);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [outputNotice, setOutputNotice] = useState<OutputNotice | null>(null);
  const [reloadVersion, setReloadVersion] = useState(0);
  const draftTimeRef = useRef(0);
  const inputDirtyRef = useRef(false);
  const loadIdRef = useRef(0);
  const previewUiIdRef = useRef(0);
  const sessionRef = useRef<PreviewSession | null>(null);
  const activeVideo = video?.path === filePath ? video : null;

  useEffect(() => {
    setFilePath(initialPath ?? '');
  }, [initialPath]);

  useEffect(() => {
    controller.mount();
    return () => controller.unmount();
  }, [controller]);

  useEffect(() => {
    if (!filePath) {
      setVideo(null);
      setDisplayedPreview(null);
      setDisplayedPreviewPath(null);
      setSuccessfulPreview(null);
      setSuccessfulPreviewPath(null);
      setLockedFrame(null);
      return;
    }

    const loadId = ++loadIdRef.current;
    const previewUiId = ++previewUiIdRef.current;
    const session = controller.beginSession(filePath);
    sessionRef.current = session;
    setVideo(null);
    setDisplayedPreview(null);
    setDisplayedPreviewPath(null);
    setSuccessfulPreview(null);
    setSuccessfulPreviewPath(null);
    setLockedFrame(null);
    setPreviewMatchesTime(false);
    setPreviewLoading(true);
    setTimeError(null);
    setNotice(null);
    setOutputNotice(null);
    setTimeText('00:00:00.000');
    setDraftTime(0);
    draftTimeRef.current = 0;
    inputDirtyRef.current = false;

    void (async () => {
      try {
        const probedVideo = await controller.probe(session);
        if (!probedVideo) return;
        if (loadIdRef.current !== loadId) return;
        setVideo(probedVideo);
        await requestPreview(filePath, 0, loadId, previewUiId, session);
      } catch (error) {
        if (loadIdRef.current !== loadId) return;
        setNotice(errorNotice(error));
      } finally {
        if (loadIdRef.current === loadId && previewUiIdRef.current === previewUiId) setPreviewLoading(false);
      }
    })();

    return () => {
      loadIdRef.current += 1;
      previewUiIdRef.current += 1;
      if (sessionRef.current === session) sessionRef.current = null;
      controller.cancelSession(session);
    };
  }, [controller, filePath, reloadVersion]);

  async function requestPreview(
    path: string,
    time: number,
    loadId = loadIdRef.current,
    uiId = ++previewUiIdRef.current,
    session = sessionRef.current,
  ): Promise<void> {
    if (!session) return;
    setPreviewLoading(true);
    setPreviewMatchesTime(false);
    setNotice(null);
    setTimeError(null);
    try {
      const result = await controller.request(path, time, session);
      if (!result || loadIdRef.current !== loadId || previewUiIdRef.current !== uiId) {
        return;
      }
      setDisplayedPreview(result);
      setDisplayedPreviewPath(path);
      setSuccessfulPreview(result);
      setSuccessfulPreviewPath(path);
      setDraftTime(result.time);
      draftTimeRef.current = result.time;
      setTimeText(formatTime(result.time));
      inputDirtyRef.current = false;
      setPreviewMatchesTime(true);
    } catch (error) {
      if (loadIdRef.current === loadId && previewUiIdRef.current === uiId) setNotice(errorNotice(error));
    } finally {
      const isCurrent = loadIdRef.current === loadId && previewUiIdRef.current === uiId;
      if (isCurrent) setPreviewLoading(false);
    }
  }

  function updateDraft(value: number, text = formatTime(value)): void {
    if (!activeVideo) return;
    if (!inputDirtyRef.current) {
      previewUiIdRef.current += 1;
      if (filePath) controller.cancel(filePath);
    }
    draftTimeRef.current = value;
    inputDirtyRef.current = true;
    setDraftTime(value);
    setTimeText(text);
    setPreviewMatchesTime(false);
    setTimeError(null);
    setNotice(null);
    setOutputNotice(null);
  }

  function commitDraft(time = draftTimeRef.current): void {
    if (!filePath || !activeVideo) return;
    if (activeVideo.duration <= 0) return;
    inputDirtyRef.current = false;
    const target = Math.min(activeVideo.duration, Math.max(0, time));
    draftTimeRef.current = target;
    setDraftTime(target);
    setTimeText(formatTime(target));
    inputDirtyRef.current = false;
    void requestPreview(filePath, target);
  }

  function commitTimeInput(rawText: string): void {
    if (!inputDirtyRef.current || !activeVideo) return;
    inputDirtyRef.current = false;
    try {
      const parsed = parseTime(rawText);
      if (parsed > activeVideo.duration) throw new Error(`时间不能超过视频时长 ${formatDuration(activeVideo.duration)}。`);
      draftTimeRef.current = parsed;
      setDraftTime(parsed);
      setTimeText(formatTime(parsed));
      commitDraft(parsed);
    } catch (error) {
      setTimeError(error instanceof Error ? error.message : '时间格式不正确。');
    }
  }

  function nudgeTime(delta: number): void {
    if (!activeVideo) return;
    const next = Math.min(activeVideo.duration, Math.max(0, draftTimeRef.current + delta));
    inputDirtyRef.current = false;
    draftTimeRef.current = next;
    setDraftTime(next);
    setTimeText(formatTime(next));
    commitDraft(next);
  }

  function finishRangeKey(event: KeyboardEvent<HTMLInputElement>): void {
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', 'Enter'].includes(event.key)) {
      commitDraft(draftTimeRef.current);
    }
  }

  async function chooseAnotherVideo(): Promise<void> {
    const previousPath = filePath;
    loadIdRef.current += 1;
    previewUiIdRef.current += 1;
    const previousSession = sessionRef.current;
    if (previousSession) controller.cancelSession(previousSession);
    sessionRef.current = null;
    setPreviewLoading(false);
    setSelectingVideo(true);
    setNotice(null);
    try {
      const selection = await window.videoHelper.chooseMediaFile();
      if (selection) {
        if (selection.path === previousPath) setReloadVersion((current) => current + 1);
        setFilePath(selection.path);
      }
      else if (previousPath) {
        setReloadVersion((current) => current + 1);
        setFilePath(previousPath);
      }
    } catch (error) {
      setNotice(errorNotice(error));
      if (previousPath) {
        setReloadVersion((current) => current + 1);
        setFilePath(previousPath);
      }
    } finally {
      setSelectingVideo(false);
    }
  }

  function setAsCover(): void {
    if (!successfulPreview || successfulPreviewPath !== filePath || !previewMatchesTime || previewLoading || !filePath) return;
    setLockedFrame({ path: filePath, preview: successfulPreview });
    setNotice(null);
    setOutputNotice(null);
  }

  async function saveAsMp4(): Promise<void> {
    const locked = lockedFrame;
    if (!locked || saving) return;
    setSaving(true);
    setNotice(null);
    setOutputNotice(null);
    try {
      const output = await window.videoHelper.chooseCoverOutputFile(locked.path);
      if (!output) return;
      const saved = await window.videoHelper.saveCover({
        path: locked.path,
        time: locked.preview.time,
        output: output.path,
        replace: false,
      });
      setOutputNotice({ message: '封面已嵌入视频', path: saved.output, purpose: 'output' });
    } catch (error) {
      setNotice(errorNotice(error));
    } finally {
      setSaving(false);
    }
  }

  async function replaceOriginal(): Promise<void> {
    const locked = lockedFrame;
    if (!locked || saving) return;
    const confirmed = window.confirm(`要用已选封面替换“${fileName(locked.path)}”吗？只有新视频通过验证后才会发布；如果失败，可以恢复原文件。`);
    if (!confirmed) return;
    setSaving(true);
    setNotice(null);
    setOutputNotice(null);
    try {
      const saved = await window.videoHelper.saveCover({
        path: locked.path,
        time: locked.preview.time,
        output: locked.path,
        replace: true,
      });
      setOutputNotice({ message: '封面已嵌入视频', path: saved.output, purpose: 'media' });
    } catch (error) {
      setNotice(errorNotice(error));
    } finally {
      setSaving(false);
    }
  }

  async function exportJpg(): Promise<void> {
    const locked = lockedFrame;
    if (!locked || exporting) return;
    setExporting(true);
    setNotice(null);
    setOutputNotice(null);
    try {
      const output = await window.videoHelper.chooseFrameOutputFile(locked.path);
      if (!output) return;
      await window.videoHelper.exportFrame({ path: locked.path, time: locked.preview.time, output: output.path });
      setOutputNotice({ message: 'JPG 已导出', path: output.path, purpose: 'output' });
    } catch (error) {
      setNotice(errorNotice(error));
    } finally {
      setExporting(false);
    }
  }

  async function openOutputFolder(): Promise<void> {
    if (!outputNotice) return;
    try {
      await window.videoHelper.openSelectedFileDirectory(outputNotice.path, outputNotice.purpose);
    } catch (error) {
      setNotice(errorNotice(error));
    }
  }

  function onTimestampChange(event: ChangeEvent<HTMLInputElement>): void {
    if (!inputDirtyRef.current) {
      previewUiIdRef.current += 1;
      if (filePath) controller.cancel(filePath);
    }
    inputDirtyRef.current = true;
    setTimeText(event.currentTarget.value);
    setTimeError(null);
    setPreviewMatchesTime(false);
    setNotice(null);
    setOutputNotice(null);
  }

  const isMp4 = filePath.toLocaleLowerCase('en-US').endsWith('.mp4');
  const visiblePreview = displayedPreview && displayedPreviewPath === filePath ? displayedPreview : null;
  const canSetCover = Boolean(successfulPreview && successfulPreviewPath === filePath && previewMatchesTime && !previewLoading);

  return (
    <section className="page-content cover-page">
      <div className="page-heading compact-heading cover-page-heading">
        <div><div className="eyebrow"><span className="eyebrow-line" />封面编辑</div><h1>设置视频封面</h1><p>选择视频时间点，确认静态画面后再嵌入封面。</p></div>
        <div className="heading-icon"><Icon name="film" /></div>
      </div>

      <section className="panel cover-workspace">
        <div className="cover-toolbar">
          <div className={`cover-file-card${filePath ? ' has-file' : ''}`}>
            <span className="cover-file-icon"><Icon name="film" /></span>
            <span className="cover-file-copy"><strong>{filePath ? fileName(filePath) : '尚未选择视频'}</strong><small>{filePath || '选择本地视频以开始设置封面'}</small></span>
          </div>
          <button className="secondary-button cover-choose-button" type="button" onClick={() => void chooseAnotherVideo()} disabled={selectingVideo}>
            {selectingVideo ? '正在选择…' : '选择视频'}<Icon name="arrow" />
          </button>
        </div>

        <div className="cover-editor-grid">
          <section className="cover-preview-panel" aria-label="静态画面预览">
            <div className="cover-section-heading"><div><span className="small-tag">静态预览</span><h2>时间点画面</h2></div><span className={`preview-state${previewLoading ? ' is-loading' : ''}`}>{previewLoading ? '正在提取画面' : visiblePreview ? '已更新' : '等待视频'}</span></div>
            <div className={`cover-preview-screen${visiblePreview ? ' has-image' : ''}`}>
              {visiblePreview ? <img data-preview-file={fileName(displayedPreviewPath ?? '')} src={visiblePreview.imageUrl} alt={`视频 ${formatTime(visiblePreview.time)} 的静态画面`} /> : <div className="cover-preview-empty"><Icon name="film" /><span>{filePath ? '正在读取视频信息…' : '尚未选择视频'}</span></div>}
              {previewLoading && <div className="cover-preview-loading"><span className="loading-spinner" />正在提取画面</div>}
            </div>
            <div className="cover-preview-meta"><span>预览时间</span><strong>{visiblePreview ? formatTime(visiblePreview.time) : '—'}</strong></div>
          </section>

          <section className="cover-timeline-panel" aria-label="封面时间选择">
            <div className="cover-section-heading"><div><span className="small-tag">时间轴</span><h2>选择封面画面</h2></div><span className="cover-duration">{activeVideo ? formatDuration(activeVideo.duration) : '00:00:00.000'}</span></div>
            <div className="cover-timeline-wrap">
              <input
                aria-label="视频时间轴"
                className="cover-range"
                type="range"
                min="0"
                max={activeVideo?.duration ?? 0}
                step="0.001"
                value={Math.min(draftTime, activeVideo?.duration ?? 0)}
                disabled={!activeVideo}
                onChange={(event) => updateDraft(Number(event.currentTarget.value))}
                onPointerUp={() => commitDraft(draftTimeRef.current)}
                onKeyUp={finishRangeKey}
              />
              <div className="cover-range-ticks"><span>00:00:00.000</span><span>{activeVideo ? formatDuration(activeVideo.duration) : '00:00:00.000'}</span></div>
            </div>
            <div className="cover-time-controls">
              <label className="cover-time-field" htmlFor="cover-time-input"><span>精确时间</span><div className={`cover-time-input-wrap${timeError ? ' has-error' : ''}`}>
                <input id="cover-time-input" type="text" inputMode="numeric" spellCheck={false} value={timeText} onChange={onTimestampChange}
                  onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commitTimeInput(event.currentTarget.value); } }}
                  onBlur={(event) => commitTimeInput(event.currentTarget.value)} disabled={!activeVideo} aria-describedby={timeError ? 'cover-time-error' : undefined} />
                <span>HH:mm:ss.SSS</span>
              </div>{timeError && <small className="cover-time-error" id="cover-time-error" role="alert">{timeError}</small>}</label>
              <div className="cover-nudge-buttons" aria-label="微调时间">
                <button className="icon-button" type="button" aria-label="前移 0.1 秒" onClick={() => nudgeTime(-0.1)} disabled={!activeVideo}><Icon name="minus" /><span>0.1 秒</span></button>
                <button className="icon-button" type="button" aria-label="后移 0.1 秒" onClick={() => nudgeTime(0.1)} disabled={!activeVideo}><Icon name="plus" /><span>0.1 秒</span></button>
              </div>
            </div>
            <div className="cover-timeline-hint"><span className="hint-dot" />时间每次微调 0.1 秒，预览以 FFmpeg 实际解码时间为准。</div>

            <div className="cover-lock-card">
              <div className="cover-lock-heading"><span className="step-number">02</span><div><h3>已选封面</h3><p>{lockedFrame ? `已锁定 ${formatTime(lockedFrame.preview.time)}` : '预览画面后，点击“设为封面”'}</p></div></div>
              {lockedFrame ? <div className="locked-frame-row"><img src={lockedFrame.preview.imageUrl} alt={`已选封面 ${formatTime(lockedFrame.preview.time)}`} /><div><strong>{fileName(lockedFrame.path)}</strong><small>{formatTime(lockedFrame.preview.time)}</small></div><span className="locked-badge">已锁定</span></div> : <div className="cover-lock-empty">尚未锁定画面</div>}
              <button className="primary-button cover-lock-button" type="button" onClick={setAsCover} disabled={!canSetCover}>
                {previewLoading ? '正在提取画面…' : '设为封面'}<Icon name="arrow" />
              </button>
            </div>
          </section>
        </div>

        <section className="cover-save-panel" aria-label="保存封面">
          <div className="cover-save-copy"><span className="small-tag">输出</span><h2>应用已选封面</h2><p>默认另存为“视频名_封面.mp4”，保留原视频。替换原文件前会先完成写入和验证。</p></div>
          <div className="cover-save-actions">
            <button className="secondary-button" type="button" onClick={() => void exportJpg()} disabled={!lockedFrame || exporting || saving}>{exporting ? '正在导出…' : '导出 JPG'}</button>
            <button className="secondary-button cover-replace-button" type="button" onClick={() => void replaceOriginal()} disabled={!lockedFrame || !isMp4 || saving || exporting}>{saving ? '正在写入…' : '替换原视频'}</button>
            <button className="primary-button" type="button" onClick={() => void saveAsMp4()} disabled={!lockedFrame || !isMp4 || saving || exporting}>{saving ? '正在写入…' : '另存为 MP4'}<Icon name="arrow" /></button>
          </div>
          {!isMp4 && filePath && <p className="cover-save-limitation">MKV 可预览并导出 JPG；目前仅支持为 MP4 嵌入封面。</p>}
        </section>

        {notice && <div className="notice cover-notice" role="status"><span className="notice-code">{notice.code}</span><span>{notice.message}</span></div>}
        {outputNotice && <div className="cover-success-notice" role="status"><span className="success-mark">✓</span><strong>{outputNotice.message}</strong><button className="text-button" type="button" onClick={() => void openOutputFolder()}><Icon name="folder" />打开输出文件夹</button></div>}
      </section>

      <aside className="cover-compatibility-note">
        <span className="compatibility-icon">i</span>
        <div><strong>文件资源管理器中的缩略图由系统处理器提供</strong><p>“封面已嵌入视频”表示封面已写入 MP4；Windows 中显示的缩略图仍取决于这台电脑的设置和处理器。</p></div>
        <button type="button" className="text-button" onClick={onOpenPlugin} disabled={!onOpenPlugin}><Icon name="plugin" />缩略图插件状态</button>
      </aside>
    </section>
  );
}

export default CoverPage;
