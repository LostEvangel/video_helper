#include "fallback.h"

#include "com_ptr.h"
#include "image.h"

#include <mfapi.h>
#include <mferror.h>
#include <mfidl.h>
#include <mfreadwrite.h>

#include <algorithm>
#include <cstdint>
#include <cstring>
#include <limits>
#include <new>
#include <vector>

// Present in the Windows SDK mfidl.h contract; some bundled MinGW header sets
// omit this declaration even though the Windows mfplat import library exports it.
extern "C" HRESULT WINAPI MFCreateMFByteStreamOnStream(IStream* stream,
                                                         IMFByteStream** byteStream);

namespace {
constexpr UINT kMaxDimension = 8192;
constexpr std::uint64_t kMaxPixels = 16ull * 1024ull * 1024ull;
constexpr DWORD kMaxVideoStreams = 64;
constexpr unsigned kMaxReadAttempts = 16;

bool SafeDimensions(UINT width, UINT height) noexcept {
  return width > 0 && height > 0 && width <= kMaxDimension &&
         height <= kMaxDimension &&
         static_cast<std::uint64_t>(width) * height <= kMaxPixels;
}

class MediaFoundationScope final {
 public:
  MediaFoundationScope() noexcept : result_(MFStartup(MF_VERSION, MFSTARTUP_LITE)) {}
  ~MediaFoundationScope() {
    if (SUCCEEDED(result_)) MFShutdown();
  }
  HRESULT result() const noexcept { return result_; }

