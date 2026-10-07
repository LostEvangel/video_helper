#include "mp4_cover.h"

#include <algorithm>
#include <array>
#include <cstdint>
#include <cstring>
#include <limits>
#include <new>
#include <string_view>

namespace {

constexpr std::uint64_t kMaxCoverBytes = 16ull * 1024ull * 1024ull;
constexpr unsigned kMaxDepth = 12;
constexpr std::uint64_t kMaxAtoms = 100000;

HRESULT BadFormat() noexcept { return HRESULT_FROM_WIN32(ERROR_BAD_FORMAT); }

std::uint32_t ReadU32Be(const unsigned char* data) noexcept {
  return (static_cast<std::uint32_t>(data[0]) << 24) |
         (static_cast<std::uint32_t>(data[1]) << 16) |
         (static_cast<std::uint32_t>(data[2]) << 8) |
         static_cast<std::uint32_t>(data[3]);
}

std::uint64_t ReadU64Be(const unsigned char* data) noexcept {
  return (static_cast<std::uint64_t>(ReadU32Be(data)) << 32) |
         ReadU32Be(data + 4);
}

HRESULT ReadAt(IStream* stream, std::uint64_t offset, void* destination,
               ULONG bytes) noexcept {
  if (offset > static_cast<std::uint64_t>(std::numeric_limits<LONGLONG>::max())) {
    return BadFormat();
  }
  LARGE_INTEGER position{};
  position.QuadPart = static_cast<LONGLONG>(offset);
  ULARGE_INTEGER actual{};
  HRESULT result = stream->Seek(position, STREAM_SEEK_SET, &actual);
  if (FAILED(result)) return result;
  if (actual.QuadPart != offset) return BadFormat();

  ULONG received = 0;
  result = stream->Read(destination, bytes, &received);
  if (FAILED(result)) return result;
  return received == bytes ? S_OK : BadFormat();
}

bool IsContainer(std::string_view type) noexcept {
  constexpr std::array<std::string_view, 21> containers = {
      "moov", "trak", "mdia", "minf", "stbl", "edts", "dinf", "udta", "meta",
      "ilst", "mvex", "moof", "traf", "mfra", "tref", "sinf", "schi", "wave",
      "ipro", "meco", "mere"};
  return std::find(containers.begin(), containers.end(), type) != containers.end();
}

class AtomParser final {
 public:
  AtomParser(IStream* stream, std::uint64_t fileSize) noexcept
      : stream_(stream), fileSize_(fileSize) {}

  HRESULT Parse(std::vector<unsigned char>& image) {
    image_ = &image;
    return ParseRange(0, fileSize_, 0, false);
  }

 private:
  HRESULT ParseRange(std::uint64_t rangeStart, std::uint64_t rangeEnd,
                     unsigned depth, bool insideCovr) {
    if (depth > kMaxDepth) return BadFormat();
    if (rangeStart > rangeEnd || rangeEnd > fileSize_) return BadFormat();

    std::uint64_t offset = rangeStart;
    while (offset < rangeEnd) {
      if (rangeEnd - offset < 8 || ++atomCount_ > kMaxAtoms) return BadFormat();

      std::array<unsigned char, 16> header{};
      HRESULT result = ReadAt(stream_, offset, header.data(), 8);
      if (FAILED(result)) return result;

      const std::uint32_t shortSize = ReadU32Be(header.data());
      const std::string_view type(reinterpret_cast<const char*>(header.data() + 4), 4);
      std::uint64_t atomSize = shortSize;
      std::uint64_t headerSize = 8;
      if (shortSize == 1) {
        if (rangeEnd - offset < 16) return BadFormat();
        result = ReadAt(stream_, offset + 8, header.data() + 8, 8);
        if (FAILED(result)) return result;
        atomSize = ReadU64Be(header.data() + 8);
        headerSize = 16;
      } else if (shortSize == 0) {
        atomSize = rangeEnd - offset;
      }

      if (atomSize < headerSize || atomSize > rangeEnd - offset) return BadFormat();
      const std::uint64_t payloadStart = offset + headerSize;
      const std::uint64_t atomEnd = offset + atomSize;

      if (type == "data" && insideCovr) {
        return ReadCoverData(payloadStart, atomEnd);
      }

      if (type == "covr") {
        result = ParseRange(payloadStart, atomEnd, depth + 1, true);
        if (result == S_FALSE) return BadFormat();
        return result;
      }

      if (IsContainer(type)) {
        std::uint64_t childrenStart = payloadStart;
        if (type == "meta") {
          if (atomEnd - childrenStart < 4) return BadFormat();
          childrenStart += 4;  // FullBox version and flags.
        }
        result = ParseRange(childrenStart, atomEnd, depth + 1, insideCovr);
        if (result != S_FALSE) return result;
      }

      if (atomEnd <= offset) return BadFormat();
      offset = atomEnd;
    }
    return S_FALSE;
  }

