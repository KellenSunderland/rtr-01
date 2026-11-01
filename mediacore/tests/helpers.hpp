#pragma once
#include <gtest/gtest.h>

#include <cmath>
#include <cstdint>
#include <cstring>
#include <vector>

#include "mediacore_c.h"

namespace testutil {

struct Frame {
  mc_frame f{};
  Frame() = default;
  Frame(int32_t w, int32_t h, mc_pixfmt fmt) {
    EXPECT_EQ(mc_frame_alloc(w, h, fmt, &f), MC_OK);
  }
  Frame(const Frame&) = delete;
  Frame& operator=(const Frame&) = delete;
  Frame(Frame&& o) noexcept : f(o.f) { o.f = mc_frame{}; }
  Frame& operator=(Frame&& o) noexcept {
    if (this != &o) {
      mc_frame_free(&f);
      f = o.f;
      o.f = mc_frame{};
    }
    return *this;
  }
  ~Frame() { mc_frame_free(&f); }
  mc_frame* get() { return &f; }
  void fill(uint8_t v) { std::memset(f.data, v, static_cast<size_t>(f.stride) * static_cast<size_t>(f.height)); }
  uint8_t* px(int x, int y) {
    return f.data + static_cast<size_t>(y) * static_cast<size_t>(f.stride) +
           static_cast<size_t>(x) * static_cast<size_t>(mc_pixfmt_bpp(f.fmt));
  }
};

// Smooth diagonal gradient (JPEG friendly).
inline Frame gradient(int32_t w, int32_t h, mc_pixfmt fmt = MC_PIXFMT_BGR8, bool invert = false) {
  Frame fr(w, h, fmt);
  const int bpp = mc_pixfmt_bpp(fmt);
  for (int y = 0; y < h; ++y)
    for (int x = 0; x < w; ++x) {
      int v = (x + y) * 255 / (w + h - 2);
      if (invert) v = 255 - v;
      for (int c = 0; c < bpp; ++c) fr.px(x, y)[c] = static_cast<uint8_t>(v);
    }
  return fr;
}

inline std::vector<int16_t> sine(double hz, int rate, size_t n, double amp = 8000.0) {
  std::vector<int16_t> v(n);
  for (size_t i = 0; i < n; ++i)
    v[i] = static_cast<int16_t>(
        std::lround(amp * std::sin(2.0 * M_PI * hz * static_cast<double>(i) / rate)));
  return v;
}

}  // namespace testutil
