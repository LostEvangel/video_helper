# MP4 内嵌封面与 Windows 缩略图实验

日期：2026-10-06

## 结论

本机 Windows 10 的 Shell 缩略图接口在红色封面样片上返回红色，在用绿色封面另存的新 MP4 上返回绿色；蓝色视频主流仍为蓝色。样片内的封面可以从 MP4 的 `moov/udta/meta/ilst/covr/data` 读取。由此确认本机注册的 Windows `shell32.dll` 处理器会采用此 MP4 封面写法。

这证明的是本机 `SHCreateItemFromParsingName` 与 `IShellItemImageFactory::GetImage` 的返回结果。没有通过文件资源管理器窗口做目视确认，也没有第二台干净 Windows 或 Windows 11 环境，因此不把结果扩展为「Explorer 已确认」或所有 Windows 电脑均支持。

## 实验环境

- 系统：Windows 10 Pro 22H2，x64，build `19045.6093`。
- FFmpeg：`ffmpeg version 8.1.1-full_build-www.gyan.dev`。
- FFprobe：`ffprobe version 8.1.1-full_build-www.gyan.dev`。
- Node.js：`v24.9.0`，`win32/x64`。
- `.mp4` 默认 ProgID：`WMP11.AssocFile.MP4`。
- `.mp4\ShellEx\{e357fccd-a995-4576-b01f-234630154e96}` 指向 CLSID `{9DBD2C50-62AD-11D0-B806-00C04FD706EC}`，名称为 `Property Thumbnail Handler`，`InProcServer32` 是 `C:\Windows\system32\shell32.dll`，线程模型 `Apartment`。检查到的 `.mp4` 与 `video` `SystemFileAssociations` 缩略图覆盖项不存在。注册表只读检查未发现第三方处理器路径。
- Shell 返回值来自上述已注册处理器；未注册、安装或卸载扩展，也没有清理系统缩略图缓存。

## 检查结果

- **通过**：以 FFmpeg 生成 6 秒蓝色 H.264 视频、AAC 音频和红色 JPEG 封面；每次运行创建新的唯一目录，不覆盖已有文件。
- **通过**：FFprobe 在 MP4 流索引 2 找到 `mjpeg` 附加图片（`attached_pic=1`）；原 H.264 主视频和 AAC 音频仍在，参数与原样片相同，二者时长均为 6 秒。
- **通过**：提取的内嵌图片经整幅缩至 `1x1` 后测得 RGB `(255, 0, 0)`；主视频首帧同样测得 `(2, 0, 255)`，判为蓝色。判色样本代表整幅图片的平均效果，不是中心像素。
- **通过**：Windows Shell API 对红封面 MP4 返回红色缩略图；返回图经整幅缩至 `1x1` 后测得 RGB `(255, 1, 0)`。请求尺寸 `256x256`，标志 `SIIGBF_THUMBNAILONLY`，HRESULT `0x00000000`。
- **通过**：红封面 MP4 复制到新路径后字节哈希一致，Shell API 仍返回红色。样片没有依赖旁置封面文件。
- **通过**：使用绿色 JPEG 另存为另一个新 MP4 路径后，Shell API 返回绿色缩略图；整幅缩至 `1x1` 后测得 RGB `(0, 130, 1)`。没有清空缩略图缓存；每个样片路径均为新路径。
- **通过**：FFmpeg 对红色样片、复制件和绿色样片的主视频流及音频流完成解码，退出码均为 0；主 H.264 与 AAC 未重新编码。
- **未验证**：文件资源管理器窗口里的实际显示。Shell API 返回的是 Windows 提供的缩略图位图，不等同于 Explorer 目视验收。
- **未验证**：干净 Windows 10/11 第二环境、不同缩略图处理器，以及外部播放器实际播放。当前只验证了 FFmpeg 对音视频流的完整解码。

## MP4 图片位置

当前 FFmpeg 样片把封面写在 `moov/udta/meta/ilst/covr/data`，没有建立 `pict` 视频轨道。样片 `embedded-red.mp4` 中的盒位置为：

- `covr`：文件偏移 `62663`，大小 `1628` 字节。
- `data` 子盒：偏移 `62671`，大小 `1620` 字节。
- 图片负载：偏移 `62687`，大小 `1604` 字节；负载以 JPEG `FF D8` 标记开始。`data` 类型指示值为 `13`，locale 为 `0`。

这些偏移只对应本次生成的样片；P1 解析器应按盒大小遍历，不能把该样片的绝对偏移当作通用常量。完整 FFprobe 结果和盒扫描摘要见 [`probe-results.json`](../../tests/generated/cover-probe/run-2026-10-06T033120673Z-6ebfff3d-3f07-4bde-885b-b0fa772f1344/probe-results.json)。

## 图片证据

对照图从 Shell 返回图和 FFmpeg 提取图拼成：左起依次为提取的红色封面、蓝色主视频首帧、红样片的 Shell 返回图、绿样片的 Shell 返回图。

![红色封面、蓝色主视频帧与 Windows Shell 缩略图对照](../../tests/generated/cover-probe/run-2026-10-06T033120673Z-6ebfff3d-3f07-4bde-885b-b0fa772f1344/thumbnail-comparison.png)

原始返回图： [红样片 Shell 返回图](../../tests/generated/cover-probe/run-2026-10-06T033120673Z-6ebfff3d-3f07-4bde-885b-b0fa772f1344/shell-thumbnail-red-sample.png)、[复制文件 Shell 返回图](../../tests/generated/cover-probe/run-2026-10-06T033120673Z-6ebfff3d-3f07-4bde-885b-b0fa772f1344/shell-thumbnail-copied-file.png)、[绿样片 Shell 返回图](../../tests/generated/cover-probe/run-2026-10-06T033120673Z-6ebfff3d-3f07-4bde-885b-b0fa772f1344/shell-thumbnail-green-sample.png)。样片和提取对照图均位于 [`tests/generated/cover-probe`](../../tests/generated/cover-probe/)；不会打包进主应用。

## 可复现实验

在仓库根目录运行：

```powershell
ffmpeg -version
ffprobe -version
node scripts/probe-cover.mjs
```

脚本用 `child_process.spawn` 和参数数组顺序执行命令，并在每次执行时创建唯一输出目录。`read-shell-thumbnail.ps1` 也可独立运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/read-shell-thumbnail.ps1 `
  -VideoPath 'D:\绝对路径\embedded-red.mp4' `
  -OutputPath 'D:\绝对路径\shell-thumbnail.png'
```

它调用 `SHCreateItemFromParsingName` 和 `IShellItemImageFactory::GetImage`，请求 256×256 的 `SIIGBF_THUMBNAILONLY` 图像，用 `System.Drawing.Image.FromHbitmap` 保存 PNG，并在 `finally` 中调用 `DeleteObject`。API 失败时输出 HRESULT、系统 build 和错误，不写伪造图像；既有输出文件会被拒绝覆盖。

## 排障记录

第一次集成测试时，PowerShell 把 COM 返回对象显示为 `System.__ComObject`，不允许直接调用 `GetImage`。该次测试没有生成或伪造缩略图。脚本改为从原生接口指针调用 `IShellItemImageFactory` 的 vtable 方法并在 `finally` 释放 HBITMAP 和 COM 引用；之后的红、绿及复制件调用均返回 HRESULT `0x00000000`。未单独触发并实测 Shell API 的失败 HRESULT 分支。
