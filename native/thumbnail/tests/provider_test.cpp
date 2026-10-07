#include "provider.h"

#include "com_ptr.h"
#include "mp4_cover_test.h"
#include "test_support.h"

#include <shlwapi.h>
#include <shellapi.h>

#include <algorithm>
#include <array>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <filesystem>
#include <iostream>
#include <iterator>
#include <string>
#include <string_view>
#include <vector>

namespace {
using DllGetClassObjectFn = HRESULT(WINAPI*)(REFCLSID, REFIID, void**);
using DllCanUnloadNowFn = HRESULT(WINAPI*)();

template <typename Function>
Function ResolveExport(HMODULE module, const char* name) {
  const FARPROC procedure = GetProcAddress(module, name);
  Function function = nullptr;
  static_assert(sizeof(procedure) == sizeof(function));
  std::memcpy(&function, &procedure, sizeof(function));
  return function;
}

std::vector<unsigned char> ReadFile(const std::wstring& path) {
  std::ifstream input(std::filesystem::path(path), std::ios::binary);
  CHECK(input.good(), "could not open provider test fixture");
  return std::vector<unsigned char>(std::istreambuf_iterator<char>(input),
                                    std::istreambuf_iterator<char>());
}

ComPtr<IStream> MakeStream(const std::vector<unsigned char>& bytes) {
  CHECK(bytes.size() <= MAXDWORD, "provider test fixture exceeds UINT");
  IStream* raw = SHCreateMemStream(bytes.data(), static_cast<UINT>(bytes.size()));
  CHECK(raw != nullptr, "SHCreateMemStream failed for provider test");
  return ComPtr<IStream>(raw);
}

ComPtr<IStream> MakeStream(const std::wstring& path) {
  return MakeStream(ReadFile(path));
}

void AppendBigEndian32(std::vector<unsigned char>& bytes, std::uint32_t value) {
  bytes.push_back(static_cast<unsigned char>((value >> 24) & 0xff));
  bytes.push_back(static_cast<unsigned char>((value >> 16) & 0xff));
  bytes.push_back(static_cast<unsigned char>((value >> 8) & 0xff));
  bytes.push_back(static_cast<unsigned char>(value & 0xff));
}

std::uint32_t PngCrc32(const std::vector<unsigned char>& bytes) {
  std::uint32_t crc = 0xffffffffu;
  for (const unsigned char byte : bytes) {
    crc ^= byte;
    for (int bit = 0; bit < 8; ++bit) {
      crc = (crc >> 1) ^ ((crc & 1) ? 0xedb88320u : 0u);
    }
  }
  return ~crc;
}

void AppendPngChunk(std::vector<unsigned char>& png, std::string_view type,
                    const std::vector<unsigned char>& data) {
  AppendBigEndian32(png, static_cast<std::uint32_t>(data.size()));
  std::vector<unsigned char> checksumInput(type.begin(), type.end());
  checksumInput.insert(checksumInput.end(), data.begin(), data.end());
  png.insert(png.end(), checksumInput.begin(), checksumInput.end());
  AppendBigEndian32(png, PngCrc32(checksumInput));
}

std::vector<unsigned char> MakeValidTransparentPng() {
  std::vector<unsigned char> png = {0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a};
  AppendPngChunk(png, "IHDR", {0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0});

  const std::vector<unsigned char> scanline = {0, 240, 32, 16, 128};
  std::uint32_t adlerA = 1;
  std::uint32_t adlerB = 0;
  for (const unsigned char byte : scanline) {
    adlerA = (adlerA + byte) % 65521;
    adlerB = (adlerB + adlerA) % 65521;
  }
  std::vector<unsigned char> compressed = {0x78, 0x01, 0x01, 0x05, 0x00, 0xfa, 0xff};
  compressed.insert(compressed.end(), scanline.begin(), scanline.end());
  AppendBigEndian32(compressed, (adlerB << 16) | adlerA);
  AppendPngChunk(png, "IDAT", compressed);
  AppendPngChunk(png, "IEND", {});
  return png;
}

void CheckDominantColor(HBITMAP bitmap, bool expectRed) {
  CHECK(bitmap != nullptr, "provider returned a null bitmap on success");
  DIBSECTION section{};
  CHECK(GetObjectW(bitmap, sizeof(section), &section) == sizeof(section),
        "provider did not return a DIB section");
  const LONG width = section.dsBmih.biWidth;
  const LONG height = section.dsBmih.biHeight < 0
      ? -section.dsBmih.biHeight
      : section.dsBmih.biHeight;
  CHECK(width > 0 && height > 0, "returned thumbnail dimensions are invalid");
  const auto* pixels = static_cast<const unsigned char*>(section.dsBm.bmBits);
  CHECK(pixels != nullptr, "returned DIB has no pixel storage");
  const std::size_t x = static_cast<std::size_t>(width / 2);
  const std::size_t y = static_cast<std::size_t>(height / 2);
  const auto* center = pixels + (y * static_cast<std::size_t>(width) + x) * 4;
  const unsigned blue = center[0];
  const unsigned green = center[1];
  const unsigned red = center[2];
  if (expectRed) {
    if (!(red > 180 && red > green * 2 && red > blue * 2)) {
      throw std::runtime_error("red cover center was BGR(" + std::to_string(blue) + "," +
                               std::to_string(green) + "," + std::to_string(red) + ")");
    }
  } else {
    if (!(blue > 150 && blue > red * 2 && blue > green * 2)) {
      throw std::runtime_error("fallback center was BGR(" + std::to_string(blue) + "," +
                               std::to_string(green) + "," + std::to_string(red) + ")");
    }
  }
}

void CheckDimensions(HBITMAP bitmap, UINT maximum) {
  DIBSECTION section{};
  CHECK(GetObjectW(bitmap, sizeof(section), &section) == sizeof(section),
        "could not inspect returned DIB");
  const UINT width = static_cast<UINT>(section.dsBmih.biWidth);
  const UINT height = static_cast<UINT>(section.dsBmih.biHeight < 0
      ? -section.dsBmih.biHeight
      : section.dsBmih.biHeight);
  CHECK(width <= maximum && height <= maximum,
        "thumbnail exceeds requested cx");
  CHECK(width > 0 && height > 0, "thumbnail has zero dimensions");
  CHECK(width * 9 == height * 16 || width * 9 + 16 >= height * 16,
        "thumbnail aspect ratio was unexpectedly distorted");
}

ComPtr<IThumbnailProvider> CreateProvider(IClassFactory* factory) {
  IThumbnailProvider* provider = nullptr;
  const HRESULT result = factory->CreateInstance(nullptr, __uuidof(IThumbnailProvider),
                                                  reinterpret_cast<void**>(&provider));
  CHECK(SUCCEEDED(result) && provider != nullptr, "class factory did not create provider");
  return ComPtr<IThumbnailProvider>(provider);
}

void TestFactoryContract(DllGetClassObjectFn getClassObject,
                         DllCanUnloadNowFn canUnload) {
  CHECK(canUnload() == S_OK, "fresh DLL should be unloadable");
  CHECK(getClassObject(CLSID_VideoHelperThumbnail, IID_IClassFactory, nullptr) == E_POINTER,
        "DllGetClassObject did not reject a null output pointer");

  ComPtr<IClassFactory> factory;
  HRESULT result = getClassObject(CLSID_VideoHelperThumbnail, IID_IClassFactory,
                                  reinterpret_cast<void**>(factory.put()));
  CHECK(result == S_OK && factory, "DllGetClassObject failed for provider CLSID");
  CHECK(canUnload() == S_FALSE, "live class factory was not counted for unload");

  IUnknown* aggregated = nullptr;
  CHECK(factory->CreateInstance(reinterpret_cast<IUnknown*>(factory.get()),
                                __uuidof(IThumbnailProvider),
                                reinterpret_cast<void**>(&aggregated)) == CLASS_E_NOAGGREGATION,
        "class factory allowed aggregation");
  CHECK(aggregated == nullptr, "aggregation failure returned an object");

  CHECK(getClassObject(CLSID_VideoHelperThumbnail, IID_IUnknown, nullptr) == E_POINTER,
        "factory query did not validate its output pointer");
  GUID unknownClass = CLSID_VideoHelperThumbnail;
  unknownClass.Data1 ^= 0x100;
  void* unavailable = nullptr;
  CHECK(getClassObject(unknownClass, IID_IClassFactory, &unavailable) ==
            CLASS_E_CLASSNOTAVAILABLE && unavailable == nullptr,
        "DLL created a class factory for an unrelated CLSID");

  CHECK(factory->LockServer(TRUE) == S_OK && canUnload() == S_FALSE,
        "server lock did not prevent unload");
  CHECK(factory->LockServer(FALSE) == S_OK,
        "server unlock failed");
}

void TestRedCover(IClassFactory* factory, const std::wstring& redPath) {
  auto stream = MakeStream(redPath);
  auto provider = CreateProvider(factory);
  ComPtr<IInitializeWithStream> initializer;
  HRESULT result = provider->QueryInterface(IID_IInitializeWithStream,
                                             reinterpret_cast<void**>(initializer.put()));
  CHECK(result == S_OK && initializer, "provider did not expose IInitializeWithStream");

  HBITMAP bitmap = reinterpret_cast<HBITMAP>(static_cast<ULONG_PTR>(1));
  WTS_ALPHATYPE alpha = WTSAT_ARGB;
  result = provider->GetThumbnail(256, &bitmap, &alpha);
  CHECK(result == E_UNEXPECTED && bitmap == nullptr,
        "uninitialized provider returned success or retained an output bitmap");
  CHECK(initializer->Initialize(nullptr, STGM_READ) == E_POINTER,
        "Initialize did not reject a null IStream");
  CHECK(initializer->Initialize(stream.get(), STGM_READ) == S_OK,
        "Initialize failed for a valid IStream");
  CHECK(initializer->Initialize(stream.get(), STGM_READ) ==
            HRESULT_FROM_WIN32(ERROR_ALREADY_INITIALIZED),
        "repeated Initialize did not return an error");

  CHECK(provider->GetThumbnail(256, nullptr, &alpha) == E_POINTER,
        "GetThumbnail did not reject a null HBITMAP output");
  bitmap = reinterpret_cast<HBITMAP>(static_cast<ULONG_PTR>(1));
  CHECK(provider->GetThumbnail(256, &bitmap, nullptr) == E_POINTER && bitmap == nullptr,
        "GetThumbnail failed to clear HBITMAP when alpha output is null");
  bitmap = reinterpret_cast<HBITMAP>(static_cast<ULONG_PTR>(1));
  CHECK(provider->GetThumbnail(0, &bitmap, &alpha) == E_INVALIDARG && bitmap == nullptr,
        "GetThumbnail accepted cx=0 or left a stale bitmap");
  CHECK(provider->GetThumbnail(1025, &bitmap, &alpha) == E_INVALIDARG && bitmap == nullptr,
        "GetThumbnail accepted cx above 1024");

  for (UINT size : {256u, 256u, 1u, 1024u}) {
    bitmap = nullptr;
    alpha = WTSAT_UNKNOWN;
    result = provider->GetThumbnail(size, &bitmap, &alpha);
    CHECK(result == S_OK && bitmap != nullptr, "provider failed to decode C1 red cover");
    CHECK(alpha == WTSAT_RGB, "opaque JPEG cover was not identified as RGB");
    CheckDimensions(bitmap, size);
    CheckDominantColor(bitmap, true);
    CHECK(DeleteObject(bitmap) != FALSE, "caller could not release returned HBITMAP");
  }
}

void TestPngCoverAlpha(IClassFactory* factory) {
  const auto mp4 = MakeSyntheticMp4CoverForTest(MakeValidTransparentPng());
  auto stream = MakeStream(mp4);
  auto provider = CreateProvider(factory);
  ComPtr<IInitializeWithStream> initializer;
  CHECK(provider->QueryInterface(IID_IInitializeWithStream,
                                 reinterpret_cast<void**>(initializer.put())) == S_OK,
        "PNG provider did not expose IInitializeWithStream");
  CHECK(initializer->Initialize(stream.get(), STGM_READ) == S_OK,
        "could not initialize provider with a valid PNG covr atom");

  HBITMAP bitmap = nullptr;
  WTS_ALPHATYPE alpha = WTSAT_UNKNOWN;
  const HRESULT result = provider->GetThumbnail(16, &bitmap, &alpha);
  CHECK(result == S_OK && bitmap != nullptr,
        "WIC could not decode the valid transparent PNG covr payload");
  CHECK(alpha == WTSAT_ARGB,
        "provider did not report ARGB for a valid transparent PNG cover");
  DIBSECTION section{};
  CHECK(GetObjectW(bitmap, sizeof(section), &section) == sizeof(section),
        "PNG provider did not return a DIB section");
  const LONG width = section.dsBmih.biWidth;
  const LONG height = section.dsBmih.biHeight < 0 ? -section.dsBmih.biHeight : section.dsBmih.biHeight;
  CHECK(width > 0 && height > 0 && width <= 16 && height <= 16,
        "PNG thumbnail dimensions are invalid");
  CHECK(DeleteObject(bitmap) != FALSE, "caller could not release PNG thumbnail HBITMAP");
}

void TestVideoFallback(IClassFactory* factory, const std::wstring& bluePath,
                       const std::wstring& redPath) {
  {
    auto stream = MakeStream(bluePath);
    auto provider = CreateProvider(factory);
    ComPtr<IInitializeWithStream> initializer;
    CHECK(provider->QueryInterface(IID_IInitializeWithStream,
                                   reinterpret_cast<void**>(initializer.put())) == S_OK,
          "blue provider did not expose initialization interface");
    CHECK(initializer->Initialize(stream.get(), STGM_READ) == S_OK,
          "could not initialize blue video provider");
    HBITMAP bitmap = nullptr;
    WTS_ALPHATYPE alpha = WTSAT_UNKNOWN;
    const HRESULT result = provider->GetThumbnail(256, &bitmap, &alpha);
    CHECK(result == S_OK && bitmap != nullptr,
          "MF fallback failed for C1 video without covr");
    CHECK(alpha == WTSAT_RGB, "opaque decoded video frame should report RGB");
    CheckDimensions(bitmap, 256);
    CheckDominantColor(bitmap, false);
    DeleteObject(bitmap);
  }

  {
    auto bytes = ReadFile(redPath);
    const std::array<unsigned char, 4> covrType = {'c', 'o', 'v', 'r'};
    const auto covr = std::search(bytes.begin(), bytes.end(), covrType.begin(), covrType.end());
    CHECK(covr != bytes.end(), "could not locate C1 covr atom to corrupt");
    const std::array<unsigned char, 4> dataType = {'d', 'a', 't', 'a'};
    const auto data = std::search(covr + 4, bytes.end(), dataType.begin(), dataType.end());
    CHECK(data != bytes.end(), "could not locate C1 covr/data atom to corrupt");
    const std::size_t imageSignatureOffset =
        static_cast<std::size_t>(std::distance(bytes.begin(), data)) + 12;
    CHECK(imageSignatureOffset + 1 < bytes.size() &&
              bytes[imageSignatureOffset] == 0xff && bytes[imageSignatureOffset + 1] == 0xd8,
          "covr/data did not contain the expected JPEG signature");
    bytes[imageSignatureOffset] = 0;
    auto stream = MakeStream(bytes);
    auto provider = CreateProvider(factory);
    ComPtr<IInitializeWithStream> initializer;
    CHECK(provider->QueryInterface(IID_IInitializeWithStream,
                                   reinterpret_cast<void**>(initializer.put())) == S_OK,
          "damaged-cover provider did not expose initialization interface");
    CHECK(initializer->Initialize(stream.get(), STGM_READ) == S_OK,
          "could not initialize damaged-cover provider");
    HBITMAP bitmap = nullptr;
    WTS_ALPHATYPE alpha = WTSAT_UNKNOWN;
    const HRESULT result = provider->GetThumbnail(256, &bitmap, &alpha);
    CHECK(result == S_OK && bitmap != nullptr,
          "damaged covr did not fall back to the moving-video frame");
    CheckDimensions(bitmap, 256);
    CheckDominantColor(bitmap, false);
    DeleteObject(bitmap);
  }
}
}  // namespace

