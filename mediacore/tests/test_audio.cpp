#include <thread>

#include "helpers.hpp"

using testutil::sine;

TEST(AudioRing, PushPopOrderAndWrap) {
  mc_audio_ring* r = nullptr;
  ASSERT_EQ(mc_audio_ring_create(16000, 1, 4, &r), MC_OK);
  int16_t in1[3] = {1, 2, 3};
  ASSERT_EQ(mc_audio_ring_push(r, in1, 3), MC_OK);
  int16_t out[8] = {};
  size_t got = 99;
  ASSERT_EQ(mc_audio_ring_pop(r, out, 2, &got), MC_OK);
  EXPECT_EQ(got, 2u);
  EXPECT_EQ(out[0], 1);
  EXPECT_EQ(out[1], 2);
  int16_t in2[3] = {4, 5, 6};  // wraps the physical buffer
  ASSERT_EQ(mc_audio_ring_push(r, in2, 3), MC_OK);
  EXPECT_EQ(mc_audio_ring_available(r), 4u);
  EXPECT_EQ(mc_audio_ring_dropped(r), 0u);
  ASSERT_EQ(mc_audio_ring_pop(r, out, 8, &got), MC_OK);
  EXPECT_EQ(got, 4u);
  EXPECT_EQ((std::vector<int16_t>(out, out + 4)), (std::vector<int16_t>{3, 4, 5, 6}));
  ASSERT_EQ(mc_audio_ring_pop(r, out, 8, &got), MC_OK);
  EXPECT_EQ(got, 0u);
  mc_audio_ring_destroy(r);
}

TEST(AudioRing, OverwriteOldestAndCountDrops) {
  mc_audio_ring* r = nullptr;
  ASSERT_EQ(mc_audio_ring_create(16000, 1, 4, &r), MC_OK);
  int16_t a[3] = {1, 2, 3}, b[3] = {4, 5, 6};
  mc_audio_ring_push(r, a, 3);
  mc_audio_ring_push(r, b, 3);  // 6 > 4: oldest two dropped
  EXPECT_EQ(mc_audio_ring_dropped(r), 2u);
  int16_t big[10] = {10, 11, 12, 13, 14, 15, 16, 17, 18, 19};
  mc_audio_ring_push(r, big, 10);  // larger than capacity: keeps last 4, drops 4 buffered + 6
  EXPECT_EQ(mc_audio_ring_dropped(r), 2u + 4u + 6u);
  int16_t out[4];
  size_t got = 0;
  ASSERT_EQ(mc_audio_ring_pop(r, out, 4, &got), MC_OK);
  EXPECT_EQ(got, 4u);
  EXPECT_EQ((std::vector<int16_t>(out, out + 4)), (std::vector<int16_t>{16, 17, 18, 19}));
  mc_audio_ring_push(r, a, 3);
  mc_audio_ring_clear(r);
  EXPECT_EQ(mc_audio_ring_available(r), 0u);
  mc_audio_ring_destroy(r);
}

TEST(AudioRing, MultiChannelFramesAndValidation) {
  mc_audio_ring* r = nullptr;
  ASSERT_EQ(mc_audio_ring_create(48000, 2, 2, &r), MC_OK);
  int16_t in[6] = {1, -1, 2, -2, 3, -3};
  ASSERT_EQ(mc_audio_ring_push(r, in, 3), MC_OK);
  EXPECT_EQ(mc_audio_ring_dropped(r), 1u);
  int16_t out[4];
  size_t got = 0;
  ASSERT_EQ(mc_audio_ring_pop(r, out, 2, &got), MC_OK);
  EXPECT_EQ(got, 2u);
  EXPECT_EQ(out[0], 2);
  EXPECT_EQ(out[3], -3);
  mc_audio_ring_destroy(r);
  EXPECT_EQ(mc_audio_ring_create(0, 1, 4, &r), MC_ERR_INVALID_ARG);
  EXPECT_EQ(mc_audio_ring_create(16000, 0, 4, &r), MC_ERR_INVALID_ARG);
  EXPECT_EQ(mc_audio_ring_create(16000, 1, 0, &r), MC_ERR_INVALID_ARG);
  EXPECT_EQ(mc_audio_ring_create(16000, 2, SIZE_MAX / 2, &r), MC_ERR_INVALID_ARG);
}

