#include <cmath>
#include <cstring>
#include <filesystem>
#include <opencv2/imgproc.hpp>
#include <opencv2/videoio.hpp>

#include "internal.hpp"

namespace mediacore {

struct Capture::Impl {
  cv::VideoCapture cap;
  bool is_device = false;
};

Capture::Capture(const std::string& uri) : impl_(std::make_unique<Impl>()) {
  if (uri.empty()) fail(MC_ERR_INVALID_ARG, "empty capture uri");
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
      if (!std::filesystem::exists(uri, ec)) fail(MC_ERR_IO, "no such file: " + uri);
    }
    opened = impl_->cap.open(uri);
  }
  if (!opened || !impl_->cap.isOpened()) fail(MC_ERR_IO, "cannot open capture: " + uri);
}

Capture::~Capture() = default;

void Capture::read(mc_frame* out) {
  if (out == nullptr) fail(MC_ERR_INVALID_ARG, "null out");
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
}

double Capture::fps() const {
  const double f = impl_->cap.get(cv::CAP_PROP_FPS);
  return (std::isfinite(f) && f > 0.0) ? f : 0.0;
}

}  // namespace mediacore
