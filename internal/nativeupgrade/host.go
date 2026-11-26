// Package nativeupgrade coordinates the versioned Go workers of one native installation.
package nativeupgrade

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/gofrs/flock"
	"github.com/reina0721/clouddrive/internal/deployment"
	"github.com/reina0721/clouddrive/internal/nativeupgrade/control"
)

const controlDirectory = ".native-upgrade"
const startupBudget = 30 * time.Second

type releaseSource interface {
	Latest(context.Context) (deployment.Release, error)
	NativeCandidates(context.Context, string) ([]string, error)
	StageNative(context.Context, string, string) (deployment.NativeTarget, error)
	LoadNative(context.Context, string, string) (deployment.NativeTarget, error)
}

type gitHubReleases struct {
	*deployment.Releases
	local Bootstrap
}

func (gitHubReleases) LoadNative(ctx context.Context, root, version string) (deployment.NativeTarget, error) {
	return deployment.LoadNative(ctx, root, version)
}

func (source gitHubReleases) StageNative(ctx context.Context, root, version string) (deployment.NativeTarget, error) {
	if source.local.ReleaseDirectory != "" && version == source.local.Version {
		return deployment.ImportNative(ctx, root, source.local.ReleaseDirectory, source.local.TrustDirectory, version)
	}
	return source.Releases.StageNative(ctx, root, version)
}

type Bootstrap struct {
	Version          string
	ReleaseDirectory string
	TrustDirectory   string
}

type host struct {
	ctx      context.Context
	root     string
	versions string
	releases releaseSource
	journal  *journal
	front    gateway

	mu     sync.Mutex
	state  State
	cancel context.CancelFunc

	op      sync.Mutex
	worker  *child
	public  [2]string
	workers sync.WaitGroup
}

func canonicalRoot(root string) (string, error) {
	abs, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(abs)
}

// Run hosts the originally configured Go API and management addresses for this instance.
func Run(ctx context.Context, root string, initial Bootstrap) error {
	if (initial.ReleaseDirectory == "") != (initial.TrustDirectory == "") ||
		(initial.ReleaseDirectory != "" && initial.Version == "") {
		return errors.New("本地引导须同时提供 --initial、--release-dir 和独立的 --trust-dir")
	}
	return run(ctx, root, initial.Version, gitHubReleases{Releases: deployment.NewReleases(), local: initial})
}

func run(ctx context.Context, root, initial string, releases releaseSource) (resultErr error) {
	root, err := canonicalRoot(root)
	if err != nil {
		return err
	}
	directory := filepath.Join(root, controlDirectory)
	if err := ensurePrivateDirectory(directory); err != nil {
		return err
	}
	versions := filepath.Join(directory, "versions")
	if err := ensurePrivateDirectory(versions); err != nil {
		return err
	}
	lock := flock.New(filepath.Join(directory, "host.lock"))
	defer func() { resultErr = errors.Join(resultErr, lock.Close()) }()
	locked, err := lock.TryLock()
	if err != nil || !locked {
		return errors.Join(errors.New("实例已有原生宿主进程"), err)
	}
	j, state, err := openJournal(ctx, filepath.Join(directory, "state.db"))
	if err != nil {
		return err
	}
	defer func() { resultErr = errors.Join(resultErr, j.db.Close()) }()
	if state.Current == "" {
		if initial == "" {
			return errors.New("首次启动需要用 --initial 指定正式版")
		}
		if _, err := releases.StageNative(ctx, versions, initial); err != nil {
			return err
		}
		state.Current = initial
		if err := j.save(ctx, state); err != nil {
			return err
		}
	}
	if state.Job != nil && state.Job.EndedAt == nil {
		now := time.Now().UTC()
		if state.Job.Phase == "committed" {
			state.Job.Result = "版本已提交，宿主将启动该版本"
		} else {
			state.Job.Phase, state.Job.Result = "interrupted", "宿主重新启动；可重试同一候选"
		}
		state.Job.EndedAt = &now
		if err := j.save(ctx, state); err != nil {
			return err
		}
	}
	ctx, stop := context.WithCancel(ctx)
	h := &host{ctx: ctx, root: root, versions: versions, releases: releases, journal: j, state: state}
	defer func() {
		stop()
		h.workers.Wait()
		if h.worker != nil {
			resultErr = errors.Join(resultErr, h.worker.exit())
		}
	}()

	h.public = state.Addresses
	if h.public[0] == "" {
		worker, err := h.prepareActive(ctx)
		if err != nil {
			return err
		}
		h.worker = worker
		h.public = [2]string{worker.prepared.ConfiguredBusinessAddr, worker.prepared.ConfiguredManagementAddr}
		if worker.prepared.Driver == "" {
			return errors.New("业务进程未返回数据库类型")
		}
		if err := h.save(func(s *State) { s.Driver, s.Addresses = worker.prepared.Driver, h.public }); err != nil {
			return err
		}
	}
	listeners := make([]net.Listener, 0, 3)
	defer func() {
		for _, listener := range listeners {
			_ = listener.Close()
		}
	}()
	for _, address := range h.public {
		l, err := net.Listen("tcp", address)
		if err != nil {
			return fmt.Errorf("接管配置的 Go 监听地址 %s: %w", address, err)
		}
		listeners = append(listeners, l)
	}
	ipc, err := listenControl(root)
	if err != nil {
		return err
	}
	listeners = append(listeners, ipc)
	if h.worker != nil {
		if err := h.startActive(ctx, h.worker); err != nil {
			slog.Error("启动原生 Go 实例失败，控制入口继续运行", "error", err)
			if err := h.worker.kill(); err != nil {
				return err
			}
			h.worker = nil
		}
	} else if err := h.recoverCurrent(); err != nil {
		slog.Error("恢复原生 Go 实例失败，控制入口继续运行", "error", err)
	}
	servers := []*http.Server{
		{Handler: h.front.handler(0), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second},
		{Handler: h.front.handler(1), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second},
		{Handler: h.controlHandler(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 30 * time.Second},
	}
	failed := make(chan error, len(servers))
	for index, server := range servers {
		go func() { failed <- server.Serve(listeners[index]) }()
	}
	h.workers.Add(1)
	go h.monitor()
	select {
	case <-ctx.Done():
	case err := <-failed:
		resultErr = err
	}
	stop()
	shutdown, cancel := context.WithTimeout(context.Background(), handoffBudget)
	defer cancel()
	for _, server := range servers {
		if err := server.Shutdown(shutdown); err != nil {
			resultErr = errors.Join(resultErr, err, server.Close())
		}
	}
	return resultErr
}

func ensurePrivateDirectory(path string) error {
	if err := os.Mkdir(path, 0700); err != nil && !errors.Is(err, os.ErrExist) {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("升级控制路径须为真实目录")
	}
	return secureDirectory(path, info)
}

func (h *host) snapshot() State {
	h.mu.Lock()
	defer h.mu.Unlock()
	return cloneState(h.state)
}

func cloneState(state State) State {
	if state.Job != nil {
		job := *state.Job
		state.Job = &job
	}
	return state
}

func (h *host) saveLocked(state State) error {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := h.journal.save(ctx, state); err != nil {
		return fmt.Errorf("保存原生升级状态: %w", err)
	}
	h.state = state
	return nil
}

func (h *host) save(update func(*State)) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	state := cloneState(h.state)
	update(&state)
	return h.saveLocked(state)
}