TEST(AudioRing, ConcurrentProducerConsumer) {
  mc_audio_ring* r = nullptr;
  ASSERT_EQ(mc_audio_ring_create(16000, 1, 1024, &r), MC_OK);
  constexpr size_t kTotal = 200000;
  std::thread prod([&] {
    std::vector<int16_t> chunk(100, 7);
    for (size_t i = 0; i < kTotal / 100; ++i) mc_audio_ring_push(r, chunk.data(), 100);
  });
  size_t consumed = 0;
  std::vector<int16_t> out(256);
  std::thread cons([&] {
    for (int spins = 0; spins < 2000000 && consumed + mc_audio_ring_dropped(r) < kTotal; ++spins) {
      size_t got = 0;
      mc_audio_ring_pop(r, out.data(), out.size(), &got);
      consumed += got;
    }
  });
  prod.join();
  cons.join();
  size_t got = 0;
  mc_audio_ring_pop(r, out.data(), out.size(), &got);
  consumed += got;
  EXPECT_EQ(consumed + mc_audio_ring_dropped(r) + mc_audio_ring_available(r), kTotal);
  mc_audio_ring_destroy(r);
}

namespace {
int zero_crossings(const std::vector<int16_t>& v) {
  int n = 0;
  for (size_t i = 1; i < v.size(); ++i)
    if ((v[i - 1] < 0) != (v[i] < 0)) ++n;
  return n;
}
}  // namespace

TEST(Resample, OutputCountFormula) {
  int16_t in[10] = {};
  int16_t out[32];
  size_t n = 99;
  EXPECT_EQ(mc_resample_pcm16(in, 10, 44100, 16000, out, 3, &n), MC_ERR_FULL);  // needs ceil(3.628)=4
  ASSERT_EQ(mc_resample_pcm16(in, 10, 44100, 16000, out, 4, &n), MC_OK);
  EXPECT_EQ(n, 4u);
  ASSERT_EQ(mc_resample_pcm16(in, 10, 16000, 48000, out, 32, &n), MC_OK);
  EXPECT_EQ(n, 30u);
  ASSERT_EQ(mc_resample_pcm16(in, 10, 8000, 8000, out, 16, &n), MC_OK);
  EXPECT_EQ(n, 10u);
  ASSERT_EQ(mc_resample_pcm16(in, 0, 8000, 16000, out, 0, &n), MC_OK);
  EXPECT_EQ(n, 0u);
  EXPECT_EQ(mc_resample_pcm16(in, 10, 0, 16000, out, 16, &n), MC_ERR_INVALID_ARG);
  EXPECT_EQ(mc_resample_pcm16(in, 10, 8000, -1, out, 16, &n), MC_ERR_INVALID_ARG);
}

TEST(Resample, DownsampleLengthAndTonePreserved) {
  const auto in = sine(440.0, 48000, 4800);  // 100 ms
  std::vector<int16_t> out(1600);
  size_t n = 0;
  ASSERT_EQ(mc_resample_pcm16(in.data(), in.size(), 48000, 16000, out.data(), out.size(), &n), MC_OK);
  ASSERT_EQ(n, 1600u);
  const int zin = zero_crossings(in), zout = zero_crossings(out);
  EXPECT_NEAR(zin, 88, 2);          // 2 * 440 Hz * 0.1 s
  EXPECT_NEAR(zout, zin, 2);        // same duration -> same count at the lower rate
  // Crossings per sample scale by the rate ratio (3x).
  EXPECT_NEAR(static_cast<double>(zout) / 1600.0, 3.0 * zin / 4800.0, 0.003);
  // Amplitude is retained for a tone far below Nyquist.
  int16_t peak = 0;
  for (int16_t s : out) peak = std::max<int16_t>(peak, s);
  EXPECT_NEAR(peak, 8000, 400);
}

