#include <algorithm>
#include <cstring>

#include "internal.hpp"

namespace mediacore {

JitterBuffer::JitterBuffer(int32_t sample_rate, int32_t target_delay_ms, int32_t max_delay_ms)
    : rate_(sample_rate), target_samples_(0), max_samples_(0), last_len_(0) {
  if (sample_rate <= 0 || target_delay_ms < 0 || max_delay_ms < target_delay_ms ||
      max_delay_ms <= 0 || max_delay_ms > 600000)
    fail(MC_ERR_INVALID_ARG, "invalid jitter buffer parameters");
  target_samples_ = static_cast<size_t>(static_cast<int64_t>(sample_rate) * target_delay_ms / 1000);
  max_samples_ = static_cast<size_t>(static_cast<int64_t>(sample_rate) * max_delay_ms / 1000);
  last_len_ = std::max<size_t>(1, static_cast<size_t>(sample_rate) / 50);  // 20 ms default
}

size_t JitterBuffer::buffered_locked() const {
  size_t t = 0;
  for (const auto& [k, p] : packets_) t += p.samples.size();
  return t >= offset_ ? t - offset_ : 0;
}

void JitterBuffer::push(uint32_t seq, int64_t ts_ns, const int16_t* samples, size_t n) {
  if (n > 0 && samples == nullptr) fail(MC_ERR_INVALID_ARG, "null samples");
  if (n > (static_cast<size_t>(1) << 24)) fail(MC_ERR_INVALID_ARG, "packet too large");
  std::lock_guard<std::mutex> lk(mu_);
  ++st_.received;
  // Unwrap the 32-bit sequence relative to the most recent packet (handles 2^32 wrap).
  int64_t ext;
  if (!have_anchor_) {
    ext = static_cast<int64_t>(1) << 40;
  } else {
    ext = anchor_ext_ + static_cast<int64_t>(static_cast<int32_t>(seq - anchor_seq_));
  }
  have_anchor_ = true;
  anchor_seq_ = seq;
  anchor_ext_ = ext;

  if ((primed_ && ext < next_ext_) || packets_.count(ext) != 0) {  // late or duplicate
    ++st_.late;
    return;
  }
  packets_.emplace(ext, Packet{ts_ns, std::vector<int16_t>(samples, samples + n)});
  if (n > 0) last_len_ = n;

  if (!primed_ && buffered_locked() >= target_samples_) {
    primed_ = true;
    next_ext_ = packets_.begin()->first;
    offset_ = 0;
    gap_offset_ = 0;
    have_ts_ = false;
  }
  // Overrun: discard oldest audio beyond max delay (counted as lost).
  while (primed_ && buffered_locked() > max_samples_ && !packets_.empty()) {
    auto it = packets_.begin();
    if (it->first > next_ext_) {
      next_ext_ = it->first;  // skip the missing ones in front
      gap_offset_ = 0;
    }
    packets_.erase(it);
    ++next_ext_;
    offset_ = 0;
    gap_offset_ = 0;
    have_ts_ = false;
    ++st_.lost;
  }
}

bool JitterBuffer::pop(int16_t* out, size_t cap, size_t* n, int64_t* ts_ns) {
  if (n == nullptr || (cap > 0 && out == nullptr)) fail(MC_ERR_INVALID_ARG, "null argument");
  std::lock_guard<std::mutex> lk(mu_);
  *n = 0;
  if (!primed_) return false;
  size_t written = 0;
  bool first = true;
  auto note_ts = [&](int64_t t) {
    if (first && ts_ns != nullptr) *ts_ns = t;
    first = false;
  };
  const int64_t ns_per_sample_num = 1000000000LL;
  while (written < cap) {
    auto it = packets_.find(next_ext_);
    if (it != packets_.end()) {
      const Packet& p = it->second;
      if (offset_ >= p.samples.size()) {  // finished (or empty) packet
        packets_.erase(it);
        ++next_ext_;
        offset_ = 0;
        have_ts_ = false;
        continue;
      }
      const int64_t t = p.ts_ns + static_cast<int64_t>(offset_) * ns_per_sample_num / rate_;
      note_ts(t);
      const size_t take = std::min(cap - written, p.samples.size() - offset_);
      std::memcpy(out + written, p.samples.data() + offset_, take * sizeof(int16_t));
      written += take;
      offset_ += take;
      play_ts_ = p.ts_ns + static_cast<int64_t>(offset_) * ns_per_sample_num / rate_;
      have_ts_ = true;
      if (offset_ >= p.samples.size()) {
        packets_.erase(it);
        ++next_ext_;
        offset_ = 0;
      }
    } else if (!packets_.empty()) {
      // Missing packet with later ones buffered: conceal with silence of one packet length.
      if (gap_offset_ == 0) ++st_.lost;
      if (have_ts_) note_ts(play_ts_);
      else note_ts(packets_.begin()->second.ts_ns);
      const size_t take = std::min(cap - written, last_len_ - gap_offset_);
      std::memset(out + written, 0, take * sizeof(int16_t));
      written += take;
      gap_offset_ += take;
      st_.concealed_frames += take;
      if (have_ts_) play_ts_ += static_cast<int64_t>(take) * ns_per_sample_num / rate_;
      if (gap_offset_ >= last_len_) {
        gap_offset_ = 0;
        ++next_ext_;
      }
    } else {
      break;  // underrun: nothing buffered
    }
  }
  *n = written;
  return true;
}

mc_jitter_stats JitterBuffer::stats() const {
  std::lock_guard<std::mutex> lk(mu_);
  mc_jitter_stats s = st_;
  s.current_delay_ms =
      static_cast<int32_t>(static_cast<int64_t>(buffered_locked()) * 1000 / rate_);
  return s;
}

void JitterBuffer::reset_locked() {
  packets_.clear();
  have_anchor_ = false;
  primed_ = false;
  next_ext_ = 0;
  offset_ = 0;
  gap_offset_ = 0;
  have_ts_ = false;
  play_ts_ = 0;
  st_ = mc_jitter_stats{};
}

void JitterBuffer::reset() {
  std::lock_guard<std::mutex> lk(mu_);
  reset_locked();
}

}  // namespace mediacore
