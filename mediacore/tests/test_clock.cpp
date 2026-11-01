#include <chrono>
#include <thread>

#include "helpers.hpp"

TEST(Clock, MonotonicIncreases) {
  int64_t prev = mc_now_monotonic_ns();
  for (int i = 0; i < 1000; ++i) {
    const int64_t t = mc_now_monotonic_ns();
    ASSERT_GE(t, prev);
    prev = t;
  }
  const int64_t a = mc_now_monotonic_ns();
  std::this_thread::sleep_for(std::chrono::milliseconds(5));
  EXPECT_GE(mc_now_monotonic_ns() - a, 4'000'000);
}

TEST(Clock, WallIsEpoch) {
  EXPECT_GT(mc_now_wall_ns(), 1'600'000'000LL * 1'000'000'000LL);
  const int64_t a = mc_now_wall_ns();
  std::this_thread::sleep_for(std::chrono::milliseconds(2));
  EXPECT_GT(mc_now_wall_ns(), a);
}
