package composition

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base32"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/reina0721/neocloud/pkg/testkit"
)

type consoleTestClient struct {
	base    string
	cookies map[string]string
	csrf    string
}

func (c *consoleTestClient) request(t *testing.T, method, path string, body any, status int, headers ...map[string]string) map[string]any {
	t.Helper()
	var payload []byte
	var err error
	if body != nil {
		payload, err = json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
	}
	request, err := http.NewRequestWithContext(t.Context(), method, c.base+"/api/console/v1"+path, bytes.NewReader(payload))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Origin", c.base)
	if method != http.MethodGet && method != http.MethodHead {
		request.Header.Set("Content-Type", "application/json")
	}
	request.Header.Set("X-CSRF-Token", c.csrf)
	for _, values := range headers {
		for key, value := range values {
			request.Header.Set(key, value)
		}
	}
	for name, value := range c.cookies {
		request.AddCookie(&http.Cookie{Name: name, Value: value})
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != status {
		t.Fatalf("%s %s: status %d want %d: %s", method, path, response.StatusCode, status, raw)
	}
	for _, cookie := range response.Cookies() {
		c.cookies[cookie.Name] = cookie.Value
	}
	result := map[string]any{}
	if len(raw) > 0 {
		if err = json.Unmarshal(raw, &result); err != nil {
			t.Fatal(err)
		}
	}
	// 只有 CSRF 端点可以更新双提交令牌；分享等业务的 token 不是会话令牌。
	if path == "/auth/csrf" {
		if token, ok := result["token"].(string); ok {
			c.csrf = token
		}
	}
	return result
}

func TestConsoleSQLiteSetupPolicyAndFailures(t *testing.T) {
	for _, tc := range []struct {
		name, passwordConfig string
		minLength, maxLength int
		requireComplexity    bool
	}{
		{name: "default", minLength: 8, maxLength: 128},
		{
			name: "configured", minLength: 18, maxLength: 32, requireComplexity: true,
			passwordConfig: "    passwordPolicy:\n      minLength: 18\n      maxLength: 32\n      requireComplexity: true\n",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			directory := testkit.PrivateTempDir(t)
			configPath := filepath.Join(directory, "config.yaml")
			config := strings.Replace(generationConfig(directory, 120, 1<<20, filepath.Join(directory, "console.db")), "mode: development-anonymous", "mode: session", 1)
			writeGenerationConfig(t, configPath, "iam:\n  local:\n    setupToken: console-setup-fixture\n"+tc.passwordConfig+config)
			coordinator, _ := newGenerationTestCoordinator(t, configPath)
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
			base := "http://" + coordinator.Diagnostics().BoundAddress
			assertPolicy := func(initialized bool) {
				t.Helper()
				anonymous := &consoleTestClient{base: base, cookies: map[string]string{}}
				value := anonymous.request(t, "GET", "/auth/setup-policy", nil, http.StatusOK)
				if len(value) != 4 || value["minLength"] != float64(tc.minLength) || value["maxLength"] != float64(tc.maxLength) ||
					value["requireComplexity"] != tc.requireComplexity || value["initialized"] != initialized {
					t.Fatalf("setup policy did not project the expected settings and initialized=%t", initialized)
				}
			}
			assertPolicy(false)

			client := &consoleTestClient{base: base, cookies: map[string]string{}}
			client.request(t, "GET", "/auth/csrf", nil, http.StatusOK)
			const setupToken = "console-setup-fixture"
			const email = "setup@example.test"
			const name = "Setup owner"
			password := strings.Repeat("a", tc.minLength)
			if tc.requireComplexity {
				password = "Aa1" + strings.Repeat("a", tc.minLength-3)
			}
			setup := func(token, password, email, name string, status int, reason string) {
				t.Helper()
				value := client.request(t, "POST", "/auth/setup", map[string]string{
					"setupToken": token, "email": email, "name": name, "password": password,
				}, status)
				if reason != "" {
					issue, _ := value["error"].(map[string]any)
					if issue["reason"] != reason {
						t.Fatalf("setup returned reason %v, want %q", issue["reason"], reason)
					}
				}
			}
			setup("incorrect", password, email, name, http.StatusUnauthorized, "invalid-setup-token")
			setup(setupToken, "short", email, name, http.StatusUnprocessableEntity, "invalid-password")
			setup(setupToken, strings.Repeat("Ab1", tc.maxLength), email, name, http.StatusUnprocessableEntity, "invalid-password")
			if tc.requireComplexity {
				setup(setupToken, strings.Repeat("a", tc.minLength), email, name, http.StatusUnprocessableEntity, "invalid-password")
			}
			setup(setupToken, password, "invalid email", name, http.StatusUnprocessableEntity, "invalid-email")
			setup(setupToken, password, email, " ", http.StatusUnprocessableEntity, "invalid-name")
			assertPolicy(false)
			setup(setupToken, password, email, name, http.StatusOK, "")
			assertPolicy(true)
			setup(setupToken, password, email, name, http.StatusConflict, "setup-closed")

			const route = "/system/password-policy"
			anonymous := &consoleTestClient{base: base, cookies: map[string]string{}}
			anonymous.request(t, "GET", route, nil, http.StatusUnauthorized)
			policy := client.request(t, "GET", route, nil, http.StatusOK)
			override := map[string]any{"minLength": 4, "maxLength": 24, "requireComplexity": false, "version": policy["version"]}
			client.request(t, "PUT", route, override, http.StatusForbidden, map[string]string{"X-CSRF-Token": "wrong"})
			saved := client.request(t, "PUT", route, override, http.StatusOK)
			if saved["minLength"] != float64(4) || saved["overridden"] != true {
				t.Fatalf("saved policy = %#v", saved)
			}
			client.request(t, "PUT", route, override, http.StatusConflict)
			publicPolicy := anonymous.request(t, "GET", "/auth/setup-policy", nil, http.StatusOK)
			if publicPolicy["minLength"] != float64(4) || publicPolicy["requireComplexity"] != false {
				t.Fatalf("public policy did not apply immediately: %#v", publicPolicy)
			}
			updated := client.request(t, "DELETE", route, map[string]any{"version": saved["version"]}, http.StatusOK)
			if updated["minLength"] != float64(tc.minLength) || updated["overridden"] != false {
				t.Fatalf("reset policy did not restore configured rules: %#v", updated)
			}
		})
	}
}

