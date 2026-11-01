#include <filesystem>
#include <fstream>

#include "helpers.hpp"

namespace fs = std::filesystem;
using testutil::Frame;

namespace {
struct TmpDir {
  fs::path p;
  TmpDir() {
    p = fs::temp_directory_path() / ("mc_test_" + std::to_string(mc_now_monotonic_ns()));
    fs::create_directories(p);
  }
  ~TmpDir() { std::error_code ec; fs::remove_all(p, ec); }
};
}  // namespace

TEST(Capture, MissingPathIsIoError) {
  mc_capture* c = nullptr;
  EXPECT_EQ(mc_capture_open("/definitely/not/here.mp4", &c), MC_ERR_IO);
  EXPECT_EQ(c, nullptr);
  EXPECT_EQ(mc_capture_open("dir:/definitely/not/here", &c), MC_ERR_IO);
  EXPECT_EQ(mc_capture_open(nullptr, &c), MC_ERR_INVALID_ARG);
  EXPECT_EQ(mc_capture_open("", &c), MC_ERR_INVALID_ARG);
  EXPECT_STRNE(mc_last_error(), "");
}

TEST(Capture, UnsupportedWithoutOpenCV) {
  if (mc_has_opencv()) GTEST_SKIP() << "OpenCV build";
  mc_capture* c = nullptr;
  EXPECT_EQ(mc_capture_open("rtsp://example.invalid/stream", &c), MC_ERR_UNSUPPORTED);
  EXPECT_EQ(mc_capture_open("device:0", &c), MC_ERR_UNSUPPORTED);
}

TEST(Capture, BadDeviceUri) {
  if (!mc_has_opencv()) GTEST_SKIP() << "no OpenCV";
  mc_capture* c = nullptr;
  EXPECT_EQ(mc_capture_open("device:abc", &c), MC_ERR_INVALID_ARG);
}

TEST(Capture, ImageSequenceDirectory) {
  TmpDir d;
  for (int i = 0; i < 4; ++i) {
    Frame f = testutil::gradient(32, 24, MC_PIXFMT_BGR8, i % 2 == 1);
    uint8_t* buf = nullptr;
    size_t len = 0;
    ASSERT_EQ(mc_encode_jpeg(f.get(), 90, &buf, &len), MC_OK);
    char name[32];
    std::snprintf(name, sizeof name, "frame_%03d.jpg", i);
    std::ofstream(d.p / name, std::ios::binary).write(reinterpret_cast<char*>(buf), static_cast<std::streamsize>(len));
    mc_buffer_free(buf);
  }
  std::ofstream(d.p / "notes.txt") << "ignored";
  mc_capture* c = nullptr;
  const std::string uri = "dir:" + d.p.string() + "@12.5";
  ASSERT_EQ(mc_capture_open(uri.c_str(), &c), MC_OK);
  EXPECT_DOUBLE_EQ(mc_capture_fps(c), 12.5);
  Frame prev;
  int n = 0;
  int64_t last_ts = 0;
  while (true) {
    Frame cur;
    const mc_status st = mc_capture_read(c, cur.get());
    if (st == MC_ERR_EOF) break;
    ASSERT_EQ(st, MC_OK);
    EXPECT_EQ(cur.f.width, 32);
    EXPECT_EQ(cur.f.height, 24);
    EXPECT_EQ(cur.f.fmt, MC_PIXFMT_BGR8);
    EXPECT_GE(cur.f.ts_ns, last_ts);
    EXPECT_GT(cur.f.wall_ns, 0);
    last_ts = cur.f.ts_ns;
    if (n > 0) {  // alternating normal/inverted frames -> large motion
      double s = 0;
      ASSERT_EQ(mc_motion_score(prev.get(), cur.get(), &s), MC_OK);
      EXPECT_GT(s, 0.3);
    }
    prev = std::move(cur);
    ++n;
  }
  EXPECT_EQ(n, 4);
  mc_capture_close(c);
  mc_capture_close(nullptr);
}

TEST(Capture, EmptyDirectoryAndBadFps) {
  TmpDir d;
  mc_capture* c = nullptr;
  const std::string empty = "dir:" + d.p.string();
  EXPECT_EQ(mc_capture_open(empty.c_str(), &c), MC_ERR_IO);
  const std::string badfps = "dir:" + d.p.string() + "@abc";
  EXPECT_EQ(mc_capture_open(badfps.c_str(), &c), MC_ERR_INVALID_ARG);
}
