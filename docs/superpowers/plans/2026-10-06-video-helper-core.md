# 下载主工具 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付可运行的 Electron 应用，正确下载在线及本地 HLS 并输出单个完整视频。

**Architecture:** 解析器生成不可变资源快照，下载器把资源完整保存到独立任务目录，FFmpeg 只读取本地重写播放列表。主进程管理有序任务队列和持久化，React 展示状态。

**Tech Stack:** TypeScript、React、Electron、Vite、Vitest、FFmpeg/FFprobe、Node fetch/streams。

**Spec:** `docs/superpowers/specs/2026-10-06-video-helper-design.md`

## Global Constraints

- Windows 10/11 x64 本地桌面工具。
- 第一版不录制直播，不做完整播放器，不生成候选截图，不提供外部图片导入，不提供逐帧定位。
- 默认每任务最多 4 个网络请求并发，第一版同一时间执行一个下载任务，其余排队。
- 下载失败自动重试最多 3 次，使用递增等待。
- 不静默覆盖已有文件；清理仅针对工具创建的临时副本。
- 默认安装主工具不注册插件。

## Task A1: 可运行的桌面壳与共享契约

**Files:** Create `package.json`, `package-lock.json`, `tsconfig.json`, `tsconfig.main.json`, `vite.config.ts`, `vitest.config.ts`, `scripts/dev.mjs`, `index.html`, `src/shared/contracts.ts`, `src/main/index.ts`, `src/main/preload.ts`, `src/main/ipc.ts`, `src/main/services.ts`, `src/renderer/App.tsx`, `src/renderer/main.tsx`, `tests/ipc.test.ts`。

**Interfaces:** Produces以下共享契约。`AppServices` 后续由 A5/C3 注入；未就绪操作返回明确的结构化错误，不假造下载进度。

```ts
export type InputSource = {kind:'url';url:string} | {kind:'file';path:string;baseUrl?:string};
export type Locator = {kind:'url'|'file';value:string};
export type Resource = {id:string;source:Locator;role:'segment'|'key'|'init';range?:{offset:number;length:number}};
export type Variant = {id:string;label:string;uri:Locator};
export type AudioTrack = {id:string;label:string;uri?:Locator;groupId:string};
export type Inspection = {id:string;variants:Variant[];audioTracks:AudioTrack[];duration?:number;segmentCount?:number;example?:string};
export type DownloadManifest = {id:string;resources:Resource[];videoText:string;audioText?:string;duration:number;snapshotHash:string;snapshots:{source:Locator;text:string}[]};
export type TaskState = 'queued'|'downloading'|'paused'|'merging'|'completed'|'failed'|'cancelled';
export type TaskView = {id:string;state:TaskState;completed:number;total:number;bytesPerSecond:number;output?:string;error?:string};
export type StreamInfo = {index:number;kind:'video'|'audio'|'subtitle'|'other';codec:string;attachedPicture:boolean};
export type VideoInfo = {path:string;duration:number;width:number;height:number;streams:StreamInfo[]};
export type Preview = {requestId:number;imageUrl:string;time:number};
export type CoverResult = {output:string;embedded:boolean;nativeDisplay:'unverified'};
export type PluginStatus = {installed:boolean;active:boolean;conflict:boolean};
export type AppError = {code:string;message:string};
export type Result<T> = {ok:true;value:T}|{ok:false;error:AppError};
export interface AppServices {
  inspect(source:InputSource):Promise<Inspection>;
  start(request:{inspectionId:string;variantId:string;audioId?:string;output:string;keepCache:boolean}):Promise<TaskView>;
  listTasks():Promise<TaskView[]>;
  control(request:{id:string;action:'pause'|'resume'|'cancel'|'retry'|'clear';outputMode?:'copy-mp4'|'copy-mkv'|'transcode-mp4'}):Promise<void>;
  probe(path:string):Promise<VideoInfo>;
  preview(request:{path:string;time:number;requestId:number}):Promise<Preview>;
  saveCover(request:{path:string;time:number;output:string;replace:boolean}):Promise<CoverResult>;
  exportFrame(request:{path:string;time:number;output:string}):Promise<void>;
  pluginStatus():Promise<PluginStatus>;
  changePlugin(action:'enable'|'disable'):Promise<PluginStatus>;
}
```

