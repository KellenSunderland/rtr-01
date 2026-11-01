#include <algorithm>
#include <cmath>
#include <limits>

#include "internal.hpp"

namespace mediacore {

namespace {
int16_t sat16(int64_t v) {
  return static_cast<int16_t>(std::clamp<int64_t>(v, INT16_MIN, INT16_MAX));
}
}  // namespace

size_t resample_required(size_t n_in, int32_t in_rate, int32_t out_rate) {
  if (in_rate <= 0 || out_rate <= 0) fail(MC_ERR_INVALID_ARG, "sample rates must be positive");
  const unsigned __int128 num = static_cast<unsigned __int128>(n_in) * static_cast<uint32_t>(out_rate);
  const unsigned __int128 r = (num + static_cast<uint32_t>(in_rate) - 1) / static_cast<uint32_t>(in_rate);
  if (r > std::numeric_limits<size_t>::max()) fail(MC_ERR_INVALID_ARG, "resample size overflow");
  return static_cast<size_t>(r);
}

size_t resample_pcm16(const int16_t* in, size_t n_in, int32_t in_rate, int32_t out_rate,
                      int16_t* out, size_t cap) {
  const size_t need = resample_required(n_in, in_rate, out_rate);
  if (need > cap) fail(MC_ERR_FULL, "output buffer too small");
  if (need == 0) return 0;
  if (in == nullptr || out == nullptr) fail(MC_ERR_INVALID_ARG, "null buffer");
  const uint64_t ir = static_cast<uint64_t>(in_rate);
  const uint64_t orr = static_cast<uint64_t>(out_rate);
  for (size_t i = 0; i < need; ++i) {
    const unsigned __int128 pos = static_cast<unsigned __int128>(i) * ir;
    const size_t idx = static_cast<size_t>(pos / orr);
    const double frac = static_cast<double>(static_cast<uint64_t>(pos % orr)) / static_cast<double>(orr);
    const double a = in[idx];
    const double b = in[std::min(idx + 1, n_in - 1)];
    out[i] = sat16(std::llround(a + (b - a) * frac));
  }
  return need;
}

void mix_pcm16(const int16_t* a, const int16_t* b, size_t n, int16_t* out) {
  if (n == 0) return;
  if (a == nullptr || b == nullptr || out == nullptr) fail(MC_ERR_INVALID_ARG, "null buffer");
  for (size_t i = 0; i < n; ++i) out[i] = sat16(static_cast<int64_t>(a[i]) + b[i]);
}

void gain_pcm16(int16_t* s, size_t n, float gain) {
  if (!std::isfinite(gain)) fail(MC_ERR_INVALID_ARG, "gain must be finite");
  if (n == 0) return;
  if (s == nullptr) fail(MC_ERR_INVALID_ARG, "null buffer");
  const double g = static_cast<double>(gain);
  for (size_t i = 0; i < n; ++i) {
    const double v = std::round(static_cast<double>(s[i]) * g);
    s[i] = static_cast<int16_t>(std::clamp(v, -32768.0, 32767.0));
  }
}

double rms_dbfs(const int16_t* s, size_t n) {
  if (n == 0) return -120.0;
  if (s == nullptr) fail(MC_ERR_INVALID_ARG, "null buffer");
  double acc = 0.0;
  for (size_t i = 0; i < n; ++i) acc += static_cast<double>(s[i]) * static_cast<double>(s[i]);
  const double rms = std::sqrt(acc / static_cast<double>(n)) / 32768.0;
  if (rms <= 0.0) return -120.0;
  return std::max(-120.0, 20.0 * std::log10(rms));
}

}  // namespace mediacore
