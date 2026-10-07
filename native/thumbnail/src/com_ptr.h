#pragma once

#include <unknwn.h>

template <typename T>
class ComPtr final {
 public:
  ComPtr() noexcept = default;
  explicit ComPtr(T* value) noexcept : value_(value) {}
  ~ComPtr() { reset(); }

  ComPtr(const ComPtr&) = delete;
  ComPtr& operator=(const ComPtr&) = delete;

  ComPtr(ComPtr&& other) noexcept : value_(other.detach()) {}
  ComPtr& operator=(ComPtr&& other) noexcept {
    if (this != &other) {
      reset(other.detach());
    }
    return *this;
  }

  T* get() const noexcept { return value_; }
  T* operator->() const noexcept { return value_; }
  explicit operator bool() const noexcept { return value_ != nullptr; }

  T** put() noexcept {
    reset();
    return &value_;
  }

  T* detach() noexcept {
    T* result = value_;
    value_ = nullptr;
    return result;
  }

  void reset(T* value = nullptr) noexcept {
    if (value_) value_->Release();
    value_ = value;
  }

 private:
  T* value_ = nullptr;
};
