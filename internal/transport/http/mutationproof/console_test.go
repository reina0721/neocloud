package mutationproof

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestConsoleMutationProofIsBoundToSessionAndTarget(t *testing.T) {
	request := httptest.NewRequest(http.MethodPatch, "/api/v1/iam/self/profile?view=current", nil)
	request.Header.Set("X-Verified-Console-Mutation", "true")
	if Matches(request, "session-a") {
		t.Fatal("network request has an internal proof")
	}
	verified := WithVerifiedConsoleMutation(request, "session-a")
	if !Matches(verified, "session-a") || Matches(verified, "session-b") {
		t.Fatal("proof was not limited to the authenticated session")
	}
	for _, item := range []struct {
		name   string
		change func(*http.Request)
	}{
		{"method", func(r *http.Request) { r.Method = http.MethodPut }},
		{"path", func(r *http.Request) { r.URL.Path = "/api/v1/iam/self/preferences" }},
		{"query", func(r *http.Request) { r.URL.RawQuery = "view=another" }},
	} {
		t.Run(item.name, func(t *testing.T) {
			changed := verified.Clone(verified.Context())
			item.change(changed)
			if Matches(changed, "session-a") {
				t.Fatal("changed request reused the proof")
			}
		})
	}
}
