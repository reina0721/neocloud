package httpbinding

import "net/http"

// The host gateway asks for a current owner decision using the Console's own
// cookie, security-revision and write-origin checks.
func (h *Handler) authorizeDeployment(w http.ResponseWriter, r *http.Request) {
	account := current(r).Identity.AccountID
	if h.requireDeploymentOwner(w, r, account) {
		reply(w, map[string]string{"owner": account})
	}
}

func (h *Handler) requireDeploymentOwner(w http.ResponseWriter, r *http.Request, account string) bool {
	if h.deploymentOwner == nil || account == "" {
		failure(w, http.StatusForbidden, "forbidden", "")
		return false
	}
	allowed, err := h.deploymentOwner(r.Context(), account)
	if err != nil {
		problem(w, err)
		return false
	}
	if !allowed {
		failure(w, http.StatusForbidden, "forbidden", "")
		return false
	}
	return true
}
