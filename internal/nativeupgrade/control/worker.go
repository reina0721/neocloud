// Package control defines the private protocol between the native host and the Go worker.
package control

import "encoding/json"

const (
	WorkerArgument = "_native-worker"
	// #nosec G101 -- 固定值是私有 HTTP 头名称，认证值由宿主运行时生成。
	TokenHeader  = "X-CloudDrive-Native-Token"
	RemoteHeader = "X-CloudDrive-Native-Remote"
	WebHeader    = "X-CloudDrive-Native-Web"
	SchemeHeader = "X-CloudDrive-Native-Scheme"
	Protocol     = 1
)

// Request is sent over the supervisor-owned stdin pipe. Tokens and release plans
// never appear in process arguments or in an HTTP request from a client.
type Request struct {
	ID              string          `json:"id,omitempty"`
	Action          string          `json:"action"`
	Token           string          `json:"token,omitempty"`
	Candidate       bool            `json:"candidate,omitempty"`
	Plan            json.RawMessage `json:"plan,omitempty"`
	Expected        string          `json:"expected,omitempty"`
	TimeoutMS       int64           `json:"timeoutMs,omitempty"`
	BackupDirectory string          `json:"backupDirectory,omitempty"`
	BackupPath      string          `json:"backupPath,omitempty"`
}

// Response is one acknowledgement per request, sent over the child stdout pipe.
type Response struct {
	ID                       string `json:"id,omitempty"`
	Protocol                 int    `json:"protocol"`
	Phase                    string `json:"phase"`
	Version                  string `json:"version"`
	Commit                   string `json:"commit"`
	Driver                   string `json:"driver,omitempty"`
	ConfigDigest             string `json:"configDigest,omitempty"`
	ConfiguredBusinessAddr   string `json:"configuredBusinessAddr,omitempty"`
	ConfiguredManagementAddr string `json:"configuredManagementAddr,omitempty"`
	BusinessAddr             string `json:"businessAddr,omitempty"`
	ManagementAddr           string `json:"managementAddr,omitempty"`
	Backup                   string `json:"backup,omitempty"`
	Error                    string `json:"error,omitempty"`
}
