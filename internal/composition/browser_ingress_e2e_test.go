package composition

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"path/filepath"
	"strings"
	"testing"

	"github.com/reina0721/neocloud/internal/nativeupgrade/control"
	"github.com/reina0721/neocloud/pkg/testkit"
)

func TestManagedHTTPSIngressConsoleAndDAV(t *testing.T) {
	const reader = "https://viewer.example.test"
	const setupToken = "browser-ingress-isolated-fixture"
	const workerToken = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	const console = "/api/console/v1"
	const owner = console + "/deployment/owner"
	var proxy http.Handler
	public := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { proxy.ServeHTTP(w, r) }))
	t.Cleanup(public.Close)
	origin := "https://" + public.Listener.Addr().String()
	directory := testkit.PrivateTempDir(t)
	databasePath := filepath.Join(directory, "app.db")
	prepareTodoSchema(t, databasePath)
	configPath := filepath.Join(directory, "config.yaml")
	config := generationConfig(directory, 120, 1<<20, databasePath)
	config = strings.Replace(config, "mode: development-anonymous", "mode: session", 1)
	config = strings.Replace(config, "files:\n", "files:\n  connections:\n    publicOrigin: "+origin+"\n", 1)
	config = strings.Replace(config, "http:\n", "http:\n  trustedProxyCIDRs: [192.0.2.7/32]\n  cors:\n    allowedOrigins: ["+reader+"]\n", 1)
	writeGenerationConfig(t, configPath, "iam:\n  local:\n    setupToken: "+setupToken+"\n"+config)
	worker := newManagedWorkerTest(t, configPath, "v1.0.0")
	for _, request := range []control.Request{{Action: "prepare", Token: workerToken}, {Action: "activate"}, {Action: "publish"}} {
		if err := worker.perform(t.Context(), request); err != nil {
			t.Fatalf("%s managed fixture: %v", request.Action, err)
		}
	}
	upstream := &url.URL{Scheme: "http", Host: worker.metadata.BusinessAddr}
	proxy = &httputil.ReverseProxy{Rewrite: func(request *httputil.ProxyRequest) {
		request.SetURL(upstream)
		request.Out.Host = request.In.Host
		request.Out.Header.Set(control.TokenHeader, workerToken)
		request.Out.Header.Set(control.WebHeader, "1")
		request.Out.Header.Set(control.RemoteHeader, "192.0.2.7:1234")
		request.Out.Header.Set("X-Forwarded-Proto", "https")
	}}
	public.StartTLS()
	client := public.Client()
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	client.Jar = jar
	request := func(method, path string, body io.Reader, headers map[string]string, want int) []byte {
		t.Helper()
		req, err := http.NewRequestWithContext(t.Context(), method, origin+path, body)
		if err != nil {
			t.Fatal(err)
		}
		for name, value := range headers {
			req.Header.Set(name, value)
		}
		response, err := client.Do(req)
		if err != nil {
			t.Fatalf("%s %s: %v", method, path, err)
		}
		defer response.Body.Close()
		data, err := io.ReadAll(io.LimitReader(response.Body, 64<<10))
		if err != nil || response.StatusCode != want {
			t.Fatalf("%s %s: status=%d want=%d read=%v, %s", method, path, response.StatusCode, want, err, data)
		}
		return data
	}
	var csrf struct{ Token string }
	if err := json.Unmarshal(request(http.MethodGet, console+"/auth/csrf", nil, nil, http.StatusOK), &csrf); err != nil || csrf.Token == "" {
		t.Fatalf("CSRF setup failed: %v", err)
	}
	post := func(path string, payload map[string]any) []byte {
		t.Helper()
		data, err := json.Marshal(payload)
		if err != nil {
			t.Fatal(err)
		}
		return request(http.MethodPost, path, bytes.NewReader(data), map[string]string{
			"Content-Type": "application/json", "Origin": origin, "X-CSRF-Token": csrf.Token,
		}, http.StatusOK)
	}
	post(console+"/auth/setup", map[string]any{
		"setupToken": setupToken, "name": "HTTPS ingress fixture", "email": "ingress-fixture@neocloud.test", "password": "ingress-fixture-password",
	})
	post(owner, nil)
	request(http.MethodPost, owner, nil, map[string]string{"Origin": origin}, http.StatusForbidden)
	request(http.MethodPost, owner, nil, map[string]string{"Origin": reader, "X-CSRF-Token": csrf.Token}, http.StatusForbidden)
	var folder struct{ ID string }
	if err := json.Unmarshal(post(console+"/native/files/folders", map[string]any{"name": "HTTPS DAV fixture", "parentId": ""}), &folder); err != nil || folder.ID == "" {
		t.Fatalf("DAV folder setup failed: %v", err)
	}
	var connection struct{ ID, Password, EndpointPath, EndpointOrigin string }
	if err := json.Unmarshal(post(console+"/native/files/connections", map[string]any{"name": "HTTPS DAV fixture", "rootId": folder.ID, "readOnly": false, "blockSystemFiles": true}), &connection); err != nil || connection.EndpointOrigin != origin {
		t.Fatalf("DAV published origin=%q want=%q: %v", connection.EndpointOrigin, origin, err)
	}
	dav := public.Client().Transport
	client = &http.Client{Transport: setFixtureBasicAuth{upstream: dav, id: connection.ID, password: connection.Password}}
	const content = "HTTPS through a trusted proxy"
	request(http.MethodPut, connection.EndpointPath+"source.txt", strings.NewReader(content), nil, http.StatusCreated)
	request("COPY", connection.EndpointPath+"source.txt", nil, map[string]string{"Destination": origin + connection.EndpointPath + "copy.txt"}, http.StatusCreated)
	if got := request(http.MethodGet, connection.EndpointPath+"copy.txt", nil, nil, http.StatusOK); string(got) != content {
		t.Fatal("absolute HTTPS DAV destination changed file bytes")
	}
}

type setFixtureBasicAuth struct {
	upstream     http.RoundTripper
	id, password string
}

func (a setFixtureBasicAuth) RoundTrip(req *http.Request) (*http.Response, error) {
	clone := req.Clone(req.Context())
	clone.SetBasicAuth(a.id, a.password)
	return a.upstream.RoundTrip(clone)
}
