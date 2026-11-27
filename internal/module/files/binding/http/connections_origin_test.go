package httpbinding

import (
	"net/http/httptest"
	"testing"
)

func TestConnectionRequestOriginIsPresentationOnly(t *testing.T) {
	for _, value := range []string{"http://192.0.2.10:4173", "https://drive.example", "http://[::1]:4173"} {
		r := httptest.NewRequest("GET", "http://backend:8080/api/v1/files/connections", nil)
		r.Header.Set("X-NeoCloud-Web-Origin", value)
		if got := connectionRequestOrigin(r); got != value {
			t.Fatalf("canonical presentation origin: %q", got)
		}
		if r.Host != "backend:8080" || r.TLS != nil || r.Header.Get("Origin") != "" {
			t.Fatal("presentation metadata changed the authorization request")
		}
	}
	for _, value := range []string{"https://user:secret@evil.example", "https://evil.example/path", "https://evil.example?x=y", "file://evil.example", "null"} {
		r := httptest.NewRequest("GET", "http://backend:8080/api/v1/files/connections", nil)
		r.Header.Set("X-NeoCloud-Web-Origin", value)
		if got := connectionRequestOrigin(r); got != "http://backend:8080" {
			t.Fatalf("invalid metadata accepted: %q", got)
		}
	}
	r := httptest.NewRequest("GET", "http://backend:8080/api/v1/files/connections", nil)
	r.Header.Add("X-NeoCloud-Web-Origin", "https://other.example")
	r.Header.Add("X-NeoCloud-Web-Origin", "https://drive.example")
	if got := connectionRequestOrigin(r); got != "http://backend:8080" {
		t.Fatalf("multiple presentation origins accepted: %q", got)
	}
}
