//go:build windows || linux

package nativeupgrade

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/reina0721/neocloud/internal/deployment"
	"github.com/reina0721/neocloud/internal/module/migration"
	"github.com/reina0721/neocloud/pkg/database"
	dbmigrate "github.com/reina0721/neocloud/pkg/database/migrate"
)

const firstVersion = "v0.9.10"
const secondVersion = "v0.9.11"
const fixtureSetupToken = "native-upgrade-fixture-setup-seed-001"

type testReleases map[string]deployment.NativeTarget

func (testReleases) Latest(context.Context) (deployment.Release, error) {
	return deployment.Release{Version: secondVersion}, nil
}
func (testReleases) NativeCandidates(context.Context, string) ([]string, error) {
	return []string{secondVersion}, nil
}
func (f testReleases) StageNative(ctx context.Context, root, version string) (deployment.NativeTarget, error) {
	return f.LoadNative(ctx, root, version)
}
func (f testReleases) LoadNative(_ context.Context, _, version string) (deployment.NativeTarget, error) {
	target, ok := f[version]
	if !ok {
		return deployment.NativeTarget{}, errors.New("unknown fixture release")
	}
	return target, nil
}

type stagedTestReleases struct {
	testReleases
	started, proceed chan struct{}
}

func (f stagedTestReleases) StageNative(ctx context.Context, root, version string) (deployment.NativeTarget, error) {
	if version == secondVersion {
		close(f.started)
		select {
		case <-ctx.Done():
			return deployment.NativeTarget{}, ctx.Err()
		case <-f.proceed:
		}
	}
	return f.testReleases.StageNative(ctx, root, version)
}

// Real native processes exercise the upgrade path. Only the release source is
// replaced, so these fixtures never fetch or apply software to a live instance.
func TestManagedNativeProcessUpgrade(t *testing.T) {
	if testing.Short() {
		t.Skip("requires building native worker processes")
	}
	repo, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	builds := t.TempDir()
	apiMigration, overlay := migrationCandidate(t, repo, builds)
	fixture := testReleases{}
	previous := strings.Repeat("1", 40)
	for index, version := range []string{firstVersion, secondVersion} {
		commit := strings.Repeat(fmt.Sprint(index+1), 40)
		executable := filepath.Join(builds, version+"-clouddrive")
		if runtime.GOOS == "windows" {
			executable += ".exe"
		}
		args := []string{"build", "-ldflags=-X main.buildVersion=" + version + " -X main.buildCommit=" + commit, "-o", executable}
		if index == 1 {
			args = append(args, "-overlay", overlay)
		}
		args = append(args, "./cmd/app")
		// #nosec G204 -- Test uses fixed repo paths and fixture build metadata.
		command := exec.CommandContext(t.Context(), "go", args...)
		command.Dir = repo
		if out, err := command.CombinedOutput(); err != nil {
			t.Fatalf("build %s: %v\n%s", version, err, out)
		}
		manifest := deployment.NativeManifest{Version: version, Commit: commit}
		if index == 1 {
			manifest.FromVersion, manifest.FromCommit, manifest.OnlinePlans = firstVersion, previous, apiMigration
		}
		fixture[version] = deployment.NativeTarget{Manifest: manifest, Executable: executable, Directory: builds}
	}
	drivers := []struct{ name, dsn string }{
		{"sqlite", ""},
		{"postgres", os.Getenv("CLOUDDRIVE_TEST_POSTGRES_DSN")},
		{"mysql", os.Getenv("CLOUDDRIVE_TEST_MYSQL_DSN")},
	}
	for _, driver := range drivers {
		t.Run(driver.name, func(t *testing.T) {
			if driver.name != "sqlite" && driver.dsn == "" {
				t.Skip("no isolated external database configured")
			}
			exerciseManagedProcess(t, fixture, driver.name, driver.dsn)
		})
	}
}