func TestConsoleSQLiteDataIsolationAndRestart(t *testing.T) {
	var hits atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		_, _ = w.Write([]byte("scheduled real response"))
	}))
	defer upstream.Close()
	directory := testkit.PrivateTempDir(t)
	configPath := filepath.Join(directory, "config.yaml")
	config := strings.Replace(generationConfig(directory, 120, 1<<20, filepath.Join(directory, "console.db")), "mode: development-anonymous", "mode: session", 1)
	config = "iam:\n  local:\n    setupToken: console-setup-secret\nconsole:\n  siteOrigins: [" + testSitePrimary + ", " + testSiteAlternative + "]\n  relay:\n    allowedOrigins: [" + upstream.URL + "]\n" + strings.Replace(config, "enabled: false", "enabled: true", 1)
	writeGenerationConfig(t, configPath, config)
	coordinator, _ := newGenerationTestCoordinator(t, configPath)
	if err := coordinator.Start(t.Context()); err != nil {
		t.Fatal(err)
	}
	stop := func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := coordinator.Stop(ctx); err != nil {
			t.Error(err)
		}
	}
	defer func() { stop() }()
	owner := &consoleTestClient{base: "http://" + coordinator.Diagnostics().BoundAddress, cookies: map[string]string{}}
	owner.request(t, "GET", "/auth/csrf", nil, 200)
	session := owner.request(t, "POST", "/auth/setup", map[string]any{"setupToken": "console-setup-secret", "email": "owner@neocloud.test", "name": "Owner", "password": "owner-password-long"}, 200)
	ownerID := session["user"].(map[string]any)["id"].(string)
	// 142：真实HTTP复核不创建/撤销Cookie会话；错误一次后可重试。
	beforeVerify := owner.request(t, "GET", "/auth/session", nil, 200)
	owner.request(t, "POST", "/auth/password/verify", map[string]any{"password": "incorrect"}, 401)
	verified := owner.request(t, "POST", "/auth/password/verify", map[string]any{"password": "owner-password-long"}, 200)
	if verified["verified"] != true {
		t.Fatal("缺少密码验证成功回执")
	}
	afterVerify := owner.request(t, "GET", "/auth/session", nil, 200)
	if beforeVerify["sessionId"] != afterVerify["sessionId"] || beforeVerify["expiresAt"] != afterVerify["expiresAt"] {
		t.Fatal("密码复核更换或延长会话")
	}
	owner.request(t, "POST", "/auth/password/verify", map[string]any{"password": ""}, 422)
	owner.request(t, "POST", "/auth/password/verify", map[string]any{"password": "owner-password-long", "accountId": ownerID}, 422)
	owner.request(t, "POST", "/auth/password/verify", map[string]any{"password": "owner-password-long"}, 403, map[string]string{"Origin": "https://untrusted.example"})
	owner.request(t, "POST", "/auth/password/verify", map[string]any{"password": "owner-password-long"}, 403, map[string]string{"X-CSRF-Token": "incorrect"})
	wrongPassword := owner.request(t, "POST", "/auth/password", map[string]any{"currentPassword": "incorrect", "newPassword": "proposed-password-long"}, 401)
	if problem := wrongPassword["error"].(map[string]any); problem["code"] != "unauthenticated" || problem["reason"] != "current-password-invalid" {
		t.Fatalf("当前密码错误的响应意外：%v", problem)
	}
	if current := owner.request(t, "GET", "/auth/session", nil, 200); current["sessionId"] != beforeVerify["sessionId"] {
		t.Fatal("当前密码错误影响了有效会话")
	}
	owner.request(t, "POST", "/native/iam/self/password/verify", map[string]any{"password": "owner-password-long"}, 200)
	owner.request(t, "GET", "/auth/access", nil, 200)
	for _, path := range []string{"/native/iam/self/mfa", "/native/iam/api-tokens", "/native/organization/departments", "/native/navigation/menus", "/native/auth/audit"} {
		owner.request(t, "GET", path, nil, 200)
	}
	department := owner.request(t, "POST", "/native/organization/departments", map[string]any{"code": "engineering", "name": "Engineering", "leader": "Owner", "remark": "real data"}, 201)
	owner.request(t, "PATCH", "/native/organization/departments/"+department["id"].(string), map[string]any{"version": department["version"], "name": "Engineering team", "active": true, "archived": false}, 200)
	todo := owner.request(t, "POST", "/todos", map[string]any{"title": "Integration todo"}, 200)
	completed := owner.request(t, "PATCH", "/todos/"+todo["id"].(string)+"/complete", map[string]any{}, 200)
	if completed["status"] != "completed" || completed["completedAt"] == nil {
		t.Fatal("completing a todo must persist its completed status and timestamp")
	}
	repeated := owner.request(t, "PATCH", "/todos/"+todo["id"].(string)+"/complete", map[string]any{}, 200)
	if repeated["completedAt"] != completed["completedAt"] {
		t.Fatal("repeating completion changed its timestamp")
	}
	issued := owner.request(t, "POST", "/native/iam/api-tokens", map[string]any{"name": "Integration token", "description": "", "scopes": []string{"todos:read"}}, 200)

	tokenID := issued["id"].(string)
	owner.request(t, "POST", "/native/iam/api-tokens/"+tokenID+"/disable", map[string]any{}, 204, map[string]string{"If-Match": "\"1\""})
	owner.request(t, "POST", "/native/iam/api-tokens/"+tokenID+"/enable", map[string]any{}, 409, map[string]string{"If-Match": "\"1\""})
	owner.request(t, "PATCH", "/native/iam/api-tokens/"+tokenID, map[string]any{"name": "Updated token", "description": "Versioned", "neverExpires": true}, 204, map[string]string{"If-Match": "\"2\""})
	owner.request(t, "POST", "/native/iam/api-tokens/"+tokenID+"/rotate", map[string]any{}, 200, map[string]string{"If-Match": "\"3\""})
	metadata := owner.request(t, "GET", "/system/runtime", nil, 200)
	encodedMetadata, _ := json.Marshal(metadata)
	if strings.Contains(string(encodedMetadata), "console-setup-secret") {
		t.Fatal("runtime metadata leaked a secret")
	}

	// Last administrator protection is enforced by IAM, also through the projection.
	ownerVersion := owner.request(t, "GET", "/users/"+ownerID, nil, 200)["user"].(map[string]any)["version"]
	owner.request(t, "PATCH", "/users/"+ownerID+"/status", map[string]any{"version": ownerVersion, "status": "disabled"}, 409)
	owner.request(t, "PATCH", "/native/iam/self/profile", map[string]any{"expectedVersion": ownerVersion, "nickname": "Owner nickname", "bio": "Verified profile", "birthDate": "2000-01-02"}, 200)

	verifyConsoleRegistrationRoleOptions(t, owner)
	role := owner.request(t, "POST", "/roles", map[string]any{"name": "Registered member", "permissions": []string{"account.update"}}, 200)["role"].(map[string]any)
	roleID := role["id"].(string)
	owner.request(t, "PUT", "/native/iam/roles/"+roleID+"/permissions", map[string]any{"expectedRoleVersion": 1, "permissionKeys": []string{"iam:account:self:read", "iam:account:self:profile:write", "iam:account:self:password:write", "iam:account:self:preferences:read", "iam:account:self:preferences:write", "iam:account:self:archive", "console:workbench:read", "todos:read"}}, 200)
	settings := owner.request(t, "GET", "/system/registration", nil, 200)["settings"].(map[string]any)
	owner.request(t, "PATCH", "/system/registration", map[string]any{"enabled": true, "defaultRoleId": roleID, "version": settings["version"]}, 200)
	member := &consoleTestClient{base: owner.base, cookies: map[string]string{}}
	member.request(t, "GET", "/auth/csrf", nil, 200)
	ownerPreferences := owner.request(t, "GET", "/native/iam/self/preferences", nil, 200)
	preferenceDraft := map[string]any{"version": ownerPreferences["version"], "language": "zh-CN", "timeZone": "Asia/Shanghai", "themeMode": "dark", "themePreset": "green", "density": "compact"}
	owner.request(t, "PATCH", "/native/iam/self/preferences", preferenceDraft, 200)
	owner.request(t, "PATCH", "/native/iam/self/preferences", preferenceDraft, 409)
	member.request(t, "POST", "/auth/register", map[string]any{"name": "Member", "email": "member@neocloud.test", "password": "member-password-long"}, 200)
	member.request(t, "GET", "/users", nil, 403)
	member.request(t, "GET", "/roles?scope=self", nil, 200)
	member.request(t, "GET", "/system/runtime", nil, 403)
	verifyConsoleSiteProfile(t, owner, member)
	verifySiteOrigins(t, owner, member)
	member.request(t, "GET", "/navigation", nil, 200)
	if preferences := member.request(t, "GET", "/native/iam/self/preferences", nil, 200); preferences["timeZone"] == "Asia/Shanghai" {
		t.Fatal("cross-user account preferences leak")
	}
	me := member.request(t, "GET", "/me", nil, 200)["user"].(map[string]any)
	draft := map[string]any{"name": "Member renamed", "email": "member@neocloud.test", "version": me["version"]}
	member.request(t, "PATCH", "/me", draft, 200)
	member.request(t, "PATCH", "/me", draft, 409)
	inbox := member.request(t, "GET", "/notifications", nil, 200)["items"].([]any)
	if len(inbox) == 0 {
		t.Fatal("identity writes did not emit a real notification")
	}
	id := inbox[0].(map[string]any)["id"].(string)
	owner.request(t, "GET", "/notifications/"+id, nil, 404)
	owner.request(t, "PATCH", "/notifications/read", map[string]any{"ids": []string{id}}, 404)
	member.request(t, "PATCH", "/notifications/read", map[string]any{"ids": []string{id}}, 204)
	dictionaries := owner.request(t, "POST", "/dictionaries", map[string]any{"name": "Test dictionary", "code": "TEST_CODES", "status": "active", "remark": "persistent"}, 200)
	dictionary := dictionaries["types"].([]any)[0].(map[string]any)
	owner.request(t, "PATCH", "/dictionaries/"+dictionary["id"].(string), map[string]any{"name": "Changed dictionary", "code": "TEST_CODES", "status": "active", "remark": "persistent", "version": 0}, 409)
	workspace := map[string]any{"version": 1, "projects": []any{map[string]string{"id": "project", "name": "Project"}}, "collections": []any{map[string]string{"id": "collection", "projectId": "project", "name": "Collection"}}, "requests": []any{map[string]any{"id": "request", "collectionId": "collection", "name": "Scheduled request", "method": "GET", "url": upstream.URL, "params": []any{}, "headers": []any{}, "auth": map[string]string{"type": "none"}, "body": map[string]string{"type": "none"}, "disguise": map[string]int{"timeoutMs": 1000}, "extractors": []any{}, "preScript": "", "postScript": ""}}, "environments": []any{}, "globals": []any{}, "tasks": []any{}, "history": []any{}}
	owner.request(t, "PUT", "/api-workbench/workspace", workspace, 204, map[string]string{"If-Match": "\"0\""})
	owner.request(t, "PUT", "/api-workbench/workspace", workspace, 409, map[string]string{"If-Match": "\"0\""})
	own := member.request(t, "GET", "/api-workbench/workspace", nil, 200)
	if len(own["requests"].([]any)) != 0 {
		t.Fatal("cross-user workspace leak")
	}
	member.request(t, "POST", "/api-workbench/execute", map[string]any{"method": "GET", "url": upstream.URL}, 403)
	owner.request(t, "POST", "/api-workbench/tasks", map[string]any{"id": "restart-task", "name": "Restart task", "targetCollectionId": "collection", "cronOrInterval": "1s", "enabled": true}, 204)
	// A service restart uses the same SQLite database, and the original cookie still restores.
	stop()
	writeGenerationConfig(t, configPath, strings.Replace(config, ", "+testSiteAlternative, "", 1))
	coordinator, _ = newGenerationTestCoordinator(t, configPath)
	if err := coordinator.Start(t.Context()); err != nil {
		t.Fatal(err)
	}
	owner.base = "http://" + coordinator.Diagnostics().BoundAddress
	member.base = owner.base
	member.request(t, "GET", "/auth/session", nil, 200)
	verifySiteOriginsAfterRestart(t, owner)
	if got := owner.request(t, "GET", "/native/iam/self/preferences", nil, 200); got["timeZone"] != "Asia/Shanghai" || got["themeMode"] != "dark" {
		t.Fatalf("account preferences did not survive restart: %v", got)
	}
	deadline := time.Now().Add(5 * time.Second)
	for hits.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if hits.Load() == 0 {
		t.Fatal("persistent task did not resume after restart")
	}
	// Pause and delete use the current server version, rejecting a stale writer.
	tasks := owner.request(t, "GET", "/api-workbench/workspace", nil, 200)["tasks"].([]any)
	if len(tasks) != 1 {
		t.Fatalf("restored tasks=%v", tasks)
	}
	task := tasks[0].(map[string]any)
	task["enabled"] = false
	task["lastRun"] = nil
	owner.request(t, "POST", "/api-workbench/tasks", task, 204)
	owner.request(t, "DELETE", "/api-workbench/tasks/restart-task?version=1", nil, 409)
	paused := owner.request(t, "GET", "/api-workbench/workspace", nil, 200)["tasks"].([]any)[0].(map[string]any)
	if paused["enabled"] != false {
		t.Fatal("task pause was not persisted")
	}
	owner.request(t, "DELETE", fmt.Sprintf("/api-workbench/tasks/restart-task?version=%.0f", paused["version"]), nil, 204)
	// Verify a real MFA challenge through the console protocol, including one-time recovery codes.
	enroll := owner.request(t, "POST", "/native/iam/self/mfa", map[string]any{}, 200)
	secret, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(enroll["secret"].(string))
	if err != nil {
		t.Fatal(err)
	}
	counter := make([]byte, 8)
	binary.BigEndian.PutUint64(counter, uint64(time.Now().Unix()/30))
	mac := hmac.New(sha1.New, secret)
	_, _ = mac.Write(counter)
	digest := mac.Sum(nil)
	offset := digest[len(digest)-1] & 15
	code := fmt.Sprintf("%06d", (binary.BigEndian.Uint32(digest[offset:offset+4])&0x7fffffff)%1000000)
	codes := owner.request(t, "POST", "/native/iam/self/mfa/confirm", map[string]any{"code": code}, 200)["recoveryCodes"].([]any)
	challenge := owner.request(t, "POST", "/auth/login", map[string]any{"email": "owner@neocloud.test", "password": "owner-password-long"}, 200)
	if challenge["mfaRequired"] != true {
		t.Fatal("MFA challenge missing")
	}
	owner.request(t, "POST", "/auth/login", map[string]any{"challengeId": challenge["challengeId"], "code": codes[0]}, 200)
	owner.request(t, "POST", "/auth/login", map[string]any{"challengeId": challenge["challengeId"], "code": codes[0]}, 401)

	restored := owner.request(t, "GET", "/dictionaries", nil, 200)["types"].([]any)
	if len(restored) != 1 {
		t.Fatalf("restored dictionaries=%v", restored)
	}
	member.request(t, "POST", "/auth/logout", map[string]bool{"logout": true}, 204)
	member.request(t, "GET", "/auth/session", nil, 401)
	memberID := me["id"].(string)
	owner.request(t, "POST", "/native/iam/accounts/"+memberID+"/password-reset", map[string]any{"password": "temporary-password-long"}, 409, map[string]string{"If-Match": "\"1\""})
	owner.request(t, "POST", "/native/iam/accounts/"+memberID+"/password-reset", map[string]any{"password": "temporary-password-long"}, 204, map[string]string{"If-Match": fmt.Sprintf("\"%.0f\"", owner.request(t, "GET", "/users/"+memberID, nil, 200)["user"].(map[string]any)["version"])})
	member.request(t, "GET", "/auth/csrf", nil, 200)
	restricted := member.request(t, "POST", "/auth/login", map[string]any{"email": "member@neocloud.test", "password": "temporary-password-long"}, 200)
	if restricted["mustChangePassword"] != true {
		t.Fatal("reset password did not restrict the new session")
	}
	member.request(t, "GET", "/navigation", nil, 403)
	member.request(t, "POST", "/auth/password", map[string]any{"currentPassword": "temporary-password-long", "newPassword": "replacement-password-long"}, 204)
	expired := member.request(t, "GET", "/auth/session", nil, 401)
	if problem := expired["error"].(map[string]any); problem["code"] != "unauthenticated" || problem["reason"] != nil {
		t.Fatalf("真实会话失效的响应意外：%v", problem)
	}
	member.request(t, "POST", "/auth/login", map[string]any{"email": "member@neocloud.test", "password": "replacement-password-long"}, 200)
	other := &consoleTestClient{base: member.base, cookies: map[string]string{}}
	other.request(t, "GET", "/auth/csrf", nil, 200)
	other.request(t, "POST", "/auth/login", map[string]any{"email": "member@neocloud.test", "password": "replacement-password-long"}, 200)
	member.request(t, "POST", "/auth/sessions/revoke-others", map[string]any{}, 204)
	other.request(t, "GET", "/auth/session", nil, 401)
	confirmation := member.request(t, "POST", "/native/iam/self/archive", map[string]any{}, 200)
	member.request(t, "POST", "/native/iam/self/archive/confirm", map[string]any{"confirmationId": confirmation["confirmationId"]}, 204)
	member.request(t, "GET", "/auth/session", nil, 401)
	member.request(t, "POST", "/auth/login", map[string]any{"email": "member@neocloud.test", "password": "replacement-password-long"}, 403)
}

