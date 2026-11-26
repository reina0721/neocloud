package composition

import (
	"context"
	"crypto/subtle"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"sync"
	"sync/atomic"

	"github.com/reina0721/clouddrive/internal/kernel/config"
	"github.com/reina0721/clouddrive/internal/module/migration"
	"github.com/reina0721/clouddrive/internal/nativeupgrade/control"
)

const managedPrivateAddress = "127.0.0.1:0"

// managedService owns admission for every application generation inside one worker.
// It also gates scheduled jobs and queued messages that do not pass through HTTP.
type managedService struct {
	application       *Application
	token             string
	initialDigest     string
	initializeStorage bool
	plan              atomic.Pointer[migration.OnlinePlan]
	published         atomic.Bool
	publishedSignal   chan struct{}

	mu     sync.Mutex
	active int
	idle   chan struct{}
	open   bool
	probes bool
}

func (m *managedService) checkSnapshot(snapshot config.Snapshot, initial bool) error {
	if initial && snapshot.Digest() != m.initialDigest {
		return fmt.Errorf("managed worker configuration changed after preparation")
	}
	return nil
}

func (m *managedService) admission(open, probes bool) <-chan struct{} {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.open, m.probes = open, probes
	return m.idle
}

func (m *managedService) admitWork() (func(), bool) { return m.enter(false) }

func (m *managedService) enter(probe bool) (func(), bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.open && !(probe && m.probes) {
		return nil, false
	}
	if m.active == 0 {
		m.idle = make(chan struct{})
	}
	m.active++
	return m.leave, true
}

func (m *managedService) leave() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.active--
	if m.active == 0 {
		close(m.idle)
		m.idle = nil
	}
}

func (m *managedService) quiesce(ctx context.Context) error {
	idle := m.admission(false, false)
	if idle == nil {
		return nil
	}
	select {
	case <-idle:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (m *managedService) handler(next http.Handler, management bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if subtle.ConstantTimeCompare([]byte(r.Header.Get(control.TokenHeader)), []byte(m.token)) != 1 {
			http.NotFound(w, r)
			return
		}
		probe := management && r.Method == http.MethodGet &&
			(r.URL.Path == "/readyz" || r.URL.Path == "/livez" || r.URL.Path == "/build")
		leave, allowed := m.enter(probe)
		if !allowed {
			w.Header().Set("Retry-After", "1")
			http.Error(w, "worker not accepting requests", http.StatusServiceUnavailable)
			return
		}
		defer leave()
		r.Header.Del(control.TokenHeader)
		if forwarded := r.Header.Get(control.RemoteHeader); forwarded != "" {
			host, _, err := net.SplitHostPort(forwarded)
			if _, parseErr := netip.ParseAddr(host); err != nil || parseErr != nil {
				http.Error(w, "invalid client address", http.StatusBadRequest)
				return
			}
			r.RemoteAddr = forwarded
		}
		r.Header.Del(control.RemoteHeader)
		next.ServeHTTP(w, r)
	})
}