func migrationCandidate(t *testing.T, repo, builds string) (map[string]json.RawMessage, string) {
	t.Helper()
	dir := filepath.Join(repo, "internal", "module", "todo", "binding", "migration")
	set, err := os.ReadFile(filepath.Join(dir, "set.go"))
	if err != nil {
		t.Fatal(err)
	}
	source := strings.Replace(string(set), "CurrentVersion uint = 1", "CurrentVersion uint = 2", 1)
	if source == string(set) {
		t.Fatal("the managed upgrade fixture expects the baseline Todo migration set at version 1")
	}
	replace := make(map[string]string)
	plans := make(map[string]json.RawMessage)
	operation := dbmigrate.OnlineOperation{Kind: dbmigrate.OnlineAddColumn, Table: "todos", Columns: []dbmigrate.OnlineColumn{{Name: "upgrade_note", Type: "text", Nullable: true}}}
	var entries strings.Builder
	write := func(relative string, data []byte) {
		t.Helper()
		file := filepath.Join(builds, strings.ReplaceAll(relative, "/", "-"))
		if err := os.WriteFile(file, data, 0600); err != nil {
			t.Fatal(err)
		}
		replace[filepath.Join(dir, relative)] = file
	}
	for _, driver := range []database.Driver{database.DriverSQLite, database.DriverPostgres, database.DriverMySQL} {
		ddl, err := dbmigrate.OnlineSQL(driver, operation)
		if err != nil {
			t.Fatal(err)
		}
		migrationName := string(driver) + "/000002_upgrade_note.up.sql"
		payload := []byte(ddl + "\n")
		digest := fmt.Sprintf("%x", sha256.Sum256(payload))
		write(migrationName, payload)
		fmt.Fprintf(&entries, "\n%q: %q,", migrationName, digest)
		plan, err := json.Marshal(migration.OnlinePlan{Driver: driver, Steps: []migration.OnlineStep{{ModuleID: "todo", From: 1, To: 2, SHA256: digest, Operation: operation}}})
		if err != nil {
			t.Fatal(err)
		}
		plans[string(driver)] = plan
	}
	source = strings.Replace(source, "SHA256ByFile: map[string]string{", "SHA256ByFile: map[string]string{"+entries.String(), 1)
	write("set.go", []byte(source))
	data, err := json.Marshal(struct{ Replace map[string]string }{replace})
	if err != nil {
		t.Fatal(err)
	}
	overlay := filepath.Join(builds, "overlay.json")
	if err := os.WriteFile(overlay, data, 0600); err != nil {
		t.Fatal(err)
	}
	return plans, overlay
}

