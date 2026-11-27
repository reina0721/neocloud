package httpbinding

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	permission "github.com/reina0721/clouddrive/internal/permission"
)

func TestReleaseCatalogReusesConsolePermission(t *testing.T) {
	for _, item := range []struct {
		name, method   string
		authenticated  bool
		permissions    []permission.Key
		passwordChange bool
		status         int
	}{
		{name: "invalid method", method: http.MethodPost, status: http.StatusMethodNotAllowed},
		{name: "no session", method: http.MethodGet, status: http.StatusUnauthorized},
		{name: "no permission", method: http.MethodGet, authenticated: true, status: http.StatusForbidden},
		{name: "password change required", method: http.MethodGet, authenticated: true, permissions: []permission.Key{managementRead}, passwordChange: true, status: http.StatusForbidden},
		{name: "permission allowed", method: http.MethodGet, authenticated: true, permissions: []permission.Key{managementRead}, status: http.StatusOK},
	} {
		t.Run(item.name, func(t *testing.T) {
			var upstream bool
			h := Handler{
				authenticateRequest: func(r *http.Request) (*http.Request, error) {
					if !item.authenticated {
						return nil, errors.New("missing session")
					}
					return WithSession(r, Session{Identity: SessionIdentity{Permissions: item.permissions, MustChangePassword: item.passwordChange}}), nil
				},
				releaseCatalog: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					upstream = true
					w.WriteHeader(http.StatusOK)
				}),
			}
			response := httptest.NewRecorder()
			h.ServeHTTP(response, httptest.NewRequest(item.method, ReleaseCatalogPath, nil))
			if response.Code != item.status || upstream != (item.status == http.StatusOK) || response.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("HTTP %d, upstream=%v: %s", response.Code, upstream, response.Body)
			}
			if item.method == http.MethodPost && response.Header().Get("Allow") != "GET" {
				t.Fatal("missing method contract")
			}
		})
	}
}
