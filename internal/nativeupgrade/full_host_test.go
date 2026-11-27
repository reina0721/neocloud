//go:build windows || linux

package nativeupgrade

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/reina0721/neocloud/internal/deployment"
)

func TestManagedFullProcessHandoff(t *testing.T) {
	if testing.Short() {
		t.Skip("requires two compiled native workers")
	}
	repo := fullFixtureRepo(t)
	fixture := buildFullFixture(t, repo, "", "")
	builds := [2]string{fixture[firstVersion].WebID, fixture[secondVersion].WebID}
	root, addresses, site := fullTestRoot(t)
	initializeFullFixture(t, root, fixture[firstVersion].Executable)
	staged := stagedTestReleases{testReleases: fixture, started: make(chan struct{}), proceed: make(chan struct{})}
	stop := startFullFixtureHost(t, root, Bootstrap{Version: firstVersion, Full: true, WebAddress: site}, staged)
	awaitVersion(t, addresses[1], firstVersion)
	owner := openFixtureSession(t, site)
	session := owner.json(t, http.MethodGet, "/auth/session", nil)["sessionId"]
	file := owner.createText(t, "native-full-before.txt", "kept across the paired switch")
	verifyFullLargeDAV(t, openFixtureDAV(t, owner))
	verifyFullFixturePage(t, site, firstVersion, builds[0])
	verifyFullStaticResponse(t, site, "/no-such-route", nil, http.StatusNotFound, "not found")
	verifyFullStaticResponse(t, site, "/_next/static/missing.js", nil, http.StatusNotFound, "")
	verifyFullStaticResponse(t, site, nativeUpdatePath, nil, http.StatusUnauthorized, "")
	update := func(action string) []byte {
		t.Helper()
		payload, err := json.Marshal(jobRequest{Action: action})
		if err != nil {
			t.Fatal(err)
		}
		return payload
	}
	owner.request(t, http.MethodPost, "/deployment/native-update/jobs", update("apply"),
		map[string]string{"Content-Type": "application/json", "Origin": ""}, http.StatusForbidden)
	owner.request(t, http.MethodPost, "/deployment/native-update/jobs", update("apply"),
		map[string]string{"Content-Type": "application/json"}, http.StatusAccepted)
	select {
	case <-staged.started:
	case <-time.After(10 * time.Second):
		t.Fatal("candidate staging did not start")
	}
	verifyFullFixturePage(t, site, firstVersion, builds[0])
	owner.verifyContent(t, file, []byte("kept across the paired switch"))
	close(staged.proceed)
	assertFullJob(t, root, secondVersion)
	awaitVersion(t, addresses[1], secondVersion)
	verifyFullFixturePage(t, site, secondVersion, builds[1])
	verifyFullStaticResponse(t, site, "/_next/static/app.js?dpl="+builds[0], nil, http.StatusOK, firstVersion)
	headers := verifyFullStaticResponse(t, site, "/home.txt", map[string]string{"RSC": "1", "x-deployment-id": builds[0]}, http.StatusOK, firstVersion)
	if headers.Get("x-nextjs-deployment-id") != builds[0] {
		t.Fatalf("old RSC body served with wrong build metadata: %v", headers)
	}
	newFile := owner.createText(t, "native-full-after.txt", "written by the new pair")
	owner.request(t, http.MethodPost, "/deployment/native-update/jobs", update("rollback"),
		map[string]string{"Content-Type": "application/json"}, http.StatusAccepted)
	assertFullJob(t, root, firstVersion)
	awaitVersion(t, addresses[1], firstVersion)
	verifyFullFixturePage(t, site, firstVersion, builds[0])
	if got := owner.json(t, http.MethodGet, "/auth/session", nil)["sessionId"]; session == nil || session != got {
		t.Fatal("paired upgrade and rollback did not preserve the owner's session")
	}
	owner.verifyContent(t, file, []byte("kept across the paired switch"))
	owner.verifyContent(t, newFile, []byte("written by the new pair"))
	stop()
	startFullFixtureHost(t, root, Bootstrap{}, fixture)
	awaitVersion(t, addresses[1], firstVersion)
	verifyFullFixturePage(t, site, firstVersion, builds[0])
}

