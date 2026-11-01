#include "helpers.hpp"

using testutil::sine;

namespace {
struct Vad {
  mc_vad* v = nullptr;
  explicit Vad(const mc_vad_config* c = nullptr) { EXPECT_EQ(mc_vad_create(c, &v), MC_OK); }
  ~Vad() { mc_vad_destroy(v); }
  // Feeds in chunks of `chunk` samples; records events with the sample offset where reported.
  std::vector<std::pair<mc_vad_event, size_t>> feed(const std::vector<int16_t>& s, size_t chunk,
                                                    size_t base = 0) {
    std::vector<std::pair<mc_vad_event, size_t>> ev;
    for (size_t i = 0; i < s.size(); i += chunk) {
      const size_t n = std::min(chunk, s.size() - i);
      mc_vad_event e = MC_VAD_NONE;
      int32_t in = -1;
      EXPECT_EQ(mc_vad_process(v, s.data() + i, n, &e, &in), MC_OK);
      if (e != MC_VAD_NONE) ev.emplace_back(e, base + i + n);
    }
    return ev;
  }
  bool in_speech() {
    int32_t in = -1;
    mc_vad_event e;
    EXPECT_EQ(mc_vad_process(v, nullptr, 0, &e, &in), MC_OK);
    return in == 1;
  }
};
std::vector<int16_t> silence(size_t n) { return std::vector<int16_t>(n, 0); }
}  // namespace

TEST(Vad, Defaults) {
  mc_vad_config c{};
  mc_vad_config_default(&c);
  EXPECT_EQ(c.sample_rate, 16000);
  EXPECT_EQ(c.frame_ms, 20);
  EXPECT_DOUBLE_EQ(c.threshold_dbfs, -40.0);
  EXPECT_EQ(c.min_speech_ms, 100);
  EXPECT_EQ(c.hangover_ms, 300);
  c.frame_ms = 0;
  mc_vad* v = nullptr;
  EXPECT_EQ(mc_vad_create(&c, &v), MC_ERR_INVALID_ARG);
}

TEST(Vad, SilenceProducesNothing) {
  Vad v;
  EXPECT_TRUE(v.feed(silence(16000), 320).empty());
  EXPECT_FALSE(v.in_speech());
  // Quiet noise below threshold (-60 dBFS ~ amplitude 33).
  EXPECT_TRUE(v.feed(sine(300, 16000, 16000, 30.0), 160).empty());
  EXPECT_FALSE(v.in_speech());
}

TEST(Vad, StartAfterDebounceAndEndAfterHangover) {
  Vad v;
  auto ev = v.feed(silence(8000), 320);  // 500 ms
  ASSERT_TRUE(ev.empty());
  ev = v.feed(sine(440, 16000, 8000), 320, 8000);  // 500 ms tone
  ASSERT_EQ(ev.size(), 1u);
  EXPECT_EQ(ev[0].first, MC_VAD_SPEECH_START);
  // 100 ms debounce = 5 frames of 20 ms -> reported once 1600 samples of tone were seen.
  EXPECT_GE(ev[0].second, 8000u + 1600u);
  EXPECT_LE(ev[0].second, 8000u + 1600u + 320u);
  EXPECT_TRUE(v.in_speech());
  ev = v.feed(silence(8000), 320, 16000);
  ASSERT_EQ(ev.size(), 1u);
  EXPECT_EQ(ev[0].first, MC_VAD_SPEECH_END);
  // 300 ms hangover = 4800 samples of silence.
  EXPECT_GE(ev[0].second, 16000u + 4800u);
  EXPECT_LE(ev[0].second, 16000u + 4800u + 320u);
  EXPECT_FALSE(v.in_speech());
}

TEST(Vad, ShortBurstIsDebounced) {
  Vad v;
  EXPECT_TRUE(v.feed(sine(440, 16000, 960), 160).empty());  // 60 ms < 100 ms
  EXPECT_TRUE(v.feed(silence(3200), 160).empty());
  EXPECT_FALSE(v.in_speech());
  // Interrupted bursts (60 ms + gap + 60 ms) also never accumulate.
  Vad w;
  for (int i = 0; i < 5; ++i) {
    EXPECT_TRUE(w.feed(sine(440, 16000, 960), 160).empty());
    EXPECT_TRUE(w.feed(silence(320), 160).empty());
  }
  EXPECT_FALSE(w.in_speech());
}

TEST(Vad, ShortPauseDoesNotEndSpeech) {
  Vad v;
  auto ev = v.feed(sine(440, 16000, 4000), 400);
  ASSERT_EQ(ev.size(), 1u);
  EXPECT_TRUE(v.feed(silence(2400), 400).empty());  // 150 ms < hangover
  EXPECT_TRUE(v.feed(sine(440, 16000, 2400), 400).empty());
  EXPECT_TRUE(v.in_speech());
  EXPECT_TRUE(v.feed(silence(3200), 400).empty());  // 200 ms, restarts hangover
  EXPECT_TRUE(v.in_speech());
}

TEST(Vad, ChunkSizeIndependenceAndReset) {
  std::vector<int16_t> sig = silence(3200);
  auto tone = sine(440, 16000, 6400);
  sig.insert(sig.end(), tone.begin(), tone.end());
  auto sil = silence(8000);
  sig.insert(sig.end(), sil.begin(), sil.end());
  for (size_t chunk : {1u, 7u, 160u, 333u, 320u, 1600u}) {
    Vad v;
    // Reconstruct events by feeding; chunk=1 would report per sample.
    auto ev = v.feed(sig, chunk);
    ASSERT_EQ(ev.size(), 2u) << "chunk " << chunk;
    EXPECT_EQ(ev[0].first, MC_VAD_SPEECH_START);
    EXPECT_EQ(ev[1].first, MC_VAD_SPEECH_END);
  }
  Vad v;
  v.feed(sine(440, 16000, 3200), 320);
  EXPECT_TRUE(v.in_speech());
  mc_vad_reset(v.v);
  EXPECT_FALSE(v.in_speech());
}