TEST(Resample, UpsampleInterpolatesLinearly) {
  const int16_t in[3] = {0, 100, 200};
  int16_t out[6];
  size_t n = 0;
  ASSERT_EQ(mc_resample_pcm16(in, 3, 1000, 2000, out, 6, &n), MC_OK);
  EXPECT_EQ(n, 6u);
  EXPECT_EQ(out[0], 0);
  EXPECT_EQ(out[1], 50);
  EXPECT_EQ(out[2], 100);
  EXPECT_EQ(out[3], 150);
  EXPECT_EQ(out[5], 200);  // clamped at the last sample
}

TEST(Mix, SaturatesBothWays) {
  const int16_t a[4] = {30000, -30000, 100, -32768};
  const int16_t b[4] = {30000, -30000, 200, -1};
  int16_t out[4];
  ASSERT_EQ(mc_mix_pcm16(a, b, 4, out), MC_OK);
  EXPECT_EQ(out[0], 32767);
  EXPECT_EQ(out[1], -32768);
  EXPECT_EQ(out[2], 300);
  EXPECT_EQ(out[3], -32768);
  int16_t x[2] = {20000, -5};
  const int16_t y[2] = {20000, -5};
  ASSERT_EQ(mc_mix_pcm16(x, y, 2, x), MC_OK);  // aliasing allowed
  EXPECT_EQ(x[0], 32767);
  EXPECT_EQ(x[1], -10);
  EXPECT_EQ(mc_mix_pcm16(nullptr, b, 4, out), MC_ERR_INVALID_ARG);
}

TEST(Gain, SaturatesAndScales) {
  int16_t s[5] = {20000, -20000, 1000, -32768, 32767};
  ASSERT_EQ(mc_gain_pcm16(s, 5, 2.0f), MC_OK);
  EXPECT_EQ(s[0], 32767);
  EXPECT_EQ(s[1], -32768);
  EXPECT_EQ(s[2], 2000);
  EXPECT_EQ(s[3], -32768);
  EXPECT_EQ(s[4], 32767);
  int16_t t[2] = {1000, -1000};
  ASSERT_EQ(mc_gain_pcm16(t, 2, 0.5f), MC_OK);
  EXPECT_EQ(t[0], 500);
  EXPECT_EQ(t[1], -500);
  int16_t u[1] = {-32768};
  ASSERT_EQ(mc_gain_pcm16(u, 1, -1.0f), MC_OK);  // negation must not wrap
  EXPECT_EQ(u[0], 32767);
  EXPECT_EQ(mc_gain_pcm16(t, 2, NAN), MC_ERR_INVALID_ARG);
}

TEST(Rms, Dbfs) {
  double d = 0;
  int16_t zeros[10] = {};
  ASSERT_EQ(mc_rms_dbfs(zeros, 10, &d), MC_OK);
  EXPECT_DOUBLE_EQ(d, -120.0);
  ASSERT_EQ(mc_rms_dbfs(nullptr, 0, &d), MC_OK);
  EXPECT_DOUBLE_EQ(d, -120.0);
  std::vector<int16_t> half(100, 16384);
  ASSERT_EQ(mc_rms_dbfs(half.data(), half.size(), &d), MC_OK);
  EXPECT_NEAR(d, -6.02, 0.01);
  std::vector<int16_t> full(100, -32768);
  ASSERT_EQ(mc_rms_dbfs(full.data(), full.size(), &d), MC_OK);
  EXPECT_NEAR(d, 0.0, 0.01);
}