func verifyFullLargeDAV(t *testing.T, dav *fixtureDAVClient) {
	t.Helper()
	const size = 33 << 20
	content := bytes.Repeat([]byte("native-full-dav"), size/len("native-full-dav")+1)[:size]
	for _, fixed := range []bool{true, false} {
		name := "chunked.bin"
		var body io.Reader = struct{ io.Reader }{bytes.NewReader(content)}
		if fixed {
			name = "fixed.bin"
			body = bytes.NewReader(content)
		}
		dav.request(t, http.MethodPut, name, body, nil, http.StatusCreated)
		request, err := http.NewRequestWithContext(t.Context(), http.MethodGet, dav.base+dav.endpoint+name, nil)
		if err != nil {
			t.Fatal(err)
		}
		request.SetBasicAuth(dav.account, dav.password)
		response, err := dav.client.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		digest := sha256.New()
		count, readErr := io.Copy(digest, io.LimitReader(response.Body, size+1))
		want := sha256.Sum256(content)
		if err := errors.Join(readErr, response.Body.Close()); err != nil || response.StatusCode != http.StatusOK || count != size || !bytes.Equal(digest.Sum(nil), want[:]) {
			t.Fatalf("large DAV %s readback: HTTP %d, %d bytes, SHA-256 %x, err %v", name, response.StatusCode, count, digest.Sum(nil), err)
		}
		// Exercise a distinct blob on the next upload.
		content[0] ^= 0xFF
	}
}

func fullFixtureRepo(t *testing.T) string {
	t.Helper()
	repo, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	return repo
}

func buildFullFixture(t *testing.T, repo, exportDirectory, exportID string) testReleases {
	t.Helper()
	versions := t.TempDir()
	fixture := testReleases{}
	var previousCommit string
	for index, version := range []string{firstVersion, secondVersion} {
		commit := strings.Repeat(fmt.Sprint(index+1), 40)
		executable := filepath.Join(versions, version+"-clouddrive")
		if runtime.GOOS == "windows" {
			executable += ".exe"
		}
		// #nosec G204 -- Fixed repository command with isolated fixture paths and identities.
		build := exec.CommandContext(t.Context(), "go", "build", "-ldflags",
			"-X main.buildVersion="+version+" -X main.buildCommit="+commit, "-o", executable, "./cmd/app")
		build.Dir = repo
		if data, err := build.CombinedOutput(); err != nil {
			t.Fatalf("build %s: %v\n%s", version, err, data)
		}
		manifest := deployment.NativeManifest{Version: version, Commit: commit, Profile: deployment.NativeFull, WebID: commit}
		if index == 1 {
			manifest.FromVersion, manifest.FromCommit = firstVersion, previousCommit
		}
		web := exportDirectory
		if web == "" {
			web = filepath.Join(versions, version+"-web")
			writeFullWebFixture(t, web, version)
		} else {
			manifest.WebID = exportID
		}
		fixture[version] = deployment.NativeTarget{Manifest: manifest, Executable: executable, Directory: versions, WebDirectory: web, WebID: manifest.WebID}
		previousCommit = commit
	}
	return fixture
}

