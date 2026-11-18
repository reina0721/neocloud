package deployment

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"html/template"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

const cookiePrefix = "clouddrive_maintenance_"

//go:embed maintenance.html
var pageHTML string

var pageTemplate = template.Must(template.New("maintenance").Funcs(template.FuncMap{
	"requestID": RandomID,
	"action": func(action string) string {
		return map[string]string{"check": "检查正式版", "backup": "完整备份", "upgrade": "升级", "rollback": "兼容回退", "restore": "恢复备份", "start": "启动", "stop": "停止", "restart": "重启"}[action]
	},
	"phase": func(phase string) string {
		return map[string]string{"queued": "等待执行", "checking": "获取版本", "preparing": "下载和验证", "stopping": "正在停服", "snapshot": "正在备份", "migrating": "数据库迁移", "compatibility": "验证兼容性", "starting": "启动和检查", "committing": "提交结果", "validating-restore": "验证恢复点", "restore-switch": "切换恢复数据", "succeeded": "已完成", "failed": "失败", "interrupted": "已中断"}[phase]
	},
}).Parse(pageHTML))

type Gateway struct {
	cfg       Config
	key       []byte
	worker    *Client
	proxy     *httputil.ReverseProxy
	owners    *http.Client
	limiterMu sync.Mutex
	attempts  int
	window    time.Time
}

func NewGateway(cfg Config, key []byte) (*Gateway, error) {
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	if len(key) < 32 {
		return nil, errors.New("网关会话密钥无效")
	}
	upstream := &url.URL{Scheme: "http", Host: cfg.Upstream}
	g := &Gateway{
		cfg: cfg, key: key, worker: NewClient(cfg.Socket()),
		owners: &http.Client{Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }},
	}
	g.proxy = &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(upstream)
			r.Out.Host = r.In.Host
			if _, secure, _ := g.origin(r.In); secure {
				r.Out.Header.Set("X-Forwarded-Proto", "https")
			}
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, _ error) { unavailable(w, r) },
	}
	return g, nil
}

func (g *Gateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == MaintenancePath+"/" && (r.Method == http.MethodGet || r.Method == http.MethodHead) {
		http.Redirect(w, r, MaintenancePath, http.StatusPermanentRedirect)
		return
	}
	if r.URL.Path == MaintenancePath {
		g.maintenance(w, r)
		return
	}
	if !g.worker.Gate(r.Context()) {
		unavailable(w, r)
		return
	}
	// The app can be reached directly on loopback. Keep this path under its
	// own authorization handler and advertise a separate maintenance page.
	g.proxy.ServeHTTP(w, r)
}

func isDAV(path string) bool { return path == "/dav" || strings.HasPrefix(path, "/dav/") }

func unavailable(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Retry-After", "15")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	if r.Method == http.MethodGet && strings.Contains(r.Header.Get("Accept"), "text/html") &&
		!isDAV(r.URL.Path) && !strings.HasPrefix(r.URL.Path, "/api/") && !strings.HasPrefix(r.URL.Path, "/wopi/") {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(503)
		_, _ = io.WriteString(w, `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>CloudDrive 正在维护</title><main><h1>CloudDrive 正在维护</h1><p><a href="/maintenance">查看维护进度</a></p></main></html>`)
		return
	}
	w.WriteHeader(503)
	if r.Method != http.MethodHead {
		_, _ = io.WriteString(w, "CloudDrive 正在维护\n")
	}
}

func validOrigin(value string) bool {
	u, err := url.Parse(value)
	return err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.User == nil &&
		u.Hostname() != "" && value == u.Scheme+"://"+u.Host
}

func (g *Gateway) origin(r *http.Request) (origin string, secure, permitted bool) {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return "", false, false
	}
	ip, err := netip.ParseAddr(host)
	if err != nil {
		return "", false, false
	}
	origin = "http://" + r.Host
	if r.TLS != nil || (g.cfg.TrustedProxy != "" && ip.Unmap().String() == g.cfg.TrustedProxy &&
		len(r.Header.Values("X-Forwarded-Proto")) == 1 && r.Header.Get("X-Forwarded-Proto") == "https" &&
		"https://"+r.Host == g.cfg.Origin) {
		origin = "https://" + r.Host
		return origin, true, validOrigin(origin)
	}
	u, err := url.Parse(origin)
	if err != nil || !validOrigin(origin) {
		return "", false, false
	}
	clientHost := net.ParseIP(u.Hostname())
	loopback := ip.IsLoopback() && (u.Hostname() == "localhost" || (clientHost != nil && clientHost.IsLoopback()))
	return origin, false, loopback
}