func exerciseManagedProcess(t *testing.T, releases testReleases, driver, dsn string) {
	t.Helper()
	for _, entry := range os.Environ() {
		name, _, _ := strings.Cut(entry, "=")
		if strings.HasPrefix(strings.ToUpper(name), "APP_") {
			t.Setenv(name, "")
			if err := os.Unsetenv(name); err != nil {
				t.Fatal(err)
			}
		}
	}
	// Keep paths short enough for Linux Unix-domain sockets even in deep checkouts.
	root, err := os.MkdirTemp("", "cdu-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	public := [2]string{unusedAddress(t), unusedAddress(t)}
	t.Setenv("APP_HTTP__ADDR", public[0])
	t.Setenv("APP_MANAGEMENT__ADDR", public[1])
	t.Setenv("APP_IAM__LOCAL__SETUPTOKEN", fixtureSetupToken)
	t.Setenv("APP_IAM__LOCAL__ALLOWINSECUREHTTP", "true")
	t.Setenv("APP_DATABASE__DRIVER", driver)
	if dsn != "" {
		t.Setenv("APP_DATABASE__DSN", dsn)
	}
	for _, args := range [][]string{{"config", "init"}, {"db", "migrate", "up"}} {
		// #nosec G204 -- Test starts only its compiled fixture worker.
		command := exec.CommandContext(t.Context(), releases[firstVersion].Executable, args...)
		command.Dir = root
		if out, err := command.CombinedOutput(); err != nil {
			t.Fatalf("initialize fixture %v: %v\n%s", args, err, out)
		}
	}
	staging := stagedTestReleases{testReleases: releases, started: make(chan struct{}), proceed: make(chan struct{})}
	stop := startFixtureHost(t, root, firstVersion, staging)
	awaitVersion(t, public[1], firstVersion)
	status := commandState(t, root)
	if status.Driver != driver || status.Addresses != public {
		t.Fatalf("unexpected instance identity: %+v", status)
	}
	business := openFixtureSession(t, public[0])
	sessionID := business.json(t, http.MethodGet, "/auth/session", nil)["sessionId"]
	if sessionID == nil || sessionID == "" {
		t.Fatal("initial authenticated session has no identity")
	}
	const oldContent = "acknowledged before changing the worker"
	const stagingContent = "acknowledged while the candidate release is staged"
	const newContent = "acknowledged by the upgraded worker"
	oldFile := business.createText(t, "before-update.txt", oldContent)
	business.verifyContent(t, oldFile, []byte(oldContent))
	dav := openFixtureDAV(t, business)
	beforeDAV := bytes.Repeat([]byte("a"), 513)
	afterDAV := []byte("written by the upgraded WebDAV worker")
	dav.request(t, http.MethodPut, "before-update.bin", struct{ io.Reader }{bytes.NewReader(beforeDAV)}, nil, http.StatusCreated)
	dav.verifyContent(t, "before-update.bin", beforeDAV)
	transfer := []byte("acknowledged chunks survive worker replacement")
	digest := sha256.Sum256(transfer)
	transferID := fixtureID(t, business.json(t, http.MethodPost, "/native/files/transfers", map[string]any{
		"name": "resume-across-upgrade.bin", "parentId": "", "key": "native-upgrade-tus", "sizeBytes": len(transfer), "sha256": fmt.Sprintf("%x", digest),
	}), "id")
	transferPath := "/native/files/transfers/" + transferID
	const split = 16
	business.patch(t, transferPath, transfer[:split], 0, split)
	var stagingFile, newFile, uploadedFile string
	for _, operation := range []struct{ action, want string }{{"apply", secondVersion}, {"rollback", firstVersion}} {
		if operation.action == "rollback" {
			dav.verifyDrainTimeout(t, root, public)
		}
		// #nosec G204 -- Invoke the actual CLI from the isolated worker build.
		command := exec.CommandContext(t.Context(), releases[firstVersion].Executable, "update", operation.action, "--root", root)
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("update CLI %s: %v\n%s", operation.action, err, output)
		}
		if operation.action == "apply" {
			select {
			case <-staging.started:
			case <-time.After(5 * time.Second):
				t.Fatal("upgrade never started loading the candidate")
			}
			stagingFile = business.createText(t, "during-staging.txt", stagingContent)
			business.verifyContent(t, stagingFile, []byte(stagingContent))
			close(staging.proceed)
		}
		status := awaitJob(t, root)
		if status.Job.Phase != "succeeded" || status.Current != operation.want || status.Addresses != public {
			t.Fatalf("%s: %+v / %+v", operation.action, status, status.Job)
		}
		if operation.action == "apply" && status.Job.Backup == "" {
			t.Fatal("no durable online-migration recovery point")
		}
		awaitVersion(t, public[1], operation.want)
		if current := business.json(t, http.MethodGet, "/auth/session", nil)["sessionId"]; current != sessionID {
			t.Fatalf("%s replaced the existing session", operation.action)
		}
		business.verifyContent(t, oldFile, []byte(oldContent))
		business.verifyContent(t, stagingFile, []byte(stagingContent))
		dav.verifyContent(t, "before-update.bin", beforeDAV)
		if operation.action == "apply" {
			newFile = business.createText(t, "after-update.txt", newContent)
			dav.request(t, http.MethodPut, "after-update.bin", bytes.NewReader(afterDAV), nil, http.StatusCreated)
			_, headers := business.request(t, http.MethodHead, transferPath+"/data", nil, map[string]string{"Tus-Resumable": "1.0.0"}, http.StatusOK)
			if got := headers.Get("Upload-Offset"); got != fmt.Sprint(split) {
				t.Fatalf("upload offset after upgrade: %s, want %d", got, split)
			}
			business.patch(t, transferPath, transfer[split:], split, len(transfer))
			uploadedFile = fixtureID(t, business.json(t, http.MethodPost, transferPath+"/commit", nil), "entryId")
		}
		business.verifyContent(t, newFile, []byte(newContent))
		business.verifyContent(t, uploadedFile, transfer)
		dav.verifyContent(t, "after-update.bin", afterDAV)
		if operation.action == "rollback" {
			const rolledBackContent = "acknowledged after rolling back with the expanded schema"
			file := business.createText(t, "after-rollback.txt", rolledBackContent)
			business.verifyContent(t, file, []byte(rolledBackContent))
			listing := dav.request(t, "PROPFIND", "", nil, map[string]string{"Depth": "1"}, http.StatusMultiStatus)
			if !bytes.Contains(listing, []byte("before-update.bin")) || !bytes.Contains(listing, []byte("after-update.bin")) || !bytes.Contains(listing, []byte("drain-timeout.bin")) {
				t.Fatal("WebDAV listing after rollback did not preserve all verified files")
			}
		}
	}
	persisted := commandState(t, root)
	stop()
	persisted.Job = &Job{ID: "interrupted-fixture", Action: "apply", Target: secondVersion, Phase: "handoff", StartedAt: time.Now()}
	journal, _, err := openJournal(t.Context(), filepath.Join(root, controlDirectory, "state.db"))
	if err != nil {
		t.Fatal(err)
	}
	if err := errors.Join(journal.save(t.Context(), persisted), journal.db.Close()); err != nil {
		t.Fatal(err)
	}
	startFixtureHost(t, root, "", releases)
	awaitVersion(t, public[1], firstVersion)
	restored := commandState(t, root)
	if restored.Job.Phase != "interrupted" || restored.Current != firstVersion || restored.Transition != secondVersion {
		t.Fatalf("restart did not restore the durable handoff state: %+v / %+v", restored, restored.Job)
	}
	if current := business.json(t, http.MethodGet, "/auth/session", nil)["sessionId"]; current != sessionID {
		t.Fatal("host restart replaced the existing session")
	}
	business.verifyContent(t, newFile, []byte(newContent))
	business.verifyContent(t, uploadedFile, transfer)
}