// This release gate executes the exact host and worker binaries shipped in
// the independently verified draft. The regular test suite has no signed draft.
func TestSignedFullReleaseBoot(t *testing.T) {
	release := os.Getenv("CLOUDDRIVE_TEST_NATIVE_RELEASE_DIR")
	trust := os.Getenv("CLOUDDRIVE_TEST_NATIVE_TRUST_DIR")
	version := os.Getenv("CLOUDDRIVE_TEST_NATIVE_TAG")
	commit := os.Getenv("CLOUDDRIVE_TEST_NATIVE_COMMIT")
	if release == "" && trust == "" && version == "" && commit == "" {
		t.Skip("no signed release draft supplied")
	}
	if release == "" || trust == "" || version == "" || commit == "" {
		t.Fatal("incomplete signed native release fixture")
	}
	root, addresses, site := fullTestRoot(t)
	target, err := deployment.ImportNativeFor(t.Context(), filepath.Join(root, controlDirectory, "versions"),
		release, trust, version, deployment.NativeFull)
	if err != nil || target.WebID != commit {
		t.Fatalf("signed full import: %v, Web identity %q, want %q", err, target.WebID, commit)
	}
	initializeFullFixture(t, root, target.Executable)
	// #nosec G204 -- The program is the verified host from the exact signed draft under test.
	cmd := exec.CommandContext(t.Context(), target.HostExecutable, "--root", root, "--full",
		"--initial", version, "--web-addr", site, "--release-dir", release, "--trust-dir", trust)
	cmd.Dir = root
	// Keep the binary-only runtime honest even though the CI runner has Node.
	cmd.Env = append(cmd.Environ(), "PATH=")
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	// testing 在 Cleanup 前取消 t.Context，由 CommandContext 终止进程。
	t.Cleanup(func() { _ = cmd.Wait() })
	awaitVersion(t, addresses[1], version)
	verifyFullStaticResponse(t, site, "/login", nil, http.StatusOK, "<html")
	verifyFullStaticResponse(t, site, "/home", nil, http.StatusOK, "<html")
	verifyFullStaticResponse(t, site, webBuildPath, nil, http.StatusOK, commit)
	verifyFullStaticResponse(t, site, "/does-not-exist", nil, http.StatusNotFound, "<html")
	owner := openFixtureSession(t, site)
	file := owner.createText(t, "signed-native-draft.txt", "written through the shipped native package")
	owner.verifyContent(t, file, []byte("written through the shipped native package"))
}

// The opt-in browser run serves an actual static export and sends the browser
// through a native full host. Release selection is a fixture in this test.
func TestManagedFullBrowser(t *testing.T) {
	directory := os.Getenv("CLOUDDRIVE_TEST_MANAGED_WEB_DIR")
	if directory == "" {
		t.Skip("no static export supplied for browser acceptance")
	}
	web, err := os.OpenRoot(directory)
	if err != nil {
		t.Fatal(err)
	}
	data, err := web.ReadFile("web-build.json")
	if err = errors.Join(err, web.Close()); err != nil {
		t.Fatal(err)
	}
	var identity struct {
		BuildID string `json:"buildId"`
	}
	if err := json.Unmarshal(data, &identity); err != nil || !webBuildID.MatchString(identity.BuildID) {
		t.Fatalf("actual static export has no valid identity: %v", err)
	}
	repo := fullFixtureRepo(t)
	fixture := buildFullFixture(t, repo, directory, identity.BuildID)
	root, addresses, site := fullTestRoot(t)
	initializeFullFixture(t, root, fixture[firstVersion].Executable)
	startFullFixtureHost(t, root, Bootstrap{Version: firstVersion, Full: true, WebAddress: site}, fixture)
	awaitVersion(t, addresses[1], firstVersion)
	openFixtureSession(t, site)

	ctx, cancel := context.WithTimeout(t.Context(), 4*time.Minute)
	defer cancel()
	// #nosec G204 -- Run the checked-in acceptance script against this isolated site.
	browser := exec.CommandContext(ctx, "node", "frontend/tooling/native-managed-browser.mjs")
	browser.Dir = repo
	browser.Env = append(browser.Environ(),
		"CLOUDDRIVE_NATIVE_BROWSER_ORIGIN=http://"+site,
		"CLOUDDRIVE_NATIVE_BROWSER_SETUP_TOKEN="+fixtureSetupToken,
		"CLOUDDRIVE_NATIVE_BROWSER_EMAIL=native-upgrade@clouddrive.test",
		"CLOUDDRIVE_NATIVE_BROWSER_PASSWORD=native-upgrade-fixture-owner-password",
	)
	if data, err := browser.CombinedOutput(); err != nil {
		t.Fatalf("native browser acceptance: %v\n%s", err, data)
	} else {
		t.Logf("%s", data)
	}
}