int main() {
  int argc = 0;
  wchar_t** argv = CommandLineToArgvW(GetCommandLineW(), &argc);
  if (!argv) {
    std::cerr << "CommandLineToArgvW failed\n";
    return 2;
  }
  if (argc != 4) {
    std::wcerr << L"Usage: thumbnail_tests <dll> <C1 red MP4> <C1 blue MP4>\n";
    LocalFree(argv);
    return 2;
  }

  const HRESULT comResult = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  if (FAILED(comResult)) {
    std::cerr << "CoInitializeEx failed: 0x" << std::hex << comResult << "\n";
    LocalFree(argv);
    return 1;
  }

  int exitCode = 0;
  HMODULE module = nullptr;
  try {
    RunMp4CoverTests(argv[2]);

    module = LoadLibraryW(argv[1]);
    CHECK(module != nullptr, "LoadLibraryW failed for built thumbnail DLL");
    auto getClassObject = ResolveExport<DllGetClassObjectFn>(module, "DllGetClassObject");
    auto canUnload = ResolveExport<DllCanUnloadNowFn>(module, "DllCanUnloadNow");
    CHECK(getClassObject != nullptr && canUnload != nullptr,
          "required COM DLL exports were missing");

    TestFactoryContract(getClassObject, canUnload);
    {
      ComPtr<IClassFactory> factory;
      CHECK(getClassObject(CLSID_VideoHelperThumbnail, IID_IClassFactory,
                           reinterpret_cast<void**>(factory.put())) == S_OK,
            "could not acquire test class factory");
      TestRedCover(factory.get(), argv[2]);
      TestPngCoverAlpha(factory.get());
      TestVideoFallback(factory.get(), argv[3], argv[2]);
    }
    CHECK(canUnload() == S_OK, "released provider/factory left DLL unload count busy");
    std::cout << "PASS: parser, COM factory/provider, WIC cover, MF fallback, refs/unload\n";
  } catch (const std::exception& error) {
    std::cerr << "FAIL: " << error.what() << "\n";
    exitCode = 1;
  }

  if (module) FreeLibrary(module);
  CoUninitialize();
  LocalFree(argv);
  return exitCode;
}
