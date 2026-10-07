# 视频助手 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付可下载完整 HLS 视频、按时间点设置内嵌封面、可选启用 Windows 缩略图插件的本地桌面应用。

**Architecture:** Electron 主进程管理文件、下载和 FFmpeg 子进程，React 只通过受控 IPC 操作。封面保存在视频内部；原生缩略图兼容先实测，独立 Windows 插件兜底。

**Tech Stack:** TypeScript、React、Electron、Vite、Vitest、electron-builder、FFmpeg/FFprobe；插件使用 C++、CMake、Windows SDK。

**Spec:** `docs/superpowers/specs/2026-10-06-video-helper-design.md`

## Global Constraints

- Windows 10/11 x64 本地桌面工具。
- 第一版不录制直播，不做完整播放器，不生成候选截图，不提供外部图片导入，不提供逐帧定位。
- 默认每任务最多 4 个网络请求并发，第一版同一时间执行一个下载任务，其余排队。
- 下载失败自动重试最多 3 次，使用递增等待。
- 不静默覆盖已有文件；清理仅针对工具创建的临时副本。
- 未安装工具的电脑是否显示指定封面，由该电脑的缩略图处理器决定，不能承诺全部原生生效。
- 默认安装主工具不注册插件。
- 安装包约 200 MB 为优化目标，最终以实际构建为准。

---

## 当前环境与执行规则

2026-10-06 已发现 Node.js v24.9.0、npm 11.6.0，以及 PATH 中的 ffmpeg/ffprobe/git。当前目录只有设计文档，尚无代码、依赖或 Git 仓库。PATH 中未发现 CMake 和 cl；执行插件计划前须检查 Visual Studio 安装目录，不能仅凭 PATH 缺失判断工具未安装。

依赖安装时查询实际版本与 engines，将适配当前 Node 的稳定版本固定在 package-lock.json。避免把其他工具同名的 SDK 当作 Electron 依赖。

代码实现采用行为测试：资源地址、重试与恢复、文件完整性、时间点取帧、封面流和注册恢复。样式、静态文案等低风险修改直接查看效果，不编写镜像实现的测试。

当前没有 Git 仓库，提交步骤仅在用户要求初始化仓库或存在仓库后执行；否则保留全部文件和测试记录，不擅自创建远程仓库。

## 分计划与执行顺序

本项目包含三个可独立验收的子系统，拆成以下计划，但共享同一设计文档：

1. `2026-10-06-video-helper-cover.md` 任务 C1：先做内嵌封面和原生缩略图技术验证。
2. `2026-10-06-video-helper-core.md` 任务 A1–A5：下载核心与可运行的 Electron 下载界面。
3. `2026-10-06-video-helper-cover.md` 任务 C2–C3：媒体服务和时间轴封面页。
4. `2026-10-06-video-helper-thumbnail.md` 任务 P1–P2：可选 Windows 插件和独立安装器。
5. 本计划任务 R1：主工具打包、整体验收。

C1 若没有另一台干净 Windows 环境，仍可完成本机探测、文件写入和读取验证，并明确把跨系统项记为未验证。不能阻塞其余模块开发，也不能宣称已完成跨系统兼容验收。

## 文件职责总图

```text
src/shared/contracts.ts                 主工具跨模块类型与 IPC 契约
src/main/index.ts                       Electron 启动、窗口、退出清理
src/main/preload.ts                     受限的 window.videoHelper API
src/main/ipc.ts                         通道、来源与参数验证
src/main/services.ts                    下载、媒体、持久化实例组装
src/main/hls/{parse,resolve,inspect,localize}.ts
                                       HLS 标签、路径解析、递归选流、本地列表生成
src/main/download/{resource,queue,runner,store}.ts
                                       传输、并发、任务生命周期、原子持久化
src/main/media/{process,probe,merge,frame,cover,publish}.ts
                                       子进程、探测、合并、取帧、封面、可靠输出
src/renderer/{App,DownloadPage,CoverPage,SettingsPage}.tsx
                                       页面与交互
src/renderer/{time,preview}.ts          时间校验与请求代次控制
native/thumbnail/                      Windows 原生 DLL 与独立安装器
scripts/                               样例生成、兼容性探测、打包
tests/                                 固定样例、行为测试、集成测试
docs/verification/                     原生兼容性及打包验收证据
```

