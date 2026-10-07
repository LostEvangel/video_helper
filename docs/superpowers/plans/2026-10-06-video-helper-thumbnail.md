# Windows 缩略图插件 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付可独立安装的 x64 Windows 缩略图插件，优先读取 MP4 内嵌封面，未设置封面时提供普通视频缩略图。

**Architecture:** 隔离进程中的原生 COM DLL 实现 IThumbnailProvider/IInitializeWithStream。解析 MP4 封面元数据、通过 WIC 解码，缺少封面时用 Media Foundation 取主视频帧；独立安装器保存并条件恢复旧注册。

**Tech Stack:** C++17、CMake、Windows SDK、WIC、Media Foundation、COM、CTest；PowerShell 安装器和缩略图测试脚本。

**Spec:** `docs/superpowers/specs/2026-10-06-video-helper-design.md`

## Global Constraints

- Windows 10/11 x64 本地桌面工具。
- 默认安装主工具不注册插件。
- 插件优先读取内嵌封面，不查询 Electron 数据库、不启动 Electron、不在缩略图请求中联网。
- 卸载时只在当前注册仍属于本插件的情况下恢复原处理器，避免覆盖后来安装的插件。
- 安装插件的环境仍需保证文件管理器已开启缩略图显示，且视频与封面格式处于已验证的支持范围。

## Task P1: MP4 缩略图 COM DLL

**Files:** Create `native/thumbnail/CMakeLists.txt`, `src/provider.h`, `provider.cpp`, `mp4_cover.h`, `mp4_cover.cpp`, `image.cpp`, `fallback.cpp`, `dll.cpp`, `exports.def`, `tests/mp4_cover_test.cpp`, `tests/provider_test.cpp`, `README.md`。

**Interfaces:** Consumes C1 验证的 MP4/covr 样片。Produces原生 DLL，CLSID 由实现阶段生成一次 GUID 并记录到 `provider.h`，安装器从同一 JSON manifest 读取，禁止不同位置独立生成。

```cpp
HRESULT ReadMp4Cover(IStream* stream, std::vector<unsigned char>& image);
HRESULT DecodeCover(const std::vector<unsigned char>& image, UINT cx, HBITMAP* bitmap, WTS_ALPHATYPE* alpha);
HRESULT ExtractVideoThumbnail(IStream* stream, UINT cx, HBITMAP* bitmap, WTS_ALPHATYPE* alpha);
```

- [ ] 检查 Visual Studio C++ build tools/Windows SDK，可用时通过其 Developer 环境运行 CMake；缺失时先保留源码、CMake 与测试，不声称构建成功，不用安装动作替代检查。

- [ ] 定义 COM provider 实现 IUnknown/IThumbnailProvider/IInitializeWithStream，AddRef 持有 IStream，重复 Initialize 返回错误。输出 HBITMAP 在成功后由 caller 拥有，失败始终设为空；不设 DisableProcessIsolation。

```cpp
HRESULT Provider::GetThumbnail(UINT cx, HBITMAP* out, WTS_ALPHATYPE* alpha) {
  if (!out || !alpha) return E_POINTER;
  *out = nullptr;
  std::vector<unsigned char> cover;
  HRESULT result = ReadMp4Cover(stream_.Get(), cover);
  if (result == S_OK) {
    result = DecodeCover(cover, cx, out, alpha);
    if (SUCCEEDED(result)) return result;
  }
  return ExtractVideoThumbnail(stream_.Get(), cx, out, alpha);
}
```

- [ ] 用 C1 样片和手工构造的截断/越界 MP4 写失败测试。ReadMp4Cover 接受有效 covr JPEG/PNG，支持 32/64 位 atom 长度；递归深度最多 12，封面最多 16 MiB，拒绝溢出、越界、无进展循环和空 data。`S_FALSE` 表示无封面，错误 HRESULT 表示损坏。

```cpp
std::vector<unsigned char> image;
assert(ReadMp4Cover(validStream.Get(), image) == S_OK);
assert(!image.empty());
assert(FAILED(ReadMp4Cover(truncatedStream.Get(), image)));
```

测试通过 SHCreateMemStream 构造 IStream，validStream/truncatedStream 由 fixture 加载；每个流初始化有独立游标，测试多次查询不得依赖上次流位置。

