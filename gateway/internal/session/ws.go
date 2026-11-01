package session

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/argus-video/argus/gateway/internal/auth"
	"github.com/argus-video/argus/gateway/internal/metrics"
	"github.com/argus-video/argus/gateway/internal/protocol"
	"github.com/argus-video/argus/gateway/internal/streams"
	"github.com/coder/websocket"
)

const (
	writeTimeout = 10 * time.Second
	firstMsgWait = 15 * time.Second
	stopGrace    = 2 * time.Second
	agentMaxMsg  = 1 << 20
)

// Handler serves the console WebSocket and relays to the agent.
type Handler struct {
	Sessions       *Manager
	Streams        *streams.Registry
	AgentURL       string // http(s)://host:port base of the agent
	InternalToken  string
	OriginPatterns []string
	Log            *slog.Logger
	Metrics        *metrics.Registry
}

type peer struct {
	c  *websocket.Conn
	mu sync.Mutex
}

func (p *peer) write(typ websocket.MessageType, data []byte) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), writeTimeout)
	defer cancel()
	return p.c.Write(ctx, typ, data)
}

func (p *peer) writeJSON(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return p.write(websocket.MessageText, b)
}

func (h *Handler) count(name string) {
	if h.Metrics != nil {
		h.Metrics.Counter(name, name).Add(1)
	}
}

// AgentWSURL converts the agent base URL into the internal session WS URL.
func AgentWSURL(base, sessionID string) (string, error) {
	u, err := url.Parse(base)
	if err != nil || u.Host == "" {
		return "", errors.New("invalid agent url")
	}
	switch u.Scheme {
	case "http":
		u.Scheme = "ws"
	case "https":
		u.Scheme = "wss"
	case "ws", "wss":
	default:
		return "", errors.New("invalid agent url scheme")
	}
	u.Path = strings.TrimRight(u.Path, "/") + "/internal/sessions/" + sessionID + "/ws"
	return u.String(), nil
}