func (g *Gateway) makeToken(kind, value, origin string, lifetime time.Duration) string {
	fields := strconv.FormatInt(time.Now().Add(lifetime).Unix(), 10) + ":" + value
	payload := base64.RawURLEncoding.EncodeToString([]byte(fields))
	return payload + "." + g.signature(kind, payload, origin)
}

func (g *Gateway) signature(kind, payload, origin string) string {
	m := hmac.New(sha256.New, g.key)
	_, _ = io.WriteString(m, kind+"\n"+payload+"\n"+origin)
	return base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}

func (g *Gateway) value(r *http.Request, kind, origin string) string {
	c, err := r.Cookie(cookiePrefix + kind)
	if err != nil {
		return ""
	}
	encoded, signature, ok := strings.Cut(c.Value, ".")
	if !ok || subtle.ConstantTimeCompare([]byte(signature), []byte(g.signature(kind, encoded, origin))) != 1 {
		return ""
	}
	payload, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		return ""
	}
	expiration, value, ok := strings.Cut(string(payload), ":")
	exp, err := strconv.ParseInt(expiration, 10, 64)
	if !ok || err != nil || exp <= time.Now().Unix() {
		return ""
	}
	return value
}

func (g *Gateway) issue(w http.ResponseWriter, kind, value, origin string, https bool, lifetime time.Duration) {
	http.SetCookie(w, &http.Cookie{Name: cookiePrefix + kind, Value: g.makeToken(kind, value, origin, lifetime),
		Path: MaintenancePath, MaxAge: int(lifetime.Seconds()), HttpOnly: true, Secure: https, SameSite: http.SameSiteStrictMode})
}

func (g *Gateway) iamRequest(r *http.Request, method, path string) (*http.Request, error) {
	req, err := http.NewRequestWithContext(r.Context(), method, "http://"+g.cfg.Upstream+path, nil)
	if err != nil {
		return nil, err
	}
	req.Host = r.Host
	for _, cookie := range r.Cookies() {
		if !strings.HasPrefix(cookie.Name, cookiePrefix) {
			req.AddCookie(cookie)
		}
	}
	return req, nil
}

func (g *Gateway) owner(r *http.Request, origin string, write bool) string {
	path := OwnerPath
	method := http.MethodGet
	if write {
		method = http.MethodPost
	}
	req, err := g.iamRequest(r, method, path)
	if err != nil {
		return ""
	}
	if write {
		csrf, err := g.iamRequest(r, http.MethodGet, "/api/console/v1/auth/csrf")
		if err != nil {
			return ""
		}
		response, err := g.owners.Do(csrf)
		if err != nil {
			return ""
		}
		var result struct {
			Token string `json:"token"`
		}
		err = json.NewDecoder(io.LimitReader(response.Body, 4096)).Decode(&result)
		response.Body.Close()
		if err != nil || response.StatusCode != 200 || len(result.Token) != 64 {
			return ""
		}
		// The Console's CSRF endpoint returns Set-Cookie for a newly minted
		// token. Merge it into the local request without changing session cookies.
		existing := req.Cookies()
		req.Header.Del("Cookie")
		updated := response.Cookies()
		for _, cookie := range existing {
			replaced := false
			for _, newer := range updated {
				if cookie.Name == newer.Name {
					replaced = true
				}
			}
			if !replaced {
				req.AddCookie(cookie)
			}
		}
		for _, cookie := range updated {
			req.AddCookie(cookie)
		}
		req.Header.Set("Origin", origin)
		req.Header.Set("X-CSRF-Token", result.Token)
	}
	response, err := g.owners.Do(req)
	if err != nil {
		return ""
	}
	defer response.Body.Close()
	var result struct {
		Owner string `json:"owner"`
	}
	if response.StatusCode != 200 || json.NewDecoder(io.LimitReader(response.Body, 1024)).Decode(&result) != nil || len(result.Owner) > 100 {
		return ""
	}
	return result.Owner
}

type maintenancePage struct {
	State
	Authorized bool
	Permitted  bool
	Receipt    *Job
	Active     bool
	IsNewer    bool
	CSRF       string
	Error      string
}

