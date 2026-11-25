// Package mutationproof 在进程内传递 Console 写请求的校验结果。
package mutationproof

import (
	"context"
	"net/http"
)

type consoleMutationKey struct{}

type consoleMutation struct {
	sessionID string
	method    string
	path      string
	query     string
}

// WithVerifiedConsoleMutation 由 Console 在完成会话、Origin 和双提交令牌校验后调用。
func WithVerifiedConsoleMutation(request *http.Request, sessionID string) *http.Request {
	proof := consoleMutation{sessionID, request.Method, request.URL.EscapedPath(), request.URL.RawQuery}
	return request.WithContext(context.WithValue(request.Context(), consoleMutationKey{}, proof))
}

// Matches 检查原生路由解析的会话和本次转发目标是否与校验结果一致。
func Matches(request *http.Request, sessionID string) bool {
	if request == nil || request.URL == nil || sessionID == "" {
		return false
	}
	proof, ok := request.Context().Value(consoleMutationKey{}).(consoleMutation)
	return ok && proof == (consoleMutation{sessionID, request.Method, request.URL.EscapedPath(), request.URL.RawQuery})
}
