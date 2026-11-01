#include "helpers.hpp"

using testutil::Frame;
using testutil::gradient;

TEST(ImageOps, ResizeGeometryAndConstant) {
  Frame in(40, 20, MC_PIXFMT_BGR8);
  in.fill(120);
  for (mc_interp i : {MC_INTERP_NEAREST, MC_INTERP_BILINEAR, MC_INTERP_AREA}) {
    Frame out;
    ASSERT_EQ(mc_resize(in.get(), 16, 9, i, out.get()), MC_OK);
    EXPECT_EQ(out.f.width, 16);
    EXPECT_EQ(out.f.height, 9);
    EXPECT_EQ(out.f.fmt, MC_PIXFMT_BGR8);
    EXPECT_EQ(out.px(15, 8)[2], 120);
    EXPECT_EQ(out.px(0, 0)[0], 120);
  }
  Frame up;
  ASSERT_EQ(mc_resize(in.get(), 100, 50, MC_INTERP_BILINEAR, up.get()), MC_OK);
  EXPECT_EQ(up.f.width, 100);
  Frame bad;
  EXPECT_EQ(mc_resize(in.get(), 0, 5, MC_INTERP_AREA, bad.get()), MC_ERR_INVALID_ARG);
  EXPECT_EQ(mc_resize(in.get(), 2000000000, 2000000000, MC_INTERP_AREA, bad.get()), MC_ERR_INVALID_ARG);
}

TEST(ImageOps, ResizeAreaAverages) {
  Frame in(2, 2, MC_PIXFMT_GRAY8);
  *in.px(0, 0) = 0;
  *in.px(1, 0) = 100;
  *in.px(0, 1) = 100;
  *in.px(1, 1) = 200;
  Frame out;
  ASSERT_EQ(mc_resize(in.get(), 1, 1, MC_INTERP_AREA, out.get()), MC_OK);
  EXPECT_EQ(*out.px(0, 0), 100);
}

TEST(ImageOps, LetterboxGeometry) {
  Frame in(200, 100, MC_PIXFMT_GRAY8);
  in.fill(200);
  Frame out;
  ASSERT_EQ(mc_letterbox(in.get(), 100, 100, 7, out.get()), MC_OK);
  EXPECT_EQ(out.f.width, 100);
  EXPECT_EQ(out.f.height, 100);
  EXPECT_EQ(*out.px(50, 10), 7);   // top pad
  EXPECT_EQ(*out.px(50, 90), 7);   // bottom pad
  EXPECT_EQ(*out.px(50, 50), 200); // content (scaled to 100x50, rows 25..74)
  EXPECT_EQ(*out.px(0, 25), 200);
  EXPECT_EQ(*out.px(0, 24), 7);
  EXPECT_EQ(*out.px(99, 74), 200);
  EXPECT_EQ(*out.px(99, 75), 7);
  // Tall source -> pillarbox.
  Frame tall(50, 100, MC_PIXFMT_BGR8);
  tall.fill(90);
  Frame out2;
  ASSERT_EQ(mc_letterbox(tall.get(), 100, 100, 0, out2.get()), MC_OK);
  EXPECT_EQ(out2.px(10, 50)[1], 0);
  EXPECT_EQ(out2.px(50, 50)[1], 90);
}

TEST(ImageOps, MotionScore) {
  Frame a = gradient(32, 32), same = gradient(32, 32), inv = gradient(32, 32, MC_PIXFMT_BGR8, true);
  double s = -1;
  ASSERT_EQ(mc_motion_score(a.get(), same.get(), &s), MC_OK);
  EXPECT_EQ(s, 0.0);
  ASSERT_EQ(mc_motion_score(a.get(), inv.get(), &s), MC_OK);
  EXPECT_GT(s, 0.4);
  EXPECT_LE(s, 1.0);
  Frame black(8, 8, MC_PIXFMT_GRAY8), white(8, 8, MC_PIXFMT_GRAY8);
  white.fill(255);
  ASSERT_EQ(mc_motion_score(black.get(), white.get(), &s), MC_OK);
  EXPECT_DOUBLE_EQ(s, 1.0);
  Frame other(9, 8, MC_PIXFMT_GRAY8);
  EXPECT_EQ(mc_motion_score(black.get(), other.get(), &s), MC_ERR_INVALID_ARG);
}

TEST(ImageOps, ChangedFraction) {
  Frame a(10, 10, MC_PIXFMT_GRAY8), b(10, 10, MC_PIXFMT_GRAY8);
  for (int x = 0; x < 10; ++x) *b.px(x, 0) = 50;  // first row differs by 50
  double f = -1;
  ASSERT_EQ(mc_changed_fraction(a.get(), b.get(), 49, &f), MC_OK);
  EXPECT_DOUBLE_EQ(f, 0.1);
  ASSERT_EQ(mc_changed_fraction(a.get(), b.get(), 50, &f), MC_OK);  // strictly exceeds
  EXPECT_DOUBLE_EQ(f, 0.0);
}

