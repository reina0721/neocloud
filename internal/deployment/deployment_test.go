//go:build linux

package deployment

import (
	"archive/tar"
	"compress/gzip"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/gofrs/flock"
)

const fromVersion = "v0.1.3"
const toVersion = "v0.2.0"

func fixture(t *testing.T) (*Worker, string) {
	t.Helper()
	root := t.TempDir()
	for _, dir := range []string{".control/maintenance", "backups", "data/storage", "releases/" + fromVersion, "releases/" + toVersion} {
		if err := os.MkdirAll(filepath.Join(root, dir), 0700); err != nil {
			t.Fatal(err)
		}
	}
	for name, contents := range map[string]string{
		".control/project": "clouddrive-12345678abcd", ".control/current": fromVersion,
		".control/maintenance/recovery-token": strings.Repeat("a", 64), "runtime.env": "WEB_PORT=4173",
		"releases/" + fromVersion + "/manifest.txt": "previous source", "releases/" + toVersion + "/manifest.txt": "next source",
		"data/app.db": "SQLite fixture", "data/storage/file": "baseline",
		".control/maintenance/engine.sh": `set -eu
action=$1; root=$3; version=$5
printf '%s %s\n' "$action" "$version" >> "$root/calls"
if [[ -f "$root/fail" ]] && grep -Fqx "$action $version" "$root/fail"; then exit 7; fi
case "$action" in
_capture)
  data="$root/data"
  if [[ -f "$root/.control/data-dir" ]]; then data=$(cat "$root/.control/data-dir"); fi
  tar -C "$data" -czf - . ;;
_extract) tar -C "$CLOUDDRIVE_MAINTENANCE_STAGE" -xzf - ;;
esac
`,
	} {
		if err := os.WriteFile(filepath.Join(root, name), []byte(contents), 0600); err != nil {
			t.Fatal(err)
		}
	}
	cfg := Config{Project: "clouddrive-12345678abcd", Listen: "127.0.0.1:4173", Upstream: "127.0.0.1:44173"}
	w, err := NewWorker(t.Context(), root, cfg)
	if err != nil {
		t.Fatal(err)
	}
	return w, root
}

func submitTest(t *testing.T, w *Worker, action, target, confirm string) Job {
	t.Helper()
	req := Request{ID: RandomID(), Action: action, Target: target, Confirm: confirm, Expected: w.Status().Current, Actor: "owner"}
	job, err := w.Submit(req)
	if err != nil {
		t.Fatal(err)
	}
	if again, err := w.Submit(req); err != nil || again.ID != job.ID {
		t.Fatalf("idempotency: %#v %v", again, err)
	}
	w.Wait()
	state := w.Status()
	return *findJob(&state, job.ID)
}

