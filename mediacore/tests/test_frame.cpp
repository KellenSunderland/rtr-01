#include <climits>

#include "helpers.hpp"

using testutil::Frame;

TEST(Frame, AllocGeometry) {
  mc_frame f{};
  ASSERT_EQ(mc_frame_alloc(10, 7, MC_PIXFMT_RGB8, &f), MC_OK);
  EXPECT_EQ(f.stride, 30);
  EXPECT_EQ(f.width, 10);
  EXPECT_EQ(f.height, 7);
  EXPECT_NE(f.data, nullptr);
  EXPECT_EQ(f.ts_ns, 0);
  mc_frame_free(&f);
  EXPECT_EQ(f.data, nullptr);
  mc_frame_free(&f);  // safe on zeroed struct
  mc_frame_free(nullptr);
}

TEST(Frame, AllocRejectsInvalidAndOverflow) {
  mc_frame f{};
  EXPECT_EQ(mc_frame_alloc(0, 10, MC_PIXFMT_BGR8, &f), MC_ERR_INVALID_ARG);
  EXPECT_EQ(mc_frame_alloc(10, -1, MC_PIXFMT_BGR8, &f), MC_ERR_INVALID_ARG);
  EXPECT_EQ(mc_frame_alloc(INT_MAX, INT_MAX, MC_PIXFMT_BGR8, &f), MC_ERR_INVALID_ARG);
  EXPECT_EQ(mc_frame_alloc(INT_MAX, 1, MC_PIXFMT_RGB8, &f), MC_ERR_INVALID_ARG);  // stride overflow
  EXPECT_EQ(mc_frame_alloc(100000, 100000, MC_PIXFMT_GRAY8, &f), MC_ERR_INVALID_ARG);
  EXPECT_EQ(mc_frame_alloc(4, 4, static_cast<mc_pixfmt>(99), &f), MC_ERR_INVALID_ARG);
  EXPECT_EQ(mc_frame_alloc(4, 4, MC_PIXFMT_BGR8, nullptr), MC_ERR_INVALID_ARG);
  EXPECT_EQ(f.data, nullptr);
  EXPECT_STRNE(mc_last_error(), "");
}

TEST(Frame, CopyHonoursStride) {
  std::vector<uint8_t> buf(20 * 3, 0xEE);  // 4x3 gray with stride 20
  for (int y = 0; y < 3; ++y)
    for (int x = 0; x < 4; ++x) buf[static_cast<size_t>(y * 20 + x)] = static_cast<uint8_t>(y * 10 + x);
  mc_frame in{};
  in.data = buf.data();
  in.width = 4;
  in.height = 3;
  in.stride = 20;
  in.fmt = MC_PIXFMT_GRAY8;
  in.ts_ns = 5;
  in.wall_ns = 6;
  in.stream_id = 7;
  in.seq = 8;
  mc_frame out{};
  ASSERT_EQ(mc_frame_copy(&in, &out), MC_OK);
  EXPECT_EQ(out.stride, 4);
  EXPECT_EQ(out.data[4 * 2 + 3], 23);
  EXPECT_EQ(out.ts_ns, 5);
  EXPECT_EQ(out.wall_ns, 6);
  EXPECT_EQ(out.stream_id, 7u);
  EXPECT_EQ(out.seq, 8u);
  mc_frame_free(&out);
  in.stride = 3;  // smaller than row
  EXPECT_EQ(mc_frame_copy(&in, &out), MC_ERR_INVALID_ARG);
  EXPECT_EQ(mc_frame_copy(nullptr, &out), MC_ERR_INVALID_ARG);
}

TEST(Frame, PixfmtBppAndVersion) {
  EXPECT_EQ(mc_pixfmt_bpp(MC_PIXFMT_RGB8), 3);
  EXPECT_EQ(mc_pixfmt_bpp(MC_PIXFMT_BGR8), 3);
  EXPECT_EQ(mc_pixfmt_bpp(MC_PIXFMT_GRAY8), 1);
  EXPECT_EQ(mc_pixfmt_bpp(static_cast<mc_pixfmt>(0)), 0);
  EXPECT_STRNE(mc_version(), "");
}
