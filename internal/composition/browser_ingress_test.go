package composition

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/reina0721/neocloud/internal/nativeupgrade/control"
	"github.com/reina0721/neocloud/pkg/httpx"
)

func TestNativeBrowserIngressTrustsOnlyVerifiedSchemeAndOwnerOrigin(t *testing.T) {
	const token = "test-only-private-control"
	const public = "https://files.example.test"
	const external = "https://reader.example.test"
	const owner = "/api/console/v1/deployment/owner"
	config := httpx.ServerConfig{TrustedProxyCIDRs: []string{"192.0.2.7/32"}}
	config.CORS.AllowedOrigins = []string{external}
	ingress, err := newBrowserIngress(public, config)
	if err != nil {
		t.Fatal(err)
	}
	service := managedService{token: token}
	service.admission(true, false)
	for _, test := range []struct {
		name, peer, path, origin, directScheme, wantOrigin string
		forwarded                                          []string
		status                                             int
		unauthenticated                                    bool
	}{
		{name: "trusted proxy and same source", peer: "192.0.2.7:1234", path: owner, origin: public, forwarded: []string{"https"}, wantOrigin: public, status: http.StatusNoContent},
		{name: "direct HTTPS", peer: "192.0.2.99:1234", path: owner, origin: public, directScheme: "https", wantOrigin: public, status: http.StatusNoContent},
		{name: "untrusted scheme claim", peer: "192.0.2.99:1234", path: owner, origin: public, forwarded: []string{"https"}, status: http.StatusForbidden},
		{name: "multiple forwarded schemes", peer: "192.0.2.7:1234", path: owner, origin: public, forwarded: []string{"https", "http"}, status: http.StatusForbidden},
		{name: "owner rejects allowed external origin", peer: "192.0.2.7:1234", path: owner, origin: external, forwarded: []string{"https"}, status: http.StatusForbidden},
		{name: "generic reads accept allowed origin", peer: "192.0.2.7:1234", path: "/api/v1/files", origin: external, forwarded: []string{"https"}, wantOrigin: public, status: http.StatusNoContent},
		{name: "malformed origin", peer: "192.0.2.7:1234", path: owner, origin: public + "/", forwarded: []string{"https"}, status: http.StatusForbidden},
		{name: "private headers require trusted hop", peer: "192.0.2.99:1234", path: owner, origin: public, directScheme: "https", unauthenticated: true, status: http.StatusNotFound},
	} {
		t.Run(test.name, func(t *testing.T) {
			upstream := http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
				if origin := httpx.RequestOrigin(request); origin != test.wantOrigin || request.Header.Get("X-NeoCloud-Web-Origin") != origin {
					t.Fatalf("public origin=%q display=%q; want %q", origin, request.Header.Get("X-NeoCloud-Web-Origin"), test.wantOrigin)
				}
				if request.Header.Get("X-Forwarded-Proto") != "" || request.Header.Get(control.WebHeader) != "" || request.Header.Get(control.SchemeHeader) != "" {
					t.Fatal("private or sensitive forwarding metadata leaked to business routes")
				}
				w.WriteHeader(http.StatusNoContent)
			})
			request := httptest.NewRequest(http.MethodPost, public+test.path, nil)
			request.TLS = nil // Go's worker always receives plain HTTP on a private listener.
			if !test.unauthenticated {
				request.Header.Set(control.TokenHeader, token)
			}
			request.Header.Set(control.RemoteHeader, test.peer)
			request.Header.Set(control.WebHeader, "1")
			request.Header.Set(control.SchemeHeader, test.directScheme)
			request.Header.Set("X-NeoCloud-Web-Origin", "https://spoofed.example.test")
			request.Header.Set("Origin", test.origin)
			for _, value := range test.forwarded {
				request.Header.Add("X-Forwarded-Proto", value)
			}
			response := httptest.NewRecorder()
			service.handler(ingress.wrap(upstream), false).ServeHTTP(response, request)
			if response.Code != test.status {
				t.Fatalf("status=%d; want %d: %s", response.Code, test.status, response.Body)
			}
		})
	}
}