func TestCompleteRestoreAndRollback(t *testing.T) {
	w, root := fixture(t)
	backup := submitTest(t, w, "backup", "", "")
	if backup.Phase != "succeeded" || backup.Backup == "" {
		t.Fatalf("backup: %+v", backup)
	}
	if err := os.WriteFile(filepath.Join(root, "data/storage/file"), []byte("after snapshot"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := w.Submit(Request{ID: RandomID(), Action: "restore", Target: backup.Backup, Expected: fromVersion, Actor: "owner"}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("missing restore confirmation: %v", err)
	}
	restore := submitTest(t, w, "restore", backup.Backup, backup.Backup)
	if restore.Phase != "succeeded" {
		t.Fatalf("restore: %+v", restore)
	}
	for name, want := range map[string]string{
		"data/storage/file": "baseline",
		".control/maintenance/restore-" + restore.ID + "/original-data/storage/file": "after snapshot",
	} {
		got, err := readText(filepath.Join(root, name))
		if err != nil || got != want {
			t.Fatalf("%s: %q %v", name, got, err)
		}
	}
	if err := w.change(func(s *State) { s.Previous = toVersion }); err != nil {
		t.Fatal(err)
	}
	rollback := submitTest(t, w, "rollback", toVersion, "")
	if rollback.Phase != "succeeded" || w.Status().Current != toVersion {
		t.Fatalf("rollback failed: %+v", rollback)
	}
	got, _ := readText(filepath.Join(root, "data/storage/file"))
	if got != "baseline" {
		t.Fatal("rollback changed live data")
	}
}

func customLayout(t *testing.T) (*Worker, string, string) {
	t.Helper()
	w, root := fixture(t)
	data := filepath.Join(t.TempDir(), "CloudDrive data")
	if err := os.Rename(filepath.Join(root, "data"), data); err != nil {
		t.Fatal(err)
	}
	for name, value := range map[string]string{
		"project": "team-documents", "maintenance-project": w.engine.cfg.Project, "data-dir": data,
	} {
		if err := os.WriteFile(filepath.Join(root, ".control", name), []byte(value+"\n"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	next, err := NewWorker(t.Context(), root, w.engine.cfg)
	if err != nil {
		t.Fatal(err)
	}
	return next, root, data
}

func TestCustomLayoutRestore(t *testing.T) {
	w, root, data := customLayout(t)
	backup := submitTest(t, w, "backup", "", "")
	if backup.Phase != "succeeded" {
		t.Fatalf("backup: %+v", backup)
	}
	const updated = "after snapshot"
	if err := os.WriteFile(filepath.Join(data, "storage", "file"), []byte(updated), 0600); err != nil {
		t.Fatal(err)
	}
	restore := submitTest(t, w, "restore", backup.Backup, backup.Backup)
	if restore.Phase != "succeeded" {
		t.Fatalf("restore: %+v", restore)
	}
	for name, want := range map[string]string{
		filepath.Join(data, "storage", "file"): "baseline",
		filepath.Join(filepath.Dir(data), ".clouddrive-restore-"+restore.ID, "original-data", "storage", "file"): updated,
		filepath.Join(root, ".control", "maintenance", "restore-"+restore.ID, "original.env"):                    "WEB_PORT=4173",
	} {
		got, err := readText(name)
		if err != nil || got != want {
			t.Fatalf("%s: %q %v", name, got, err)
		}
	}
	if _, err := os.Stat(filepath.Join(root, "data")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("restored to default data directory: %v", err)
	}
}

func TestCustomLayoutRestoreRecovery(t *testing.T) {
	for _, tc := range []string{"live directory absent", "replacement installed"} {
		t.Run(tc, func(t *testing.T) {
			w, root, data := customLayout(t)
			backup := submitTest(t, w, "backup", "", "")
			if backup.Phase != "succeeded" {
				t.Fatalf("backup: %+v", backup)
			}
			const updated = "live data before restore"
			if err := os.WriteFile(filepath.Join(data, "storage", "file"), []byte(updated), 0600); err != nil {
				t.Fatal(err)
			}
			const changedConfig = "WEB_PORT=4180"
			configPath := filepath.Join(root, "runtime.env")
			if err := os.WriteFile(configPath, []byte(changedConfig), 0600); err != nil {
				t.Fatal(err)
			}
			id := RandomID()
			if err := w.change(func(s *State) {
				s.Serving = false
				s.Jobs = append(s.Jobs, Job{
					Request:  Request{ID: id, Action: "restore", Target: backup.Backup},
					Original: fromVersion, WasServing: true, Phase: "restore-switch",
				})
			}); err != nil {
				t.Fatal(err)
			}
			stage := filepath.Join(filepath.Dir(data), "restore-stage")
			meta := w.Status().Backups[0]
			if tc == "replacement installed" {
				if err := os.Mkdir(stage, 0700); err != nil {
					t.Fatal(err)
				}
				if err := w.engine.prepareRestore(t.Context(), meta, stage); err != nil {
					t.Fatal(err)
				}
			}
			err := w.engine.beginSwap(id, meta, stage)
			if tc == "replacement installed" && err != nil || tc == "live directory absent" && !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("swap: %v", err)
			}
			next, err := NewWorker(t.Context(), root, w.engine.cfg)
			if err != nil {
				t.Fatal(err)
			}
			state := next.Status()
			if !state.Serving || state.Recovery || findJob(&state, id).Phase != "interrupted" {
				t.Fatalf("recovered state: %+v", state)
			}
			if err := next.engine.undoSwap(id); err != nil {
				t.Fatalf("repeated recovery: %v", err)
			}
			for name, want := range map[string]string{
				filepath.Join(data, "storage", "file"): updated,
				configPath:                             changedConfig,
			} {
				got, err := readText(name)
				if err != nil || got != want {
					t.Fatalf("%s: %q %v", name, got, err)
				}
			}
			if tc == "replacement installed" {
				name := filepath.Join(filepath.Dir(data), ".clouddrive-restore-"+id, "failed-data", "storage", "file")
				if got, err := readText(name); err != nil || got != "baseline" {
					t.Fatalf("failed replacement was not retained: %q %v", got, err)
				}
			}
		})
	}
}

func TestBackupFailureAndInterruptedMigration(t *testing.T) {
	w, root := fixture(t)
	if err := os.WriteFile(filepath.Join(root, "fail"), []byte("_capture "+fromVersion), 0600); err != nil {
		t.Fatal(err)
	}
	failed := submitTest(t, w, "backup", "", "")
	if failed.Phase != "failed" || !w.Status().Serving || w.Status().Recovery {
		t.Fatalf("failure state: %+v", w.Status())
	}
	calls, _ := readText(filepath.Join(root, "calls"))
	if strings.Contains(calls, "_migrate") {
		t.Fatal("failed backup reached migration")
	}
	if err := os.WriteFile(filepath.Join(root, "fail"), []byte("_compat "+fromVersion), 0600); err != nil {
		t.Fatal(err)
	}
	id := RandomID()
	if err := w.change(func(s *State) {
		s.Serving = false
		s.Jobs = append(s.Jobs, Job{Request: Request{ID: id, Action: "upgrade", Target: toVersion}, Original: fromVersion, WasServing: true, Phase: "migrating"})
	}); err != nil {
		t.Fatal(err)
	}
	next, err := NewWorker(t.Context(), root, w.engine.cfg)
	if err != nil {
		t.Fatal(err)
	}
	state := next.Status()
	if !state.Recovery || state.Serving || findJob(&state, id).Phase != "interrupted" {
		t.Fatalf("unsafe restart state: %+v", state)
	}
}

func TestInstallerLockAndVerificationBeforeStop(t *testing.T) {
	w, root := fixture(t)
	lock := flock.New(filepath.Join(root, ".control", "lock"))
	defer lock.Close()
	if err := lock.Lock(); err != nil {
		t.Fatal(err)
	}
	req := Request{ID: RandomID(), Action: "backup", Expected: fromVersion, Actor: "owner"}
	if _, err := w.Submit(req); !errors.Is(err, ErrBusy) {
		t.Fatalf("concurrent installer: %v", err)
	}
	if err := lock.Unlock(); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(root, ".control", "maintenance", "assets", toVersion)
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CLOUDDRIVE_COSIGN", "/bin/false")
	failed := submitTest(t, w, "upgrade", toVersion, "")
	if failed.Phase != "failed" || !w.Status().Serving || w.Status().Current != fromVersion {
		t.Fatalf("unverified assets changed instance: %+v", w.Status())
	}
	if _, err := os.Stat(filepath.Join(root, "calls")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("unverified assets reached Compose: %v", err)
	}
}

func TestSnapshotRefusesTraversalAndCorruption(t *testing.T) {
	for _, name := range []string{"../outside", "/outside", "safe"} {
		t.Run(name, func(t *testing.T) {
			file := filepath.Join(t.TempDir(), "data.tar.gz")
			f, err := os.Create(file)
			if err != nil {
				t.Fatal(err)
			}
			z := gzip.NewWriter(f)
			a := tar.NewWriter(z)
			for _, entry := range []string{"app.db", name} {
				if err := a.WriteHeader(&tar.Header{Name: entry, Size: 1, Mode: 0600, Typeflag: tar.TypeReg}); err != nil {
					t.Fatal(err)
				}
				if _, err := a.Write([]byte{1}); err != nil {
					t.Fatal(err)
				}
			}
			a.Close()
			z.Close()
			f.Close()
			_, err = inspectArchive(t.Context(), file)
			if (err != nil) != (name != "safe") {
				t.Fatalf("archive validation: %v", err)
			}
		})
	}
}

func TestGatewayProofAndMaintenanceWithoutBackend(t *testing.T) {
	w, _ := fixture(t)
	upstream := httptest.NewServer(http.HandlerFunc(func(res http.ResponseWriter, req *http.Request) {
		if req.URL.Path == OwnerPath {
			if req.Header.Get("Cookie") != "app=owner" && !strings.Contains(req.Header.Get("Cookie"), "app=owner;") {
				res.WriteHeader(403)
				return
			}
			if req.Method == http.MethodPost && (req.Header.Get("X-CSRF-Token") != strings.Repeat("c", 64) || req.Header.Get("Origin") == "" || !strings.Contains(req.Header.Get("Cookie"), "app_csrf=")) {
				res.WriteHeader(403)
				return
			}
			_, _ = io.WriteString(res, `{"owner":"owner-a"}`)
			return
		}
		if req.URL.Path == "/api/console/v1/auth/csrf" {
			http.SetCookie(res, &http.Cookie{Name: "app_csrf", Value: strings.Repeat("c", 64)})
			fmt.Fprintf(res, `{"token":"%s"}`, strings.Repeat("c", 64))
			return
		}
		res.WriteHeader(204)
	}))
	defer upstream.Close()
	testWorker := httptest.NewServer(WorkerHandler(w))
	defer testWorker.Close()
	cfg := w.engine.cfg
	cfg.Upstream = strings.TrimPrefix(upstream.URL, "http://")
	g, err := NewGateway(cfg, []byte(strings.Repeat("key!", 8)))
	if err != nil {
		t.Fatal(err)
	}
	g.worker = &Client{http: &http.Client{Transport: rewriteRoundTripper(testWorker.URL)}}
	request := func(method, path, origin, cookie, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "http://127.0.0.1:4173"+path, strings.NewReader(body))
		r.RemoteAddr = "127.0.0.1:1111"
		r.Header.Set("Origin", origin)
		r.Header.Set("Cookie", cookie)
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		out := httptest.NewRecorder()
		g.ServeHTTP(out, r)
		return out
	}
	const origin = "http://127.0.0.1:4173"
	page := request("GET", MaintenancePath, "", "app=owner", "")
	csrf := page.Result().Cookies()[0]
	cookie := "app=owner; " + csrf.Name + "=" + csrf.Value
	value := g.value(makeCookieRequest(csrf), "csrf", origin)
	form := url.Values{"action": {"backup"}, "expected": {fromVersion}, "id": {RandomID()}, "csrf": {value}}
	if out := request("POST", MaintenancePath, "http://evil.test", cookie, form.Encode()); out.Code != 403 {
		t.Fatalf("CSRF %d", out.Code)
	}
	if out := request("POST", MaintenancePath, origin, csrf.Name+"="+csrf.Value, form.Encode()); out.Code != 403 {
		t.Fatalf("non-owner: %d", out.Code)
	}
	out := request("POST", MaintenancePath, origin, cookie, form.Encode())
	if out.Code != 303 {
		t.Fatalf("owner submit: %d %s", out.Code, out.Body)
	}
	receipt := out.Result().Cookies()[0]
	w.Wait()
	if err := w.change(func(s *State) { s.Serving = false }); err != nil {
		t.Fatal(err)
	}
	if got := request("GET", "/dav/node", "", "", ""); got.Code != 503 || got.Header().Get("Retry-After") != "15" {
		t.Fatalf("DAV response %d", got.Code)
	}
	got := request("GET", MaintenancePath, "", receipt.Name+"="+receipt.Value, "")
	if got.Code != 200 || !strings.Contains(got.Body.String(), "操作完成") || strings.Contains(got.Body.String(), "版本</h2>") {
		t.Fatalf("maintenance receipt %d", got.Code)
	}
}

type rewriteRoundTripper string

func (s rewriteRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) {
	address, _ := url.Parse(string(s))
	request.URL.Host = address.Host
	return http.DefaultTransport.RoundTrip(request)
}
func makeCookieRequest(cookie *http.Cookie) *http.Request {
	req := httptest.NewRequest("GET", "http://127.0.0.1:4173/maintenance", nil)
	req.AddCookie(cookie)
	return req
}

func TestGatewayRecognizesOnlyConfiguredTLSProxy(t *testing.T) {
	cfg := Config{Project: "clouddrive-12345678abcd", Listen: "0.0.0.0:4173",
		Upstream: "127.0.0.1:44173", Origin: "https://drive.test", TrustedProxy: "192.0.2.10"}
	gateway, err := NewGateway(cfg, []byte(strings.Repeat("k", 32)))
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		remote, site      string
		secure, permitted bool
	}{
		{"192.0.2.10:6789", "drive.test", true, true},
		{"192.0.2.11:6789", "drive.test", false, false},
		{"192.0.2.10:6789", "foreign.test", false, false},
		{"127.0.0.1:6789", "127.0.0.1:4173", false, true},
		{"192.0.2.11:6789", "127.0.0.1:4173", false, false},
	} {
		req := httptest.NewRequest("POST", "http://"+test.site+MaintenancePath, nil)
		req.RemoteAddr = test.remote
		req.Header.Set("X-Forwarded-Proto", "https")
		_, secure, permitted := gateway.origin(req)
		if secure != test.secure || permitted != test.permitted {
			t.Fatalf("%s %s: secure=%t permitted=%t", test.remote, test.site, secure, permitted)
		}
	}
}

func TestUpgradeFailureKeepsDataAndGatesOldProgram(t *testing.T) {
	for _, run := range []struct {
		name, failures  string
		dirty, migrated bool
	}{
		{"backup fails before migration", "_capture " + fromVersion, false, false},
		{"migration fails with compatible old program", "_migrate " + toVersion, false, true},
		{"new program cannot start with incompatible old program", "_start " + toVersion + "\n_compat " + fromVersion, true, true},
	} {
		t.Run(run.name, func(t *testing.T) {
			w, root := fixture(t)
			t.Setenv("CLOUDDRIVE_COSIGN", "/bin/true")
			cache := filepath.Join(w.engine.control(), "assets", toVersion)
			if err := os.MkdirAll(cache, 0700); err != nil {
				t.Fatal(err)
			}
			name := fmt.Sprintf("clouddrive_%s_linux_%s_docker.tar.gz", toVersion, runtime.GOARCH)
			if err := os.WriteFile(filepath.Join(cache, name), []byte("verified flow fixture"), 0600); err != nil {
				t.Fatal(err)
			}
			digest, err := fileDigest(filepath.Join(cache, name))
			if err != nil {
				t.Fatal(err)
			}
			if err = os.WriteFile(filepath.Join(cache, "checksums.txt"), []byte(digest+"  "+name+"\n"), 0600); err != nil {
				t.Fatal(err)
			}
			if err = os.WriteFile(filepath.Join(root, "fail"), []byte(run.failures), 0600); err != nil {
				t.Fatal(err)
			}
			failed := submitTest(t, w, "upgrade", toVersion, "")
			state := w.Status()
			if failed.Phase != "failed" || state.Current != fromVersion || state.Recovery != run.dirty || state.Serving == run.dirty {
				t.Fatalf("unsafe failed state: %+v", state)
			}
			log, err := readText(filepath.Join(root, "calls"))
			if err != nil {
				t.Fatal(err)
			}
			if strings.Contains(log, "_migrate") != run.migrated {
				t.Fatalf("unexpected migration: %s", log)
			}
			if run.dirty && strings.Contains(log, "_start "+fromVersion) {
				t.Fatalf("old program started against incompatible data: %s", log)
			}
			data, err := readText(filepath.Join(root, "data/storage/file"))
			if err != nil || data != "baseline" {
				t.Fatalf("live file changed: %q %v", data, err)
			}
		})
	}
}
