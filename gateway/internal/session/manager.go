// Package session holds session objects and the console WebSocket relay.
package session

import (
	"context"
	"errors"
	"sort"
	"sync"
	"time"

	"github.com/argus-video/argus/gateway/internal/auth"
	"github.com/argus-video/argus/gateway/internal/protocol"
	"github.com/google/uuid"
)

var (
	ErrNotFound = errors.New("session not found")
	ErrQuota    = errors.New("session quota exceeded")
)

// Session is a conversation over one or more streams.
type Session struct {
	ID          string
	Scenario    string
	StreamIDs   []string
	Owner       *auth.Principal
	CreatedWall time.Time

	startMono time.Time // monotonic reading (time.Now carries one)
	ctx       context.Context
	cancel    context.CancelFunc

	mu     sync.Mutex
	state  string
	attach bool // a console WS is attached
}

// NowMs is the session clock: monotonic ms since session start.
func (s *Session) NowMs() int64 { return time.Since(s.startMono).Milliseconds() }

// StartMono returns the session's start instant (carries a monotonic reading).
func (s *Session) StartMono() time.Time { return s.startMono }

// Info renders the wire SessionInfo.
func (s *Session) Info() protocol.SessionInfo {
	s.mu.Lock()
	defer s.mu.Unlock()
	return protocol.SessionInfo{ID: s.ID, Scenario: s.Scenario, StreamIDs: append([]string{}, s.StreamIDs...),
		CreatedWallMs: s.CreatedWall.UnixMilli(), State: s.state}
}

// Done is closed when the session is closed.
func (s *Session) Done() <-chan struct{} { return s.ctx.Done() }

func (s *Session) tryAttach() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.attach || s.state != "open" {
		return false
	}
	s.attach = true
	return true
}

func (s *Session) detach() { s.mu.Lock(); s.attach = false; s.mu.Unlock() }

// Manager tracks sessions.
type Manager struct {
	mu       sync.Mutex
	sessions map[string]*Session
}

func NewManager() *Manager { return &Manager{sessions: map[string]*Session{}} }

// Create makes a new open session, consuming session quota.
func (m *Manager) Create(owner *auth.Principal, scenario string, streamIDs []string) (*Session, error) {
	if owner != nil && !owner.Acquire(auth.Sessions) {
		return nil, ErrQuota
	}
	ctx, cancel := context.WithCancel(context.Background())
	s := &Session{ID: uuid.NewString(), Scenario: scenario, StreamIDs: append([]string{}, streamIDs...), Owner: owner,
		CreatedWall: time.Now(), startMono: time.Now(), ctx: ctx, cancel: cancel, state: "open"}
	m.mu.Lock()
	m.sessions[s.ID] = s
	m.mu.Unlock()
	return s, nil
}

// Get returns an open session.
func (m *Manager) Get(id string) (*Session, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.sessions[id]
	return s, ok
}

// List returns sessions owned by owner, sorted by creation.
func (m *Manager) List(owner *auth.Principal) []*Session {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []*Session
	for _, s := range m.sessions {
		if owner == nil || s.Owner == owner {
			out = append(out, s)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedWall.Before(out[j].CreatedWall) })
	return out
}

// Count returns the number of open sessions.
func (m *Manager) Count() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.sessions)
}

// Close closes and removes a session, releasing quota and ending any WS.
func (m *Manager) Close(id string) error {
	m.mu.Lock()
	s, ok := m.sessions[id]
	delete(m.sessions, id)
	m.mu.Unlock()
	if !ok {
		return ErrNotFound
	}
	s.mu.Lock()
	s.state = "closed"
	s.mu.Unlock()
	s.cancel()
	if s.Owner != nil {
		s.Owner.Release(auth.Sessions)
	}
	return nil
}

// CloseAll closes every session.
func (m *Manager) CloseAll() {
	m.mu.Lock()
	ids := make([]string, 0, len(m.sessions))
	for id := range m.sessions {
		ids = append(ids, id)
	}
	m.mu.Unlock()
	for _, id := range ids {
		_ = m.Close(id)
	}
}

// OriginOn returns the session start expressed on the media monotonic clock (ns).
func (s *Session) OriginOn(nowMediaNs int64) int64 {
	return nowMediaNs - time.Since(s.startMono).Nanoseconds()
}
