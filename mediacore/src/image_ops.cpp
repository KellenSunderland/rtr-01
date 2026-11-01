#include <algorithm>
#include <cmath>
#include <cstring>
#include <limits>
#include <opencv2/imgcodecs.hpp>
#include <opencv2/imgproc.hpp>

#include "internal.hpp"

namespace mediacore {
namespace {

int cv_type(mc_pixfmt fmt) { return pixfmt_bpp(fmt) == 1 ? CV_8UC1 : CV_8UC3; }

// Non-owning view of a validated frame (respects stride).
cv::Mat view(const mc_frame* f) {
  return cv::Mat(f->height, f->width, cv_type(f->fmt), f->data, static_cast<size_t>(f->stride));
}

// Copies `m` into a freshly allocated packed frame, carrying metadata from `meta`.
void emit(const cv::Mat& m, mc_pixfmt fmt, const mc_frame& meta, mc_frame* out) {
  if (m.type() != cv_type(fmt)) fail(MC_ERR_INTERNAL, "unexpected image type");
  mc_frame tmp;
  frame_alloc(m.cols, m.rows, fmt, &tmp);
  const size_t row = static_cast<size_t>(tmp.stride);
  for (int y = 0; y < m.rows; ++y)
    std::memcpy(tmp.data + static_cast<size_t>(y) * row, m.ptr(y), row);
  tmp.ts_ns = meta.ts_ns;
  tmp.wall_ns = meta.wall_ns;
  tmp.stream_id = meta.stream_id;
  tmp.seq = meta.seq;
  *out = tmp;
}

cv::Mat gray_of(const mc_frame* f) {
  cv::Mat src = view(f);
  if (f->fmt == MC_PIXFMT_GRAY8) return src;
  cv::Mat g;
  cv::cvtColor(src, g, f->fmt == MC_PIXFMT_RGB8 ? cv::COLOR_RGB2GRAY : cv::COLOR_BGR2GRAY);
  return g;
}

cv::Mat diff_gray(const mc_frame* a, const mc_frame* b) {
  validate_frame(a, "a");
  validate_frame(b, "b");
  if (a->width != b->width || a->height != b->height)
    fail(MC_ERR_INVALID_ARG, "frame geometry mismatch");
  cv::Mat d;
  cv::absdiff(gray_of(a), gray_of(b), d);
  return d;
}

}  // namespace

void resize(const mc_frame* in, int32_t w, int32_t h, mc_interp interp, mc_frame* out) {
  validate_frame(in, "resize");
  if (out == nullptr) fail(MC_ERR_INVALID_ARG, "null out");
  (void)checked_frame_bytes(w, h, in->fmt);
  int flag = cv::INTER_LINEAR;
  switch (interp) {
    case MC_INTERP_NEAREST:
      flag = cv::INTER_NEAREST;
      break;
    case MC_INTERP_BILINEAR:
      flag = cv::INTER_LINEAR;
      break;
    case MC_INTERP_AREA:
      flag = cv::INTER_AREA;
      break;
    default:
      fail(MC_ERR_INVALID_ARG, "invalid interpolation");
  }
  const mc_frame meta = *in;
  cv::Mat dst;
  cv::resize(view(in), dst, cv::Size(w, h), 0, 0, flag);
  emit(dst, meta.fmt, meta, out);
}

void letterbox(const mc_frame* in, int32_t w, int32_t h, uint8_t pad, mc_frame* out) {
  validate_frame(in, "letterbox");
  if (out == nullptr) fail(MC_ERR_INVALID_ARG, "null out");
  (void)checked_frame_bytes(w, h, in->fmt);
  const double scale = std::min(static_cast<double>(w) / in->width,
                                static_cast<double>(h) / in->height);
  const int nw = std::clamp(static_cast<int>(std::lround(in->width * scale)), 1, w);
  const int nh = std::clamp(static_cast<int>(std::lround(in->height * scale)), 1, h);
  const int ox = (w - nw) / 2;
  const int oy = (h - nh) / 2;
  const mc_frame meta = *in;
  cv::Mat canvas(h, w, cv_type(meta.fmt), cv::Scalar::all(pad));
  cv::Mat scaled;
  cv::resize(view(in), scaled, cv::Size(nw, nh), 0, 0,
             scale < 1.0 ? cv::INTER_AREA : cv::INTER_LINEAR);
  scaled.copyTo(canvas(cv::Rect(ox, oy, nw, nh)));
  emit(canvas, meta.fmt, meta, out);
}

void to_gray(const mc_frame* in, mc_frame* out) {
  validate_frame(in, "to_gray");
  if (out == nullptr) fail(MC_ERR_INVALID_ARG, "null out");
  const mc_frame meta = *in;
  emit(gray_of(in), MC_PIXFMT_GRAY8, meta, out);
}

void convert(const mc_frame* in, mc_pixfmt fmt, mc_frame* out) {
  validate_frame(in, "convert");
  if (out == nullptr) fail(MC_ERR_INVALID_ARG, "null out");
  if (pixfmt_bpp(fmt) == 0) fail(MC_ERR_INVALID_ARG, "invalid target format");
  const mc_frame meta = *in;
  if (fmt == in->fmt) {
    emit(view(in), fmt, meta, out);
    return;
  }
  if (fmt == MC_PIXFMT_GRAY8) {
    emit(gray_of(in), fmt, meta, out);
    return;
  }
  cv::Mat dst;
  if (in->fmt == MC_PIXFMT_GRAY8) {
    cv::cvtColor(view(in), dst, cv::COLOR_GRAY2BGR);  // R=G=B so BGR/RGB identical
  } else {
    cv::cvtColor(view(in), dst, cv::COLOR_BGR2RGB);  // symmetric swap
  }
  emit(dst, fmt, meta, out);
}

void crop(const mc_frame* in, int32_t x, int32_t y, int32_t w, int32_t h, mc_frame* out) {
  validate_frame(in, "crop");
  if (out == nullptr) fail(MC_ERR_INVALID_ARG, "null out");
  if (x < 0 || y < 0 || w <= 0 || h <= 0 ||
      static_cast<int64_t>(x) + w > in->width || static_cast<int64_t>(y) + h > in->height)
    fail(MC_ERR_INVALID_ARG, "crop region outside frame");
  const mc_frame meta = *in;
  emit(view(in)(cv::Rect(x, y, w, h)), meta.fmt, meta, out);
}

double motion_score(const mc_frame* a, const mc_frame* b) {
  const cv::Mat d = diff_gray(a, b);
  return std::clamp(cv::mean(d)[0] / 255.0, 0.0, 1.0);
}

double changed_fraction(const mc_frame* a, const mc_frame* b, uint8_t threshold) {
  const cv::Mat d = diff_gray(a, b);
  cv::Mat mask;
  cv::threshold(d, mask, static_cast<double>(threshold), 255, cv::THRESH_BINARY);
  const double n = static_cast<double>(cv::countNonZero(mask));
  return n / (static_cast<double>(d.rows) * static_cast<double>(d.cols));
}

uint8_t* encode_jpeg(const mc_frame* in, int32_t quality, size_t* len) {
  validate_frame(in, "encode_jpeg");
  if (len == nullptr) fail(MC_ERR_INVALID_ARG, "null len");
  if (quality < 1 || quality > 100) fail(MC_ERR_INVALID_ARG, "quality must be 1..100");
  cv::Mat src = view(in);
  cv::Mat bgr;
  if (in->fmt == MC_PIXFMT_RGB8) {
    cv::cvtColor(src, bgr, cv::COLOR_RGB2BGR);
  } else {
    bgr = src;
  }
  std::vector<uchar> enc;
  if (!cv::imencode(".jpg", bgr, enc, {cv::IMWRITE_JPEG_QUALITY, quality}))
    fail(MC_ERR_INTERNAL, "jpeg encode failed");
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
  cv::Mat raw(1, static_cast<int>(len), CV_8UC1, const_cast<uint8_t*>(buf));
  cv::Mat img = cv::imdecode(raw, cv::IMREAD_COLOR);
  if (img.empty()) fail(MC_ERR_INVALID_ARG, "undecodable image data");
  emit(img, MC_PIXFMT_BGR8, mc_frame{}, out);
}

}  // namespace mediacore
