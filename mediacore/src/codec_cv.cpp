// JPEG/PNG/BMP/... codec via OpenCV (used when built with MEDIACORE_WITH_OPENCV).
#include <cstdlib>
#include <cstring>
#include <limits>
#include <opencv2/imgcodecs.hpp>

#include "internal.hpp"

namespace mediacore {

bool has_opencv() noexcept { return true; }

uint8_t* encode_jpeg(const mc_frame* in, int32_t quality, size_t* len) {
  validate_frame(in, "encode_jpeg");
  if (len == nullptr) fail(MC_ERR_INVALID_ARG, "null len");
  if (quality < 1 || quality > 100) fail(MC_ERR_INVALID_ARG, "quality must be 1..100");
  mc_frame bgr{};
  const mc_frame* src = in;
  const bool conv = in->fmt == MC_PIXFMT_RGB8;
  if (conv) {
    convert(in, MC_PIXFMT_BGR8, &bgr);
    src = &bgr;
  }
  const cv::Mat m(src->height, src->width, src->fmt == MC_PIXFMT_GRAY8 ? CV_8UC1 : CV_8UC3,
                  src->data, static_cast<size_t>(src->stride));
  std::vector<uchar> enc;
  const bool ok = cv::imencode(".jpg", m, enc, {cv::IMWRITE_JPEG_QUALITY, quality});
  if (conv) frame_free(&bgr);
  if (!ok || enc.empty()) fail(MC_ERR_INTERNAL, "jpeg encode failed");
  auto* p = static_cast<uint8_t*>(std::malloc(enc.size()));
  if (p == nullptr) fail(MC_ERR_INTERNAL, "out of memory");
  std::memcpy(p, enc.data(), enc.size());
  *len = enc.size();
  return p;
}

void decode_image(const uint8_t* buf, size_t len, mc_frame* out) {
  if (buf == nullptr || len == 0 || out == nullptr) fail(MC_ERR_INVALID_ARG, "bad decode args");
  if (len > static_cast<size_t>(std::numeric_limits<int>::max()))
    fail(MC_ERR_INVALID_ARG, "buffer too large");
  const cv::Mat raw(1, static_cast<int>(len), CV_8UC1, const_cast<uint8_t*>(buf));
  const cv::Mat img = cv::imdecode(raw, cv::IMREAD_COLOR);
  if (img.empty() || img.type() != CV_8UC3) fail(MC_ERR_INVALID_ARG, "undecodable image data");
  mc_frame tmp;
  frame_alloc(img.cols, img.rows, MC_PIXFMT_BGR8, &tmp);
  for (int y = 0; y < img.rows; ++y)
    std::memcpy(tmp.data + static_cast<size_t>(y) * static_cast<size_t>(tmp.stride), img.ptr(y),
                static_cast<size_t>(tmp.stride));
  *out = tmp;
}

}  // namespace mediacore
