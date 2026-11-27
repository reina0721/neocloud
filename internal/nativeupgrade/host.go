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
	"strconv"
	"sync"
	"time"

	"github.com/gofrs/flock"
	"github.com/reina0721/clouddrive/internal/deployment"
	"github.com/reina0721/clouddrive/internal/nativeupgrade/control"
)

const controlDirectory = ".native-upgrade"
const startupBudget = 30 * time.Second
const fullProfile = "managed-full"

type releaseSource interface {
	Latest(context.Context) (deployment.Release, error)
	NativeCandidates(context.Context, string) ([]string, error)
	StageNative(context.Context, string, string) (deployment.NativeTarget, error)
	LoadNative(context.Context, string, string) (deployment.NativeTarget, error)
}

type gitHubReleases struct {
	*deployment.Releases
	local   Bootstrap
	profile deployment.NativeProfile
}

func (source gitHubReleases) NativeCandidates(ctx context.Context, current string) ([]string, error) {
	return source.Releases.NativeCandidatesFor(ctx, current, source.profile)
}

func (source gitHubReleases) LoadNative(ctx context.Context, root, version string) (deployment.NativeTarget, error) {
	return deployment.LoadNativeFor(ctx, root, version, source.profile)
}

func (source gitHubReleases) StageNative(ctx context.Context, root, version string) (deployment.NativeTarget, error) {
	if source.local.ReleaseDirectory != "" && version == source.local.Version {
		return deployment.ImportNativeFor(ctx, root, source.local.ReleaseDirectory, source.local.TrustDirectory, version, source.profile)
	}
	return source.Releases.StageNativeFor(ctx, root, version, source.profile)
}

type Bootstrap struct {
	Version          string
	ReleaseDirectory string
	TrustDirectory   string
	Full             bool
	AdoptFull        bool
	WebAddress       string
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

	op          sync.Mutex
	worker      *child
	public      [2]string
	webAddress  string
	previousWeb *webSite
	workers     sync.WaitGroup
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
	if err := validateReleaseInput(initial); err != nil {
		return err
	}
	return runProfile(ctx, root, initial, gitHubReleases{Releases: deployment.NewReleases(), local: initial})
}

func validateReleaseInput(initial Bootstrap) error {
	if (initial.ReleaseDirectory == "") != (initial.TrustDirectory == "") ||
		(initial.ReleaseDirectory != "" && initial.Version == "") {
		return errors.New("本地引导须同时提供 --initial、--release-dir 和独立的 --trust-dir")
	}
	return nil
}

type FullPreparation struct {
	Version    string `json:"version"`
	WebBuildID string `json:"webBuildId"`
	WebAddress string `json:"webAddress"`
	Business   string `json:"business"`
	Management string `json:"management"`
}

// PrepareFull verifies and stages a full release and probes the current
// configuration/database read-only. This does not take public listeners or
// modify the instance's selected release.
func PrepareFull(ctx context.Context, root string, initial Bootstrap) (FullPreparation, error) {
	if err := validateReleaseInput(initial); err != nil {
		return FullPreparation{}, err
	}
	if initial.Version == "" {
		return FullPreparation{}, errors.New("--prepare-full 需要 --initial 正式版本")
	}
	if err := validateWebAddress(initial.WebAddress); err != nil {
		return FullPreparation{}, err
	}
	root, err := canonicalRoot(root)
	if err != nil {
		return FullPreparation{}, err
	}
	private := filepath.Join(root, controlDirectory)
	versions := filepath.Join(private, "versions")
	for _, directory := range []string{private, versions} {
		if err := ensurePrivateDirectory(directory); err != nil {
			return FullPreparation{}, err
		}
	}
	source := gitHubReleases{Releases: deployment.NewReleases(), local: initial, profile: deployment.NativeFull}
	target, err := source.StageNative(ctx, versions, initial.Version)
	if err != nil {
		return FullPreparation{}, err
	}
	probe, stop := context.WithTimeout(ctx, startupBudget)
	defer stop()
	worker, err := launch(probe, root, target, nil, false)
	if err != nil {
		return FullPreparation{}, err
	}
	result := FullPreparation{Version: worker.prepared.Version, WebBuildID: target.WebID,
		Business: worker.prepared.ConfiguredBusinessAddr, Management: worker.prepared.ConfiguredManagementAddr,
		WebAddress: initial.WebAddress}
	if result.WebAddress == "" {
		result.WebAddress = result.Business
	}
	return result, worker.exit()
}

func run(ctx context.Context, root, initial string, releases releaseSource) error {
	return runProfile(ctx, root, Bootstrap{Version: initial}, releases)
}