func startFixtureHost(t *testing.T, root, initial string, releases releaseSource) func() {
	t.Helper()
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan error, 1)
	go func() { done <- run(ctx, root, initial, releases) }()
	stop := sync.OnceFunc(func() {
		cancel()
		select {
		case err := <-done:
			if err != nil {
				t.Errorf("host exit: %v", err)
			}
		case <-time.After(20 * time.Second):
			t.Error("host did not exit")
		}
	})
	t.Cleanup(stop)
	return stop
}

type fixtureDAVClient struct {
	base, endpoint, account, password string
	client                            *http.Client
}

func openFixtureDAV(t *testing.T, business *fixtureBusinessClient) *fixtureDAVClient {
	t.Helper()
	root := fixtureID(t, business.json(t, http.MethodPost, "/native/files/folders", map[string]string{
		"name": "Verified WebDAV handoff", "parentId": "",
	}), "id")
	connection := business.json(t, http.MethodPost, "/native/files/connections", map[string]any{
		"name": "Native upgrade WebDAV fixture", "rootId": root, "readOnly": false, "blockSystemFiles": true,
	})
	dav := &fixtureDAVClient{
		base: business.base, endpoint: fixtureID(t, connection, "endpointPath"),
		account: fixtureID(t, connection, "id"), password: fixtureID(t, connection, "password"),
		client: &http.Client{Timeout: 8 * time.Second},
	}
	t.Cleanup(dav.client.CloseIdleConnections)
	return dav
}

