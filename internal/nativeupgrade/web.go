package nativeupgrade

import (
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"regexp"
	"strings"
)

const webBuildPath = "/api/host/v1/web-build"
const nativeUpdatePath = "/api/console/v1/deployment/native-update"

var webBuildID = regexp.MustCompile(`^[a-f0-9]{40}$`)

type webSite struct {
	directory string
	build     string
}

func prepareWebSite(directory, build string) (*webSite, error) {
	if directory == "" && build == "" {
		return nil, nil
	}
	if directory == "" || !webBuildID.MatchString(build) {
		return nil, errors.New("静态 Web 没有可验证的构建标识")
	}
	root, err := os.OpenRoot(directory)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	for _, entry := range []string{"index.html", "404.html", "home.html", "login.html"} {
		info, err := root.Stat(entry)
		if err != nil || !info.Mode().IsRegular() || info.Size() == 0 {
			return nil, fmt.Errorf("静态 Web 缺少必要页面 %s", entry)
		}
	}
	return &webSite{directory: directory, build: build}, nil
}

func pathWithin(path, prefix string) bool {
	return path == prefix || strings.HasPrefix(path, prefix+"/")
}

func webHeaders(w http.ResponseWriter, path string) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if pathWithin(path, "/home") || strings.HasPrefix(path, "/home.") {
		w.Header().Set("Referrer-Policy", "no-referrer")
	}
	if pathWithin(path, "/file-viewers/pdf") {
		w.Header().Set("Content-Security-Policy", "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self' blob:; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
	}
}

func (site *webSite) route(previous *webSite, api, update http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		switch {
		case path == webBuildPath:
			if r.Method != http.MethodGet && r.Method != http.MethodHead {
				w.Header().Set("Allow", "GET, HEAD")
				respond(w, http.StatusMethodNotAllowed, "请求方法不受支持")
				return
			}
			respond(w, http.StatusOK, struct {
				Build string `json:"buildId"`
			}{site.build})
		case pathWithin(path, nativeUpdatePath):
			update.ServeHTTP(w, r)
		case pathWithin(path, "/api") || pathWithin(path, "/dav") || pathWithin(path, "/wopi") || pathWithin(path, "/management"):
			if pathWithin(path, "/api") {
				w.Header().Set("Referrer-Policy", "no-referrer")
			}
			api.ServeHTTP(w, r)
		default:
			assets := pathWithin(path, "/_next/static")
			flight := r.Header.Get("RSC") == "1" && strings.HasSuffix(path, ".txt")
			selected := site
			if assets || flight {
				id := r.URL.Query().Get("dpl")
				if flight {
					id = r.Header.Get("x-deployment-id")
					w.Header().Add("Vary", "x-deployment-id")
				}
				switch {
				case id == "" || id == site.build:
				case previous != nil && id == previous.build:
					selected = previous
				default:
					webHeaders(w, path)
					w.Header().Set("x-nextjs-deployment-id", site.build)
					http.NotFound(w, r)
					return
				}
			}
			selected.serve(w, r, assets, flight)
		}
	})
}

func (site *webSite) serve(w http.ResponseWriter, r *http.Request, assets, flight bool) {
	webHeaders(w, r.URL.Path)
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "请求方法不受支持", http.StatusMethodNotAllowed)
		return
	}
	if r.URL.Path == "/" {
		location := "/home"
		if r.URL.RawQuery != "" {
			location += "?" + r.URL.RawQuery
		}
		http.Redirect(w, r, location, http.StatusTemporaryRedirect)
		return
	}
	path := strings.TrimPrefix(r.URL.Path, "/")
	if !fs.ValidPath(strings.TrimSuffix(path, "/")) || strings.ContainsAny(path, `\:`) || path == "web-build.json" {
		http.NotFound(w, r)
		return
	}
	root, err := os.OpenRoot(site.directory)
	if err != nil {
		http.Error(w, "静态 Web 暂不可用", http.StatusServiceUnavailable)
		return
	}
	defer root.Close()
	if strings.HasSuffix(path, "/") {
		path = strings.TrimSuffix(path, "/") + ".html"
	}
	file, err := openWebFile(root, path)
	if err != nil && !assets && !flight && !strings.Contains(path[strings.LastIndex(path, "/")+1:], ".") {
		path += ".html"
		file, err = openWebFile(root, path)
	}
	if err != nil {
		if assets || flight || strings.Contains(path, ".") && !strings.HasSuffix(path, ".html") {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusNotFound)
		if r.Method != http.MethodHead {
			if data, readErr := root.ReadFile("404.html"); readErr == nil {
				_, _ = w.Write(data)
			}
		}
		return
	}
	defer file.Close()
	if assets {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	}
	if flight {
		w.Header().Set("x-nextjs-deployment-id", site.build)
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	}
	switch {
	case strings.HasSuffix(path, ".mjs"), strings.HasSuffix(path, ".js"):
		w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
	case strings.HasSuffix(path, ".wasm"):
		w.Header().Set("Content-Type", "application/wasm")
	}
	info, err := file.Stat()
	if err != nil {
		http.NotFound(w, r)
		return
	}
	http.ServeContent(w, r, path, info.ModTime(), file)
}

func openWebFile(root *os.Root, path string) (*os.File, error) {
	file, err := root.Open(path)
	if err != nil {
		return nil, err
	}
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return nil, errors.Join(fs.ErrNotExist, err, file.Close())
	}
	return file, nil
}
