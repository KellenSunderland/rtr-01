// Package metrics is a tiny hand-written Prometheus text exposition.
package metrics

import (
	"fmt"
	"io"
	"net/http"
	"sort"
	"sync"
	"sync/atomic"
)

type Registry struct {
	mu         sync.Mutex
	counters   map[string]*atomic.Int64
	help       map[string]string
	collectors []func(io.Writer)
}

func New() *Registry {
	return &Registry{counters: map[string]*atomic.Int64{}, help: map[string]string{}}
}

// Counter returns (creating if needed) a monotonically increasing counter.
func (r *Registry) Counter(name, help string) *atomic.Int64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	c, ok := r.counters[name]
	if !ok {
		c = new(atomic.Int64)
		r.counters[name] = c
		r.help[name] = help
	}
	return c
}

// AddCollector registers a function that writes extra exposition lines (gauges).
func (r *Registry) AddCollector(f func(io.Writer)) {
	r.mu.Lock()
	r.collectors = append(r.collectors, f)
	r.mu.Unlock()
}

// Write renders the exposition text.
func (r *Registry) Write(w io.Writer) {
	r.mu.Lock()
	names := make([]string, 0, len(r.counters))
	for n := range r.counters {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		fmt.Fprintf(w, "# HELP %s %s\n# TYPE %s counter\n%s %d\n", n, r.help[n], n, n, r.counters[n].Load())
	}
	cs := append([]func(io.Writer){}, r.collectors...)
	r.mu.Unlock()
	for _, c := range cs {
		c(w)
	}
}

// Handler serves /metrics.
func (r *Registry) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; version=0.0.4")
		r.Write(w)
	})
}
