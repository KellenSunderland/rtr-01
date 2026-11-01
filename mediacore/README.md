# mediacore

C++20 media library for Argus, exposed only through the C ABI in `include/mediacore_c.h`
(consumed by the Go gateway via cgo and the Python agent via ctypes).

## Build and test

```
export PATH=$HOME/.local/bin:$PATH      # CMake >= 3.16 (arm64-capable)
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j
ctest --test-dir build --output-on-failure
```

Outputs: `build/libmediacore.dylib|so` (shared), `build/libmediacore.a`, `build/mc_bench`,
`build/compile_commands.json`. `cmake --install build --prefix <dir>` installs header + libs.

Options: `MEDIACORE_BUILD_TESTS` (ON), `MEDIACORE_BUILD_TOOLS` (ON), `MEDIACORE_WERROR` (ON),
`MEDIACORE_WITH_OPENCV` = `AUTO` (default, use if found) | `ON` (required) | `OFF`.
On Apple silicon the build defaults to the host arch (arm64) and ignores `/usr/local`
(Intel Homebrew) when searching for OpenCV; `/opt/homebrew` is searched.
Tests download GoogleTest 1.14 via FetchContent; they need no camera or network otherwise.

### Two configurations
* **No OpenCV**: vendored `third_party/stb` (JPEG/PNG/BMP decode, JPEG encode). `mc_capture_open`
  supports only `dir:<path>[@fps]` (sorted jpg/png/bmp sequence, default 10 fps; frames are
  returned as fast as read, not paced). RTSP/HTTP/`device:N`/video files -> `MC_ERR_UNSUPPORTED`
  (a missing plain path is still `MC_ERR_IO`).
* **OpenCV**: codecs and `cv::VideoCapture` (files, URLs, `device:N`). `dir:` still works.
`mc_has_opencv()` reports which one is linked. All pixel ops (resize/letterbox/gray/convert/crop/
motion) are plain C++ and identical in both builds.

## Design notes

**Errors.** Every C entry point is wrapped in a catch-all that maps `mediacore::Error`, `bad_alloc`
and other exceptions to `mc_status` and stores a thread-local message for `mc_last_error()`.
The message is not cleared by successful calls.

**Memory.** Frames are `calloc`ed; all geometry is validated in 64-bit (width*bpp must fit the
int32 stride; a frame is capped at 1 GiB) and overflow is rejected with `MC_ERR_INVALID_ARG`.
Inputs honour `stride` (never assume `stride == width*bpp`); outputs are tightly packed and carry
the input's `ts_ns/wall_ns/stream_id/seq`.

**Frame store.** One mutex; per stream a `deque<shared_ptr<StoredFrame>>` sorted by strictly
increasing `ts_ns` (binary search for nearest/range). A lease is a heap `shared_ptr` copy in
`mc_frame_view.lease`; a frame with `use_count()>1` is "leased" and is never evicted by
retention, thinning or `max_bytes` (the store may exceed `max_bytes` if everything left is leased).
`remove_stream` always drops the store's reference, but memory stays valid for outstanding leases.
Per-stream last `ts_ns` is remembered after eviction, so out-of-order rejection survives pruning.
Thinning: frames older than `now - thin_after` are grouped by nearest interval boundary
`k*thinned_interval`; the frame closest to the boundary (ties -> earlier) survives. `max_bytes`
evicts the globally oldest unleased frame first. `evicted_total` counts retention and size
evictions, `thinned_total` counts thinning removals. A single frame larger than `max_bytes` is
refused with `MC_ERR_FULL`.

**Audio.** Ring: mutex-protected (not lock-free), overwrite-oldest; `dropped` counts overwritten
frames. Resampler: linear interpolation, exact rational positions, output length
`ceil(n_in*out/in)`, no anti-alias filter. VAD: per-frame RMS vs threshold; START after
`ceil(min_speech_ms/frame_ms)` consecutive loud frames, END after `ceil(hangover_ms/frame_ms)`
consecutive quiet frames; only the first transition within one `process` call is reported.
Jitter buffer: packets keyed by 64-bit unwrapped seq (handles 2^32 wraparound); playout primes once
`target_delay_ms` is buffered, starting at the lowest seq; a missing packet with later ones buffered
is concealed with one (last-seen) packet length of silence (`lost`, `concealed_frames`); packets
behind the playout head and duplicates count as `late` and are dropped; buffered audio above
`max_delay_ms` drops oldest packets (counted in `lost`). Pop on an empty primed buffer returns
`MC_OK` with 0 frames; before priming `MC_ERR_EOF`.

**Clocks.** `mc_now_monotonic_ns` = `steady_clock`, `mc_now_wall_ns` = `system_clock` epoch ns;
the two are captured independently and never converted into one another.

**Threading.** Frame store, audio ring, VAD and jitter buffer are internally locked. Capture handles
are single-threaded. Do not destroy an object while another thread is using it.
