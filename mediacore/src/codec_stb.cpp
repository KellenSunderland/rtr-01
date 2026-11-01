// JPEG/PNG/BMP codec via vendored stb (used when OpenCV is absent).
#include <cstdlib>
#include <cstring>
#include <limits>

#define STB_IMAGE_IMPLEMENTATION
#define STB_IMAGE_WRITE_IMPLEMENTATION
#define STBI_ONLY_JPEG
#define STBI_ONLY_PNG
#define STBI_ONLY_BMP
#define STBI_NO_STDIO
#define STBI_WRITE_NO_STDIO
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Weverything"
#include "stb_image.h"
#include "stb_image_write.h"
#pragma clang diagnostic pop

#include "internal.hpp"

namespace mediacore {

bool has_opencv() noexcept { return false; }

namespace {
void append(void* ctx, void* data, int size) {
  auto* v = static_cast<std::vector<uint8_t>*>(ctx);
  const auto* p = static_cast<const uint8_t*>(data);
  v->insert(v->end(), p, p + size);
}
}  // namespace

uint8_t* encode_jpeg(const mc_frame* in, int32_t quality, size_t* len) {
  validate_frame(in, "encode_jpeg");
  if (len == nullptr) fail(MC_ERR_INVALID_ARG, "null len");
  if (quality < 1 || quality > 100) fail(MC_ERR_INVALID_ARG, "quality must be 1..100");
  mc_frame packed;
  const bool gray = in->fmt == MC_PIXFMT_GRAY8;
  convert(in, gray ? MC_PIXFMT_GRAY8 : MC_PIXFMT_RGB8, &packed);
  std::vector<uint8_t> enc;
  const int ok = stbi_write_jpg_to_func(append, &enc, packed.width, packed.height, gray ? 1 : 3,
                                        packed.data, quality);
  frame_free(&packed);
  if (!ok || enc.empty()) fail(MC_ERR_INTERNAL, "jpeg encode failed");
  auto* p = static_cast<uint8_t*>(std::malloc(enc.size()));
  if (p == nullptr) fail(MC_ERR_INTERNAL, "out of memory");
  std::memcpy(p, enc.data(), enc.size());
  *len = enc.size();
  return p;
}

void decode_image(const uint8_t* buf, size_t len, mc_frame* out) {
  if (buf == nullptr || len == 0 || out == nullptr) fail(MC_ERR_INVALID_ARG, "bad decode args");
  if (len > static_cast<size_t>(std::numeric_limits<int>::max()))
    fail(MC_ERR_INVALID_ARG, "buffer too large");
  int w = 0, h = 0, n = 0;
  uint8_t* px = stbi_load_from_memory(buf, static_cast<int>(len), &w, &h, &n, 3);
  if (px == nullptr) fail(MC_ERR_INVALID_ARG, "undecodable image data");
  mc_frame rgb{};
  try {
    (void)checked_frame_bytes(w, h, MC_PIXFMT_RGB8);
    rgb.data = px;
    rgb.width = w;
    rgb.height = h;
    rgb.stride = w * 3;
    rgb.fmt = MC_PIXFMT_RGB8;
    convert(&rgb, MC_PIXFMT_BGR8, out);
  } catch (...) {
    stbi_image_free(px);
    throw;
  }
  stbi_image_free(px);
}

}  // namespace mediacore