func verifyConsoleRegistrationRoleOptions(t *testing.T, owner *consoleTestClient) {
	t.Helper()
	const route = "/system/registration"
	const optionsRoute = route + "?include=roleOptions"
	anonymous := &consoleTestClient{base: owner.base, cookies: map[string]string{}}
	anonymous.request(t, "GET", optionsRoute, nil, http.StatusUnauthorized)
	plain := owner.request(t, "GET", route, nil, http.StatusOK)
	if _, exists := plain["roleOptions"]; exists {
		t.Fatal("普通注册设置读取不应带角色选项")
	}
	settings := plain["settings"].(map[string]any)
	role := owner.request(t, "POST", "/roles", map[string]any{
		"name": "Registration permissions fixture", "permissions": []string{},
	}, http.StatusOK)["role"].(map[string]any)
	roleID := role["id"].(string)
	permissionsRoute := "/native/iam/roles/" + roleID + "/permissions"
	option := func() map[string]any {
		t.Helper()
		for _, value := range owner.request(t, "GET", optionsRoute, nil, http.StatusOK)["roleOptions"].([]any) {
			candidate := value.(map[string]any)
			if candidate["id"] == roleID {
				return candidate
			}
		}
		t.Fatal("注册设置缺少测试角色选项")
		return nil
	}
	update := func(roleID string, enabled bool, status int, reason string) {
		t.Helper()
		result := owner.request(t, "PATCH", route, map[string]any{
			"enabled": enabled, "defaultRoleId": roleID, "version": settings["version"],
		}, status)
		if status == http.StatusOK {
			settings = result["settings"].(map[string]any)
			if _, exists := result["roleOptions"]; exists || settings["enabled"] != enabled || settings["defaultRoleId"] != roleID {
				t.Fatalf("注册设置保存回执不正确：%v", result)
			}
			return
		}
		if issue := result["error"].(map[string]any); issue["reason"] != reason {
			t.Fatalf("注册默认角色拒绝原因 = %v，预期 %q", issue, reason)
		}
	}
	if empty := option(); empty["eligible"] != true || len(empty["permissionKeys"].([]any)) != 0 {
		t.Fatalf("无授权角色资格不正确：%v", empty)
	}
	owner.request(t, "PUT", permissionsRoute, map[string]any{
		"expectedRoleVersion": role["version"], "permissionKeys": []string{"files:read", "files:write"},
	}, http.StatusOK)
	if restricted := option(); restricted["eligible"] != false || restricted["reason"] != "restricted-permissions" ||
		!slices.Equal(restricted["permissionKeys"].([]any), []any{"files:read", "files:write"}) {
		t.Fatalf("受限角色未报告真实权限和资格：%v", restricted)
	}
	update(roleID, true, http.StatusConflict, "restricted-permissions")
	update("missing-registration-role", true, http.StatusNotFound, "missing-role")
	rolePermissions := owner.request(t, "GET", permissionsRoute, nil, http.StatusOK)
	owner.request(t, "PUT", permissionsRoute, map[string]any{
		"expectedRoleVersion": rolePermissions["roleVersion"], "permissionKeys": []string{"files:read"},
	}, http.StatusOK)
	if allowed := option(); allowed["eligible"] != true || allowed["reason"] != nil ||
		!slices.Equal(allowed["permissionKeys"].([]any), []any{"files:read"}) {
		t.Fatalf("权限调整后角色未变为可选：%v", allowed)
	}
	update(roleID, true, http.StatusOK, "")
	public := anonymous.request(t, "GET", "/auth/registration-policy", nil, http.StatusOK)
	if len(public) != 1 || public["enabled"] != true {
		t.Fatalf("匿名注册策略出现额外信息：%v", public)
	}
	member := &consoleTestClient{base: owner.base, cookies: map[string]string{}}
	member.request(t, "GET", "/auth/csrf", nil, http.StatusOK)
	registration := map[string]string{
		"name": "File reader", "email": "registration-reader@neocloud.test", "password": "registration-password-long",
	}
	member.request(t, "POST", "/auth/register", registration, http.StatusOK)
	member.request(t, "GET", optionsRoute, nil, http.StatusForbidden)
	access := member.request(t, "GET", "/auth/access", nil, http.StatusOK)["nativePermissions"].([]any)
	if !slices.Contains(access, "files:read") || slices.Contains(access, "files:write") {
		t.Fatalf("注册成员权限与角色不一致：%v", access)
	}
	member.request(t, "GET", "/native/files", nil, http.StatusOK)
	member.request(t, "POST", "/native/files/folders", map[string]string{"parentId": "", "name": "Forbidden"}, http.StatusForbidden)

	owner.request(t, "POST", "/native/iam/roles/"+roleID+"/archive", nil, http.StatusNoContent)
	if inactive := option(); inactive["eligible"] != false || inactive["reason"] != "inactive-role" {
		t.Fatalf("已配置的归档角色缺少失效状态：%v", inactive)
	}
	anonymous.request(t, "GET", "/auth/csrf", nil, http.StatusOK)
	registration["email"] = "registration-blocked@neocloud.test"
	blocked := anonymous.request(t, "POST", "/auth/register", registration, http.StatusForbidden)["error"].(map[string]any)
	if blocked["code"] != "forbidden" || blocked["reason"] != nil {
		t.Fatalf("匿名注册暴露内部角色拒绝原因：%v", blocked)
	}
	update(roleID, false, http.StatusOK, "")
	update(roleID, true, http.StatusConflict, "inactive-role")
	update("", false, http.StatusOK, "")
}
