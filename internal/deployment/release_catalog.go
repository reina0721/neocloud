package deployment

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

const releaseCatalogBudget = 10 * time.Second
const releaseCatalogBytes = 1 << 20

var catalogAssetName = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,199}$`)

type catalogAsset struct {
	Name        string `json:"name"`
	SizeBytes   int64  `json:"sizeBytes"`
	DownloadURL string `json:"downloadUrl"`
	Kind        string `json:"kind"`
}

type releaseCatalog struct {
	Version     string         `json:"version"`
	PublishedAt string         `json:"publishedAt"`
	Notes       string         `json:"notes"`
	URL         string         `json:"releaseUrl"`
	Assets      []catalogAsset `json:"assets"`
}

// ServeReleaseCatalog only reads public release metadata. Authorization is owned by the console HTTP binding.
func (s *Releases) ServeReleaseCatalog(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	catalog, status, problem := s.readReleaseCatalog(r.Context())
	if r.Context().Err() != nil {
		return
	}
	w.WriteHeader(status)
	if problem != "" {
		_ = json.NewEncoder(w).Encode(map[string]string{"error": problem})
		return
	}
	_ = json.NewEncoder(w).Encode(catalog)
}

func (s *Releases) readReleaseCatalog(ctx context.Context) (releaseCatalog, int, string) {
	ctx, cancel := context.WithTimeout(ctx, releaseCatalogBudget)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.github.com/repos/"+repository+"/releases/latest", nil)
	if err != nil {
		return releaseCatalog{}, http.StatusBadGateway, "upstream"
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("User-Agent", "NeoCloud-Release-Catalog")
	request.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	// The public metadata endpoint has a fixed origin and does not follow redirects.
	client := *s.http
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	response, err := client.Do(request)
	if err != nil {
		return catalogUpstreamFailure(ctx)
	}
	defer response.Body.Close()
	switch {
	case response.StatusCode == http.StatusNotFound:
		return releaseCatalog{}, http.StatusNotFound, "no-release"
	case response.StatusCode == http.StatusTooManyRequests || (response.StatusCode == http.StatusForbidden &&
		(response.Header.Get("X-RateLimit-Remaining") == "0" || response.Header.Get("Retry-After") != "")):
		return releaseCatalog{}, http.StatusTooManyRequests, "rate-limited"
	case response.StatusCode != http.StatusOK:
		return releaseCatalog{}, http.StatusBadGateway, "upstream"
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, releaseCatalogBytes+1))
	if err != nil || len(data) > releaseCatalogBytes {
		return catalogUpstreamFailure(ctx)
	}
	var value struct {
		Tag         string    `json:"tag_name"`
		PublishedAt time.Time `json:"published_at"`
		Body        *string   `json:"body"`
		Draft       *bool     `json:"draft"`
		Prerelease  *bool     `json:"prerelease"`
		Assets      []struct {
			Name  string `json:"name"`
			Size  int64  `json:"size"`
			State string `json:"state"`
		} `json:"assets"`
	}
	if err := json.Unmarshal(data, &value); err != nil || !versionPattern.MatchString(value.Tag) || value.PublishedAt.IsZero() ||
		value.Draft == nil || *value.Draft || value.Prerelease == nil || *value.Prerelease || value.Assets == nil {
		return catalogUpstreamFailure(ctx)
	}
	release := releaseOrigin + "/releases"
	tag := url.PathEscape(value.Tag)
	catalog := releaseCatalog{
		Version: value.Tag, PublishedAt: value.PublishedAt.UTC().Format(time.RFC3339Nano),
		URL: release + "/tag/" + tag, Assets: make([]catalogAsset, 0, len(value.Assets)),
	}
	if value.Body != nil {
		catalog.Notes = *value.Body
	}
	version := strings.TrimPrefix(value.Tag, "v")
	kinds := make(map[string]string)
	for _, family := range releaseFamilies {
		kinds[string(family)+"_"+version+"_windows_amd64.zip"] = "windows-backend"
		kinds[string(family)+"_"+version+"_windows_arm64.zip"] = "windows-backend"
		if name, err := family.nativeAsset(value.Tag, "windows", "amd64", NativeGo); err == nil {
			kinds[name] = "windows-backend"
		}
		for _, platform := range []struct{ os, arch string }{{"windows", "amd64"}, {"linux", "amd64"}, {"linux", "arm64"}} {
			if name, err := family.nativeAsset(value.Tag, platform.os, platform.arch, NativeFull); err == nil {
				kinds[name] = "managed-full"
			}
		}
	}
	for _, item := range value.Assets {
		if item.Size < 0 {
			return catalogUpstreamFailure(ctx)
		}
		if item.State != "uploaded" || !catalogAssetName.MatchString(item.Name) {
			continue
		}
		kind := kinds[item.Name]
		if kind == "" {
			kind = "other"
		}
		escapedAsset := strings.ReplaceAll(url.PathEscape(item.Name), "+", "%2B")
		catalog.Assets = append(catalog.Assets, catalogAsset{
			Name: item.Name, SizeBytes: item.Size, Kind: kind, DownloadURL: release + "/download/" + tag + "/" + escapedAsset,
		})
	}
	return catalog, http.StatusOK, ""
}

func catalogUpstreamFailure(ctx context.Context) (releaseCatalog, int, string) {
	if ctx.Err() == context.DeadlineExceeded {
		return releaseCatalog{}, http.StatusGatewayTimeout, "timeout"
	}
	return releaseCatalog{}, http.StatusBadGateway, "upstream"
}