func (g *Gateway) maintenance(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "same-origin")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")
	origin, secure, permitted := g.origin(r)
	csrf := g.value(r, "csrf", origin)
	recovery := permitted && g.value(r, "recovery", origin) == "authorized"
	if r.Method == http.MethodPost {
		g.mutate(w, r, origin, secure, permitted, recovery, csrf)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD, POST")
		http.Error(w, "不支持的请求方式", 405)
		return
	}
	w.Header().Set("X-CloudDrive-Maintenance", "1")
	if r.Method == http.MethodHead {
		w.WriteHeader(200)
		return
	}
	if permitted && csrf == "" {
		csrf = RandomID()
		g.issue(w, "csrf", csrf, origin, secure, 4*time.Hour)
	}
	page := maintenancePage{Permitted: permitted, CSRF: csrf}
	if permitted {
		state, err := g.worker.Status(r.Context())
		if err != nil {
			page.Error = "维护服务暂不可用"
		} else {
			page.Authorized = recovery || (state.Serving && g.owner(r, origin, false) != "")
			if page.Authorized {
				page.State = state
				page.IsNewer = state.Update != nil && newer(state.Update.Version, state.Current)
				for _, job := range state.Jobs {
					page.Active = page.Active || job.Finished == nil
				}
			}
			if id := g.value(r, "receipt", origin); id != "" {
				for _, job := range state.Jobs {
					if job.ID == id {
						page.Receipt = &job
						page.Active = page.Active || job.Finished == nil
						break
					}
				}
			}
		}
	}
	g.render(w, 200, page)
}

func (g *Gateway) mutate(w http.ResponseWriter, r *http.Request, origin string, secure, permitted, recovery bool, csrf string) {
	r.Body = http.MaxBytesReader(w, r.Body, 8192)
	if !permitted || len(r.Header.Values("Origin")) != 1 || r.Header.Get("Origin") != origin ||
		!strings.HasPrefix(r.Header.Get("Content-Type"), "application/x-www-form-urlencoded") ||
		r.ParseForm() != nil || csrf == "" || subtle.ConstantTimeCompare([]byte(r.PostForm.Get("csrf")), []byte(csrf)) != 1 {
		g.render(w, 403, maintenancePage{Error: "会话或请求来源验证失败，请返回维护页后重试", Permitted: permitted})
		return
	}
	action := r.PostForm.Get("action")
	switch action {
	case "recovery-login":
		g.limiterMu.Lock()
		now := time.Now()
		if now.Sub(g.window) > time.Minute {
			g.window = now
			g.attempts = 0
		}
		g.attempts++
		limited := g.attempts > 12
		g.limiterMu.Unlock()
		if limited {
			g.render(w, 429, maintenancePage{Error: "恢复凭据尝试过多，请稍后重试"})
			return
		}
		if err := g.worker.Recovery(r.Context(), r.PostForm.Get("secret")); err != nil {
			g.render(w, 403, maintenancePage{Error: "恢复凭据无效或维护服务不可用", Permitted: true, CSRF: csrf})
			return
		}
		g.issue(w, "recovery", "authorized", origin, secure, 30*time.Minute)
	case "recovery-logout":
		http.SetCookie(w, &http.Cookie{Name: cookiePrefix + "recovery", Path: MaintenancePath, MaxAge: -1, HttpOnly: true, Secure: secure, SameSite: http.SameSiteStrictMode})
	default:
		switch action {
		case "check", "upgrade", "backup", "rollback", "restore":
		default:
			g.render(w, 400, maintenancePage{Error: "无效的维护操作"})
			return
		}
		actor := "recovery"
		if !recovery {
			actor = g.owner(r, origin, true)
		}
		if actor == "" {
			g.render(w, 403, maintenancePage{Error: "请使用系统所有者会话或恢复凭据"})
			return
		}
		req := Request{ID: r.PostForm.Get("id"), Action: action, Target: r.PostForm.Get("target"), Expected: r.PostForm.Get("expected"),
			Confirm: r.PostForm.Get("confirm"), Actor: actor}
		job, err := g.worker.Submit(r.Context(), req)
		if err != nil {
			g.render(w, 409, maintenancePage{Error: err.Error()})
			return
		}
		g.issue(w, "receipt", job.ID, origin, secure, 4*time.Hour)
	}
	http.Redirect(w, r, MaintenancePath, http.StatusSeeOther)
}

func (g *Gateway) render(w http.ResponseWriter, status int, value maintenancePage) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(status)
	_ = pageTemplate.Execute(w, value)
}
