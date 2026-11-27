package deployment

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestReleaseCatalogReadsCanonicalPublicAssets(t *testing.T) {
	const release = "https://github.com/reina0721/neocloud/releases"
	source := &Releases{http: &http.Client{Transport: nativeReleaseRoundTrip(func(req *http.Request) (*http.Response, error) {
		if req.URL.String() != "https://api.github.com/repos/reina0721/neocloud/releases/latest" || req.Method != http.MethodGet {
			t.Fatalf("request selected another release source: %v", req.URL)
		}
		for _, field := range []string{"Cookie", "Authorization", "Origin"} {
			if req.Header.Get(field) != "" {
				t.Fatalf("request leaked %s to GitHub", field)
			}
		}
		return catalogFixtureResponse(http.StatusOK, `{
			"tag_name":"v0.2.2", "published_at":"2026-11-18T18:54:00Z", "body":"Release notes",
			"draft":false,"prerelease":false,"html_url":"https://untrusted.invalid", "assets":[
				{"name":"clouddrive_0.2.2_windows_amd64.zip", "size":20, "state":"uploaded", "browser_download_url":"http://untrusted.invalid"},
				{"name":"checksums+extra.txt", "size":24, "state":"uploaded"},
				{"name":"clouddrive_v0.2.2_windows_amd64_managed-full.zip", "size":25, "state":"uploaded"},
				{"name":"../secret", "size":12,"state":"uploaded"},
				{"name":"incomplete.zip", "size":5,"state":"starter"}
			]}`), nil
	})}}
	request := httptest.NewRequest(http.MethodGet, "https://cloud.example.test/api/host/v1/releases/latest?repository=untrusted", nil)
	request.Header.Set("Authorization", "Bearer test-auth")
	request.Header.Set("Origin", "https://cloud.example.test")
	request.Header.Set("Cookie", "test=value")
	response := httptest.NewRecorder()
	source.ServeReleaseCatalog(response, request)
	if response.Code != http.StatusOK || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("status=%d header=%v: %s", response.Code, response.Header(), response.Body)
	}
	var got releaseCatalog
	if err := json.Unmarshal(response.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Version != "v0.2.2" || got.Notes != "Release notes" || got.PublishedAt != "2026-11-18T18:54:00Z" || got.URL != release+"/tag/v0.2.2" || len(got.Assets) != 3 {
		t.Fatalf("invalid catalog: %+v", got)
	}
	if got.Assets[0].Kind != "windows-backend" || got.Assets[0].DownloadURL != release+"/download/v0.2.2/clouddrive_0.2.2_windows_amd64.zip" ||
		got.Assets[1].Kind != "other" || got.Assets[1].DownloadURL != release+"/download/v0.2.2/checksums%2Bextra.txt" || got.Assets[2].Kind != "managed-full" {
		t.Fatalf("invalid catalog assets: %+v", got.Assets)
	}
}

func TestReleaseCatalogFailureContracts(t *testing.T) {
	for _, item := range []struct {
		name, headers, body, problem string
		upstream, want               int
	}{
		{name: "no release", upstream: http.StatusNotFound, want: http.StatusNotFound, problem: "no-release"},
		{name: "rate limit", upstream: http.StatusForbidden, headers: "0", want: http.StatusTooManyRequests, problem: "rate-limited"},
		{name: "unavailable", upstream: http.StatusServiceUnavailable, want: http.StatusBadGateway, problem: "upstream"},
		{name: "no redirects", upstream: http.StatusMovedPermanently, want: http.StatusBadGateway, problem: "upstream"},
		{name: "prerelease", upstream: http.StatusOK, want: http.StatusBadGateway, problem: "upstream", body: `{"tag_name":"v0.2.2","published_at":"2026-11-18T18:54:00Z","draft":false,"prerelease":true,"assets":[]}`},
		{name: "oversized", upstream: http.StatusOK, want: http.StatusBadGateway, problem: "upstream", body: strings.Repeat(" ", releaseCatalogBytes+1)},
	} {
		t.Run(item.name, func(t *testing.T) {
			calls := 0
			source := &Releases{http: &http.Client{Transport: nativeReleaseRoundTrip(func(req *http.Request) (*http.Response, error) {
				calls++
				response := catalogFixtureResponse(item.upstream, item.body)
				if item.headers != "" {
					response.Header.Set("X-RateLimit-Remaining", item.headers)
				}
				if item.upstream == http.StatusMovedPermanently {
					response.Header.Set("Location", "https://untrusted.invalid")
				}
				return response, nil
			})}}
			_, got, problem := source.readReleaseCatalog(t.Context())
			if got != item.want || problem != item.problem || calls != 1 {
				t.Fatalf("status=%d problem=%q calls=%d", got, problem, calls)
			}
		})
	}
	t.Run("deadline", func(t *testing.T) {
		ctx, cancel := context.WithDeadline(t.Context(), time.Unix(0, 0))
		defer cancel()
		source := &Releases{http: &http.Client{Transport: nativeReleaseRoundTrip(func(req *http.Request) (*http.Response, error) {
			return nil, req.Context().Err()
		})}}
		_, status, problem := source.readReleaseCatalog(ctx)
		if status != http.StatusGatewayTimeout || problem != "timeout" {
			t.Fatalf("status=%d problem=%q", status, problem)
		}
	})
}

func catalogFixtureResponse(status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}
}