// ServeWS handles GET /v1/sessions/{id}/ws (auth middleware already applied).
func (h *Handler) ServeWS(w http.ResponseWriter, r *http.Request) {
	p := auth.FromContext(r.Context())
	s, ok := h.Sessions.Get(r.PathValue("id"))
	if !ok || (p != nil && s.Owner != p) {
		auth.WriteError(w, http.StatusNotFound, protocol.CodeNotFound, "session not found")
		return
	}
	if !s.tryAttach() {
		auth.WriteError(w, http.StatusConflict, protocol.CodeBadRequest, "session already has an attached websocket")
		return
	}
	defer s.detach()

	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: h.OriginPatterns})
	if err != nil {
		return // Accept already replied
	}
	c.SetReadLimit(protocol.MaxBinaryBytes + 1024)
	con := &peer{c: c}
	log := h.Log.With("session", s.ID)
	h.count("argus_gateway_ws_connections_total")

	fail := func(code string, msg string, closeCode websocket.StatusCode) {
		_ = con.writeJSON(protocol.NewError(code, msg))
		_ = c.Close(closeCode, code)
	}

	// 1. first message must be session.start
	rctx, rcancel := context.WithTimeout(r.Context(), firstMsgWait)
	typ, data, err := c.Read(rctx)
	rcancel()
	if err != nil {
		_ = c.CloseNow()
		return
	}
	if typ != websocket.MessageText || len(data) > protocol.MaxTextBytes {
		fail(protocol.CodeBadRequest, "first message must be a text session.start (<=64KiB)", websocket.StatusPolicyViolation)
		return
	}
	msg, err := protocol.Decode(data)
	start, isStart := msg.(protocol.SessionStart)
	if err != nil || !isStart {
		fail(protocol.CodeBadRequest, "first message must be a valid session.start", websocket.StatusPolicyViolation)
		return
	}
	if start.Scenario != s.Scenario {
		fail(protocol.CodeBadRequest, "scenario does not match the session", websocket.StatusPolicyViolation)
		return
	}
	infos := make([]protocol.StreamInfo, 0, len(start.StreamIDs))
	allowed := map[string]bool{}
	for _, id := range s.StreamIDs {
		allowed[id] = true
	}
	for _, id := range start.StreamIDs {
		st, ok := h.Streams.Get(id)
		if !allowed[id] || !ok || (p != nil && st.Owner != p) {
			fail(protocol.CodeNotFound, "stream "+id+" is not available to this session", websocket.StatusPolicyViolation)
			return
		}
		infos = append(infos, st.Info())
	}

	// 2. dial the agent
	wsURL, err := AgentWSURL(h.AgentURL, s.ID)
	if err != nil {
		fail(protocol.CodeInternal, "agent url misconfigured", websocket.StatusInternalError)
		return
	}
	dctx, dcancel := context.WithTimeout(r.Context(), 10*time.Second)
	ac, _, err := websocket.Dial(dctx, wsURL, &websocket.DialOptions{HTTPHeader: http.Header{"X-Internal-Token": {h.InternalToken}}})
	dcancel()
	if err != nil {
		log.Warn("agent dial failed", "err", err)
		fail(protocol.CodeUpstream, "agent unavailable", websocket.StatusInternalError)
		return
	}
	ac.SetReadLimit(agentMaxMsg)
	agent := &peer{c: ac}
	if err := agent.write(websocket.MessageText, data); err != nil {
		_ = ac.CloseNow()
		fail(protocol.CodeUpstream, "agent unavailable", websocket.StatusInternalError)
		return
	}
	_ = con.writeJSON(protocol.SessionStarted{Type: "session.started", SessionID: s.ID, Scenario: s.Scenario, Streams: infos, ServerWallMs: time.Now().UnixMilli()})
	log.Info("session ws started", "streams", len(infos))

	// 3. relay
	loopCtx, loopCancel := context.WithCancel(context.Background())
	var once sync.Once
	shutdown := func(code websocket.StatusCode, reason string) {
		once.Do(func() {
			loopCancel()
			go func() {
				t := time.AfterFunc(5*time.Second, func() { _ = c.CloseNow(); _ = ac.CloseNow() })
				defer t.Stop()
				var wg sync.WaitGroup
				wg.Add(2)
				go func() { defer wg.Done(); _ = ac.Close(code, reason) }()
				go func() { defer wg.Done(); _ = c.Close(code, reason) }()
				wg.Wait()
			}()
		})
	}
	var wg sync.WaitGroup
	var stopping sync.Once // control.stop received

	wg.Add(1)
	go func() { // session closed (DELETE) or server shutdown
		defer wg.Done()
		select {
		case <-s.Done():
			shutdown(websocket.StatusGoingAway, "session closed")
		case <-loopCtx.Done():
		}
	}()

	wg.Add(1)
	go func() { // stream.status injector
		defer wg.Done()
		ch, cancel := h.Streams.Watch()
		defer cancel()
		for {
			select {
			case <-loopCtx.Done():
				return
			case info := <-ch:
				if !allowed[info.ID] {
					continue
				}
				if err := con.writeJSON(protocol.StreamStatus{Type: "stream.status", Stream: info}); err != nil {
					shutdown(websocket.StatusInternalError, "write failed")
					return
				}
			}
		}
	}()

	wg.Add(1)
	go func() { // console -> agent
		defer wg.Done()
		for {
			typ, data, err := c.Read(context.Background())
			if err != nil {
				shutdown(websocket.StatusNormalClosure, "console closed")
				return
			}
			if typ == websocket.MessageBinary {
				if len(data) > protocol.MaxBinaryBytes {
					_ = con.writeJSON(protocol.NewError(protocol.CodeBadRequest, "binary message too large"))
					shutdown(websocket.StatusMessageTooBig, "too big")
					return
				}
				_ = con.writeJSON(protocol.NewError(protocol.CodeBadRequest, "binary messages are not supported"))
				continue
			}
			if len(data) > protocol.MaxTextBytes {
				_ = con.writeJSON(protocol.NewError(protocol.CodeBadRequest, "text message too large"))
				shutdown(websocket.StatusMessageTooBig, "too big")
				return
			}
			msg, err := protocol.Decode(data)
			if err != nil || !protocol.IsClientType(msg.MsgType()) {
				_ = con.writeJSON(protocol.NewError(protocol.CodeBadRequest, "invalid client message"))
				continue
			}
			h.count("argus_gateway_ws_client_messages_total")
			switch m := msg.(type) {
			case protocol.SessionStart:
				_ = con.writeJSON(protocol.NewError(protocol.CodeBadRequest, "session already started"))
				continue
			case protocol.ClientAudio:
				m.TsMs = s.NowMs() // the gateway stamps audio with the session clock
				if data, err = json.Marshal(m); err != nil {
					continue
				}
			case protocol.Stop:
				_ = agent.write(websocket.MessageText, data)
				stopping.Do(func() {
					time.AfterFunc(stopGrace, func() { shutdown(websocket.StatusNormalClosure, "stop") })
				})
				return
			}
			if err := agent.write(websocket.MessageText, data); err != nil {
				_ = con.writeJSON(protocol.NewError(protocol.CodeUpstream, "agent write failed"))
				shutdown(websocket.StatusInternalError, "upstream")
				return
			}
		}
	}()

	wg.Add(1)
	go func() { // agent -> console (single reader/writer chain keeps per-utterance order)
		defer wg.Done()
		cancelled := map[string]bool{}
		for {
			typ, data, err := ac.Read(context.Background())
			if err != nil {
				stopped := false
				select {
				case <-loopCtx.Done():
					stopped = true
				default:
				}
				if !stopped && websocket.CloseStatus(err) != websocket.StatusNormalClosure {
					_ = con.writeJSON(protocol.NewError(protocol.CodeUpstream, "agent connection lost"))
				}
				shutdown(websocket.StatusNormalClosure, "agent closed")
				return
			}
			if typ != websocket.MessageText {
				continue
			}
			msg, err := protocol.Decode(data)
			if err != nil || protocol.IsClientType(msg.MsgType()) {
				log.Warn("dropping malformed agent message")
				continue
			}
			switch m := msg.(type) {
			case protocol.SessionStarted:
				continue // the gateway already sent session.started
			case protocol.AssistantCancelled:
				cancelled[m.UtteranceID] = true
			case protocol.AssistantText:
				if cancelled[m.UtteranceID] {
					continue
				}
			case protocol.AssistantAudio:
				if cancelled[m.UtteranceID] {
					continue
				}
			}
			h.count("argus_gateway_ws_server_messages_total")
			if err := con.write(websocket.MessageText, data); err != nil {
				shutdown(websocket.StatusInternalError, "console write failed")
				return
			}
		}
	}()

	wg.Wait()
	log.Info("session ws ended")
}
