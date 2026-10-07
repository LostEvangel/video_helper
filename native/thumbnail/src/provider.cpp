#include "provider.h"

#include "fallback.h"
#include "image.h"
#include "mp4_cover.h"

#include <atomic>
#include <vector>

namespace {
std::atomic<long> g_moduleObjects{0};

class CriticalSectionLock final {
 public:
  explicit CriticalSectionLock(CRITICAL_SECTION* section) noexcept : section_(section) {
    EnterCriticalSection(section_);
  }
  ~CriticalSectionLock() { LeaveCriticalSection(section_); }
  CriticalSectionLock(const CriticalSectionLock&) = delete;
  CriticalSectionLock& operator=(const CriticalSectionLock&) = delete;

 private:
  CRITICAL_SECTION* section_;
};
}  // namespace

ThumbnailProvider::ThumbnailProvider() noexcept {
  InitializeCriticalSection(&streamLock_);
  ModuleObjectAdded();
}

ThumbnailProvider::~ThumbnailProvider() {
  if (stream_) stream_->Release();
  DeleteCriticalSection(&streamLock_);
  ModuleObjectRemoved();
}

HRESULT STDMETHODCALLTYPE ThumbnailProvider::QueryInterface(REFIID iid, void** object) {
  if (!object) return E_POINTER;
  *object = nullptr;

  if (iid == IID_IUnknown || iid == __uuidof(IThumbnailProvider)) {
    *object = static_cast<IThumbnailProvider*>(this);
  } else if (iid == IID_IInitializeWithStream) {
    *object = static_cast<IInitializeWithStream*>(this);
  } else {
    return E_NOINTERFACE;
  }
  AddRef();
  return S_OK;
}

ULONG STDMETHODCALLTYPE ThumbnailProvider::AddRef() {
  return static_cast<ULONG>(InterlockedIncrement(&refs_));
}

ULONG STDMETHODCALLTYPE ThumbnailProvider::Release() {
  const LONG remaining = InterlockedDecrement(&refs_);
  if (remaining == 0) delete this;
  return static_cast<ULONG>(remaining);
}

HRESULT STDMETHODCALLTYPE ThumbnailProvider::Initialize(IStream* stream, DWORD /*mode*/) {
  if (!stream) return E_POINTER;
  CriticalSectionLock lock(&streamLock_);
  if (initialized_) return HRESULT_FROM_WIN32(ERROR_ALREADY_INITIALIZED);
  stream->AddRef();
  stream_ = stream;
  initialized_ = true;
  return S_OK;
}

HRESULT STDMETHODCALLTYPE ThumbnailProvider::GetThumbnail(UINT cx, HBITMAP* bitmap,
                                                            WTS_ALPHATYPE* alpha) {
  if (bitmap) *bitmap = nullptr;
  if (alpha) *alpha = WTSAT_UNKNOWN;
  if (!bitmap || !alpha) return E_POINTER;
  if (cx < 1 || cx > 1024) return E_INVALIDARG;

  CriticalSectionLock lock(&streamLock_);
  if (!initialized_ || !stream_) return E_UNEXPECTED;

  std::vector<unsigned char> image;
  HRESULT result = ReadMp4Cover(stream_, image);
  if (result == S_OK) {
    result = DecodeCover(image, cx, bitmap, alpha);
    if (SUCCEEDED(result)) return result;
    *bitmap = nullptr;
    *alpha = WTSAT_UNKNOWN;
  }

  // Both the parser and the decoder use independent seeks. A corrupt cover
  // therefore leaves the original stream ready for the bounded video fallback.
  result = ExtractVideoThumbnail(stream_, cx, bitmap, alpha);
  if (FAILED(result)) {
    *bitmap = nullptr;
    *alpha = WTSAT_UNKNOWN;
  }
  return result;
}

void ModuleObjectAdded() noexcept { g_moduleObjects.fetch_add(1, std::memory_order_relaxed); }
void ModuleObjectRemoved() noexcept { g_moduleObjects.fetch_sub(1, std::memory_order_relaxed); }
LONG ModuleObjectCount() noexcept {
  return static_cast<LONG>(g_moduleObjects.load(std::memory_order_relaxed));
}
