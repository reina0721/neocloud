package composition

import (
	"context"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"

	databaseapp "github.com/reina0721/clouddrive/internal/kernel/app/database"
	"github.com/reina0721/clouddrive/internal/kernel/logging"
	"github.com/reina0721/clouddrive/internal/nativeupgrade/control"
	"github.com/reina0721/clouddrive/pkg/logger"
	"github.com/reina0721/clouddrive/pkg/testkit"
)

func TestManagedWorkerStandbyAndHandoff(t *testing.T) {
	directory := testkit.PrivateTempDir(t)
	databasePath := filepath.Join(directory, "app.db")
	prepareTodoSchema(t, databasePath)
	configPath := filepath.Join(directory, "config.yaml")
	writeGenerationConfig(t, configPath, generationConfig(directory, 120, 1<<20, databasePath))
	old := newManagedWorkerTest(t, configPath, "v1.0.0")
	newWorker := newManagedWorkerTest(t, configPath, "v1.0.1")
	oldToken := strings.Repeat("1", 64)
	newToken := strings.Repeat("2", 64)
	perform := func(worker *managedWorker, request control.Request, phase string) {
		t.Helper()
		if err := worker.perform(t.Context(), request); err != nil || worker.metadata.Phase != phase {
			t.Fatalf("%s => phase=%q: %v; want %q", request.Action, worker.metadata.Phase, err, phase)
		}
	}
	checkPaths := func(worker *managedWorker, want bool) {
		t.Helper()
		snapshot, err := worker.application.loadInstanceConfiguration(t.Context())
		if err != nil {
			t.Fatal(err)
		}
		settings, err := databaseapp.Decode(snapshot)
		if err != nil {
			t.Fatal(err)
		}
		initialized, err := checkManagedStorage(t.Context(), snapshot, settings.PackageConfig(), false)
		if err != nil || initialized != want {
			t.Fatalf("initialized=%v: %v; want %v", initialized, err, want)
		}
	}
	perform(old, control.Request{Action: "prepare", Token: oldToken}, "prepared")
	checkPaths(old, false)
	perform(old, control.Request{Action: "activate"}, "active-ready")
	checkPaths(old, true)
	assertManagedStatus(t, old.metadata.ManagementAddr, "/readyz", "", http.StatusNotFound)
	assertManagedStatus(t, old.metadata.ManagementAddr, "/readyz", oldToken, http.StatusOK)
	assertManagedStatus(t, old.metadata.BusinessAddr, "/api/v1/todos", oldToken, http.StatusServiceUnavailable)
	perform(old, control.Request{Action: "publish"}, "active")
	checkPaths(old, true)

	perform(newWorker, control.Request{Action: "prepare", Token: newToken, Candidate: true, Expected: old.metadata.ConfigDigest}, "prepared")
	if err := newWorker.perform(t.Context(), control.Request{Action: "activate", TimeoutMS: 50}); err == nil || newWorker.metadata.Phase != "prepared" {
		t.Fatalf("concurrent activate must fail before the old worker releases its ownership: %v", err)
	}

	leave, admitted := old.managed.admitWork()
	if !admitted {
		t.Fatal("old worker ceased admitting work")
	}
	err := old.perform(t.Context(), control.Request{Action: "quiesce", TimeoutMS: 5})
	leave()
	if err == nil || old.metadata.Phase != "active" {
		t.Fatalf("quiesce timed out without preserving the old worker: %+v, %v", old.metadata, err)
	}
	if resumed, ok := old.managed.admitWork(); !ok {
		t.Fatal("old worker did not restore workload admission")
	} else {
		resumed()
	}

	perform(old, control.Request{Action: "quiesce"}, "quiescent")
	perform(old, control.Request{Action: "release"}, "old-released")
	perform(newWorker, control.Request{Action: "activate"}, "active-ready")
	perform(newWorker, control.Request{Action: "publish"}, "active")
	assertManagedStatus(t, newWorker.metadata.ManagementAddr, "/readyz", newToken, http.StatusOK)
	perform(old, control.Request{Action: "exit"}, "exiting")
}

func newManagedWorkerTest(t *testing.T, configPath, version string) *managedWorker {
	t.Helper()
	options := logger.DefaultConfig()
	options.OutputPaths = []string{"stderr"}
	base, err := logger.New(&options)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = base.Close() })
	logs, err := logging.New(base)
	if err != nil {
		t.Fatal(err)
	}
	application, err := New(Config{Name: "cloud-drive-test", Description: "managed worker fixture", ConfigPath: configPath, EnvironmentPrefix: "MANAGED_FIXTURE_", Logging: logs,
		Build: BuildInfo{Version: version, Commit: "build", BuildTime: "versioned", GoVersion: "test"}})
	if err != nil {
		t.Fatal(err)
	}
	worker := &managedWorker{application: application, metadata: control.Response{Version: version, Commit: "build"}}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
		defer cancel()
		if err := worker.stopRuntime(ctx); err != nil {
			t.Error(err)
		}
	})
	return worker
}

func assertManagedStatus(t *testing.T, address, path, token string, want int) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 2*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+address+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set(control.TokenHeader, token)
	response, err := managedProbeClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != want {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 1000))
		t.Fatalf("%s status=%d; want %d: %s", path, response.StatusCode, want, body)
	}
}
