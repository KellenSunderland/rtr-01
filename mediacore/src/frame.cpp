#include <cstdlib>
#include <cstring>
#include <limits>

#include "internal.hpp"

namespace mediacore {

int32_t pixfmt_bpp(mc_pixfmt fmt) noexcept {
  switch (fmt) {
    case MC_PIXFMT_RGB8:
    case MC_PIXFMT_BGR8:
      return 3;
    case MC_PIXFMT_GRAY8:
      return 1;
  }
  return 0;
}

size_t checked_frame_bytes(int32_t w, int32_t h, mc_pixfmt fmt) {
  const int32_t bpp = pixfmt_bpp(fmt);
  if (bpp == 0) fail(MC_ERR_INVALID_ARG, "invalid pixel format");
  if (w <= 0 || h <= 0) fail(MC_ERR_INVALID_ARG, "frame dimensions must be positive");
  const uint64_t row = static_cast<uint64_t>(w) * static_cast<uint64_t>(bpp);
  if (row > static_cast<uint64_t>(std::numeric_limits<int32_t>::max()))
    fail(MC_ERR_INVALID_ARG, "row size overflows int32 stride");
  const uint64_t total = row * static_cast<uint64_t>(h);  // < 2^31 * 2^31, cannot wrap
  if (total > kMaxFrameBytes) fail(MC_ERR_INVALID_ARG, "frame too large");
  return static_cast<size_t>(total);
}

void validate_frame(const mc_frame* f, const char* what) {
  if (f == nullptr) fail(MC_ERR_INVALID_ARG, std::string(what) + ": null frame");
  const size_t bytes = checked_frame_bytes(f->width, f->height, f->fmt);
  (void)bytes;
  if (f->data == nullptr) fail(MC_ERR_INVALID_ARG, std::string(what) + ": null data");
  const int64_t row = static_cast<int64_t>(f->width) * pixfmt_bpp(f->fmt);
  if (f->stride < row) fail(MC_ERR_INVALID_ARG, std::string(what) + ": stride smaller than row");
}

void frame_alloc(int32_t w, int32_t h, mc_pixfmt fmt, mc_frame* out) {
  if (out == nullptr) fail(MC_ERR_INVALID_ARG, "null out frame");
  const size_t bytes = checked_frame_bytes(w, h, fmt);
  auto* data = static_cast<uint8_t*>(std::calloc(bytes, 1));
  if (data == nullptr) fail(MC_ERR_INTERNAL, "out of memory");
  *out = mc_frame{};
  out->data = data;
  out->width = w;
  out->height = h;
  out->stride = w * pixfmt_bpp(fmt);
  out->fmt = fmt;
}

void frame_free(mc_frame* f) noexcept {
  if (f == nullptr) return;
  std::free(f->data);
  *f = mc_frame{};
}

void frame_copy(const mc_frame* in, mc_frame* out) {
  validate_frame(in, "copy");
  if (out == nullptr) fail(MC_ERR_INVALID_ARG, "null out frame");
  const mc_frame meta = *in;
  mc_frame tmp;
  frame_alloc(meta.width, meta.height, meta.fmt, &tmp);
  const size_t row = static_cast<size_t>(meta.width) * static_cast<size_t>(pixfmt_bpp(meta.fmt));
  for (int32_t y = 0; y < meta.height; ++y)
    std::memcpy(tmp.data + static_cast<size_t>(y) * row,
                meta.data + static_cast<size_t>(y) * static_cast<size_t>(meta.stride), row);
  tmp.ts_ns = meta.ts_ns;
  tmp.wall_ns = meta.wall_ns;
  tmp.stream_id = meta.stream_id;
  tmp.seq = meta.seq;
  *out = tmp;
}

}  // namespace mediacore
