#include "image.h"

#include "com_ptr.h"

#include <algorithm>
#include <cstdint>
#include <limits>
#include <shlwapi.h>
#include <wincodec.h>

namespace {
constexpr std::uint64_t kMaxImagePixels = 16ull * 1024ull * 1024ull;
constexpr UINT kMaxImageDimension = 8192;
constexpr std::uint64_t kMaxEncodedImageBytes = 16ull * 1024ull * 1024ull;

bool SafeDimensions(UINT width, UINT height) noexcept {
  return width > 0 && height > 0 && width <= kMaxImageDimension &&
         height <= kMaxImageDimension &&
         static_cast<std::uint64_t>(width) * height <= kMaxImagePixels;
}

void ScaledDimensions(UINT width, UINT height, UINT cx, UINT* scaledWidth,
                      UINT* scaledHeight) noexcept {
  *scaledWidth = width;
  *scaledHeight = height;
  if (width <= cx && height <= cx) return;

  if (width >= height) {
    *scaledWidth = cx;
    *scaledHeight = std::max<UINT>(1, static_cast<UINT>(
        (static_cast<std::uint64_t>(height) * cx + width / 2) / width));
  } else {
    *scaledHeight = cx;
    *scaledWidth = std::max<UINT>(1, static_cast<UINT>(
        (static_cast<std::uint64_t>(width) * cx + height / 2) / height));
  }
}

HRESULT CreateWicFactory(IWICImagingFactory** factory) noexcept {
  if (!factory) return E_POINTER;
  *factory = nullptr;
  return CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER,
                         IID_IWICImagingFactory,
                         reinterpret_cast<void**>(factory));
}

HRESULT CreateTopDownDib(UINT width, UINT height, HBITMAP* bitmap,
                         unsigned char** pixels) noexcept {
  if (!bitmap || !pixels) return E_POINTER;
  *bitmap = nullptr;
  *pixels = nullptr;

  BITMAPINFO info{};
  info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  info.bmiHeader.biWidth = static_cast<LONG>(width);
  info.bmiHeader.biHeight = -static_cast<LONG>(height);
  info.bmiHeader.biPlanes = 1;
  info.bmiHeader.biBitCount = 32;
  info.bmiHeader.biCompression = BI_RGB;
  void* dibPixels = nullptr;
  HBITMAP dib = CreateDIBSection(nullptr, &info, DIB_RGB_COLORS, &dibPixels,
                                 nullptr, 0);
  if (!dib || !dibPixels) {
    if (dib) DeleteObject(dib);
    const DWORD error = GetLastError();
    return error == ERROR_SUCCESS ? E_FAIL : HRESULT_FROM_WIN32(error);
  }
  *bitmap = dib;
  *pixels = static_cast<unsigned char*>(dibPixels);
  return S_OK;
}

HRESULT CopyScaledBgra(IWICImagingFactory* factory, IWICBitmapSource* source,
                       UINT sourceWidth, UINT sourceHeight, UINT cx,
                       bool hasAlpha, HBITMAP* bitmap,
                       WTS_ALPHATYPE* alpha) {
  if (!factory || !source || !bitmap || !alpha) return E_POINTER;
  *bitmap = nullptr;
  *alpha = WTSAT_UNKNOWN;
  if (cx < 1 || cx > 1024 || !SafeDimensions(sourceWidth, sourceHeight)) {
    return E_INVALIDARG;
  }

  UINT outputWidth = 0;
  UINT outputHeight = 0;
  ScaledDimensions(sourceWidth, sourceHeight, cx, &outputWidth, &outputHeight);

  ComPtr<IWICBitmapScaler> scaler;
  HRESULT result = factory->CreateBitmapScaler(scaler.put());
  if (FAILED(result)) return result;
  result = scaler->Initialize(source, outputWidth, outputHeight,
                              WICBitmapInterpolationModeFant);
  if (FAILED(result)) return result;

  ComPtr<IWICFormatConverter> converter;
  result = factory->CreateFormatConverter(converter.put());
  if (FAILED(result)) return result;
  result = converter->Initialize(scaler.get(), GUID_WICPixelFormat32bppBGRA,
                                 WICBitmapDitherTypeNone, nullptr, 0.0,
                                 WICBitmapPaletteTypeCustom);
  if (FAILED(result)) return result;

  unsigned char* dibPixels = nullptr;
  result = CreateTopDownDib(outputWidth, outputHeight, bitmap, &dibPixels);
  if (FAILED(result)) return result;

  const std::uint64_t stride64 = static_cast<std::uint64_t>(outputWidth) * 4;
  const std::uint64_t bufferSize64 = stride64 * outputHeight;
  if (stride64 > std::numeric_limits<UINT>::max() ||
      bufferSize64 > std::numeric_limits<UINT>::max()) {
    DeleteObject(*bitmap);
    *bitmap = nullptr;
    return E_INVALIDARG;
  }
  result = converter->CopyPixels(nullptr, static_cast<UINT>(stride64),
                                 static_cast<UINT>(bufferSize64), dibPixels);
  if (FAILED(result)) {
    DeleteObject(*bitmap);
    *bitmap = nullptr;
    return result;
  }

  if (!hasAlpha) {
    const std::size_t pixelCount = static_cast<std::size_t>(outputWidth) * outputHeight;
    for (std::size_t i = 0; i < pixelCount; ++i) dibPixels[i * 4 + 3] = 0xff;
  }
  *alpha = hasAlpha ? WTSAT_ARGB : WTSAT_RGB;
  return S_OK;
}

