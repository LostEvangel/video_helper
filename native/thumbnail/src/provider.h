#pragma once

#include <thumbcache.h>
#include <shobjidl.h>

// Keep this value in sync with native/thumbnail/manifest.json. The manifest is
// the installer-facing source; this literal is the COM implementation's ID.
inline const CLSID CLSID_VideoHelperThumbnail = {
    0xc74c4f7e, 0xec39, 0x44e4, {0x9d, 0xaa, 0x78, 0xd6, 0x50, 0x93, 0x84, 0xeb}};

class ThumbnailProvider final : public IThumbnailProvider, public IInitializeWithStream {
 public:
  ThumbnailProvider() noexcept;
  ~ThumbnailProvider();

  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void** object) override;
  ULONG STDMETHODCALLTYPE AddRef() override;
  ULONG STDMETHODCALLTYPE Release() override;

  HRESULT STDMETHODCALLTYPE GetThumbnail(UINT cx, HBITMAP* bitmap,
                                          WTS_ALPHATYPE* alpha) override;
  HRESULT STDMETHODCALLTYPE Initialize(IStream* stream, DWORD mode) override;

 private:
  volatile LONG refs_ = 1;
  IStream* stream_ = nullptr;
  bool initialized_ = false;
  CRITICAL_SECTION streamLock_{};
};

void ModuleObjectAdded() noexcept;
void ModuleObjectRemoved() noexcept;
LONG ModuleObjectCount() noexcept;