  HRESULT ReadCoverData(std::uint64_t payloadStart, std::uint64_t atomEnd) {
    if (atomEnd < payloadStart || atomEnd - payloadStart < 8) return BadFormat();
    std::array<unsigned char, 8> metadata{};
    HRESULT result = ReadAt(stream_, payloadStart, metadata.data(),
                            static_cast<ULONG>(metadata.size()));
    if (FAILED(result)) return result;

    const std::uint32_t dataType = ReadU32Be(metadata.data());
    const std::uint64_t imageStart = payloadStart + metadata.size();
    const std::uint64_t imageSize = atomEnd - imageStart;
    if (imageSize == 0 || imageSize > kMaxCoverBytes) return BadFormat();
    if (dataType != 13 && dataType != 14) return BadFormat();

    const std::size_t signatureSize = dataType == 13 ? 2u : 8u;
    if (imageSize < signatureSize) return BadFormat();
    std::array<unsigned char, 8> signature{};
    result = ReadAt(stream_, imageStart, signature.data(),
                    static_cast<ULONG>(signatureSize));
    if (FAILED(result)) return result;

    static constexpr unsigned char kJpegSignature[] = {0xff, 0xd8};
    static constexpr unsigned char kPngSignature[] = {0x89, 0x50, 0x4e, 0x47,
                                                       0x0d, 0x0a, 0x1a, 0x0a};
    const bool signatureMatches = dataType == 13
        ? std::memcmp(signature.data(), kJpegSignature, sizeof(kJpegSignature)) == 0
        : std::memcmp(signature.data(), kPngSignature, sizeof(kPngSignature)) == 0;
    if (!signatureMatches) return BadFormat();

    try {
      image_->resize(static_cast<std::size_t>(imageSize));
    } catch (const std::bad_alloc&) {
      return E_OUTOFMEMORY;
    } catch (...) {
      return E_FAIL;
    }
    return ReadAt(stream_, imageStart, image_->data(),
                  static_cast<ULONG>(image_->size()));
  }

  IStream* stream_;
  std::uint64_t fileSize_;
  std::uint64_t atomCount_ = 0;
  std::vector<unsigned char>* image_ = nullptr;
};

}  // namespace

HRESULT ReadMp4Cover(IStream* stream, std::vector<unsigned char>& image) {
  image.clear();
  if (!stream) return E_POINTER;

  STATSTG stat{};
  HRESULT result = stream->Stat(&stat, STATFLAG_NONAME);
  if (FAILED(result)) return result;
  const std::uint64_t fileSize = stat.cbSize.QuadPart;
  if (fileSize < 8 || fileSize > static_cast<std::uint64_t>(std::numeric_limits<LONGLONG>::max())) {
    return BadFormat();
  }

  LARGE_INTEGER start{};
  ULARGE_INTEGER actual{};
  result = stream->Seek(start, STREAM_SEEK_SET, &actual);
  if (FAILED(result)) return result;
  if (actual.QuadPart != 0) return BadFormat();

  try {
    AtomParser parser(stream, fileSize);
    result = parser.Parse(image);
  } catch (const std::bad_alloc&) {
    image.clear();
    return E_OUTOFMEMORY;
  } catch (...) {
    image.clear();
    return E_FAIL;
  }
  if (result != S_OK) image.clear();
  return result;
}
