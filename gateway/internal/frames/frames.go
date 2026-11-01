// Package frames serves /internal/frames/{stream_id}: motion-gated JPEG frames for the agent.
package frames

import (
	"context"
	"encoding/binary"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/argus-video/argus/gateway/internal/auth"
	"github.com/argus-video/argus/gateway/internal/media"
	"github.com/argus-video/argus/gateway/internal/metrics"
	"github.com/argus-video/argus/gateway/internal/protocol"
	"github.com/argus-video/argus/gateway/internal/session"
	"github.com/argus-video/argus/gateway/internal/streams"
	"github.com/coder/websocket"
)

// HeaderLen is the size of the binary frame header.
const HeaderLen = 16

// Handler serves the internal frames WebSocket (wrap with auth.Internal).
type Handler struct {
	Streams  *streams.Registry
	Sessions *session.Manager // optional: for ?session_id= clock rebasing
	Log      *slog.Logger
	Metrics  *metrics.Registry
}

// Encode builds header + JPEG: uint32 stream_idx, int64 ts_ms, int32 jpeg_len (little-endian).
func Encode(streamIdx uint32, tsMs int64, jpeg []byte) []byte {
	b := make([]byte, HeaderLen+len(jpeg))
	binary.LittleEndian.PutUint32(b[0:4], streamIdx)
	binary.LittleEndian.PutUint64(b[4:12], uint64(tsMs))
	binary.LittleEndian.PutUint32(b[12:16], uint32(int32(len(jpeg))))
	copy(b[HeaderLen:], jpeg)
	return b
}

// Decode parses a frame message.
func Decode(b []byte) (streamIdx uint32, tsMs int64, jpeg []byte, ok bool) {
	if len(b) < HeaderLen {
		return 0, 0, nil, false
	}
	n := int(int32(binary.LittleEndian.Uint32(b[12:16])))
	if n < 0 || len(b)-HeaderLen != n {
		return 0, 0, nil, false
	}
	return binary.LittleEndian.Uint32(b[0:4]), int64(binary.LittleEndian.Uint64(b[4:12])), b[HeaderLen:], true
}

func qFloat(r *http.Request, k string, def float64) (float64, bool) {
	v := r.URL.Query().Get(k)
	if v == "" {
		return def, true
	}
	f, err := strconv.ParseFloat(v, 64)
	return f, err == nil && f >= 0
}

// Gate decides whether a frame should be sent.
type Gate struct {
	M           media.Media
	MinMotion   float64
	MaxInterval time.Duration
	last        *media.Frame
}

// Allow reports whether f passes the gate, and records it as the last sent frame if so.
// Motion is measured against the last *sent* frame, never the previous captured one.
func (g *Gate) Allow(f media.Frame) bool {
	send := false
	switch {
	case g.last == nil:
		send = true
	case time.Duration(f.TsNs-g.last.TsNs) >= g.MaxInterval:
		send = true
	default:
		s := g.M.MotionScore(*g.last, f)
		send = s < 0 || s >= g.MinMotion // geometry mismatch / error => send
	}
	if send {
		c := f
		g.last = &c
	}
	return send
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	st, ok := h.Streams.Get(r.PathValue("stream_id"))
	if !ok {
		auth.WriteError(w, http.StatusNotFound, protocol.CodeNotFound, "stream not found")
		return
	}
	minMotion, ok1 := qFloat(r, "min_motion", 0.02)
	maxIntMs, ok2 := qFloat(r, "max_interval_ms", 5000)
	maxW, ok3 := qFloat(r, "max_w", 640)
	if !ok1 || !ok2 || !ok3 || minMotion > 1 || maxIntMs < 1 || maxW < 16 || maxW > 1920 {
		auth.WriteError(w, http.StatusBadRequest, protocol.CodeBadRequest, "invalid query parameters")
		return
	}
	m := h.Streams.Media()
	origin := h.Streams.OriginNs()
	if sid := r.URL.Query().Get("session_id"); sid != "" && h.Sessions != nil {
		s, ok := h.Sessions.Get(sid)
		if !ok {
			auth.WriteError(w, http.StatusNotFound, protocol.CodeNotFound, "session not found")
			return
		}
		origin = s.OriginOn(m.NowMonotonicNs())
	}

	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true}) // non-browser, internal
	if err != nil {
		return
	}
	defer c.CloseNow()
	ctx := c.CloseRead(r.Context())
	sub, cancel := st.Subscribe()
	defer cancel()
	gate := &Gate{M: m, MinMotion: minMotion, MaxInterval: time.Duration(maxIntMs) * time.Millisecond}
	var sent, gated uint64
	defer func() { h.Log.Debug("frames ws closed", "stream", st.ID, "sent", sent, "gated", gated) }()

	for {
		select {
		case <-ctx.Done():
			return
		case <-st.Done():
			_ = c.Close(websocket.StatusNormalClosure, "stream ended")
			return
		case f := <-sub:
			if !gate.Allow(f) {
				gated++
				continue
			}
			out := f
			if float64(f.W) > maxW {
				nw := int(maxW)
				nh := f.H * nw / f.W
				if nh < 1 {
					nh = 1
				}
				if out, err = m.Resize(f, nw, nh); err != nil {
					continue
				}
			}
			jpg, err := m.EncodeJPEG(out, 80)
			if err != nil {
				continue
			}
			wctx, wc := context.WithTimeout(ctx, 5*time.Second)
			err = c.Write(wctx, websocket.MessageBinary, Encode(f.StreamID, (f.TsNs-origin)/1e6, jpg))
			wc()
			if err != nil {
				return // slow or gone consumer: drop the connection, capture is unaffected
			}
			sent++
			if h.Metrics != nil {
				h.Metrics.Counter("argus_gateway_frames_sent_total", "frames sent to agent").Add(1)
			}
		}
	}
}