bool PixelFormatHasTransparency(IWICImagingFactory* factory,
                                REFWICPixelFormatGUID pixelFormat) noexcept {
  ComPtr<IWICComponentInfo> component;
  if (FAILED(factory->CreateComponentInfo(pixelFormat, component.put()))) return true;
  ComPtr<IWICPixelFormatInfo2> formatInfo;
  if (FAILED(component->QueryInterface(IID_IWICPixelFormatInfo2,
                                       reinterpret_cast<void**>(formatInfo.put())))) {
    return true;
  }
  BOOL supportsTransparency = TRUE;
  if (FAILED(formatInfo->SupportsTransparency(&supportsTransparency))) return true;
  return supportsTransparency != FALSE;
}
}  // namespace

HRESULT DecodeCover(const std::vector<unsigned char>& image, UINT cx,
                    HBITMAP* bitmap, WTS_ALPHATYPE* alpha) {
  if (bitmap) *bitmap = nullptr;
  if (alpha) *alpha = WTSAT_UNKNOWN;
  if (!bitmap || !alpha) return E_POINTER;
  if (image.empty() || image.size() > kMaxEncodedImageBytes || cx < 1 || cx > 1024) {
    return E_INVALIDARG;
  }
  if (image.size() > std::numeric_limits<UINT>::max()) return E_INVALIDARG;

  ComPtr<IWICImagingFactory> factory;
  HRESULT result = CreateWicFactory(factory.put());
  if (FAILED(result)) return result;

  ComPtr<IStream> memoryStream(SHCreateMemStream(
      image.data(), static_cast<UINT>(image.size())));
  if (!memoryStream) return E_OUTOFMEMORY;

  ComPtr<IWICBitmapDecoder> decoder;
  result = factory->CreateDecoderFromStream(memoryStream.get(), nullptr,
                                            WICDecodeMetadataCacheOnDemand,
                                            decoder.put());
  if (FAILED(result)) return result;

  ComPtr<IWICBitmapFrameDecode> frame;
  result = decoder->GetFrame(0, frame.put());
  if (FAILED(result)) return result;

  UINT width = 0;
  UINT height = 0;
  result = frame->GetSize(&width, &height);
  if (FAILED(result)) return result;
  if (!SafeDimensions(width, height)) return E_INVALIDARG;

  WICPixelFormatGUID pixelFormat{};
  result = frame->GetPixelFormat(&pixelFormat);
  if (FAILED(result)) return result;
  const bool hasAlpha = PixelFormatHasTransparency(factory.get(), pixelFormat);
  return CopyScaledBgra(factory.get(), frame.get(), width, height, cx, hasAlpha,
                        bitmap, alpha);
}

HRESULT CreateScaledDibFromBgra(const unsigned char* pixels, UINT width,
                                UINT height, UINT cx, HBITMAP* bitmap,
                                WTS_ALPHATYPE* alpha) {
  if (bitmap) *bitmap = nullptr;
  if (alpha) *alpha = WTSAT_UNKNOWN;
  if (!bitmap || !alpha) return E_POINTER;
  if (!pixels || cx < 1 || cx > 1024 || !SafeDimensions(width, height)) {
    return E_INVALIDARG;
  }
  const std::uint64_t stride = static_cast<std::uint64_t>(width) * 4;
  const std::uint64_t byteCount = stride * height;
  if (stride > std::numeric_limits<UINT>::max() ||
      byteCount > std::numeric_limits<UINT>::max()) {
    return E_INVALIDARG;
  }

  ComPtr<IWICImagingFactory> factory;
  HRESULT result = CreateWicFactory(factory.put());
  if (FAILED(result)) return result;

  ComPtr<IWICBitmap> source;
  result = factory->CreateBitmapFromMemory(width, height,
                                           GUID_WICPixelFormat32bppBGRA,
                                           static_cast<UINT>(stride),
                                           static_cast<UINT>(byteCount),
                                           const_cast<BYTE*>(pixels), source.put());
  if (FAILED(result)) return result;
  return CopyScaledBgra(factory.get(), source.get(), width, height, cx, false,
                        bitmap, alpha);
}
