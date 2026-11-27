package nativeupgrade

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func testSite(t *testing.T, value string) *webSite {
	t.Helper()
	root := t.TempDir()
	for _, name := range []string{"_next/static", "home/view", "file-viewers/pdf"} {
		if err := os.MkdirAll(filepath.Join(root, name), 0700); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{"index.html", "404.html", "home.html", "login.html", "home/view.html",
		"home/view/__next._tree.txt", "_next/static/a.js", "file-viewers/pdf/reader.mjs", "file-viewers/pdf/reader.wasm"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte(value+":"+name), 0600); err != nil {
			t.Fatal(err)
		}
	}
	s, err := prepareWebSite(root, strings.Repeat(value, 40))
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestStaticWebRoutingAndPreviousAssets(t *testing.T) {
	current, previous := testSite(t, "a"), testSite(t, "b")
	app := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		respond(w, http.StatusNotFound, "api")
	})
	site := current.route(previous, app, app)
	for _, test := range []struct {
		name, method, url, want string
		status                  int
		headers                 http.Header
	}{
		{"root", "GET", "/?preview=123", "", 307, nil},
		{"deep link", "GET", "/home/view?file=123", "a:home/view.html", 200, nil},
		{"head", "HEAD", "/login", "", 200, nil},
		{"not found", "GET", "/not-a-page", "a:404.html", 404, nil},
		{"api 404", "GET", "/api/not-a-route", "\"api\"", 404, nil},
		{"no fallback on POST", "POST", "/home", "", 405, nil},
		{"previous JS", "GET", "/_next/static/a.js?dpl=" + previous.build, "b:_next/static/a.js", 200, nil},
		{"previous flight", "GET", "/home/view/__next._tree.txt", "b:home/view/__next._tree.txt", 200,
			http.Header{"Rsc": {"1"}, "X-Deployment-Id": {previous.build}}},
		{"unknown flight", "GET", "/home/view/__next._tree.txt", "", 404,
			http.Header{"Rsc": {"1"}, "X-Deployment-Id": {strings.Repeat("c", 40)}}},
		{"not a real asset", "GET", "/_next/static/missing.js", "", 404, nil},
		{"not a public file", "GET", "/web-build.json", "", 404, nil},
		{"dot segments", "GET", "/home/%2e%2e/login.html", "", 404, nil},
		{"pdf javascript", "GET", "/file-viewers/pdf/reader.mjs", "a:file-viewers/pdf/reader.mjs", 200, nil},
		{"pdf wasm", "GET", "/file-viewers/pdf/reader.wasm", "a:file-viewers/pdf/reader.wasm", 200, nil},
	} {
		t.Run(test.name, func(t *testing.T) {
			rec, r := httptest.NewRecorder(), httptest.NewRequest(test.method, test.url, nil)
			if test.headers != nil {
				r.Header = test.headers
			}
			site.ServeHTTP(rec, r)
			if rec.Code != test.status || !strings.Contains(rec.Body.String(), test.want) {
				t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
			}
			switch test.name {
			case "root":
				if rec.Header().Get("Location") != "/home?preview=123" {
					t.Fatal("root lost the query")
				}
			case "previous flight":
				if rec.Header().Get("x-nextjs-deployment-id") != previous.build || rec.Header().Get("Cache-Control") != "no-store" {
					t.Fatal("navigation payload was not bound to the previous version")
				}
			case "previous JS":
				if !strings.Contains(rec.Header().Get("Cache-Control"), "immutable") {
					t.Fatal("versioned chunks should be immutable")
				}
			case "pdf javascript":
				if !strings.HasPrefix(rec.Header().Get("Content-Type"), "text/javascript") ||
					!strings.Contains(rec.Header().Get("Content-Security-Policy"), "frame-ancestors 'self'") {
					t.Fatal("PDF protection or MIME is missing")
				}
			case "pdf wasm":
				if rec.Header().Get("Content-Type") != "application/wasm" {
					t.Fatal("incorrect PDF WASM content type")
				}
			}
		})
	}
}

func TestFullJournalCannotBeOpenedAsLegacy(t *testing.T) {
	ctx := context.Background()
	j, _, err := openJournal(ctx, filepath.Join(t.TempDir(), "state.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = j.db.Close() })
	want := State{Current: "v1.2.3", Profile: fullProfile, WebAddress: "127.0.0.1:4180"}
	if err := j.save(ctx, want); err != nil {
		t.Fatal(err)
	}
	var data []byte
	if err := j.db.QueryRowContext(ctx, "SELECT body FROM native_state").Scan(&data); err != nil {
		t.Fatal(err)
	}
	var old State
	if err := json.Unmarshal(data, &old); err != nil || old.Current != "" {
		t.Fatalf("legacy host could pick %q: %v", old.Current, err)
	}
	if got, err := j.load(ctx); err != nil || got != want {
		t.Fatalf("new host did not recover the full pair: %+v, %v", got, err)
	}
}