- [ ] WIC 使用内存 stream 解码、保持比例缩放到 cx，cx 接受 1–1024；最大源尺寸和像素数受限，输出 32bpp DIB 并正确填写 alpha。拒绝超大解码分配。

- [ ] fallback 用 MFCreateMFByteStreamOnStream 和 Source Reader，排除 attached picture，获取有效视频帧并缩放；不支持的原生编码返回失败，让 Explorer 使用默认文件图标，不崩溃或启动 Electron。不能无限调用旧 handler 造成递归。

- [ ] 导出 DllGetClassObject、DllCanUnloadNow。COM class factory 和引用计数测试覆盖指针错误、无封面 fallback、损坏封面 fallback、有效红封面、释放后可卸载。CMake 配置输出 x64 DLL 并链接 windowscodecs/mf/mfplat/mfreadwrite/mfuuid/shlwapi/ole32。

```powershell
cmake -S native/thumbnail -B native/thumbnail/build -A x64
cmake --build native/thumbnail/build --config Release
ctest --test-dir native/thumbnail/build -C Release --output-on-failure
```

- [ ] 构建和测试通过后，将 DLL 与许可证复制至 native/thumbnail/dist；用现有 read-shell-thumbnail.ps1 在受控测试环境验证，注册须经用户在工具里显式启用，不在测试中偷偷全局启用。

## Task P2: 可选安装、条件恢复与独立分发

**Files:** Create `native/thumbnail/install.ps1`, `uninstall.ps1`, `manifest.json`, `tests/registration.Tests.ps1`, `src/main/plugin/service.ts`, `tests/plugin-service.test.ts`；Modify `src/main/services.ts`, `src/renderer/SettingsPage.tsx`, `native/thumbnail/README.md`。

**Interfaces:** Produces `getPluginStatus():Promise<PluginStatus>`、`changePlugin(action:'enable'|'disable'):Promise<PluginStatus>`；安装器使用 `-RegistryRoot` 参数进行测试，正式路径固定为 `HKCU:\Software\Classes`，handler 键为 `.mp4\ShellEx\{E357FCCD-A995-4576-B01F-234630154E96}`。manifest 包含 clsid/version/dllFile/hash，主工具和安装器只读同一来源。

- [ ] 用临时 HKCU 测试根写 Pester 用例：空值/旧 handler、重复安装、注册失败回滚、卸载恢复、安装后别人改了 handler 则不覆盖。先运行失败：

```powershell
Invoke-Pester native/thumbnail/tests/registration.Tests.ps1
```

用例仅操作测试根；准备有效原值与 JSON backup，再调用 `install.ps1 -RegistryRoot <测试根>`/uninstall，最后检查原值。不要使用用户真实 handler 路径运行单元测试。

- [ ] 安装器先校验架构、文件 hash 与路径，复制 DLL 到当前用户 LocalAppData 下的版本目录；只更新 HKCU 注册，默认不申请机器级安装。安装后若更高优先级/其他注册使本插件未被采用，返回 conflict，不报告 active。

- [ ] 注册 COM InprocServer32 和 Apartment threading；原 handler 精确备份（包含值不存在/空值区别），重复安装不能把自身写为原 handler。安装失败按所记录的原值回滚。

- [ ] 卸载只在当前 handler 为本插件 CLSID 时恢复原值；若别人后来修改，不碰该键，仅报告情况。DLL 正被占用时报告延迟清理，不能强制关闭文件管理器或杀进程。

- [ ] 注册变更使用 SHChangeNotify 通知关联变化，不直接修改系统缩略图数据库。封面内容变化时只通知相关文件更新，不清空用户所有缩略图。

- [ ] 主工具 plugin/service 调用本地固定脚本和 manifest，不拼接任意 PowerShell 指令。通过参数数组传入 enable/disable，执行失败返回 Result 错误；settings 提供启用、停用、冲突说明和当前状态。测试脚本退出非零与状态不一致均不能返回安装成功。

- [ ] 提供独立 ZIP 安装包含 DLL、manifest、install/uninstall.ps1、说明和许可证，用户无需 Electron 也可安装；主工具界面同样使用该组件。R1 打包前确认独立安装产物存在。

- [ ] 验收安装前/后红封面、无封面蓝视频、新封面更新、主工具关闭仍工作、复制到安装插件的第二台电脑、卸载回退与第三方注册保护。没有真实第二台环境时记录未验证，不用本机重复测试冒充。
