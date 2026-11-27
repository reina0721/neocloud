package composition

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"unicode"

	"github.com/reina0721/neocloud/pkg/httpx"
)

type nativeBrowserSchemeKey struct{}

// withNativeBrowserScheme is used only after authenticating the supervisor's HTTP hop.
func withNativeBrowserScheme(r *http.Request, scheme string) *http.Request {
	return r.WithContext(context.WithValue(r.Context(), nativeBrowserSchemeKey{}, scheme))
}

type browserIngress struct {
	publicOrigin string
	trusted      []netip.Prefix
	allowed      []string
}

func newBrowserIngress(publicOrigin string, config httpx.ServerConfig) (browserIngress, error) {
	policy := browserIngress{allowed: slices.Clone(config.CORS.AllowedOrigins)}
	if publicOrigin != "" {
		origin, err := url.Parse(publicOrigin)
		if err != nil || publicOrigin != origin.Scheme+"://"+origin.Host {
			return browserIngress{}, fmt.Errorf("invalid configured public origin")
		}
		var valid bool
		policy.publicOrigin, valid = browserOrigin(origin.Scheme, origin.Host)
		if !valid {
			return browserIngress{}, fmt.Errorf("invalid configured public origin")
		}
	}
	for _, cidr := range config.TrustedProxyCIDRs {
		prefix, err := netip.ParsePrefix(cidr)
		if err != nil {
			return browserIngress{}, fmt.Errorf("parse public ingress trusted proxy CIDR %q: %w", cidr, err)
		}
		policy.trusted = append(policy.trusted, prefix)
	}
	return policy, nil
}

func (p browserIngress) wrap(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		scheme, native := r.Context().Value(nativeBrowserSchemeKey{}).(string)
		if !native {
			next.ServeHTTP(w, r)
			return
		}
		origin, ok := browserOrigin(scheme, r.Host)
		if !ok {
			rejectBrowserOrigin(w)
			return
		}
		if scheme == "http" && p.trustedForwardedHTTPS(r) {
			origin, _ = browserOrigin("https", r.Host)
		}
		if values := r.Header.Values("Origin"); len(values) != 0 {
			if len(values) != 1 || !p.acceptsOrigin(r.URL.Path, origin, values[0]) {
				rejectBrowserOrigin(w)
				return
			}
		}
		for _, key := range []string{"Forwarded", "X-Forwarded-Host", "X-Forwarded-Proto", "X-Forwarded-Port", "X-NeoCloud-Web-Origin"} {
			r.Header.Del(key)
		}
		// Display metadata must never copy a client value or act as a permission grant.
		r.Header.Set("X-NeoCloud-Web-Origin", origin)
		next.ServeHTTP(w, httpx.WithVerifiedRequestOrigin(r, origin))
	})
}

func (p browserIngress) trustedForwardedHTTPS(r *http.Request) bool {
	values := r.Header.Values("X-Forwarded-Proto")
	if len(values) != 1 || values[0] != "https" || p.publicOrigin == "" {
		return false
	}
	want, ok := browserOrigin("https", r.Host)
	if !ok || want != p.publicOrigin {
		return false
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return false
	}
	peer, err := netip.ParseAddr(host)
	if err != nil {
		return false
	}
	return slices.ContainsFunc(p.trusted, func(prefix netip.Prefix) bool {
		return prefix.Contains(peer) || prefix.Contains(peer.Unmap())
	})
}

func (p browserIngress) acceptsOrigin(path, requestOrigin, supplied string) bool {
	value, err := url.Parse(supplied)
	if err != nil || value.User != nil || supplied != value.Scheme+"://"+value.Host {
		return false
	}
	canonical, ok := browserOrigin(value.Scheme, value.Host)
	if !ok || canonical != supplied {
		return false
	}
	if path == "/api/console/v1/deployment/owner" {
		return supplied == requestOrigin
	}
	return supplied == requestOrigin || slices.Contains(p.allowed, supplied) || strings.HasPrefix(path, "/wopi/")
}

func browserOrigin(scheme, authority string) (string, bool) {
	if scheme != "http" && scheme != "https" || authority == "" || len(authority) > 320 || strings.ContainsAny(authority, `,@/\?#`) || strings.ContainsFunc(authority, unicode.IsSpace) {
		return "", false
	}
	value, err := url.Parse(scheme + "://" + authority)
	if err != nil || value.Hostname() == "" || value.User != nil || value.Host != authority || strings.HasSuffix(authority, ":") {
		return "", false
	}
	port := value.Port()
	if port != "" {
		number, err := strconv.ParseUint(port, 10, 16)
		if err != nil || number == 0 {
			return "", false
		}
		port = strconv.FormatUint(number, 10)
	}
	if scheme == "https" && port == "443" || scheme == "http" && port == "80" {
		port = ""
	}
	host := strings.ToLower(value.Hostname())
	if strings.HasPrefix(authority, "[") {
		address, err := netip.ParseAddr(host)
		if err != nil || !address.Is6() || address.Zone() != "" {
			return "", false
		}
		host = address.String()
	} else if strings.Contains(host, ":") {
		return "", false
	}
	if port != "" {
		host = net.JoinHostPort(host, port)
	} else if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	return scheme + "://" + host, true
}

func rejectBrowserOrigin(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusForbidden)
	_, _ = io.WriteString(w, `{"error":"Invalid request origin or authority."}`)
}
