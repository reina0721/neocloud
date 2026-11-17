package httpx

import (
	"net/http"
	"strings"
)

// CookiePolicy 是显式部署策略；零值保留 HTTPS 与 __Host- Cookie 约束。
// HTTP 模式使用独立名称，不让浏览器拒绝缺少 Secure 的 __Host- Cookie。
type CookiePolicy struct {
	AllowInsecureHTTP bool
}

func (p CookiePolicy) Name(name string) string {
	if p.AllowInsecureHTTP {
		return strings.TrimPrefix(name, "__Host-")
	}
	return name
}

// #nosec G124 -- 显式允许 HTTP 的部署策略才关闭 Secure 并移除 __Host-；零值始终 Secure。
// IAM/Console 调用方仍显式设置 HttpOnly、SameSite 与 Path，双模式集成测试覆盖 CSRF 与会话校验。
func (p CookiePolicy) Cookie(cookie http.Cookie) *http.Cookie {
	cookie.Name = p.Name(cookie.Name)
	cookie.Secure = !p.AllowInsecureHTTP
	return &cookie
}