 private:
  HRESULT result_;
};

HRESULT ReadSample(IMFSourceReader* reader, DWORD streamIndex,
                   IMFSample** sampleOut) noexcept {
  if (!reader || !sampleOut) return E_POINTER;
  *sampleOut = nullptr;

  for (unsigned attempt = 0; attempt < kMaxReadAttempts; ++attempt) {
    DWORD actualStream = 0;
    DWORD flags = 0;
    LONGLONG timestamp = 0;
    ComPtr<IMFSample> sample;
    HRESULT result = reader->ReadSample(streamIndex, 0, &actualStream, &flags,
                                        &timestamp, sample.put());
    if (FAILED(result)) return result;
    if (flags & MF_SOURCE_READERF_ENDOFSTREAM) return MF_E_END_OF_STREAM;
    if (flags & MF_SOURCE_READERF_ERROR) return E_FAIL;
    if (sample) {
      *sampleOut = sample.detach();
      return S_OK;
    }
  }
  return HRESULT_FROM_WIN32(ERROR_TIMEOUT);
}

HRESULT CopySampleBgra(IMFSample* sample, UINT width, UINT height,
                       LONG defaultStride, std::vector<unsigned char>& pixels) {
  if (!sample) return E_POINTER;
  if (!SafeDimensions(width, height)) return E_INVALIDARG;
  const std::uint64_t rowBytes64 = static_cast<std::uint64_t>(width) * 4;
  const std::uint64_t byteCount64 = rowBytes64 * height;
  if (rowBytes64 > std::numeric_limits<std::size_t>::max() ||
      byteCount64 > std::numeric_limits<std::size_t>::max()) {
    return E_INVALIDARG;
  }

  try {
    pixels.resize(static_cast<std::size_t>(byteCount64));
  } catch (const std::bad_alloc&) {
    return E_OUTOFMEMORY;
  } catch (...) {
    return E_FAIL;
  }

  ComPtr<IMFMediaBuffer> mediaBuffer;
  HRESULT result = sample->ConvertToContiguousBuffer(mediaBuffer.put());
  if (FAILED(result)) return result;

  ComPtr<IMF2DBuffer> twoDBuffer;
  result = mediaBuffer->QueryInterface(IID_IMF2DBuffer,
                                       reinterpret_cast<void**>(twoDBuffer.put()));
  const std::size_t rowBytes = static_cast<std::size_t>(rowBytes64);
  if (SUCCEEDED(result)) {
    BYTE* scanline0 = nullptr;
    LONG pitch = 0;
    result = twoDBuffer->Lock2D(&scanline0, &pitch);
    if (FAILED(result)) return result;
    const std::uint64_t pitchMagnitude = pitch < 0
        ? static_cast<std::uint64_t>(-static_cast<std::int64_t>(pitch))
        : static_cast<std::uint64_t>(pitch);
    if (!scanline0 || pitchMagnitude < rowBytes64) {
      twoDBuffer->Unlock2D();
      return E_FAIL;
    }
    for (UINT y = 0; y < height; ++y) {
      const auto* sourceRow = scanline0 + static_cast<std::int64_t>(y) * pitch;
      auto* targetRow = pixels.data() + static_cast<std::size_t>(y) * rowBytes;
      std::memcpy(targetRow, sourceRow, rowBytes);
    }
    result = twoDBuffer->Unlock2D();
    if (FAILED(result)) return result;
  } else {
    BYTE* data = nullptr;
    DWORD maxLength = 0;
    DWORD currentLength = 0;
    result = mediaBuffer->Lock(&data, &maxLength, &currentLength);
    if (FAILED(result)) return result;
    const LONG stride = defaultStride == 0
        ? static_cast<LONG>(rowBytes64)
        : defaultStride;
    const std::uint64_t strideMagnitude = stride < 0
        ? static_cast<std::uint64_t>(-static_cast<std::int64_t>(stride))
        : static_cast<std::uint64_t>(stride);
    const std::uint64_t neededBytes = strideMagnitude * height;
    if (!data || strideMagnitude < rowBytes64 || neededBytes > currentLength ||
        currentLength > maxLength) {
      mediaBuffer->Unlock();
      return E_FAIL;
    }
    for (UINT y = 0; y < height; ++y) {
      const UINT physicalRow = stride < 0 ? height - 1 - y : y;
      const auto* sourceRow = data + static_cast<std::size_t>(physicalRow) * strideMagnitude;
      auto* targetRow = pixels.data() + static_cast<std::size_t>(y) * rowBytes;
      std::memcpy(targetRow, sourceRow, rowBytes);
    }
    result = mediaBuffer->Unlock();
    if (FAILED(result)) return result;
  }

  const std::size_t pixelCount = static_cast<std::size_t>(width) * height;
  for (std::size_t i = 0; i < pixelCount; ++i) pixels[i * 4 + 3] = 0xff;
  return S_OK;
}

HRESULT ExtractFromReader(IMFSourceReader* reader, UINT cx, HBITMAP* bitmap,
                          WTS_ALPHATYPE* alpha) {
  if (!reader || !bitmap || !alpha) return E_POINTER;
  HRESULT result = reader->SetStreamSelection(MF_SOURCE_READER_ALL_STREAMS, FALSE);
  if (FAILED(result)) return result;

  for (DWORD streamIndex = 0; streamIndex < kMaxVideoStreams; ++streamIndex) {
    ComPtr<IMFMediaType> nativeType;
    result = reader->GetNativeMediaType(streamIndex, 0, nativeType.put());
    if (result == MF_E_INVALIDSTREAMNUMBER || result == MF_E_NO_MORE_TYPES) break;
    if (FAILED(result)) continue;

    GUID majorType{};
    result = nativeType->GetGUID(MF_MT_MAJOR_TYPE, &majorType);
    UINT64 nativeFrameSize = 0;
    nativeType->GetUINT64(MF_MT_FRAME_SIZE, &nativeFrameSize);
    if (FAILED(result) || majorType != MFMediaType_Video) continue;

    const UINT nativeWidth = static_cast<UINT>(nativeFrameSize >> 32);
    const UINT nativeHeight = static_cast<UINT>(nativeFrameSize & 0xffffffffu);
    if (!SafeDimensions(nativeWidth, nativeHeight)) continue;

    result = reader->SetStreamSelection(streamIndex, TRUE);
    if (FAILED(result)) continue;

    ComPtr<IMFMediaType> outputType;
    result = MFCreateMediaType(outputType.put());
    if (FAILED(result)) return result;
    result = outputType->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
    if (SUCCEEDED(result)) result = outputType->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_RGB32);
    if (SUCCEEDED(result)) {
      result = outputType->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
    }
    if (SUCCEEDED(result)) {
      result = reader->SetCurrentMediaType(streamIndex, nullptr, outputType.get());
    }
    if (FAILED(result)) {
      reader->SetStreamSelection(streamIndex, FALSE);
      continue;
    }

    ComPtr<IMFMediaType> currentType;
    result = reader->GetCurrentMediaType(streamIndex, currentType.put());
    if (FAILED(result)) {
      reader->SetStreamSelection(streamIndex, FALSE);
      continue;
    }
    UINT64 currentFrameSize = 0;
    if (FAILED(currentType->GetUINT64(MF_MT_FRAME_SIZE, &currentFrameSize))) {
      reader->SetStreamSelection(streamIndex, FALSE);
      continue;
    }
    const UINT width = static_cast<UINT>(currentFrameSize >> 32);
    const UINT height = static_cast<UINT>(currentFrameSize & 0xffffffffu);
    if (!SafeDimensions(width, height)) {
      reader->SetStreamSelection(streamIndex, FALSE);
      continue;
    }

    UINT32 strideBits = 0;
    LONG stride = 0;
    if (SUCCEEDED(currentType->GetUINT32(MF_MT_DEFAULT_STRIDE, &strideBits))) {
      stride = static_cast<LONG>(strideBits);
    }

    // A one-sample video stream is a still/attached-picture track. Require a
    // second sample before treating a stream as the moving-video fallback.
    ComPtr<IMFSample> firstSample;
    result = ReadSample(reader, streamIndex, firstSample.put());
    if (FAILED(result)) {
      reader->SetStreamSelection(streamIndex, FALSE);
      continue;
    }
    ComPtr<IMFSample> secondSample;
    result = ReadSample(reader, streamIndex, secondSample.put());
    if (FAILED(result)) {
      reader->SetStreamSelection(streamIndex, FALSE);
      continue;
    }

    std::vector<unsigned char> bgra;
    result = CopySampleBgra(firstSample.get(), width, height, stride, bgra);
    if (FAILED(result)) return result;
    return CreateScaledDibFromBgra(bgra.data(), width, height, cx, bitmap, alpha);
  }
  return MF_E_INVALIDMEDIATYPE;
}
}  // namespace