func fullTestRoot(t *testing.T) (string, [2]string, string) {
	t.Helper()
	for _, value := range os.Environ() {
		name, _, _ := strings.Cut(value, "=")
		if strings.HasPrefix(strings.ToUpper(name), "APP_") {
			t.Setenv(name, "")
			if err := os.Unsetenv(name); err != nil {
				t.Fatal(err)
			}
		}
	}
	temporaryRoot, err := os.MkdirTemp("", "cduf-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(temporaryRoot) })
	// Windows runner 的临时目录可能使用 8.3 短路径。
	root, err := canonicalRoot(temporaryRoot)
	if err != nil {
		t.Fatal(err)
	}
	addresses := [2]string{unusedAddress(t), unusedAddress(t)}
	t.Setenv("APP_HTTP__ADDR", addresses[0])
	t.Setenv("APP_MANAGEMENT__ADDR", addresses[1])
	t.Setenv("APP_IAM__LOCAL__SETUPTOKEN", fixtureSetupToken)
	t.Setenv("APP_IAM__LOCAL__ALLOWINSECUREHTTP", "true")
	return root, addresses, unusedAddress(t)
}

func initializeFullFixture(t *testing.T, root, app string) {
	t.Helper()
	for _, args := range [][]string{{"config", "init"}, {"db", "migrate", "up"}} {
		// #nosec G204 -- This fixture initializes only its disposable instance directory.
		command := exec.CommandContext(t.Context(), app, args...)
		command.Dir = root
		if data, err := command.CombinedOutput(); err != nil {
			t.Fatalf("initialize full package %v: %v\n%s", args, err, data)
		}
	}
}

func writeFullWebFixture(t *testing.T, web, version string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(web, "_next/static"), 0700); err != nil {
		t.Fatal(err)
	}
	for name, content := range map[string]string{
		"index.html": "<html>" + version, "login.html": "<html>" + version, "home.html": "<html>" + version,
		"404.html": "<html>not found", "home.txt": version, "_next/static/app.js": "const version = " + version,
	} {
		if err := os.WriteFile(filepath.Join(web, name), []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
}

func startFullFixtureHost(t *testing.T, root string, initial Bootstrap, releases releaseSource) func() {
	t.Helper()
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan error, 1)
	go func() { done <- runProfile(ctx, root, initial, releases) }()
	stop := sync.OnceFunc(func() {
		cancel()
		select {
		case err := <-done:
			if err != nil {
				t.Errorf("full host exit: %v", err)
			}
		case <-time.After(20 * time.Second):
			t.Error("full host did not exit")
		}
	})
	t.Cleanup(stop)
	return stop
}

func assertFullJob(t *testing.T, root, version string) {
	t.Helper()
	status := awaitJob(t, root)
	if status.Job.Phase != "succeeded" || status.Current != version {
		t.Fatalf("paired switch: state %+v, job %+v", status, status.Job)
	}
}

func verifyFullFixturePage(t *testing.T, site, version, build string) {
	t.Helper()
	verifyFullStaticResponse(t, site, "/home?folder=root", nil, http.StatusOK, version)
	verifyFullStaticResponse(t, site, webBuildPath, nil, http.StatusOK, build)
	verifyFullStaticResponse(t, site, "/_next/static/app.js?dpl="+build, nil, http.StatusOK, version)
}

func verifyFullStaticResponse(t *testing.T, site, path string, headers map[string]string, want int, content string) http.Header {
	t.Helper()
	client := &http.Client{Timeout: 5 * time.Second}
	defer client.CloseIdleConnections()
	request, err := http.NewRequestWithContext(t.Context(), http.MethodGet, "http://"+site+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	for key, value := range headers {
		request.Header.Set(key, value)
	}
	resp, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 8192))
	if err = errors.Join(err, resp.Body.Close()); err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != want || !bytes.Contains(body, []byte(content)) {
		t.Fatalf("GET %s: HTTP %d, want %d and %q body", path, resp.StatusCode, want, content)
	}
	return resp.Header
}
