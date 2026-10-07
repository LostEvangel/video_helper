#pragma once

#include <thumbcache.h>

HRESULT ExtractVideoThumbnail(IStream* stream, UINT cx, HBITMAP* bitmap,
                              WTS_ALPHATYPE* alpha);