HRESULT ExtractVideoThumbnail(IStream* stream, UINT cx, HBITMAP* bitmap,
                               WTS_ALPHATYPE* alpha) {
  if (bitmap) *bitmap = nullptr;
  if (alpha) *alpha = WTSAT_UNKNOWN;
  if (!bitmap || !alpha) return E_POINTER;
  if (!stream) return E_POINTER;
  if (cx < 1 || cx > 1024) return E_INVALIDARG;

  LARGE_INTEGER start{};
  ULARGE_INTEGER actual{};
  HRESULT result = stream->Seek(start, STREAM_SEEK_SET, &actual);
  if (FAILED(result)) return result;
  if (actual.QuadPart != 0) return STG_E_INVALIDFUNCTION;

  MediaFoundationScope mf;
  if (FAILED(mf.result())) return mf.result();

  ComPtr<IMFByteStream> byteStream;
  result = MFCreateMFByteStreamOnStream(stream, byteStream.put());
  if (FAILED(result)) return result;

  ComPtr<IMFAttributes> attributes;
  result = MFCreateAttributes(attributes.put(), 1);
  if (FAILED(result)) return result;
  result = attributes->SetUINT32(MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING, TRUE);
  if (FAILED(result)) return result;

  ComPtr<IMFSourceReader> reader;
  result = MFCreateSourceReaderFromByteStream(byteStream.get(), attributes.get(),
                                               reader.put());
  if (FAILED(result)) return result;
  result = ExtractFromReader(reader.get(), cx, bitmap, alpha);
  if (FAILED(result)) {
    *bitmap = nullptr;
    *alpha = WTSAT_UNKNOWN;
  }
  return result;
}
