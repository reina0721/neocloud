package httpbinding

import "net/http"

const ReleaseCatalogPath = "/api/host/v1/releases/latest"

const managementRead = "management:read"

func (h *Handler) serveReleaseCatalog(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	authenticated, err := h.authenticateRequest(r)
	if err != nil {
		w.WriteHeader(http.StatusUnauthorized)
		reply(w, map[string]string{"error": "unauthenticated"})
		return
	}
	if current(authenticated).Identity.MustChangePassword || !allowed(authenticated, managementRead) {
		w.WriteHeader(http.StatusForbidden)
		reply(w, map[string]string{"error": "forbidden"})
		return
	}
	h.releaseCatalog.ServeHTTP(w, authenticated)
}
