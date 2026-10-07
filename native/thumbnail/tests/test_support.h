#pragma once

#include <stdexcept>
#include <string>

inline void Check(bool condition, const std::string& message) {
  if (!condition) throw std::runtime_error(message);
}

#define CHECK(condition, message) Check((condition), (message))
