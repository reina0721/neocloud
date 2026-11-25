package composition

import (
	"context"
	"fmt"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/reina0721/clouddrive/internal/module/iam/service"
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
			cookieName := service.SessionCookieName
			if insecure {
				cookieName = strings.TrimPrefix(cookieName, "__Host-")
			}
			for name := range client.cookies {
				if strings.HasSuffix(name, "clouddrive_native_csrf") {
					t.Fatal("Console sign-in issued a native CSRF mirror")
				}
			}
			preferences := map[string]any{"themeMode": "dark"}
			before := client.request(t, "GET", "/native/iam/session", nil, 200)
			if token, ok := before["csrfToken"].(string); !ok || token == "" {
				t.Fatal("native session projection omitted the rotated token")
			}
			client.request(t, "PATCH", "/native/iam/self/preferences", preferences, 200)
			client.request(t, "POST", "/native/files/folders", map[string]any{"parentId": "", "name": "Console proof"}, 200)
			for _, denial := range []struct{ header, value, reason string }{
				{"Origin", "", "origin_rejected"},
				{"X-CSRF-Token", "invalid", "csrf_rejected"},
			} {
				failure := client.request(t, "PATCH", "/native/iam/self/preferences", preferences, 403, map[string]string{denial.header: denial.value})
				if envelope, ok := failure["error"].(map[string]any); !ok || envelope["code"] != "forbidden" || envelope["reason"] != denial.reason {
					t.Fatalf("unexpected Console guard error for %s", denial.header)
				}
			}
			anonymous := &consoleTestClient{base: client.base, cookies: map[string]string{}}
			anonymous.request(t, "GET", "/auth/csrf", nil, 200)
			anonymous.request(t, "PATCH", "/native/iam/self/preferences", preferences, 401)

			raw := iamClient{address: strings.TrimPrefix(client.base, "http://"), cookie: cookieName + "=" + client.cookies[cookieName]}
			rotated := raw.roundTrip(t, http.MethodGet, "/api/v1/iam/session", "")
			if rotated.code != 200 || rotated.csrf == "" || rotated.csrf == before["csrfToken"] {
				t.Fatal("direct native session read did not rotate its token")
			}
			raw.csrf = before["csrfToken"].(string)
			if rejected := raw.roundTrip(t, http.MethodPatch, "/api/v1/iam/self/preferences", `{"themeMode":"light"}`); rejected.code != 403 || jsonField(rejected.body, "code") != "csrf_rejected" {
				t.Fatal("direct native mutation accepted a superseded token")
			}
			raw.csrf = client.csrf
			if rejected := raw.roundTrip(t, http.MethodPatch, "/api/v1/iam/self/preferences", `{"themeMode":"light"}`); rejected.code != 403 || jsonField(rejected.body, "code") != "csrf_rejected" {
				t.Fatal("direct native mutation accepted a Console double-submit token")
			}
			raw.csrf = rotated.csrf
			if accepted := raw.roundTrip(t, http.MethodPatch, "/api/v1/iam/self/preferences", `{"themeMode":"light"}`); accepted.code != 200 {
				t.Fatalf("direct native mutation did not accept the current token: %d", accepted.code)
			}
			client.request(t, "PATCH", "/native/iam/self/preferences", preferences, 200)

			login := (iamClient{address: raw.address}).roundTrip(t, http.MethodPost, "/api/v1/iam/login", `{"username":"http-owner@clouddrive.test","password":"http-cookie-owner-password"}`)
			nativeSession, ok := strings.CutPrefix(login.cookie, cookieName+"=")
			if login.code != http.StatusOK || !ok || nativeSession == "" {
				t.Fatalf("native login did not issue a session cookie: %d", login.code)
			}
			fromNative := &consoleTestClient{base: client.base, cookies: map[string]string{cookieName: nativeSession}}
			fromNative.request(t, "GET", "/auth/csrf", nil, 200)
			fromNative.request(t, "GET", "/auth/session", nil, 200)
			fromNative.request(t, "PATCH", "/native/iam/self/preferences", preferences, 200)

			role := client.request(t, "POST", "/native/iam/roles", map[string]any{"code": "self-reader", "name": "Self reader", "description": ""}, 201)
			roleID := role["id"].(string)
			client.request(t, "PUT", "/native/iam/roles/"+roleID+"/permissions", map[string]any{"expectedRoleVersion": role["version"], "permissionKeys": []string{"iam:account:self:preferences:read"}}, 200)
			credentials := map[string]any{"email": "reader@clouddrive.test", "password": "http-cookie-reader-password"}
			client.request(t, "POST", "/users", map[string]any{"email": credentials["email"], "password": credentials["password"], "name": "Reader", "roleIds": []string{roleID}, "status": "active"}, 200)
			reader := &consoleTestClient{base: client.base, cookies: map[string]string{}}
			reader.request(t, "GET", "/auth/csrf", nil, 200)
			reader.request(t, "POST", "/auth/login", credentials, 200)
			reader.request(t, "GET", "/native/iam/self/preferences", nil, 200)
			denied := reader.request(t, "PATCH", "/native/iam/self/preferences", preferences, 403)
			if denied["code"] != "permission_denied" {
				t.Fatal("Console proof bypassed the native operation policy")
			}
			client.request(t, "GET", "/native/iam/self/mfa", nil, 200)
			client.request(t, "POST", "/native/iam/self/password/verify", map[string]any{"password": "http-cookie-owner-password"}, 200)
			client.request(t, "POST", "/native/iam/self/password/verify", map[string]any{"password": "http-cookie-owner-password"}, 403, map[string]string{"Origin": "http://untrusted.example:4173"})
			client.request(t, "POST", "/native/iam/self/password/verify", map[string]any{"password": "http-cookie-owner-password"}, 403, map[string]string{"X-CSRF-Token": "invalid"})
			legacyCookie := strings.Replace(cookieName, "iam_session", "native_csrf", 1)
			client.cookies[legacyCookie] = "obsolete"
			client.request(t, "POST", "/auth/logout", nil, 204)
			if client.cookies[legacyCookie] != "" {
				t.Fatal("Console logout left a legacy native CSRF cookie")
			}
			client.request(t, "GET", "/auth/session", nil, 401)
		})
	}
}
