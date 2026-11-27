package deployment

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

type maintenanceSourceTransport func(*http.Request) (*http.Response, error)

func (f maintenanceSourceTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	return f(r)
}

func TestGatewaySubmitsReleaseSource(t *testing.T) {
	for _, tc := range []struct {
		name, action, target string
		source               []string
		offline              bool
		status               int
	}{
		{name: "GitHub", action: "check", source: []string{"github"}, status: http.StatusSeeOther},
		{name: "local check", action: "check", source: []string{"offline"}, offline: true, status: http.StatusSeeOther},
		{name: "local upgrade", action: "upgrade", target: "v1.2.0", source: []string{"offline"}, offline: true, status: http.StatusSeeOther},
		{name: "local rollback", action: "rollback", target: "v1.0.0", offline: true, status: http.StatusSeeOther},
		{name: "local restore", action: "restore", target: "fixture-backup", offline: true, status: http.StatusSeeOther},
		{name: "invalid source", action: "upgrade", source: []string{"/host/assets"}, status: http.StatusBadRequest},
		{name: "ambiguous source", action: "check", source: []string{"offline", "github"}, status: http.StatusBadRequest},
	} {
		t.Run(tc.name, func(t *testing.T) {
			const origin, csrf = "http://localhost", "fixture-csrf"
			var submitted []Request
			gateway := &Gateway{key: make([]byte, 32)}
			gateway.worker = &Client{http: &http.Client{
				Transport: maintenanceSourceTransport(func(r *http.Request) (*http.Response, error) {
					var request Request
					if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
						return nil, err
					}
					submitted = append(submitted, request)
					return &http.Response{StatusCode: http.StatusAccepted, Body: io.NopCloser(strings.NewReader(`{"id":"fixture-job"}`))}, nil
				}),
			}}
			form := url.Values{"csrf": {csrf}, "action": {tc.action}, "target": {tc.target}, "source": tc.source}
			request := httptest.NewRequest(http.MethodPost, origin+MaintenancePath, strings.NewReader(form.Encode()))
			request.RemoteAddr = "127.0.0.1:12345"
			request.Header.Set("Origin", origin)
			request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
			request.AddCookie(&http.Cookie{Name: cookiePrefix + "csrf", Value: gateway.makeToken("csrf", csrf, origin, time.Minute)})
			request.AddCookie(&http.Cookie{Name: cookiePrefix + "recovery", Value: gateway.makeToken("recovery", "authorized", origin, time.Minute)})
			response := httptest.NewRecorder()
			gateway.ServeHTTP(response, request)
			if response.Code != tc.status {
				t.Fatalf("status %d, want %d", response.Code, tc.status)
			}
			if tc.status == http.StatusBadRequest {
				if len(submitted) != 0 {
					t.Fatalf("invalid source reached worker: %+v", submitted)
				}
				return
			}
			if len(submitted) != 1 || submitted[0].Action != tc.action || submitted[0].Target != tc.target || submitted[0].Offline != tc.offline {
				t.Fatalf("unexpected worker request: %+v", submitted)
			}
		})
	}
}

func TestMaintenancePageShowsVerifiedLocalVersions(t *testing.T) {
	page := maintenancePage{
		Authorized: true,
		Permitted:  true,
		IsNewer:    true,
		State: State{
			Current: "v1.1.0",
			Update:  &Release{Version: "v1.3.0", URL: "https://github.com/reina0721/neocloud/releases/tag/v1.3.0"},
			LocalReleases: []Release{
				{Version: "v1.2.0", Notes: "/host/private/assets"},
				{Version: "v1.0.0"},
			},
		},
	}
	var rendered bytes.Buffer
	if err := pageTemplate.Execute(&rendered, page); err != nil {
		t.Fatal(err)
	}
	for _, text := range []string{"检查正式版（GitHub）", "检查本地包", "最新正式版 v1.3.0", "从本地包升级到 v1.2.0", `name="target" value="v1.2.0"`, `name="source" value="offline"`, "此版本较旧"} {
		if !strings.Contains(rendered.String(), text) {
			t.Errorf("maintenance page missing %q", text)
		}
	}
	for _, text := range []string{"/host/private/assets", "从本地包升级到 v1.0.0"} {
		if strings.Contains(rendered.String(), text) {
			t.Errorf("maintenance page exposed %q", text)
		}
	}

	page.LocalCheckError = "上次本地检查未通过"
	rendered.Reset()
	if err := pageTemplate.Execute(&rendered, page); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(rendered.String(), page.LocalCheckError) || strings.Contains(rendered.String(), "从本地包升级到 v1.2.0") {
		t.Error("failed local check left a previous candidate actionable")
	}
}
