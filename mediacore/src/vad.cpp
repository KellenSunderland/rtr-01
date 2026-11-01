#include <algorithm>

#include "internal.hpp"

namespace mediacore {

Vad::Vad(const mc_vad_config& cfg) : cfg_(cfg) {
  if (cfg.sample_rate <= 0 || cfg.frame_ms <= 0 || cfg.min_speech_ms < 0 || cfg.hangover_ms < 0)
    fail(MC_ERR_INVALID_ARG, "invalid vad config");
  const int64_t fs = static_cast<int64_t>(cfg.sample_rate) * cfg.frame_ms / 1000;
  if (fs < 1 || fs > (1 << 24)) fail(MC_ERR_INVALID_ARG, "vad frame size out of range");
  frame_samples_ = static_cast<size_t>(fs);
  auto frames_for = [&](int32_t ms) {
    return static_cast<int32_t>((static_cast<int64_t>(ms) + cfg.frame_ms - 1) / cfg.frame_ms);
  };
  start_frames_ = std::max(1, frames_for(cfg.min_speech_ms));
  end_frames_ = std::max(1, frames_for(cfg.hangover_ms));
  pending_.reserve(frame_samples_);
}

mc_vad_event Vad::process(const int16_t* s, size_t n, int32_t* in_speech) {
  if (n > 0 && s == nullptr) fail(MC_ERR_INVALID_ARG, "null samples");
  std::lock_guard<std::mutex> lk(mu_);
  mc_vad_event ev = MC_VAD_NONE;
  auto on_frame = [&](const int16_t* f) {
    const bool loud = rms_dbfs(f, frame_samples_) > cfg_.threshold_dbfs;
    mc_vad_event t = MC_VAD_NONE;
    if (!in_speech_) {
      loud_run_ = loud ? loud_run_ + 1 : 0;  // debounce: consecutive loud frames
      if (loud_run_ >= start_frames_) {
        in_speech_ = true;
        loud_run_ = 0;
        quiet_run_ = 0;
        t = MC_VAD_SPEECH_START;
      }
    } else {
      quiet_run_ = loud ? 0 : quiet_run_ + 1;  // hangover: consecutive quiet frames
      if (quiet_run_ >= end_frames_) {
        in_speech_ = false;
        loud_run_ = 0;
        quiet_run_ = 0;
        t = MC_VAD_SPEECH_END;
      }
    }
    if (ev == MC_VAD_NONE) ev = t;
  };
  size_t i = 0;
  if (!pending_.empty()) {
    const size_t take = std::min(n, frame_samples_ - pending_.size());
    pending_.insert(pending_.end(), s, s + take);
    i = take;
    if (pending_.size() == frame_samples_) {
      on_frame(pending_.data());
      pending_.clear();
    }
  }
  while (n - i >= frame_samples_) {
    on_frame(s + i);
    i += frame_samples_;
  }
  if (i < n) pending_.insert(pending_.end(), s + i, s + n);
  if (in_speech != nullptr) *in_speech = in_speech_ ? 1 : 0;
  return ev;
}

void Vad::reset() {
  std::lock_guard<std::mutex> lk(mu_);
  pending_.clear();
  in_speech_ = false;
  loud_run_ = 0;
  quiet_run_ = 0;
}

}  // namespace mediacore
