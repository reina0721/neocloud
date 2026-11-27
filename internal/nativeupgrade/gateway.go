package nativeupgrade

import (
	"context"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"sync"
	"time"

	"github.com/reina0721/clouddrive/internal/nativeupgrade/control"
)

const handoffBudget = 5 * time.Second
const pendingLimit = 128

type gatewayRoutes [3]http.Handler

// gateway 只负责准入。已送往业务进程的请求不会在换版时被重放。
type gateway struct {
	mu      sync.Mutex
	active  int
	pending int
	resume  chan struct{}
	idle    chan struct{}
	routes  gatewayRoutes
}

func (g *gateway) handler(index int) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstream := g.admit(r.Context(), index)
		if upstream == nil {
			w.Header().Set("Retry-After", "1")
			http.Error(w, "服务正在换版，请稍后重试", http.StatusServiceUnavailable)
			return
		}
		defer g.complete()
		upstream.ServeHTTP(w, r)
	})
}

func (g *gateway) admit(ctx context.Context, index int) http.Handler {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.resume != nil {
		if g.pending >= pendingLimit {
			return nil
		}
		g.pending++
		timer := time.NewTimer(handoffBudget)
		defer timer.Stop()
		for g.resume != nil {
			resume := g.resume
			g.mu.Unlock()
			select {
			case <-resume:
				g.mu.Lock()
			case <-ctx.Done():
				g.mu.Lock()
				g.pending--
				return nil
			case <-timer.C:
				g.mu.Lock()
				g.pending--
				return nil
			}
		}
		g.pending--
	}
	if ctx.Err() != nil || g.routes[index] == nil {
		return nil
	}
	if g.active == 0 {
		g.idle = make(chan struct{})
	}
	g.active++
	return g.routes[index]
}

func (g *gateway) complete() {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.active--
	if g.active == 0 {
		close(g.idle)
	}
}

func (g *gateway) drain(ctx context.Context) error {
	g.mu.Lock()
	if g.resume == nil {
		g.resume = make(chan struct{})
	}
	if g.active == 0 {
		g.mu.Unlock()
		return nil
	}
	idle := g.idle
	g.mu.Unlock()
	select {
	case <-idle:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (g *gateway) open(routes gatewayRoutes) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.routes = routes
	if g.resume != nil {
		close(g.resume)
		g.resume = nil
	}
}

func newProxy(addr, token string) http.Handler {
	return proxyWorker(addr, token, false)
}

func proxyWorker(addr, token string, full bool) http.Handler {
	upstream := &url.URL{Scheme: "http", Host: addr}
	return &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			originalHost := r.In.Host
			r.SetURL(upstream)
			r.Out.Host = originalHost
			// Preserve the original peer address. The worker runs its existing trusted proxy policy.
			for _, header := range []string{"X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto"} {
				r.Out.Header[header] = r.In.Header.Values(header)
			}
			r.Out.Header.Set(control.RemoteHeader, r.In.RemoteAddr)
			r.Out.Header.Set(control.TokenHeader, token)
			r.Out.Header.Del(control.WebHeader)
			r.Out.Header.Del(control.SchemeHeader)
			if full {
				r.Out.Header.Set(control.WebHeader, "1")
				if r.In.TLS != nil {
					r.Out.Header.Set(control.SchemeHeader, "https")
				}
			}
		},
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, _ error) {
			w.Header().Set("Retry-After", "1")
			http.Error(w, "业务进程暂不可用", http.StatusServiceUnavailable)
		},
	}
}

func isLoopback(addr string) bool {
	host, port, err := net.SplitHostPort(addr)
	number, portErr := strconv.Atoi(port)
	return err == nil && host == "127.0.0.1" && portErr == nil && number > 0 && number <= 65535
}