- [ ] 初始化依赖与构建配置；使用 npm registry 返回的版本和 engines 检查后固定锁文件，不安装多余视频播放器或 UI 框架。定义 `dev`、`build`、`test`、`typecheck`，Electron 主/preload 分开输出，Vite 输出 renderer。

```json
{"scripts":{"dev":"node scripts/dev.mjs","build":"tsc -p tsconfig.main.json && vite build","test":"vitest run","typecheck":"tsc --noEmit -p tsconfig.json"}}
```

- [ ] 创建受限窗口、preload 和 IPC；只加载本地应用，开发允许指定 localhost URL。发送方必须是主窗口且页面来源正确；校验字符串长度、有限数值、枚举和受控文件选择结果。

```ts
new BrowserWindow({webPreferences:{preload:preloadPath,contextIsolation:true,nodeIntegration:false,sandbox:true}});
```

- [ ] 写 `tests/ipc.test.ts` 验证未知通道、非法 sender、NaN 时间和任意 shell 参数无法进入服务。运行 `npm test -- tests/ipc.test.ts` 先失败，再实现来源/参数检查至通过。

- [ ] 通过 contextBridge 暴露 AppServices 对应操作及文件/目录选择、任务订阅、打开输出目录；不暴露 ipcRenderer、exec 或任意读文件函数。下载 HTTP 内容由主进程处理，不载入网页。

- [ ] 补 `scripts/dev.mjs`、`tsconfig.main.json`，启动静态导航壳，关闭应用时终止已登记子进程并保存状态；`npm run typecheck` 和 `npm run build` 通过。新增样式直接人工查看，不写重复静态测试。

## Task A2: HLS 解析、定位与选流

**Files:** Create `src/main/hls/parse.ts`, `resolve.ts`, `inspect.ts`, `localize.ts`, `tests/hls.test.ts`, `tests/fixtures/hls/*.m3u8`。

**Interfaces:** Consumes A1 types。Produces `resolveResource(uri:string,context:{source:Locator;baseUrl?:string}):Locator`、`inspectInput(source:InputSource):Promise<Inspection>`、`selectManifest(inspectionId:string,variantId:string,audioId?:string):Promise<DownloadManifest>`、`localizeManifest(manifest:DownloadManifest,cacheDir:string):Promise<{video:string;audio?:string}>`。

- [ ] 写地址与列表行为测试，固定以下输入和输出。

```ts
it('uses base URL for local relative segments',()=>{
  expect(resolveResource('parts/001.ts',{source:{kind:'file',value:'D:\\samples\\movie.m3u8'},baseUrl:'https://example.com/videos/'}))
    .toEqual({kind:'url',value:'https://example.com/videos/parts/001.ts'});
});
it('rejects an unfinished media playlist',async()=>{
  await expect(selectFixture('#EXTM3U\n#EXTINF:2,\na.ts\n')).rejects.toMatchObject({code:'INCOMPLETE_PLAYLIST'});
});
```

`selectFixture(text)` 是测试帮助函数：写入临时 m3u8，调用 inspectInput，再以第一条 variant 调用 selectManifest；测试结束只清理测试生成目录。

- [ ] `npm test -- tests/hls.test.ts` 应因模块缺失失败。实现 parse/resolve，以完整 URI、远程实际响应 URL、显式基础 URL、本地目录为明确优先级；Windows 盘符绝对路径先识别为本地路径，不误当 URL scheme。

- [ ] 实现主列表递归解析和音轨分组关联，重定向后更新基准；限制递归深度为 8，拒绝循环引用。解析属性列表需尊重引号内逗号，不用简单 split(',')。

- [ ] 明确保留 MEDIA-SEQUENCE、DISCONTINUITY、MAP、KEY/IV、BYTERANGE、EXTINF、ENDLIST，拒绝不支持的加密方式。AES-128 密钥缓存为资源，不自写解密，由本地 HLS 与 FFmpeg 处理；隐式 IV 必须保留原始序号。

- [ ] 每个字节范围下载成独立缓存文件；重写列表时去掉相应 BYTERANGE 标签，MAP 的 BYTERANGE 同样转换，保留初始化分片切换。资源 ID 由角色、URI、范围生成稳定 hash，不依赖用户文件名。

