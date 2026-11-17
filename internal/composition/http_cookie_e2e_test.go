package composition

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/reina0721/clouddrive/pkg/testkit"
)

func TestExplicitHTTPCookiesKeepConsoleAndNativeAuthorization(t *testing.T) {
	for _, insecure := range []bool{false, true} {
		t.Run(fmt.Sprint(insecure), func(t *testing.T) {
			dir := testkit.PrivateTempDir(t)
			path := filepath.Join(dir, "config.yaml")
			payload := strings.Replace(generationConfig(dir, 120, 1<<20, filepath.Join(dir, "app.db")), "mode: development-anonymous", "mode: session", 1)
			payload = fmt.Sprintf("iam:\n  local:\n    allowInsecureHTTP: %t\n    setupToken: http-cookie-fixture\n", insecure) + payload
			writeGenerationConfig(t, path, payload)
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
			client := &consoleTestClient{base: "http://" + coordinator.Diagnostics().BoundAddress, cookies: map[string]string{}}
			client.request(t, "GET", "/auth/csrf", nil, 200)
			client.request(t, "POST", "/auth/setup", map[string]any{"setupToken": "http-cookie-fixture", "email": "http-owner@clouddrive.test", "name": "HTTP Owner", "password": "http-cookie-owner-password"}, 200)
			for name := range client.cookies {
				if strings.HasPrefix(name, "__Host-") == insecure {
					t.Fatalf("unexpected cookie name for HTTP=%v: %s", insecure, name)
				}
			}
			client.request(t, "GET", "/auth/session", nil, 200)
			client.request(t, "GET", "/native/iam/self/mfa", nil, 200)
			client.request(t, "POST", "/native/iam/self/password/verify", map[string]any{"password": "http-cookie-owner-password"}, 200)
			client.request(t, "POST", "/native/iam/self/password/verify", map[string]any{"password": "http-cookie-owner-password"}, 403, map[string]string{"Origin": "http://untrusted.example:4173"})
			client.request(t, "POST", "/native/iam/self/password/verify", map[string]any{"password": "http-cookie-owner-password"}, 403, map[string]string{"X-CSRF-Token": "invalid"})
			client.request(t, "POST", "/auth/logout", nil, 204)
			client.request(t, "GET", "/auth/session", nil, 401)
		})
	}
}
