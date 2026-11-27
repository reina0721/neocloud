package composition

import (
	"context"
	"fmt"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/reina0721/neocloud/internal/module/iam/service"
	"github.com/reina0721/neocloud/pkg/httpx"
	"github.com/reina0721/neocloud/pkg/testkit"
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
			original := client.request(t, "GET", "/auth/session", nil, 200)
			policy := httpx.CookiePolicy{AllowInsecureHTTP: insecure}
			cookieName := policy.Name(service.SessionCookieName)
			legacySessionName := policy.Name(service.LegacySessionCookieName)
			csrfName := policy.Name("__Host-neocloud_console_csrf")
			legacyCSRFName := policy.Name("__Host-clouddrive_console_csrf")
			if client.cookies[cookieName] == "" || client.cookies[csrfName] != client.csrf || client.cookies[legacySessionName] != "" || client.cookies[legacyCSRFName] != "" {
				t.Fatal("首次登录没有使用 NeoCloud Cookie")
			}
			for name := range client.cookies {
				if strings.HasSuffix(name, "clouddrive_native_csrf") {
					t.Fatal("Console sign-in issued a native CSRF mirror")
				}
			}
			preferences := map[string]any{"themeMode": "dark"}
			old := &consoleTestClient{base: client.base, csrf: client.csrf, cookies: map[string]string{
				legacySessionName: client.cookies[cookieName], legacyCSRFName: client.cookies[csrfName],
			}}
			old.request(t, "PATCH", "/native/iam/self/preferences", preferences, 200)
			if restored := old.request(t, "GET", "/auth/session", nil, 200); restored["sessionId"] != original["sessionId"] || old.cookies[cookieName] != old.cookies[legacySessionName] {
				t.Fatal("旧 Cookie 未恢复为同一个会话")
			}
			if csrf := old.request(t, "GET", "/auth/csrf", nil, 200); csrf["token"] != client.csrf || old.cookies[csrfName] != old.cookies[legacyCSRFName] {
				t.Fatal("旧 CSRF Cookie 未沿用为 NeoCloud Cookie")
			}
			old.cookies[cookieName] = "invalid-canonical-session"
			old.request(t, "GET", "/auth/session", nil, http.StatusUnauthorized)
			old.cookies[cookieName] = client.cookies[cookieName]
			old.cookies[csrfName] = "different-canonical-csrf"
			old.request(t, "PATCH", "/native/iam/self/preferences", preferences, http.StatusForbidden)

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
			logoutRequest, err := http.NewRequestWithContext(t.Context(), http.MethodPost, client.base+"/api/v1/iam/logout", nil)
			if err != nil {
				t.Fatal(err)
			}
			logoutRequest.Header.Set("Origin", client.base)
			logoutRequest.Header.Set("X-CSRF-Token", login.csrf)
			logoutRequest.AddCookie(&http.Cookie{Name: legacySessionName, Value: nativeSession})
			logoutResponse, err := http.DefaultClient.Do(logoutRequest)
			if err != nil {
				t.Fatal(err)
			}
			defer logoutResponse.Body.Close()
			cleared := make(map[string]bool)
			for _, cookie := range logoutResponse.Cookies() {
				cleared[cookie.Name] = cookie.MaxAge < 0 && cookie.HttpOnly && cookie.Secure != insecure
			}
			if logoutResponse.StatusCode != http.StatusNoContent || !cleared[cookieName] || !cleared[legacySessionName] {
				t.Fatalf("原生注销未清除两种会话 Cookie，状态 %d", logoutResponse.StatusCode)
			}
			fromNative.request(t, "GET", "/auth/session", nil, http.StatusUnauthorized)

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
			legacyCookie := policy.Name("__Host-clouddrive_native_csrf")
			client.cookies[legacyCookie] = "obsolete"
			client.cookies[legacySessionName] = client.cookies[cookieName]
			client.cookies[legacyCSRFName] = client.cookies[csrfName]
			oldToken := client.cookies[legacySessionName]
			client.request(t, "POST", "/auth/logout", nil, 204)
			for _, name := range []string{cookieName, legacySessionName, csrfName, legacyCSRFName, legacyCookie} {
				if client.cookies[name] != "" {
					t.Fatalf("控制台注销未清除 Cookie %s", name)
				}
			}
			client.request(t, "GET", "/auth/session", nil, 401)
			client.cookies = map[string]string{legacySessionName: oldToken}
			client.request(t, "GET", "/auth/session", nil, 401)
		})
	}
}
