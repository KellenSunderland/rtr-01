#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iterator>
#ifdef MC_WITH_OPENCV
#include <opencv2/imgproc.hpp>
#include <opencv2/videoio.hpp>
#endif

#include "internal.hpp"

namespace fs = std::filesystem;

namespace mediacore {

struct Capture::Impl {
#ifdef MC_WITH_OPENCV
  cv::VideoCapture cap;
#endif
  bool is_device = false;
  // "dir:<path>[@fps]" image-sequence mode
  bool is_dir = false;
  std::vector<fs::path> files;
  size_t next = 0;
  double dir_fps = 10.0;
};

namespace {
bool is_image_ext(const fs::path& p) {
  std::string e = p.extension().string();
  std::transform(e.begin(), e.end(), e.begin(), [](unsigned char c) { return std::tolower(c); });
  return e == ".jpg" || e == ".jpeg" || e == ".png" || e == ".bmp";
}
}  // namespace

Capture::Capture(const std::string& uri) : impl_(std::make_unique<Impl>()) {
  if (uri.empty()) fail(MC_ERR_INVALID_ARG, "empty capture uri");
  if (uri.rfind("dir:", 0) == 0) {
    std::string path = uri.substr(4);
    const size_t at = path.rfind('@');
    if (at != std::string::npos) {
      const std::string f = path.substr(at + 1);
      char* end = nullptr;
      const double v = std::strtod(f.c_str(), &end);
      if (f.empty() || end == nullptr || *end != '\0' || !std::isfinite(v) || v <= 0 || v > 1000)
        fail(MC_ERR_INVALID_ARG, "bad fps in dir uri");
      impl_->dir_fps = v;
      path.resize(at);
    }
    std::error_code ec;
    if (path.empty() || !fs::is_directory(path, ec)) fail(MC_ERR_IO, "not a directory: " + path);
    for (const auto& e : fs::directory_iterator(path, ec))
      if (e.is_regular_file() && is_image_ext(e.path())) impl_->files.push_back(e.path());
    if (impl_->files.empty()) fail(MC_ERR_IO, "no images in directory: " + path);
    std::sort(impl_->files.begin(), impl_->files.end());
    impl_->is_dir = true;
    return;
  }
#ifdef MC_WITH_OPENCV
  bool opened = false;
  if (uri.rfind("device:", 0) == 0) {
    const std::string num = uri.substr(7);
    if (num.empty() || num.size() > 6 || num.find_first_not_of("0123456789") != std::string::npos)
      fail(MC_ERR_INVALID_ARG, "bad device uri: " + uri);
    impl_->is_device = true;
    opened = impl_->cap.open(std::stoi(num));
  } else {
    if (uri.find("://") == std::string::npos) {
      std::error_code ec;
      if (!fs::exists(uri, ec)) fail(MC_ERR_IO, "no such file: " + uri);
    }
    opened = impl_->cap.open(uri);
  }
  if (!opened || !impl_->cap.isOpened()) fail(MC_ERR_IO, "cannot open capture: " + uri);
#else
  if (uri.rfind("device:", 0) == 0 || uri.find("://") != std::string::npos)
    fail(MC_ERR_UNSUPPORTED, "built without OpenCV: only dir:<path>[@fps] is supported");
  std::error_code ec;
  if (!fs::exists(uri, ec)) fail(MC_ERR_IO, "no such file: " + uri);
  fail(MC_ERR_UNSUPPORTED, "built without OpenCV: video files unsupported (use dir:<path>)");
#endif
}

Capture::~Capture() = default;

void Capture::read(mc_frame* out) {
  if (out == nullptr) fail(MC_ERR_INVALID_ARG, "null out");
  if (impl_->is_dir) {
    // Skip unreadable/corrupt files? No: report them, but advance so the caller can continue.
    if (impl_->next >= impl_->files.size()) fail(MC_ERR_EOF, "end of image sequence");
    const fs::path p = impl_->files[impl_->next++];
    std::ifstream f(p, std::ios::binary);
    if (!f) fail(MC_ERR_IO, "cannot read " + p.string());
    std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
    mc_frame tmp;
    decode_image(bytes.data(), bytes.size(), &tmp);
    tmp.ts_ns = now_monotonic_ns();
    tmp.wall_ns = now_wall_ns();
    *out = tmp;
    return;
  }
#ifdef MC_WITH_OPENCV
  cv::Mat m;
  if (!impl_->cap.read(m) || m.empty()) {
    if (impl_->is_device) fail(MC_ERR_IO, "device read failed");
    fail(MC_ERR_EOF, "end of stream");
  }
  cv::Mat bgr;
  if (m.channels() == 1) {
    cv::cvtColor(m, bgr, cv::COLOR_GRAY2BGR);
  } else if (m.channels() == 4) {
    cv::cvtColor(m, bgr, cv::COLOR_BGRA2BGR);
  } else {
    bgr = m;
  }
  if (bgr.type() != CV_8UC3) fail(MC_ERR_UNSUPPORTED, "unsupported capture pixel type");
  mc_frame tmp;
  frame_alloc(bgr.cols, bgr.rows, MC_PIXFMT_BGR8, &tmp);
  const size_t row = static_cast<size_t>(tmp.stride);
  for (int y = 0; y < bgr.rows; ++y)
    std::memcpy(tmp.data + static_cast<size_t>(y) * row, bgr.ptr(y), row);
  tmp.ts_ns = now_monotonic_ns();
  tmp.wall_ns = now_wall_ns();
  *out = tmp;
#else
  fail(MC_ERR_UNSUPPORTED, "capture unsupported");
#endif
}

double Capture::fps() const {
  if (impl_->is_dir) return impl_->dir_fps;
#ifdef MC_WITH_OPENCV
  const double f = impl_->cap.get(cv::CAP_PROP_FPS);
  return (std::isfinite(f) && f > 0.0) ? f : 0.0;
#else
  return 0.0;
#endif
}

}  // namespace mediacore