func (c *fixtureDAVClient) request(t *testing.T, method, path string, body io.Reader, headers map[string]string, status int) []byte {
	t.Helper()
	request, err := http.NewRequestWithContext(t.Context(), method, c.base+c.endpoint+path, body)
	if err != nil {
		t.Fatal(err)
	}
	request.SetBasicAuth(c.account, c.password)
	for key, value := range headers {
		request.Header.Set(key, value)
	}
	response, err := c.client.Do(request)
	if err != nil {
		t.Fatalf("DAV %s %s: %v", method, path, err)
	}
	data, readErr := io.ReadAll(io.LimitReader(response.Body, 8192))
	if err := errors.Join(readErr, response.Body.Close()); err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != status {
		t.Fatalf("DAV %s %s: HTTP %d, want %d: %s", method, path, response.StatusCode, status, data)
	}
	return data
}

func (c *fixtureDAVClient) verifyContent(t *testing.T, path string, want []byte) {
	t.Helper()
	if got := c.request(t, http.MethodGet, path, nil, nil, http.StatusOK); !bytes.Equal(got, want) {
		t.Fatalf("WebDAV content changed for %s", path)
	}
}

func (c *fixtureDAVClient) verifyDrainTimeout(t *testing.T, root string, public [2]string) {
	t.Helper()
	const filename = "drain-timeout.bin"
	const content = "admitted stream survives the drain deadline"
	wait, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	conn, err := (&net.Dialer{}).DialContext(wait, "tcp", public[0])
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err := conn.SetDeadline(time.Now().Add(30 * time.Second)); err != nil {
		t.Fatal(err)
	}
	credentials := base64.StdEncoding.EncodeToString([]byte(c.account + ":" + c.password))
	if _, err := fmt.Fprintf(conn, "PUT %s%s HTTP/1.1\r\nHost: %s\r\nAuthorization: Basic %s\r\nContent-Length: %d\r\nExpect: 100-continue\r\nConnection: close\r\n\r\n", c.endpoint, filename, public[0], credentials, len(content)); err != nil {
		t.Fatal(err)
	}
	reader := bufio.NewReader(conn)
	readResponse := func(status int) {
		t.Helper()
		response, err := http.ReadResponse(reader, &http.Request{Method: http.MethodPut})
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		if response.StatusCode != status {
			t.Fatalf("streamed WebDAV response HTTP %d, want %d", response.StatusCode, status)
		}
	}
	// The 100 proves the public gateway already admitted the request and is reading its held body.
	readResponse(http.StatusContinue)
	var output bytes.Buffer
	if err := executeCommand(t.Context(), &output, "rollback", root, ""); err != nil {
		t.Fatal(err)
	}
	state := awaitJob(t, root)
	if state.Current != secondVersion || state.Job.Phase != "failed" || !strings.Contains(state.Job.Result, "在途请求未能及时排空") {
		t.Fatalf("a long WebDAV request did not preserve the current worker at the drain deadline: %+v / %+v", state, state.Job)
	}
	awaitVersion(t, public[1], secondVersion)
	if _, err := io.WriteString(conn, content); err != nil {
		t.Fatal(err)
	}
	readResponse(http.StatusCreated)
	c.verifyContent(t, filename, []byte(content))
}

type fixtureBusinessClient struct {
	base, csrf string
	client     *http.Client
}

func openFixtureSession(t *testing.T, address string) *fixtureBusinessClient {
	t.Helper()
	open := func() *fixtureBusinessClient {
		jar, err := cookiejar.New(nil)
		if err != nil {
			t.Fatal(err)
		}
		client := &fixtureBusinessClient{base: "http://" + address, client: &http.Client{Timeout: 5 * time.Second, Jar: jar}}
		t.Cleanup(client.client.CloseIdleConnections)
		client.csrf = fixtureID(t, client.json(t, http.MethodGet, "/auth/csrf", nil), "token")
		return client
	}
	const email = "native-upgrade@clouddrive.test"
	const password = "native-upgrade-fixture-owner-password"
	open().json(t, http.MethodPost, "/auth/setup", map[string]string{
		"setupToken": fixtureSetupToken, "email": email, "password": password, "name": "Native upgrade fixture",
	})
	client := open()
	client.json(t, http.MethodPost, "/auth/login", map[string]string{"email": email, "password": password})
	return client
}

