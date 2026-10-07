#pragma once

#include <objidl.h>
#include <vector>

HRESULT ReadMp4Cover(IStream* stream, std::vector<unsigned char>& image);
