package deployment

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"time"
)

func matchSecret(path, token string) bool {
	if len(token) != 64 {
		return false
	}
	expected, err := readText(path)
	return err == nil && subtle.ConstantTimeCompare([]byte(expected), []byte(token)) == 1
}

func WorkerHandler(w *Worker) http.Handler {
	router := http.NewServeMux()
	router.HandleFunc("GET /status", func(res http.ResponseWriter, req *http.Request) { respond(res, 200, w.Status()) })
	router.HandleFunc("GET /gate", func(res http.ResponseWriter, req *http.Request) {
		w.mu.Lock()
		defer w.mu.Unlock()
		respond(res, 200, w.state.Serving && !w.faulted)
	})
	router.HandleFunc("POST /jobs", func(res http.ResponseWriter, req *http.Request) {
		var input struct {
			Request
			Actor string `json:"actor"`
		}
		if !decode(res, req, &input) {
			return
		}
		input.Request.Actor = input.Actor
		job, err := w.Submit(input.Request)
		switch {
		case err == nil:
			respond(res, 202, job)
		case errors.Is(err, ErrInvalid):
			respond(res, 400, err.Error())
		case errors.Is(err, ErrBusy), errors.Is(err, ErrRecovery), errors.Is(err, ErrStale):
			respond(res, 409, err.Error())
		default:
			respond(res, 503, "维护状态暂不可用，请查看宿主机服务日志")
		}
	})
	router.HandleFunc("POST /recovery", func(res http.ResponseWriter, req *http.Request) {
		var input struct {
			Secret string `json:"secret"`
		}
		if !decode(res, req, &input) {
			return
		}
		if !w.ValidateRecovery(input.Secret) {
			respond(res, 403, "恢复凭据无效")
			return
		}
		res.WriteHeader(204)
	})
	return router
}

func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192))
	d.DisallowUnknownFields()
	if d.Decode(v) != nil || d.Decode(new(any)) != io.EOF {
		respond(w, 400, "无效的请求参数")
		return false
	}
	return true
}

func respond(w http.ResponseWriter, code int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(value)
}

func SocketListener(address string) (net.Listener, error) {
	if info, err := os.Lstat(address); err == nil {
		if info.Mode()&os.ModeSocket == 0 {
			return nil, errors.New("维护 socket 路径已被占用")
		}
		conn, dialErr := net.DialTimeout("unix", address, time.Second)
		if dialErr == nil {
			conn.Close()
			return nil, ErrBusy
		}
		if err = os.Remove(address); err != nil {
			return nil, err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	l, err := net.Listen("unix", address)
	if err != nil {
		return nil, err
	}
	if err = os.Chmod(address, 0660); err != nil {
		l.Close()
		return nil, err
	}
	return l, nil
}

type Client struct{ http *http.Client }

func NewClient(socket string) *Client {
	return &Client{http: &http.Client{
		Timeout: 4 * time.Second,
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
				return (&net.Dialer{}).DialContext(ctx, "unix", socket)
			},
			MaxIdleConnsPerHost: 8, IdleConnTimeout: 20 * time.Second,
		},
	}}
}

func (c *Client) Status(ctx context.Context) (State, error) {
	var out State
	err := c.call(ctx, http.MethodGet, "/status", nil, &out)
	return out, err
}

func (c *Client) Gate(ctx context.Context) bool {
	var serving bool
	return c.call(ctx, http.MethodGet, "/gate", nil, &serving) == nil && serving
}

func (c *Client) Recovery(ctx context.Context, secret string) error {
	return c.call(ctx, http.MethodPost, "/recovery", map[string]string{"secret": secret}, nil)
}

func (c *Client) Submit(ctx context.Context, request Request) (Job, error) {
	var out Job
	wrapped := struct {
		Request
		Actor string `json:"actor"`
	}{request, request.Actor}
	err := c.call(ctx, http.MethodPost, "/jobs", wrapped, &out)
	return out, err
}

func (c *Client) call(ctx context.Context, method, path string, input, output any) error {
	var body io.Reader
	if input != nil {
		wire, err := json.Marshal(input)
		if err != nil {
			return err
		}
		body = strings.NewReader(string(wire))
	}
	req, err := http.NewRequestWithContext(ctx, method, "http://maintenance.local"+path, body)
	if err != nil {
		return err
	}
	res, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode >= 400 {
		var message string
		if err = json.NewDecoder(io.LimitReader(res.Body, 2048)).Decode(&message); err == nil && message != "" {
			return errors.New(message)
		}
		return errors.New("维护接口暂不可用")
	}
	if output == nil {
		return nil
	}
	return json.NewDecoder(io.LimitReader(res.Body, 16<<20)).Decode(output)
}
