#include "mp4_cover_test.h"

#include "com_ptr.h"
#include "mp4_cover.h"
#include "test_support.h"

#include <shlwapi.h>

#include <algorithm>
#include <array>
#include <cstdint>
#include <fstream>
#include <filesystem>
#include <iterator>
#include <sstream>
#include <limits>
#include <string_view>
#include <vector>

namespace {
void AppendU32(std::vector<unsigned char>& output, std::uint32_t value) {
  output.push_back(static_cast<unsigned char>((value >> 24) & 0xff));
  output.push_back(static_cast<unsigned char>((value >> 16) & 0xff));
  output.push_back(static_cast<unsigned char>((value >> 8) & 0xff));
  output.push_back(static_cast<unsigned char>(value & 0xff));
}

void AppendU64(std::vector<unsigned char>& output, std::uint64_t value) {
  AppendU32(output, static_cast<std::uint32_t>(value >> 32));
  AppendU32(output, static_cast<std::uint32_t>(value & 0xffffffffu));
}

std::vector<unsigned char> Atom(std::string_view type,
                                const std::vector<unsigned char>& payload,
                                bool extended = false, bool sizeZero = false) {
  CHECK(type.size() == 4, "synthetic atom type must be four bytes");
  std::vector<unsigned char> result;
  if (sizeZero) {
    AppendU32(result, 0);
    result.insert(result.end(), type.begin(), type.end());
    result.insert(result.end(), payload.begin(), payload.end());
    return result;
  }
  if (extended) {
    AppendU32(result, 1);
    result.insert(result.end(), type.begin(), type.end());
    AppendU64(result, static_cast<std::uint64_t>(payload.size()) + 16);
  } else {
    AppendU32(result, static_cast<std::uint32_t>(payload.size() + 8));
    result.insert(result.end(), type.begin(), type.end());
  }
  result.insert(result.end(), payload.begin(), payload.end());
  return result;
}

std::vector<unsigned char> CoverFile(const std::vector<unsigned char>& image,
                                     std::uint32_t dataType = 13,
                                     bool extendedCovr = false,
                                     bool zeroSizeMoov = false) {
  std::vector<unsigned char> dataPayload;
  AppendU32(dataPayload, dataType);
  AppendU32(dataPayload, 0);
  dataPayload.insert(dataPayload.end(), image.begin(), image.end());
  auto data = Atom("data", dataPayload);
  auto covr = Atom("covr", data, extendedCovr);
  auto ilst = Atom("ilst", covr);
  std::vector<unsigned char> metaPayload(4, 0);  // FullBox version and flags.
  metaPayload.insert(metaPayload.end(), ilst.begin(), ilst.end());
  auto meta = Atom("meta", metaPayload);
  auto udta = Atom("udta", meta);
  return Atom("moov", udta, false, zeroSizeMoov);
}

std::vector<unsigned char> ReadFile(const std::wstring& path) {
  std::ifstream input(std::filesystem::path(path), std::ios::binary);
  CHECK(input.good(), "could not open C1 red MP4 fixture");
  return std::vector<unsigned char>(std::istreambuf_iterator<char>(input),
                                    std::istreambuf_iterator<char>());
}

ComPtr<IStream> MakeStream(const std::vector<unsigned char>& bytes) {
  CHECK(bytes.size() <= std::numeric_limits<UINT>::max(), "test stream exceeds UINT");
  IStream* raw = SHCreateMemStream(bytes.data(), static_cast<UINT>(bytes.size()));
  CHECK(raw != nullptr, "SHCreateMemStream failed for parser test");
  return ComPtr<IStream>(raw);
}

HRESULT Parse(const std::vector<unsigned char>& bytes,
              std::vector<unsigned char>& image) {
  auto stream = MakeStream(bytes);
  return ReadMp4Cover(stream.get(), image);
}

void TestRealC1Fixture(const std::wstring& path) {
  auto streamBytes = ReadFile(path);
  auto stream = MakeStream(streamBytes);
  std::vector<unsigned char> image;
  const HRESULT parseResult = ReadMp4Cover(stream.get(), image);
  if (parseResult != S_OK) {
    std::ostringstream error;
    error << "C1 covr JPEG was not found; HRESULT=0x" << std::hex
          << static_cast<unsigned long>(parseResult);
    throw std::runtime_error(error.str());
  }
  CHECK(image.size() == 1604, "C1 covr payload size changed unexpectedly");
  CHECK(image.size() >= 2 && image[0] == 0xff && image[1] == 0xd8,
        "C1 cover payload is not JPEG data");

  LARGE_INTEGER end{};
  end.QuadPart = 0;
  CHECK(SUCCEEDED(stream->Seek(end, STREAM_SEEK_END, nullptr)),
        "could not move C1 test stream cursor");
  std::vector<unsigned char> repeated;
  CHECK(ReadMp4Cover(stream.get(), repeated) == S_OK && repeated == image,
        "parser depended on the prior IStream cursor position");
}

void TestSyntheticAtoms() {
  static constexpr unsigned char pngSignature[] = {0x89, 0x50, 0x4e, 0x47,
                                                    0x0d, 0x0a, 0x1a, 0x0a};
  std::vector<unsigned char> png(pngSignature, pngSignature + sizeof(pngSignature));
  png.push_back(0x42);
  std::vector<unsigned char> image;
  const auto extended = CoverFile(png, 14, true);
  CHECK(Parse(extended, image) == S_OK && image == png,
        "64-bit covr atom with PNG payload did not parse");

  const auto zeroSized = CoverFile({0xff, 0xd8, 0x11}, 13, false, true);
  CHECK(Parse(zeroSized, image) == S_OK && image.size() == 3,
        "size-zero final MP4 atom did not use its parent boundary");

  std::vector<unsigned char> noCoverPayload = {0, 0, 0, 0};
  const auto noCover = Atom("ftyp", noCoverPayload);
  CHECK(Parse(noCover, image) == S_FALSE && image.empty(),
        "valid MP4 without covr must return S_FALSE");
}

void TestMalformedAtoms() {
  std::vector<unsigned char> image;
  CHECK(Parse({0, 0, 0, 8, 'f', 't', 'y'}, image) != S_OK,
        "truncated top-level atom was accepted");

  std::vector<unsigned char> oversized = {0xff, 0xff, 0xff, 0xf0,
                                           'm', 'o', 'o', 'v'};
  CHECK(Parse(oversized, image) != S_OK, "out-of-parent atom length was accepted");

  std::vector<unsigned char> u64Overflow;
  AppendU32(u64Overflow, 1);
  u64Overflow.insert(u64Overflow.end(), {'m', 'o', 'o', 'v'});
  AppendU64(u64Overflow, std::numeric_limits<std::uint64_t>::max());
  CHECK(Parse(u64Overflow, image) != S_OK, "overflowing 64-bit atom length was accepted");

  const auto emptyData = CoverFile({}, 13);
  CHECK(FAILED(Parse(emptyData, image)), "empty covr/data payload was accepted");

  std::vector<unsigned char> tooLarge = {0xff, 0xd8};
  tooLarge.resize(16u * 1024u * 1024u + 1u, 0x41);
  CHECK(FAILED(Parse(CoverFile(tooLarge), image)), "cover larger than 16 MiB was accepted");

  const auto smallData = CoverFile({0xff, 0xd8}, 13);
  auto nested = smallData;
  for (int i = 0; i < 14; ++i) nested = Atom("udta", nested);
  CHECK(FAILED(Parse(nested, image)), "atom nesting deeper than 12 was accepted");

  const auto unknownImageType = CoverFile({0, 1, 2}, 13);
  CHECK(FAILED(Parse(unknownImageType, image)), "non-JPEG covr payload was accepted");
  CHECK(image.empty(), "failed parse retained partial image bytes");
}
}  // namespace

std::vector<unsigned char> MakeSyntheticMp4CoverForTest(const std::vector<unsigned char>& image) {
  return CoverFile(image, 14);
}

void RunMp4CoverTests(const std::wstring& redFixturePath) {
  TestRealC1Fixture(redFixturePath);
  TestSyntheticAtoms();
  TestMalformedAtoms();
}
