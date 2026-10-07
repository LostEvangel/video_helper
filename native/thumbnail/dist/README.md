# Video Helper native MP4 thumbnail provider

This x64 COM DLL implements `IThumbnailProvider` and `IInitializeWithStream` for MP4 files. It reads JPEG or PNG image data from `moov/udta/meta/ilst/covr/data`, decodes and scales the image through WIC, and falls back to a decoded moving-video frame through Media Foundation when the cover is missing or damaged. The request path reads only the supplied stream; it does not use Electron, the network, or another thumbnail handler.

The COM class ID is `{c74c4f7e-ec39-44e4-9daa-78d6509384eb}`. It is recorded in `manifest.json` and repeated in `src/provider.h` for COM activation. Keep those values identical. `dist/manifest.json` is the runtime identity source read by both Video Helper and the PowerShell scripts.

## Build and test

With Visual Studio C++ tools and a Windows SDK installed, run from the repository root:

```powershell
cmake -S native/thumbnail -B native/thumbnail/build -A x64
cmake --build native/thumbnail/build --config Release
ctest --test-dir native/thumbnail/build -C Release --output-on-failure
```

The current workspace also supports its portable Zig toolchain. The following PowerShell commands keep compiler caches inside `.tools` and build an x64 Windows GNU-target DLL with CMake and Ninja:

```powershell
$repo = (Resolve-Path .).Path
$zig = Join-Path $repo '.tools\zig\zig-x86_64-windows-0.14.1\zig.exe'
$cmake = Join-Path $repo '.tools\cmake\cmake-3.31.12-windows-x86_64\bin\cmake.exe'
$ninja = Join-Path $repo '.tools\ninja\ninja.exe'
$env:ZIG_GLOBAL_CACHE_DIR = Join-Path $repo '.tools\cache\zig-global'
$env:ZIG_LOCAL_CACHE_DIR = Join-Path $repo '.tools\cache\zig-local'
& $cmake -S native/thumbnail -B native/thumbnail/build -G Ninja `
  -DCMAKE_MAKE_PROGRAM=$ninja `
  -DCMAKE_CXX_COMPILER=$zig `
  -DCMAKE_CXX_COMPILER_ARG1=c++ `
  '-DCMAKE_CXX_FLAGS=-target x86_64-windows-gnu -std=c++20' `
  -DBUILD_TESTING=ON
& $cmake --build native/thumbnail/build --config Release
& (Join-Path (Split-Path $cmake) 'ctest.exe') --test-dir native/thumbnail/build -C Release --output-on-failure
```

The native CTest parses the actual C1 red-cover fixture and synthetic valid/malformed atoms, then loads the built DLL directly and exercises its class factory and provider. It checks red cover output, blue fallback for a coverless video, blue fallback after corrupting the `covr/data` image signature, stream cursor resets, pointer validation, repeated initialization, caller-owned `HBITMAP` cleanup, and `DllCanUnloadNow`. It does not register the DLL.

The parser supports 32-bit and extended 64-bit atom sizes, a maximum nesting depth of 12, and image payloads up to 16 MiB. It returns `S_FALSE` when no cover exists and a failing HRESULT for malformed atom data. WIC decoding caps either image dimension at 8192 and total source pixels at 16 million. The Media Foundation fallback caps video dimensions and pixels to the same limits, scans at most 64 streams, and skips one-sample still-image streams.

The class links to Windows `windowscodecs`, `mf`, `mfplat`, `mfreadwrite`, `mfuuid`, `shlwapi`, `ole32`, and `oleaut32` APIs. Windows 10/11 x64 is the intended host; this build and test used the available Windows 10 host. A clean Windows 11 host and Explorer registration/display behavior have not been validated in this phase.

## Windows API references

- [IThumbnailProvider](https://learn.microsoft.com/en-us/windows/win32/api/thumbcache/nn-thumbcache-ithumbnailprovider) requires a stream initialization interface for the Shell thumbnail-cache path.
- [MFCreateMFByteStreamOnStream](https://learn.microsoft.com/en-us/windows/win32/api/mfidl/nf-mfidl-mfcreatemfbytestreamonstream) wraps the caller's `IStream` for Media Foundation. The Zig-bundled MinGW headers omit this documented declaration, so `fallback.cpp` declares the documented Windows ABI prototype locally and links it from `mfplat`.
- [Windows Imaging Component](https://learn.microsoft.com/en-us/windows/win32/wic/-wic-portal) provides the decoder, scaler, format conversion, and alpha metadata used to return the caller-owned DIB.

## Optional per-user installation

The optional provider supports Windows 10/11 x64 and uses the current user's Windows PowerShell and HKCU registration. The main application does not register it automatically. Extract the independent `VideoHelperThumbnail-0.1.0-win-x64.zip` archive, open 64-bit Windows PowerShell in the extracted folder, and run:

```powershell
.\install.ps1
```

The installer validates the x64 PE image and SHA-256 in the adjacent `manifest.json`, copies the DLL to `%LOCALAPPDATA%\VideoHelper\ThumbnailProvider\0.1.0`, and writes the COM server, Apartment threading model, and MP4 thumbnail-handler association under `HKCU:\Software\Classes`. It records the exact previous handler value, including whether the value was missing or an empty string and its registry type, in `registration-backup.json`. Repeating installation preserves the first backup.

The installer checks the merged Windows `HKEY_CLASSES_ROOT` handler after registration. It reports the provider as active only when Windows resolves the MP4 thumbnail-handler association to this CLSID. A higher-precedence registration can leave the provider installed but inactive; the status message reports that conflict. Windows may also require thumbnail display to be enabled in Folder Options.

To inspect the current state without changing registration, run `./install.ps1 -Status`. To disable the provider, run:

```powershell
.\uninstall.ps1
```

Uninstall restores the saved handler only while the current per-user handler still points to this provider. If another program has replaced it, uninstall preserves that value and reports the conflict. The COM registration is removed only while its server path still points to this provider's versioned DLL. A DLL that Explorer holds open is left in place and reported for deferred cleanup. The scripts do not stop Explorer or clear the thumbnail database.

Registration changes notify Windows with `SHChangeNotify(SHCNE_ASSOCCHANGED)`. When Video Helper saves a changed MP4 cover, it sends an update notification for that file only. Neither path clears the user's thumbnail cache.

The zip is self-contained apart from Windows system components and can be installed without Electron. It contains the x64 DLL, the runtime manifest read by both the main app and scripts, installation/removal scripts, this guide, and the bundled compiler/runtime license texts. The DLL still dynamically depends on Windows system libraries; it is not a fully static binary.

Pester registration tests write only beneath a fresh `HKCU:\Software\VideoHelper.Tests.<guid>` key and a temporary DLL directory under `native/thumbnail/tests`; they never modify the user's real MP4 handler. Run them with `Invoke-Pester native/thumbnail/tests/registration.Tests.ps1` from Windows PowerShell with Pester 3.4 or later.

Explorer activation and display have not been validated on a clean Windows 11 machine or a second computer. The test DLL was exercised directly without registering it. A real Explorer display check remains necessary before claiming system-level cover display support.