func (c *fixtureBusinessClient) json(t *testing.T, method, path string, value any) map[string]any {
	t.Helper()
	var payload []byte
	if value != nil {
		var err error
		payload, err = json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
	}
	raw, _ := c.request(t, method, path, payload, map[string]string{"Content-Type": "application/json"}, http.StatusOK)
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	return decoded
}

func (c *fixtureBusinessClient) request(t *testing.T, method, path string, payload []byte, headers map[string]string, status int) ([]byte, http.Header) {
	t.Helper()
	request, err := http.NewRequestWithContext(t.Context(), method, c.base+"/api/console/v1"+path, bytes.NewReader(payload))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Origin", c.base)
	request.Header.Set("X-CSRF-Token", c.csrf)
	for key, value := range headers {
		request.Header.Set(key, value)
	}
	response, err := c.client.Do(request)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	data, readErr := io.ReadAll(io.LimitReader(response.Body, 8192))
	if err := errors.Join(readErr, response.Body.Close()); err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != status {
		t.Fatalf("%s %s: HTTP %d, want %d: %s", method, path, response.StatusCode, status, data)
	}
	return data, response.Header
}

func fixtureID(t *testing.T, data map[string]any, key string) string {
	t.Helper()
	id, ok := data[key].(string)
	if !ok || id == "" {
		t.Fatalf("response does not contain %q", key)
	}
	return id
}

func (c *fixtureBusinessClient) createText(t *testing.T, name, content string) string {
	t.Helper()
	return fixtureID(t, c.json(t, http.MethodPost, "/native/files/text", map[string]string{
		"name": name, "parentId": "", "key": "native-upgrade-text-" + name, "text": content,
	}), "id")
}

func (c *fixtureBusinessClient) verifyContent(t *testing.T, id string, want []byte) {
	t.Helper()
	got, _ := c.request(t, http.MethodGet, "/native/files/"+id+"/content", nil, nil, http.StatusOK)
	if !bytes.Equal(got, want) {
		t.Fatalf("content changed for %s", id)
	}
}

func (c *fixtureBusinessClient) patch(t *testing.T, path string, data []byte, offset, end int) {
	t.Helper()
	_, headers := c.request(t, http.MethodPatch, path+"/data", data, map[string]string{
		"Content-Type": "application/offset+octet-stream", "Tus-Resumable": "1.0.0", "Upload-Offset": fmt.Sprint(offset),
	}, http.StatusNoContent)
	if got := headers.Get("Upload-Offset"); got != fmt.Sprint(end) {
		t.Fatalf("acknowledged upload offset: %s, want %d", got, end)
	}
}

func unusedAddress(t *testing.T) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	return listener.Addr().String()
}

func commandState(t *testing.T, root string) State {
	t.Helper()
	var output bytes.Buffer
	if err := executeCommand(t.Context(), &output, "status", root, ""); err != nil {
		t.Fatal(err)
	}
	var state State
	if err := json.Unmarshal(output.Bytes(), &state); err != nil {
		t.Fatal(err)
	}
	return state
}

func awaitJob(t *testing.T, root string) State {
	t.Helper()
	deadline := time.Now().Add(90 * time.Second)
	for time.Now().Before(deadline) {
		current := commandState(t, root)
		if current.Job != nil && current.Job.EndedAt != nil {
			return current
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("managed update did not finish")
	return State{}
}

func awaitVersion(t *testing.T, address, version string) {
	t.Helper()
	client := &http.Client{Timeout: 2 * time.Second}
	defer client.CloseIdleConnections()
	deadline := time.Now().Add(40 * time.Second)
	for time.Now().Before(deadline) {
		request, err := http.NewRequestWithContext(t.Context(), http.MethodGet, "http://"+address+"/build", nil)
		if err != nil {
			t.Fatal(err)
		}
		response, err := client.Do(request)
		if err == nil {
			var build struct{ Version string }
			decodeErr := json.NewDecoder(response.Body).Decode(&build)
			_ = response.Body.Close()
			if decodeErr == nil && build.Version == version {
				return
			}
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatalf("management endpoint %s did not report %s", address, version)
}
