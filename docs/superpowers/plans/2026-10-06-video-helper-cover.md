# 时间点封面 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 不做播放器，通过时间轴和静态取帧选择封面，将图片嵌入 MP4，并记录原生 Windows 缩略图兼容性。

**Architecture:** 先使用独立脚本生成和检查封面样片，主工具建好后复用媒体进程服务。renderer 只控制时间和展示取帧结果，媒体服务负责提取、保存、验证和输出发布。

**Tech Stack:** Node.js、TypeScript、React、FFmpeg/FFprobe、Vitest；Windows 系统缩略图验证使用 Shell API。

**Spec:** `docs/superpowers/specs/2026-10-06-video-helper-design.md`

## Global Constraints

- Windows 10/11 x64 本地桌面工具。
- 第一版不录制直播，不做完整播放器，不生成候选截图，不提供外部图片导入，不提供逐帧定位。
- 前后微调时间按钮，第一版每次调整 0.1 秒。这是时间调整，不承诺恰好移动一帧。
- 默认另存为 `视频名_封面.mp4`，保留原视频。
- 能复制编码时不重新编码原音视频。封面是内嵌图片，不作为视频开头片段，不改变正常播放内容。
- 未安装工具的电脑是否显示指定封面，由该电脑的缩略图处理器决定，不能承诺全部原生生效。
- 默认安装主工具不注册插件。

## Task C1: 最先执行的封面兼容性实验

**Files:** Create `scripts/probe-cover.mjs`, `scripts/read-shell-thumbnail.ps1`, `docs/verification/cover-native.md`；生成样片放 `tests/generated/cover-probe/`，不打包。

**Interfaces:** 此任务不依赖 Electron 或 npm 依赖。Produces `node scripts/probe-cover.mjs`、`read-shell-thumbnail.ps1 -VideoPath <绝对路径> -OutputPath <png绝对路径>`，以及带环境与结论的实验报告。

- [ ] 检查 `ffmpeg -version`、`ffprobe -version`，记录系统版本和当前 `.mp4` 缩略图处理器的注册来源。只读注册表，不注册或卸载已有插件。如果环境已有第三方处理器，报告该环境不能代表原生 Windows。

- [ ] probe-cover.mjs 用 node child_process.spawn 的参数数组生成 6 秒蓝色视频及红色 JPEG 封面，保存为唯一的新文件名。用红/蓝显著不同的颜色避免误判封面与默认截帧。

```js
const makeVideo=['-f','lavfi','-i','color=c=blue:s=640x360:r=25:d=6','-f','lavfi','-i','sine=frequency=440:duration=6','-c:v','libx264','-c:a','aac','-shortest',plainPath];
const makeCover=['-f','lavfi','-i','color=c=red:s=640x360','-frames:v','1',coverPath];
const embed=['-i',plainPath,'-i',coverPath,'-map','0:v:0','-map','0:a?','-map','1:v:0','-c','copy','-c:v:1','mjpeg','-disposition:v:1','attached_pic',embeddedPath];
```

脚本定义 plainPath、coverPath、embeddedPath 为自己生成目录的绝对路径；每次执行选择新的目录，不用 `-y` 覆盖已有用户文件。脚本 helper 处理退出码并保证顺序执行。

- [ ] FFprobe 验证封面流标记及原音视频；提取附加图片检查为红色，再从视频主流取第一帧确认仍为蓝色。记录 MP4 内部图片存储位置，为 P1 的 covr 解析器提供已验证样片。

```js
const streams=JSON.parse(probeJson).streams;
if(!streams.some(s=>s.disposition?.attached_pic===1)) throw new Error('COVER_NOT_EMBEDDED');
if(!streams.some(s=>s.codec_type==='video'&&s.disposition?.attached_pic!==1)) throw new Error('MAIN_VIDEO_MISSING');
```

- [ ] read-shell-thumbnail.ps1 通过 Add-Type 声明 `SHCreateItemFromParsingName` 和 `IShellItemImageFactory::GetImage`，请求 256×256 `SIIGBF_THUMBNAILONLY` 图像，保存返回 HBITMAP 为 PNG，finally DeleteObject。该方法取得系统返回结果，不等价于干净系统结果，报告中必须记录 handler。

```csharp
[ComImport, Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IShellItemImageFactory {
  [PreserveSig] int GetImage(SIZE size, int flags, out IntPtr bitmap);
}
struct SIZE { public int cx; public int cy; }
```

脚本还需声明 SHCreateItemFromParsingName、DeleteObject，GetImage 成功后用 System.Drawing.Image.FromHbitmap 保存，再释放 COM 对象。失败写 HRESULT 和环境，不伪造图像。

- [ ] 新文件第一次生成缩略图后取结果，再写入另一张绿色封面、另存新路径复测；保存截图/返回图片和对照图。不要默认清空整台电脑的缩略图缓存。

- [ ] 在可用的 Windows 10/11 干净环境复测。report 为每项记录「通过/失败/未验证」、系统 build、FFmpeg 版本、handler、原生缩略图颜色、复制文件结果、正常播放结果。不用未经测试的预期填写结果。

- [ ] 核对结论：若内嵌成功但默认系统取蓝色，记录原生不采用封面，将插件作为显示兜底；继续开发内嵌方式，不改变主视频画面。没有干净环境时继续其他开发，但最终验收保留该限制。

## Task C2: 时间点取帧与可靠封面保存

