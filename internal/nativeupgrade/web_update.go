package nativeupgrade

import (
	"bytes"
	"encoding/json"
	"net/http"
)

// The decision is made by the current worker's IAM endpoint. Nothing from the
// public request can select an IPC route or an executable.
func (h *host) webUpdate(worker *child, previous *webSite) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		action := r.URL.Path
		var method string
		switch action {
		case nativeUpdatePath:
			method = http.MethodGet
		case nativeUpdatePath + "/jobs", nativeUpdatePath + "/cancel":
			method = http.MethodPost
		default:
			respond(w, http.StatusNotFound, "未知的原生更新接口")
			return
		}
		if r.Method != method {
			w.Header().Set("Allow", method)
			respond(w, http.StatusMethodNotAllowed, "请求方法不受支持")
			return
		}
		if method == http.MethodPost && (r.Header.Get("Origin") == "" || r.Header.Get("Sec-Fetch-Site") == "cross-site") {
			respond(w, http.StatusForbidden, "更新操作需要同源授权")
			return
		}
		proof := r.Clone(r.Context())
		proof.URL.Path = "/api/console/v1/deployment/owner"
		proof.URL.RawPath, proof.URL.RawQuery = "", ""
		proof.Body, proof.GetBody, proof.ContentLength, proof.TransferEncoding = nil, nil, 0, nil
		proof.Header.Del("Content-Type")
		proof.Header.Del("Content-Length")
		decision := ownerDecision{header: make(http.Header)}
		worker.webProxy.ServeHTTP(&decision, proof)
		switch decision.status {
		case http.StatusOK:
			// IAM confirmed both the owner role and the mutation proof.
		case http.StatusUnauthorized, http.StatusForbidden:
			respond(w, decision.status, "需要当前系统所有者授权")
			return
		default:
			respond(w, http.StatusServiceUnavailable, "暂时无法核对系统所有者权限")
			return
		}

		switch action {
		case nativeUpdatePath:
			h.mu.Lock()
			state := cloneState(h.state)
			cancel := h.cancellableLocked()
			h.mu.Unlock()
			var job *webJob
			if state.Job != nil {
				job = publicJob(*state.Job)
			}
			canApply := state.Job == nil || state.Job.EndedAt != nil
			respond(w, http.StatusOK, webUpdateStatus{
				Current: state.Current, WebVersion: state.Current, WebBuildID: worker.web.build,
				Previous: state.Previous, CanApply: canApply, CanCancel: cancel,
				CanRollback: canApply && previous != nil && worker.source == state.Previous &&
					(state.Transition == "" || state.Transition == state.Current),
				Job: job,
			})
		case nativeUpdatePath + "/jobs":
			var request jobRequest
			if !decode(w, r, &request) || !validJobRequest(request) {
				respond(w, http.StatusBadRequest, "无效的更新操作或正式版本")
				return
			}
			if request.Action == "rollback" {
				state := h.snapshot()
				if previous == nil || worker.source != state.Previous {
					respond(w, http.StatusConflict, "暂无可回退的兼容整包")
					return
				}
			}
			var output bytes.Buffer
			if err := executeCommand(r.Context(), &output, request.Action, h.root, request.Target); err != nil {
				respond(w, http.StatusConflict, "当前无法创建更新任务")
				return
			}
			var job Job
			if err := json.Unmarshal(output.Bytes(), &job); err != nil {
				respond(w, http.StatusServiceUnavailable, "无法读取原生更新任务")
				return
			}
			respond(w, http.StatusAccepted, publicJob(job))
		case nativeUpdatePath + "/cancel":
			var output bytes.Buffer
			if err := executeCommand(r.Context(), &output, "cancel", h.root, ""); err != nil {
				respond(w, http.StatusConflict, "当前没有可以取消的更新任务")
				return
			}
			respond(w, http.StatusAccepted, "已请求取消")
		}
	})
}

type ownerDecision struct {
	header http.Header
	status int
}

func (d *ownerDecision) Header() http.Header { return d.header }

func (d *ownerDecision) WriteHeader(status int) {
	if status >= 200 && d.status == 0 {
		d.status = status
	}
}

func (d *ownerDecision) Write(data []byte) (int, error) {
	d.WriteHeader(http.StatusOK)
	return len(data), nil
}

type webUpdateStatus struct {
	Current     string  `json:"current"`
	WebVersion  string  `json:"webVersion"`
	WebBuildID  string  `json:"webBuildId"`
	Previous    string  `json:"previous,omitempty"`
	CanApply    bool    `json:"canApply"`
	CanCancel   bool    `json:"canCancel"`
	CanRollback bool    `json:"canRollback"`
	Job         *webJob `json:"job,omitempty"`
}

type webJob struct {
	ID     string `json:"id"`
	Action string `json:"action"`
	Target string `json:"target"`
	Phase  string `json:"phase"`
	Done   bool   `json:"done"`
}

func publicJob(job Job) *webJob {
	return &webJob{ID: job.ID, Action: job.Action, Target: job.Target, Phase: job.Phase, Done: job.EndedAt != nil}
}
