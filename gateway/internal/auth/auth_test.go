package auth

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func newAuth() *Authenticator {
	return New([]TokenSpec{{Name: "a", Token: "token-aaaaaaaa", MaxStreams: 1, MaxSessions: 2}, {Name: "b", Token: "token-bbbbbbbb"}}, "internal-secret")
}

func TestLookup(t *testing.T) {
	a := newAuth()
	if p := a.Lookup("token-aaaaaaaa"); p == nil || p.Name != "a" {
		t.Fatal("valid token rejected")
	}
	for _, bad := range []string{"", "token-aaaaaaa", "token-aaaaaaaaa", "TOKEN-AAAAAAAA", "token-bbbbbbbb "} {
		if a.Lookup(bad) != nil {
			t.Fatalf("accepted %q", bad)
		}
	}
}

func TestMiddleware(t *testing.T) {
	h := newAuth().Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if FromContext(r.Context()) == nil {
			t.Error("no principal")
		}
	}))
	for hdr, want := range map[string]int{"": 401, "Bearer nope": 401, "Basic token-aaaaaaaa": 401, "Bearer token-aaaaaaaa": 200, "bearer token-bbbbbbbb": 200} {
		r := httptest.NewRequest("GET", "/", nil)
		if hdr != "" {
			r.Header.Set("Authorization", hdr)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != want {
			t.Errorf("%q: got %d want %d", hdr, w.Code, want)
		}
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/?access_token=token-aaaaaaaa", nil))
	if w.Code != 200 {
		t.Error("query token fallback")
	}
}

func TestQuota(t *testing.T) {
	p := newAuth().Lookup("token-aaaaaaaa")
	if !p.Acquire(Streams) || p.Acquire(Streams) {
		t.Fatal("stream quota of 1")
	}
	p.Release(Streams)
	if !p.Acquire(Streams) {
		t.Fatal("release should free")
	}
	if !p.Acquire(Sessions) || !p.Acquire(Sessions) || p.Acquire(Sessions) {
		t.Fatal("session quota of 2")
	}
	unl := newAuth().Lookup("token-bbbbbbbb")
	for i := 0; i < 100; i++ {
		if !unl.Acquire(Streams) {
			t.Fatal("unlimited")
		}
	}
}

func TestInternal(t *testing.T) {
	h := newAuth().Internal(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	cases := []struct {
		addr, tok string
		want      int
	}{
		{"127.0.0.1:5000", "internal-secret", 200},
		{"[::1]:5000", "internal-secret", 200},
		{"127.0.0.1:5000", "wrong", 401},
		{"127.0.0.1:5000", "", 401},
		{"10.0.0.5:5000", "internal-secret", 403},
		{"garbage", "internal-secret", 403},
	}
	for _, c := range cases {
		r := httptest.NewRequest("GET", "/", nil)
		r.RemoteAddr = c.addr
		r.Header.Set("X-Internal-Token", c.tok)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != c.want {
			t.Errorf("%v: got %d", c, w.Code)
		}
	}
}