**Files:** Create `src/main/media/frame.ts`, `cover.ts`, `tests/integration/cover.test.ts`；Modify `probe.ts`, `publish.ts`, `process.ts`（A4 创建）。

**Interfaces:** Consumes A1 `VideoInfo/Preview/CoverResult` 与 A4 `runMedia/probeVideo/publishOutput`。Produces `extractFrame(path:string,time:number,signal:AbortSignal):Promise<{jpeg:Buffer;time:number}>`、`saveVideoCover(request:{path:string;time:number;output:string;replace:boolean},signal:AbortSignal):Promise<CoverResult>`、`exportVideoFrame(request:{path:string;time:number;output:string},signal:AbortSignal):Promise<void>`。

- [ ] 测试使用红/绿/蓝三个时间段的视频，检查 0.5/2.5/4.5 秒取帧颜色明显不同；非有限时间、负值、超时长返回 `INVALID_TIME`，末端不能产生空 JPEG。运行 `npm test -- tests/integration/cover.test.ts` 先失败。

- [ ] 按 ffprobe 主视频流索引取帧，不映射已有 attached_pic。使用快速 seek + 输出侧解码到目标时间，不仅截取之前的关键帧；输出 JPEG pipe 并限制最大响应 32 MB，超限返回 `FRAME_TOO_LARGE`。

```text
-ss 请求秒数 -i 原视频 -map 0:主视频索引 -frames:v 1 -f image2pipe -c:v mjpeg pipe:1
```

使用 API 请求的时间对应的实际帧；不足一帧间隔的结束边界以可解码的最后画面作为回退。frame.ts 返回实际采用的时间，不将取帧精度宣传为逐帧定位。

- [ ] 封面保存只接受已选视频和有效时间。先在私有临时目录生成 JPEG，再按 C1 验证方式写 MP4。映射主视频、音轨以及 MP4 能保留的原字幕/metadata，排除旧 attached_pic，添加新的图片；不支持的流不能静默丢弃，需明确报错并保留原文件。

- [ ] 验证输出包含且仅包含一个选定封面，主视频/音轨编码与原文件相同，时长在原视频一个有效帧间隔内；封面可提取、宽高比例正确。替换失败使用 A4 发布回滚。result 为 `{output,embedded:true,nativeDisplay:'unverified'}`，不返回原生显示成功。

- [ ] 测试覆盖首次嵌入、替换已有封面、原视频流不变、中文路径、输出同名拒绝、发布故障不损坏原文件、无视频流、取消提取。JPG 单独导出使用相同提取结果和可靠发布。

- [ ] 通过相关集成测试和 typecheck。给发布测试增加 MKV 可取帧/导图但不能直接调用 MP4 封面写入的提示。

## Task C3: 静态时间轴页面与竞态控制

**Files:** Create `src/renderer/CoverPage.tsx`, `time.ts`, `preview.ts`, `tests/cover-state.test.ts`；Modify `src/main/services.ts`, `ipc.ts`, `src/renderer/App.tsx`, `styles.css`。

**Interfaces:** Consumes AppServices probe/preview/saveCover/exportFrame、C2 取帧服务。Produces `parseTime(text:string):number`、`formatTime(seconds:number):string`、`PreviewController` 的 `request(path,time):Promise<Preview|undefined>` 和 `dispose():void`；CoverPage 接收 `{initialPath?:string}`。

- [ ] 写时间输入与请求代次行为测试：`00:01:23.450 -> 83.45`；拒绝 `00:61:00.000`、空值、NaN；较早请求后返回时不能覆盖较新请求。

```ts
it('parses a millisecond timestamp',()=>expect(parseTime('00:01:23.450')).toBe(83.45));
it('rejects invalid minute fields',()=>expect(()=>parseTime('00:61:00.000')).toThrow());
```

竞态测试创建两个可手动 resolve 的 promise，先 resolve request 2，后 resolve request 1；最终可见预览只能是 2。执行 `npm test -- tests/cover-state.test.ts` 先失败再实现。

- [ ] 服务层为每页每视频维护最新请求 ID 和 AbortController，取消旧取帧；renderer 同样检查 ID。切换视频、页面销毁、应用退出全部清理，不只在 UI 隐藏结果。

- [ ] 初始 probe 后取有效画面。range 的 input 只更新时间文本，pointerup/键盘操作结束提交预览，时间输入回车/失焦提交；0.1 秒按钮进行范围约束。static img 按 contain 保持比例。

- [ ] 预览采用只由主进程产生的私有图片 URL 或受限自定义协议 token，不将任意磁盘路径暴露为读文件服务。取帧失败保留之前画面，但禁用「设为封面」，防止旧图配新时间。

- [ ] 「设为封面」锁定当前成功预览的 path/time。之后改变时间只影响浏览，不悄悄改变已选封面；最终保存使用已锁定时间。提供另存、明确替换和导出 JPG，不加入播放器、外部图片或候选图。

- [ ] 保存成功仅显示「封面已写入视频」和打开输出目录入口；兼容帮助说明原生显示取决于系统，提供可选插件入口。服务还未接入插件时显示明确不可用状态，不返回伪安装成功。

- [ ] 人工运行验证拖动、键盘时间轴、精确时间、快速切换视频、长任务同时浏览封面、覆盖失败。通过 typecheck、相关测试、build，记录静态预览实际截图。