TEST(ImageOps, MotionRespectsStride) {
  // 4x2 gray image embedded in rows of stride 16 with garbage padding.
  std::vector<uint8_t> p(32, 0xAA), q(32, 0x55);
  mc_frame a{}, b{};
  a.data = p.data();
  b.data = q.data();
  a.width = b.width = 4;
  a.height = b.height = 2;
  a.stride = b.stride = 16;
  a.fmt = b.fmt = MC_PIXFMT_GRAY8;
  for (int y = 0; y < 2; ++y)
    for (int x = 0; x < 4; ++x) p[static_cast<size_t>(y * 16 + x)] = q[static_cast<size_t>(y * 16 + x)] = 10;
  double s = -1;
  ASSERT_EQ(mc_motion_score(&a, &b, &s), MC_OK);
  EXPECT_EQ(s, 0.0);
}

TEST(ImageOps, ConvertAndGray) {
  Frame rgb(2, 1, MC_PIXFMT_RGB8);
  rgb.px(0, 0)[0] = 255;  // pure red
  rgb.px(1, 0)[2] = 255;  // pure blue
  Frame bgr;
  ASSERT_EQ(mc_convert(rgb.get(), MC_PIXFMT_BGR8, bgr.get()), MC_OK);
  EXPECT_EQ(bgr.px(0, 0)[2], 255);
  EXPECT_EQ(bgr.px(1, 0)[0], 255);
  Frame g;
  ASSERT_EQ(mc_to_gray(rgb.get(), g.get()), MC_OK);
  EXPECT_EQ(g.f.fmt, MC_PIXFMT_GRAY8);
  EXPECT_NEAR(*g.px(0, 0), 76, 2);
  EXPECT_NEAR(*g.px(1, 0), 29, 2);
  Frame back;
  ASSERT_EQ(mc_convert(g.get(), MC_PIXFMT_RGB8, back.get()), MC_OK);
  EXPECT_EQ(back.px(0, 0)[0], back.px(0, 0)[2]);
  Frame same;
  ASSERT_EQ(mc_convert(rgb.get(), MC_PIXFMT_RGB8, same.get()), MC_OK);
  EXPECT_EQ(same.px(0, 0)[0], 255);
  EXPECT_EQ(mc_convert(rgb.get(), static_cast<mc_pixfmt>(42), same.get()), MC_ERR_INVALID_ARG);
}

TEST(ImageOps, Crop) {
  Frame in = gradient(20, 10, MC_PIXFMT_GRAY8);
  Frame out;
  ASSERT_EQ(mc_crop(in.get(), 5, 2, 8, 4, out.get()), MC_OK);
  EXPECT_EQ(out.f.width, 8);
  EXPECT_EQ(out.f.height, 4);
  EXPECT_EQ(*out.px(0, 0), *in.px(5, 2));
  EXPECT_EQ(*out.px(7, 3), *in.px(12, 5));
  Frame bad;
  EXPECT_EQ(mc_crop(in.get(), 15, 0, 6, 1, bad.get()), MC_ERR_INVALID_ARG);
  EXPECT_EQ(mc_crop(in.get(), -1, 0, 2, 2, bad.get()), MC_ERR_INVALID_ARG);
  EXPECT_EQ(mc_crop(in.get(), 0, 0, 0, 2, bad.get()), MC_ERR_INVALID_ARG);
  ASSERT_EQ(mc_crop(in.get(), 12, 6, 8, 4, out.get() == nullptr ? nullptr : bad.get()), MC_OK);  // exactly fits
}

TEST(ImageOps, JpegRoundtrip) {
  Frame in = gradient(64, 48);
  uint8_t* buf = nullptr;
  size_t len = 0;
  ASSERT_EQ(mc_encode_jpeg(in.get(), 90, &buf, &len), MC_OK);
  ASSERT_GT(len, 100u);
  EXPECT_EQ(buf[0], 0xFF);
  EXPECT_EQ(buf[1], 0xD8);
  Frame out;
  ASSERT_EQ(mc_decode_image(buf, len, out.get()), MC_OK);
  mc_buffer_free(buf);
  EXPECT_EQ(out.f.width, 64);
  EXPECT_EQ(out.f.height, 48);
  EXPECT_EQ(out.f.fmt, MC_PIXFMT_BGR8);
  double s = 1;
  ASSERT_EQ(mc_motion_score(in.get(), out.get(), &s), MC_OK);
  EXPECT_LT(s, 0.03);
}

TEST(ImageOps, JpegColorOrderAndErrors) {
  Frame rgb(16, 16, MC_PIXFMT_RGB8);
  for (int y = 0; y < 16; ++y)
    for (int x = 0; x < 16; ++x) rgb.px(x, y)[0] = 255;  // red in RGB
  uint8_t* buf = nullptr;
  size_t len = 0;
  ASSERT_EQ(mc_encode_jpeg(rgb.get(), 95, &buf, &len), MC_OK);
  Frame out;
  ASSERT_EQ(mc_decode_image(buf, len, out.get()), MC_OK);
  EXPECT_GT(out.px(8, 8)[2], 200);  // BGR: red channel is index 2
  EXPECT_LT(out.px(8, 8)[0], 50);
  EXPECT_EQ(mc_encode_jpeg(rgb.get(), 0, &buf + 1 - 1, &len), MC_ERR_INVALID_ARG);
  mc_buffer_free(buf);
  const uint8_t junk[] = {1, 2, 3, 4, 5};
  Frame bad;
  EXPECT_EQ(mc_decode_image(junk, sizeof junk, bad.get()), MC_ERR_INVALID_ARG);
  EXPECT_EQ(mc_decode_image(nullptr, 0, bad.get()), MC_ERR_INVALID_ARG);
}
