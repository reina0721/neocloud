package httpbinding

import "net/http"

// The host gateway asks for a current owner decision using the Console's own
// cookie, security-revision and write-origin checks.
func (h *Handler) authorizeDeployment(w http.ResponseWriter, r *http.Request) {
	account := current(r).Identity.AccountID
	if h.deploymentOwner == nil || account == "" {
		failure(w, http.StatusForbidden, "forbidden", "")
		return
	}
	allowed, err := h.deploymentOwner(r.Context(), account)
	if err != nil {
		problem(w, err)
		return
	}
	if !allowed {
		failure(w, http.StatusForbidden, "forbidden", "")
		return
	}
	reply(w, map[string]string{"owner": account})
}