- [ ] 对无基础 URL、本地子列表、协议相对地址、重定向、查询参数、独立音轨、fMP4、隐式范围偏移、AES IV 和未结束列表补固定 fixture；全套 hls 测试通过。对于加密且带字节范围的组合，需样片实测支持后才接受，不能盲目宣称支持。

## Task A3: 可恢复下载与有序任务状态

**Files:** Create `src/main/download/resource.ts`, `queue.ts`, `runner.ts`, `store.ts`, `tests/download.test.ts`, `tests/helpers/server.ts`。

**Interfaces:** Consumes Resource/DownloadManifest/TaskView。Produces `downloadResource(resource:Resource,destination:string,signal:AbortSignal):Promise<{bytes:number;sha256:string}>`、`runDownload(manifest:DownloadManifest,cacheDir:string,signal:AbortSignal,onProgress:(view:TaskView)=>void):Promise<void>`、`TaskStore` 的 `load(id)`/`save(record)`/`list()`，`TaskRunner` 的 `start`/`control`/`listTasks`；持久化 `TaskRecord` 在 store.ts 定义并含 manifest、completed hashes、output、keepCache、state、outputMode。

```ts
export type TaskRecord = {
  manifest:DownloadManifest; view:TaskView; cacheDir:string; output:string; keepCache:boolean;
  outputMode:'copy-mp4'|'copy-mkv'|'transcode-mp4';
  completed:Record<string,{path:string;bytes:number;sha256:string;etag?:string;lastModified?:string}>;
};
export interface TaskStore {
  load(id:string):Promise<TaskRecord|undefined>;
  save(record:TaskRecord):Promise<void>;
  list():Promise<TaskRecord[]>;
}
```

TaskRunner.start 消费已解析 manifest、output、keepCache 并返回 Promise<TaskView>，control/listTasks 的参数与返回值严格使用 A1 AppServices 契约。

- [ ] tests/helpers/server.ts 启动本地 HTTP server，提供：第 1 次 503 后成功、永久 403、延迟响应、截断响应、206 范围响应、忽略 Range 返回 200、无 Content-Length 流。写测例确认并发不超过 4，403 不重试，503 最多重试 3 次。

```ts
it('does not retry access denial',async()=>{
  const server=await makeServer({status:403});
  await expect(downloadResource(server.resource,tempFile,new AbortController().signal)).rejects.toMatchObject({code:'ACCESS_DENIED'});
  expect(server.requests).toBe(1);
});
```

`makeServer` 返回 `{resource,requests,close}`；tempFile 为测试新建目录下唯一输出，每个测试 finally 关闭 server。

- [ ] 运行 `npm test -- tests/download.test.ts` 验证失败。实现流式保存 `.part`、成功 rename、长度/范围验证和 sha256。Range 未按要求返回时从完整响应正确截取且限制写入长度；拒绝超出资源长度或错误 Content-Range。

- [ ] 重试使用 1/2/4 秒延迟且支持 AbortSignal；超时 30 秒后按可重试网络错误处理。401/403/404、不支持格式、磁盘错误停止自动重试；502/503/504 与连接中断允许重试。测试用 fake timers，不能实际等待长时间。

- [ ] 实现一个任务执行、其余排队，任务内并发 4；暂停/取消中止正在传输资源，不记录完成，已完成文件保留。明确限制 merging 阶段只提供取消，不提供无意义的暂停合并。

- [ ] TaskStore 使用临时 JSON + rename，更新串行化。启动时将遗留 downloading/merging 改为 paused，删除本任务未完成 `.part`，逐个检查 completed 文件 hash。恢复前重新解析快照；内容变化返回 `SOURCE_CHANGED`，不混合资源。网络缓存记录 ETag/Last-Modified；可用时通过条件请求核对，无法可靠验证时重新读取资源并比较 hash，本地资源重新计算 hash；资源变化同样返回 SOURCE_CHANGED。

- [ ] 资源缓存属于独立任务目录，清理前解析绝对路径并核对是否在工具 cacheRoot 内；使用原生 fs 操作不构造 shell 删除命令。添加原始本地分片仍存在、缓存篡改需重下、重启恢复、取消可恢复测试并通过。

## Task A4: 本地 HLS 合并与可靠输出

**Files:** Create `src/main/media/process.ts`, `probe.ts`, `merge.ts`, `publish.ts`, `scripts/create-fixtures.mjs`, `tests/integration/merge.test.ts`。

