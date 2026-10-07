#pragma once

#include <thumbcache.h>
#include <vector>

HRESULT DecodeCover(const std::vector<unsigned char>& image, UINT cx, HBITMAP* bitmap,
                    WTS_ALPHATYPE* alpha);

HRESULT CreateScaledDibFromBgra(const unsigned char* pixels, UINT width, UINT height,
                                UINT cx, HBITMAP* bitmap, WTS_ALPHATYPE* alpha);