func runProfile(ctx context.Context, root string, initial Bootstrap, releases releaseSource) (resultErr error) {
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
	full := initial.Full || initial.AdoptFull || state.Profile == fullProfile
	if source, ok := releases.(gitHubReleases); ok {
		source.profile = deployment.NativeGo
		if full {
			source.profile = deployment.NativeFull
		}
		releases = source
	}
	pending, err := prepareBootstrap(ctx, releases, versions, initial, full, &state)
	if err != nil {
		return err
	}
	if !pending && state.Job != nil && state.Job.EndedAt == nil {
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
	h := &host{ctx: ctx, root: root, versions: versions, releases: releases, journal: j, state: state, webAddress: state.WebAddress}
	defer func() {
		stop()
		h.workers.Wait()
		if h.worker != nil {
			resultErr = errors.Join(resultErr, h.worker.exit())
		}
	}()

	h.public = state.Addresses
	if pending || h.public[0] == "" {
		worker, err := h.prepareActive(ctx)
		if err != nil {
			return err
		}
		h.worker = worker
		configured := [2]string{worker.prepared.ConfiguredBusinessAddr, worker.prepared.ConfiguredManagementAddr}
		if worker.prepared.Driver == "" {
			return errors.New("业务进程未返回数据库类型")
		}
		if h.public[0] != "" && (h.public != configured || state.Driver != worker.prepared.Driver) {
			return errors.New("接管整包时原 Go 监听地址或数据库类型发生变化")
		}
		h.public = configured
		h.state.Driver, h.state.Addresses = worker.prepared.Driver, configured
	}
	listeners := make([]net.Listener, 0, 4)
	defer func() {
		for _, listener := range listeners {
			_ = listener.Close()
		}
	}()
	addresses := []string{h.public[0], h.public[1]}
	if h.webAddress != "" && h.webAddress != h.public[0] {
		addresses = append(addresses, h.webAddress)
	}
	for _, address := range addresses {
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
		if err := h.startActive(ctx, h.worker, func() error { return h.save(func(*State) {}) }); err != nil {
			return fmt.Errorf("首次启动原生实例: %w", err)
		}
	} else if err := h.recoverCurrent(); err != nil {
		slog.Error("恢复原生 Go 实例失败，控制入口继续运行", "error", err)
	}
	servers := []*http.Server{
		publicHTTP(h.front.handler(0)),
		publicHTTP(h.front.handler(1)),
	}
	if len(addresses) == 3 {
		servers = append(servers, publicHTTP(h.front.handler(2)))
	}
	servers = append(servers, &http.Server{Handler: h.controlHandler(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 30 * time.Second})
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

func publicHTTP(handler http.Handler) *http.Server {
	return &http.Server{Handler: handler, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second}
}

func prepareBootstrap(ctx context.Context, releases releaseSource, versions string, initial Bootstrap, full bool, state *State) (bool, error) {
	if initial.WebAddress != "" {
		if !full {
			return false, errors.New("--web-addr 只用于原生整包")
		}
		if err := validateWebAddress(initial.WebAddress); err != nil {
			return false, err
		}
	}
	if state.Profile == fullProfile {
		if initial.AdoptFull || initial.WebAddress != "" && initial.WebAddress != state.WebAddress {
			return false, errors.New("整包实例已接管，Web 地址须与首次配置一致")
		}
		return false, nil
	}
	existing := state.Current != ""
	if existing && !full {
		return false, nil
	}
	if existing && !initial.AdoptFull {
		return false, errors.New("已有 Go-only 实例，请指定 --adopt-full 和 --initial")
	}
	if initial.AdoptFull && !existing {
		return false, errors.New("--adopt-full 需要已有托管 Go 实例，独立 Go 实例使用 --full")
	}
	if initial.Version == "" {
		return false, errors.New("首次启动需要用 --initial 指定正式版")
	}
	target, err := releases.StageNative(ctx, versions, initial.Version)
	if err != nil {
		return false, err
	}
	if full && (target.WebDirectory == "" || target.WebID == "") {
		return false, errors.New("候选发行包缺少已验签的静态 Web")
	}
	if existing {
		legacy, err := deployment.LoadNative(ctx, versions, state.Current)
		if err != nil {
			return false, err
		}
		if state.Transition != "" && state.Transition != state.Current || state.Job != nil && state.Job.EndedAt == nil ||
			target.Manifest.FromVersion != legacy.Manifest.Version || target.Manifest.FromCommit != legacy.Manifest.Commit ||
			len(target.Manifest.OnlinePlans) != 0 {
			return false, errors.New("首次接管需要精确匹配旧版的无迁移整包，并等待已有升级任务完成")
		}
	}
	state.Current, state.Previous, state.Job = initial.Version, "", nil
	state.Transition, state.Checkpoint = "", ""
	if full {
		state.Profile, state.WebAddress = fullProfile, initial.WebAddress
	}
	return true, nil
}

func validateWebAddress(address string) error {
	if address == "" {
		return nil
	}
	_, port, splitErr := net.SplitHostPort(address)
	number, portErr := strconv.ParseUint(port, 10, 16)
	if splitErr != nil || portErr != nil || number == 0 {
		return errors.New("--web-addr 需要固定的监听地址与数字端口")
	}
	return nil
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

func (h *host) startActive(ctx context.Context, c *child, beforePublish func() error) error {
	ctx, cancel := context.WithTimeout(ctx, startupBudget)
	defer cancel()
	if err := c.activate(ctx); err != nil {
		return err
	}
	if beforePublish != nil {
		if err := beforePublish(); err != nil {
			return err
		}
	}
	if _, err := c.call(ctx, control.Request{Action: "publish"}, "active"); err != nil {
		return err
	}
	h.openWorker(c)
	return nil
}

func (h *host) openWorker(c *child) {
	routes := gatewayRoutes{c.routes[0], c.routes[1]}
	if c.web != nil {
		web := c.web.route(h.previousWeb, c.webProxy, h.webUpdate(c, h.previousWeb))
		if h.webAddress == "" || h.webAddress == h.public[0] {
			routes[0] = web
		} else {
			routes[2] = web
		}
	}
	h.front.open(routes)
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
	h.front.open(gatewayRoutes{})
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
	h.previousWeb = nil
	if previous := persisted.Previous; c.web != nil && previous != "" {
		target, err := h.releases.LoadNative(ctx, h.versions, previous)
		if err == nil {
			h.previousWeb, err = prepareWebSite(target.WebDirectory, target.WebID)
		}
		if err != nil {
			slog.Warn("上一版 Web 资源暂不可用", "error", err)
		}
	}
	if err := h.startActive(ctx, c, nil); err != nil {
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
