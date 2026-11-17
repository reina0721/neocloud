package httpx

import (
	"net/http"
	"testing"
)

func TestCookiePolicyPreservesProtectionUnlessHTTPIsExplicit(t *testing.T) {
	for _, insecure := range []bool{false, true} {
		policy := CookiePolicy{AllowInsecureHTTP: insecure}
		cookie := policy.Cookie(http.Cookie{Name: "__Host-session", Path: "/", Value: "test", HttpOnly: true, SameSite: http.SameSiteStrictMode, MaxAge: -1})
		wantName := "__Host-session"
		if insecure {
			wantName = "session"
		}
		if cookie.Name != wantName || cookie.Secure == insecure || !cookie.HttpOnly || cookie.SameSite != http.SameSiteStrictMode || cookie.Path != "/" || cookie.MaxAge != -1 {
			t.Fatalf("policy insecure=%v: unexpected cookie attributes: %+v", insecure, cookie)
		}
	}
}
