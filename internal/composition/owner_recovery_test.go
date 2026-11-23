package composition

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	kernellogging "github.com/reina0721/clouddrive/internal/kernel/logging"
	"github.com/reina0721/clouddrive/internal/module/iam/model"
	"github.com/reina0721/clouddrive/pkg/logger"
	"github.com/reina0721/clouddrive/pkg/testkit"
)

func TestOwnerRecoveryUsesExistingSQLiteInstanceAndRequiresPasswordChange(t *testing.T) {
	dir := testkit.PrivateTempDir(t)
	path := filepath.Join(dir, "config.yaml")
	databasePath := filepath.Join(dir, "custom-instance.db")
	const setupToken = "fictional-recovery-setup"
	payload := strings.Replace(generationConfig(dir, 120, 1<<20, databasePath), "mode: development-anonymous", "mode: session", 1)
	writeGenerationConfig(t, path, "iam:\n  local:\n    setupToken: "+setupToken+"\n"+payload)
	coordinator, _ := newGenerationTestCoordinator(t, path)
	if err := coordinator.Start(t.Context()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := coordinator.Stop(ctx); err != nil {
			t.Error(err)
		}
	})
	executor := newOwnerRecoveryTestExecutor(t, path)
	ctx := t.Context()
	cancelled := errors.New("test recovery canceled")
	if err := executor.RecoverOwner(ctx, func(_ context.Context, owners []model.RecoveryOwner, _ model.PasswordPolicy) (string, string, error) {
		if len(owners) != 0 {
			t.Fatal("uninitialized SQLite instance listed owners")
		}
		return "", "", cancelled
	}); !errors.Is(err, cancelled) {
		t.Fatalf("empty instance recovery error = %v", err)
	}
	const username = "recover@example.test"
	const originalPassword = "fictional-original-password"
	const temporaryPassword = "fictional-temporary-password"
	base := "http://" + coordinator.Diagnostics().BoundAddress
	client := &consoleTestClient{base: base, cookies: map[string]string{}}
	client.request(t, "GET", "/auth/csrf", nil, http.StatusOK)
	client.request(t, "POST", "/auth/setup", map[string]string{
		"setupToken": setupToken, "email": username, "name": "Fixture owner", "password": originalPassword,
	}, http.StatusOK)
	if err := executor.RecoverOwner(ctx, func(_ context.Context, owners []model.RecoveryOwner, _ model.PasswordPolicy) (string, string, error) {
		if len(owners) != 1 || owners[0].Username != username {
			t.Fatal("configured SQLite instance did not list its active owner")
		}
		return "", "", cancelled
	}); !errors.Is(err, cancelled) {
		t.Fatalf("cancelled recovery returned %v", err)
	}
	client.request(t, "GET", "/auth/session", nil, http.StatusOK)
	if err := executor.RecoverOwner(ctx, func(_ context.Context, owners []model.RecoveryOwner, policy model.PasswordPolicy) (string, string, error) {
		if len(owners) != 1 || owners[0].Username != username {
			t.Fatal("configured SQLite instance did not list its active owner")
		}
		if policy != model.DefaultPasswordPolicy() {
			t.Fatal("recovery did not receive the instance policy")
		}
		return owners[0].ID, temporaryPassword, nil
	}); err != nil {
		t.Fatal(err)
	}
	client.request(t, "GET", "/auth/session", nil, http.StatusUnauthorized)
	fresh := &consoleTestClient{base: base, cookies: map[string]string{}}
	fresh.request(t, "GET", "/auth/csrf", nil, http.StatusOK)
	fresh.request(t, "POST", "/auth/login", map[string]string{"email": username, "password": originalPassword}, http.StatusUnauthorized)
	freshLogin := fresh.request(t, "POST", "/auth/login", map[string]string{"email": username, "password": temporaryPassword}, http.StatusOK)
	if freshLogin["mustChangePassword"] != true {
		t.Fatal("recovered session did not require changing its temporary password")
	}
	fresh.request(t, "GET", "/system/runtime", nil, http.StatusForbidden)
}

func TestOwnerRecoveryDoesNotCreateMissingSQLiteInstance(t *testing.T) {
	dir := testkit.PrivateTempDir(t)
	path := filepath.Join(dir, "config.yaml")
	missing := filepath.Join(dir, "missing")
	writeGenerationConfig(t, path, generationConfig(dir, 120, 1<<20, filepath.Join(missing, "app.db")))
	executor := newOwnerRecoveryTestExecutor(t, path)
	if err := executor.RecoverOwner(t.Context(), func(context.Context, []model.RecoveryOwner, model.PasswordPolicy) (string, string, error) {
		t.Fatal("recovery prompted for an account in a missing instance")
		return "", "", nil
	}); err == nil {
		t.Fatal("recovery accepted a missing instance")
	}
	for _, directory := range []string{missing, filepath.Join(dir, "storage")} {
		if _, err := os.Stat(directory); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("recovery changed instance directories: %v", err)
		}
	}
}

func newOwnerRecoveryTestExecutor(t *testing.T, configPath string) iamExecutor {
	t.Helper()
	manager, err := kernellogging.New(logger.Noop())
	if err != nil {
		t.Fatal(err)
	}
	application, err := New(Config{Name: "clouddrive", Description: "owner recovery test", ConfigPath: configPath,
		EnvironmentPrefix: "CLOUDDRIVE_TEST_OWNER_RECOVERY_", Logging: manager})
	if err != nil {
		t.Fatal(err)
	}
	return iamExecutor{application: application}
}