## Task R1: 主工具打包与整体交付

**Files:** Create `electron-builder.yml`, `scripts/package.mjs`, `tests/integration/release.test.ts`, `README.md`, `docs/verification/release.md`; Modify `package.json`, `src/main/services.ts`, `src/renderer/SettingsPage.tsx`。

**Interfaces:** Consumes A/C/P 的应用服务和插件管理接口。Produces `npm run dist`，产物为 `release/VideoHelper-Setup.exe`；插件另有独立安装器，不在主工具安装时默认注册。

- [ ] 固定打包配置，开发模式从显式环境变量或 PATH 找 FFmpeg，发布模式仅从 resources/bin 加载。只打包必要二进制、许可证与归档信息，排除测试样片和缓存。

```yaml
appId: local.videohelper.desktop
productName: VideoHelper
directories:
  output: release
files:
  - dist/**
  - package.json
extraResources:
  - from: vendor/ffmpeg
    to: bin
  - from: native/thumbnail/dist
    to: thumbnail
win:
  artifactName: VideoHelper-Setup.exe
  target:
    - target: nsis
      arch: [x64]
nsis:
  oneClick: false
  allowToChangeInstallationDirectory: true
```

- [ ] `scripts/package.mjs` 校验 ffmpeg.exe、ffprobe.exe、插件安装器和各自许可证确实存在，缺失则退出非零；实际发布不能从用户 PATH 静默借用依赖。增加脚本：

```json
{"scripts":{"dist":"npm run build && node scripts/package.mjs && electron-builder --win --x64"}}
```

- [ ] 先写发布行为测试，验证发布路径带中文和空格时二进制可运行、输出可解析、文件写入失败不破坏已有输出。运行 `npm test -- tests/integration/release.test.ts`，实现前应失败，实现后通过。

- [ ] 运行 `npm run typecheck`、`npm test`、`npm run build`、`npm run dist`；只在变更或发现失败后重跑相关项目。

- [ ] 在安装版中实际完成：在线 TS 下载、本地列表+基础 URL、本地分片、fMP4、音轨选择、暂停重启恢复、选时间点、另存封面、更换封面、独立插件安装/卸载。新建测试视频路径避免旧缓存影响。

- [ ] Windows 10/11 干净环境分别记录默认与插件启用结果、二进制版本、安装包大小、安装后大小、运行截图和已知限制。未执行的项目写「未验证」及具体环境缺失，不写通过。

- [ ] README 写明启动/打包命令、本地基础 URL 示例、封面兼容边界、独立插件安装和卸载路径；用 `Get-Item release/VideoHelper-Setup.exe | Select-Object Name,Length` 记录实际大小。

- [ ] 有 Git 仓库时提交已通过验收的改动；没有仓库时记录文件和验证报告即可。

## 覆盖检查

- 设计 1–3：A1/A2/A5 提供平台、输入、清晰度、独立音轨和基础 URL。
- 设计 4：A2/A3/A4 提供 HLS 标签、AES-128、字节范围、暂停重试、恢复与验证合并。
- 设计 5：C1/C2/C3/P1/P2 提供原生实测、时间点封面、另存/替换、插件兜底。
- 设计 6–7：A1/A3/A5/C2 定义模块、IPC、状态、错误与子进程退出。
- 设计 8：各行为测试与 R1 提供最终验收和体积实测。

## 官方实现参考

- Electron 隔离与 IPC：https://www.electronjs.org/docs/latest/tutorial/security
- FFmpeg 流选择、取帧：https://ffmpeg.org/ffmpeg.html
- FFmpeg HLS/MP4：https://ffmpeg.org/ffmpeg-formats.html
- Windows 缩略图处理器：https://learn.microsoft.com/en-us/windows/win32/shell/building-thumbnail-providers

## 执行交接

计划已可供执行。选择在当前会话逐项执行，或按任务使用子代理实现并审查。执行时先读设计和对应子计划；每个任务核对依赖、完成测试并更新勾选状态，再进入下一任务。