**Interfaces:** Produces `runMedia(binary:string,args:string[],signal:AbortSignal):Promise<{stdout:Buffer;stderr:string}>`、`probeVideo(path:string):Promise<VideoInfo>`、`mergeVideo(input:{video:string;audio?:string;output:string;mode:'copy-mp4'|'copy-mkv'|'transcode-mp4';expectedDuration:number},signal:AbortSignal):Promise<string>`、`publishOutput(temp:string,target:string,replace:boolean):Promise<void>`。

- [ ] create-fixtures 用 FFmpeg lavfi 生成 6 秒 H.264/AAC 测试视频、TS HLS、fMP4 HLS、独立音轨列表和 AES-128 HLS。全部写 tests/generated，ffmpeg 参数用数组传给 spawn，错误非零退出。

```ts
spawn(binary,args,{shell:false,windowsHide:true});
```

- [ ] 写集成测试：输出有主视频及音频、时长误差 `<= max(1 秒, 总时长 * 0.01)`；缺失分片和子进程失败不发布目标文件。`npm test -- tests/integration/merge.test.ts` 先失败，再实现。

- [ ] FFprobe 使用 JSON 返回流和格式信息，主视频排除 attached_pic。runMedia 限制 stderr 为最近 256 KB，stdout 探测 JSON 限制 8 MB，确保取消终止进程而不是只 reject promise。开发 FFmpeg/FFprobe 路径通过环境变量/PATH，发布按 R1 使用 bundled 版本。

- [ ] 合并只允许必要本地协议 `file,crypto,data`，拒绝重写列表中残留的网络地址。无独立音轨时映射 `0:v:0`、`0:a:0?`；有独立音轨时映射 `0:v:0`、`1:a:0`。

```text
-i video.m3u8 [-i audio.m3u8] -map 0:v:0 -map 音轨 -c copy -movflags +faststart output.partial.mp4
```

转码明确用 `-c:v libx264 -c:a aac`；若 bundled 版本缺少 encoder，显示不支持并保留资源。MP4 失败时不自动转码，TaskView 返回可执行的 MKV/MP4 转码重试选项。

- [ ] 输出先验证再发布。另存遇同名返回 `OUTPUT_EXISTS`；replace 先将原文件改为备份，发布失败回滚，成功后才清理备份。测试注入 rename 失败，确认原文件内容保持一致。

- [ ] TS/fMP4/音轨/AES 样片集成通过，资源下载完整但合并失败时保留缓存；成功清理仅针对工具缓存。

## Task A5: 下载页面与应用服务接线

**Files:** Create `src/renderer/DownloadPage.tsx`, `SettingsPage.tsx`, `styles.css`, `tests/task-service.test.ts`; Modify `src/main/services.ts`, `ipc.ts`, `src/renderer/App.tsx`。

**Interfaces:** Consumes A1 AppServices、A2 inspectInput/selectManifest、A3 TaskRunner、A4 mergeVideo。Produces在线/本地输入界面、任务操作和下载完成进入封面页的 `onChooseVideo(path:string)` 事件。

- [ ] 实现 services.ts 的 inspect/start/listTasks/control；inspectionId 和 variantId 由主进程生成/查找，renderer 不能伪造资源清单。错误转为 Result，URL 展示去除账号和查询参数，调试报告默认脱敏。

- [ ] 任务服务行为测试：未完成列表不可 start、无效 variant 不下载、状态完成只发生在发布成功后、任务排队顺序正确。运行 `npm test -- tests/task-service.test.ts` 先失败，再接线至通过。

- [ ] 按设计完成输入切换、基础 URL 示例、清晰度/音轨、保存目录/文件名、任务进度和速度。解析失败保持用户输入。completed 提供打开目录与设置封面，failed 显示具体错误及允许的重试方式。

- [ ] 设置允许并发 1–8，默认 4；变更作用于下一个任务，不把当前下载的计数器立即改坏。支持保留缓存和选择可写缓存目录；目录变更不破坏已有任务缓存定位。

- [ ] 手动启动 `npm run dev`，实际测试本地列表、基础 URL 和在线样片；检查中文长路径、错误路径、暂停/恢复和取消。完成 `npm run typecheck`、相关测试和 `npm run build`。

- [ ] 有 Git 仓库时每个任务完成后提交；当前无仓库则记录完成项。交付时下载页必须实际可用，不能仅完成静态界面。
