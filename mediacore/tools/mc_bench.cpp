// Usage: mc_bench <file|url|device:N> [max_frames]
#include <cstdio>
#include <cstdlib>

#include "mediacore_c.h"

int main(int argc, char** argv) {
  if (argc < 2) {
    std::fprintf(stderr, "usage: %s <uri> [max_frames]\n", argv[0]);
    return 2;
  }
  const long max_frames = argc > 2 ? std::atol(argv[2]) : 300;
  mc_capture* cap = nullptr;
  if (mc_capture_open(argv[1], &cap) != MC_OK) {
    std::fprintf(stderr, "open failed: %s\n", mc_last_error());
    return 1;
  }
  std::printf("reported fps: %.2f\n", mc_capture_fps(cap));
  mc_frame prev{}, cur{};
  long n = 0;
  const int64_t t0 = mc_now_monotonic_ns();
  while (n < max_frames && mc_capture_read(cap, &cur) == MC_OK) {
    double score = 0.0;
    if (prev.data != nullptr && mc_motion_score(&prev, &cur, &score) == MC_OK)
      std::printf("frame %ld motion %.4f\n", n, score);
    mc_frame_free(&prev);
    prev = cur;
    cur = mc_frame{};
    ++n;
  }
  const double secs = static_cast<double>(mc_now_monotonic_ns() - t0) / 1e9;
  std::printf("read %ld frames in %.3fs (%.1f fps)\n", n, secs, secs > 0 ? static_cast<double>(n) / secs : 0.0);
  mc_frame_free(&prev);
  mc_capture_close(cap);
  return 0;
}