func (h *host) prepareActive(ctx context.Context) (*child, error) {
	state := h.snapshot()
	current, err := h.releases.LoadNative(ctx, h.versions, state.Current)
	if err != nil {
		return nil, err
	}
	var plan json.RawMessage
	if state.Transition != "" && state.Transition != state.Current {
		expansion, err := h.releases.LoadNative(ctx, h.versions, state.Transition)
		if err != nil {
			return nil, err
		}
		if expansion.Manifest.FromVersion != current.Manifest.Version || expansion.Manifest.FromCommit != current.Manifest.Commit {
			return nil, errors.New("已登记的在线迁移与当前版本不匹配")
		}
		plan = expansion.Manifest.OnlinePlans[state.Driver]
		if len(plan) == 0 {
			return nil, errors.New("缺少已经登记的在线迁移契约")
		}
	}
	ctx, cancel := context.WithTimeout(ctx, startupBudget)
	defer cancel()
	return launch(ctx, h.root, current, plan, false)
}

func (h *host) startActive(ctx context.Context, c *child) error {
	ctx, cancel := context.WithTimeout(ctx, startupBudget)
	defer cancel()
	if err := c.activate(ctx); err != nil {
		return err
	}
	if _, err := c.call(ctx, control.Request{Action: "publish"}, "active"); err != nil {
		return err
	}
	h.front.open(c.routes)
	return nil
}

func (h *host) monitor() {
	defer h.workers.Done()
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-h.ctx.Done():
			return
		case <-ticker.C:
			if h.op.TryLock() {
				if h.worker == nil || h.worker.exited() {
					if err := h.recoverCurrent(); err != nil {
						slog.Error("恢复已提交的 Go 版本失败", "error", err)
					}
				}
				h.op.Unlock()
			}
		}
	}
}

func (h *host) recoverCurrent() error {
	old := h.worker
	if old != nil {
		if err := old.kill(); err != nil {
			return err
		}
		h.worker = nil
	}
	h.front.open([2]http.Handler{})
	ctx, cancel := context.WithTimeout(h.ctx, startupBudget)
	defer cancel()
	// Read the durable decision before restarting after an uncertain commit.
	h.mu.Lock()
	persisted, err := h.journal.load(ctx)
	if err == nil {
		h.state = persisted
	}
	h.mu.Unlock()
	if err != nil {
		return fmt.Errorf("读取原生升级状态: %w", err)
	}
	c, err := h.prepareActive(ctx)
	if err != nil {
		return err
	}
	if c.prepared.ConfiguredBusinessAddr != h.public[0] || c.prepared.ConfiguredManagementAddr != h.public[1] || c.prepared.Driver != h.snapshot().Driver {
		return errors.Join(errors.New("恢复版本配置的公开地址已变化"), c.kill())
	}
	if err := h.startActive(ctx, c); err != nil {
		return errors.Join(err, c.kill())
	}
	h.worker = c
	return nil
}

func decode(w http.ResponseWriter, r *http.Request, value any) bool {
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192))
	d.DisallowUnknownFields()
	return d.Decode(value) == nil && errors.Is(d.Decode(new(any)), io.EOF)
}

func respond(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
