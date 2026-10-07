#include "provider.h"

#include <atomic>
#include <new>

namespace {
std::atomic<long> g_serverLocks{0};

class ThumbnailClassFactory final : public IClassFactory {
 public:
  ThumbnailClassFactory() noexcept { ModuleObjectAdded(); }
  ~ThumbnailClassFactory() { ModuleObjectRemoved(); }

  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void** object) override {
    if (!object) return E_POINTER;
    *object = nullptr;
    if (iid != IID_IUnknown && iid != IID_IClassFactory) return E_NOINTERFACE;
    *object = static_cast<IClassFactory*>(this);
    AddRef();
    return S_OK;
  }

  ULONG STDMETHODCALLTYPE AddRef() override {
    return static_cast<ULONG>(InterlockedIncrement(&refs_));
  }

  ULONG STDMETHODCALLTYPE Release() override {
    const LONG remaining = InterlockedDecrement(&refs_);
    if (remaining == 0) delete this;
    return static_cast<ULONG>(remaining);
  }

  HRESULT STDMETHODCALLTYPE CreateInstance(IUnknown* outer, REFIID iid,
                                             void** object) override {
    if (!object) return E_POINTER;
    *object = nullptr;
    if (outer) return CLASS_E_NOAGGREGATION;

    auto* provider = new (std::nothrow) ThumbnailProvider();
    if (!provider) return E_OUTOFMEMORY;
    const HRESULT result = provider->QueryInterface(iid, object);
    provider->Release();
    return result;
  }

  HRESULT STDMETHODCALLTYPE LockServer(BOOL lock) override {
    if (lock) {
      g_serverLocks.fetch_add(1, std::memory_order_relaxed);
    } else {
      const long prior = g_serverLocks.fetch_sub(1, std::memory_order_relaxed);
      if (prior <= 0) {
        g_serverLocks.store(0, std::memory_order_relaxed);
        return E_UNEXPECTED;
      }
    }
    return S_OK;
  }

 private:
  volatile LONG refs_ = 1;
};
}  // namespace

extern "C" HRESULT __stdcall DllGetClassObject(REFCLSID clsid, REFIID iid,
                                                void** object) {
  if (!object) return E_POINTER;
  *object = nullptr;
  if (clsid != CLSID_VideoHelperThumbnail) return CLASS_E_CLASSNOTAVAILABLE;

  auto* factory = new (std::nothrow) ThumbnailClassFactory();
  if (!factory) return E_OUTOFMEMORY;
  const HRESULT result = factory->QueryInterface(iid, object);
  factory->Release();
  return result;
}

extern "C" HRESULT __stdcall DllCanUnloadNow() {
  return ModuleObjectCount() == 0 && g_serverLocks.load(std::memory_order_relaxed) == 0
      ? S_OK
      : S_FALSE;
}
