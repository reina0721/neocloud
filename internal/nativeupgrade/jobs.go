package nativeupgrade

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"path/filepath"
	"regexp"
	"time"

	"github.com/reina0721/neocloud/internal/deployment"
	"github.com/reina0721/neocloud/internal/nativeupgrade/control"
)

var stableTag = regexp.MustCompile(`^v(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$`)

type jobRequest struct {
	Action string `json:"action"`
	Target string `json:"target,omitempty"`
}

func validJobRequest(request jobRequest) bool {
	return (request.Action == "apply" || request.Action == "rollback") &&
		(request.Target == "" || request.Action == "apply" && stableTag.MatchString(request.Target))
}

func (h *host) cancellableLocked() bool {
	return h.cancel != nil && h.state.Job != nil && h.state.Job.EndedAt == nil &&
		h.state.Job.Phase != "handoff" && h.state.Job.Phase != "committed"
}

func (h *host) controlHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /status", func(w http.ResponseWriter, _ *http.Request) {
		respond(w, http.StatusOK, h.snapshot())
	})
	mux.HandleFunc("GET /check", func(w http.ResponseWriter, r *http.Request) {
		current := h.snapshot().Current
		latest, err := h.releases.Latest(r.Context())
		if err != nil {
			respond(w, http.StatusBadGateway, "无法读取 GitHub 正式版本")
			return
		}
		candidates, err := h.releases.NativeCandidates(r.Context(), current)
		if err != nil {
			respond(w, http.StatusBadGateway, "无法查询适合本平台的托管发行包")
			return
		}
		respond(w, http.StatusOK, struct {
			Current    string             `json:"current"`
			Latest     deployment.Release `json:"latest"`
			Candidates []string           `json:"candidates"`
		}{current, latest, candidates})
	})
	mux.HandleFunc("POST /jobs", func(w http.ResponseWriter, r *http.Request) {
		var request jobRequest
		if !decode(w, r, &request) || !validJobRequest(request) {
			respond(w, http.StatusBadRequest, "无效的更新操作或正式版本")
			return
		}
		job, err := h.submit(request)
		if err != nil {
			respond(w, http.StatusConflict, err.Error())
			return
		}
		respond(w, http.StatusAccepted, job)
	})
	mux.HandleFunc("POST /cancel", func(w http.ResponseWriter, _ *http.Request) {
		h.mu.Lock()
		defer h.mu.Unlock()
		if !h.cancellableLocked() {
			respond(w, http.StatusConflict, "当前没有可以取消的更新任务")
			return
		}
		h.cancel()
		respond(w, http.StatusAccepted, "已请求取消")
	})
	return mux
}

func (h *host) submit(request jobRequest) (Job, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.ctx.Err() != nil {
		return Job{}, h.ctx.Err()
	}
	if h.cancel != nil || !h.op.TryLock() {
		return Job{}, errors.New("实例已有更新或恢复任务")
	}
	if h.worker == nil || h.worker.exited() {
		h.op.Unlock()
		return Job{}, errors.New("当前 Go 版本尚未就绪")
	}
	job := Job{ID: deployment.RandomID(), Action: request.Action, Target: request.Target, Phase: "preparing", StartedAt: time.Now().UTC()}
	state := h.state
	jobCopy := job
	state.Job = &jobCopy
	if err := h.saveLocked(state); err != nil {
		h.op.Unlock()
		return Job{}, err
	}
	ctx, cancel := context.WithTimeout(h.ctx, time.Hour)
	h.cancel = cancel
	h.workers.Add(1)
	go h.perform(ctx, cancel, job)
	return job, nil
}

func (h *host) perform(ctx context.Context, cancel context.CancelFunc, job Job) {
	defer h.workers.Done()
	defer h.op.Unlock()
	defer cancel()
	err := h.update(ctx, job)
	if err != nil && h.worker != nil && h.worker.exited() && h.ctx.Err() == nil {
		err = errors.Join(err, h.recoverCurrent())
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	state := cloneState(h.state)
	now := time.Now().UTC()
	state.Job.EndedAt = &now
	switch {
	case err == nil && job.Action == "apply" && state.Job.Target == "":
		state.Job.Phase, state.Job.Result = "succeeded", "没有更高的正式托管版"
	case err == nil:
		state.Job.Phase, state.Job.Result = "succeeded", "更新处理完成"
	case errors.Is(err, context.Canceled) && state.Job.Phase != "committed":
		state.Job.Phase, state.Job.Result = "canceled", "已取消，可重试同一候选"
	default:
		state.Job.Result = err.Error()
		if state.Job.Phase != "committed" {
			state.Job.Phase = "failed"
		}
	}
	if err := h.saveLocked(state); err != nil {
		slog.Error("保存自升级结果失败", "error", err)
	}
	h.cancel = nil
}

func (h *host) update(ctx context.Context, job Job) error {
	state := h.snapshot()
	old := h.worker
	target, plan, err := h.resolve(ctx, state, old, job)
	if err != nil || target.Manifest.Version == state.Current {
		return err
	}
	if err := h.save(func(s *State) { s.Job.Target = target.Manifest.Version }); err != nil {
		return err
	}
	launchCtx, cancel := context.WithTimeout(ctx, startupBudget)
	candidate, err := launch(launchCtx, h.root, target, plan, job.Action == "apply")
	cancel()
	if err != nil {
		return err
	}
	defer func() {
		if h.worker != candidate {
			_ = candidate.kill()
		}
	}()
	if candidate.prepared.ConfigDigest != old.prepared.ConfigDigest || candidate.prepared.Driver != state.Driver ||
		candidate.prepared.ConfiguredBusinessAddr != h.public[0] || candidate.prepared.ConfiguredManagementAddr != h.public[1] {
		return errors.New("候选配置或公开端口与当前实例不一致")
	}
	if job.Action == "apply" && len(plan) > 0 {
		if err := h.expand(ctx, old, candidate, target.Manifest.Version, plan); err != nil {
			return err
		}
	}
	return h.switchWorker(ctx, old, candidate, job.Action)
}

func (h *host) resolve(ctx context.Context, state State, old *child, job Job) (deployment.NativeTarget, json.RawMessage, error) {
	if job.Action == "rollback" {
		return h.rollbackTarget(ctx, state)
	}
	versions := []string{job.Target}
	transition := state.Transition != "" && state.Transition != state.Current
	if transition {
		if job.Target != "" && job.Target != state.Transition {
			return deployment.NativeTarget{}, nil, errors.New("已有扩展迁移记录，请重试同一候选")
		}
		versions = []string{state.Transition}
	} else if job.Target == "" {
		var err error
		versions, err = h.releases.NativeCandidates(ctx, state.Current)
		if err != nil {
			return deployment.NativeTarget{}, nil, err
		}
		if len(versions) == 0 {
			return deployment.NativeTarget{Manifest: deployment.NativeManifest{Version: state.Current}}, nil, nil
		}
	}
	// Limit automatic staging. Operators can supply an exact release to search farther back.
	for _, version := range versions[:min(len(versions), 3)] {
		if !deployment.NewerStableVersion(version, state.Current) {
			return deployment.NativeTarget{}, nil, errors.New("应用升级只接受较新的正式版")
		}
		target, err := h.releases.StageNative(ctx, h.versions, version)
		if err != nil {
			return deployment.NativeTarget{}, nil, err
		}
		if target.Manifest.FromVersion == old.prepared.Version && target.Manifest.FromCommit == old.prepared.Commit {
			return target, target.Manifest.OnlinePlans[state.Driver], nil
		}
	}
	return deployment.NativeTarget{}, nil, errors.New("已检查的发行包未声明从当前构建在线升级，请指定有兼容契约的正式版")
}

func (h *host) rollbackTarget(ctx context.Context, state State) (deployment.NativeTarget, json.RawMessage, error) {
	if state.Previous == "" || (state.Transition != "" && state.Transition != state.Current) {
		return deployment.NativeTarget{}, nil, errors.New("当前没有可用的兼容回退版本")
	}
	current, err := h.releases.LoadNative(ctx, h.versions, state.Current)
	if err != nil {
		return deployment.NativeTarget{}, nil, err
	}
	previous, err := h.releases.LoadNative(ctx, h.versions, state.Previous)
	if err != nil {
		return deployment.NativeTarget{}, nil, err
	}
	if current.Manifest.FromVersion != previous.Manifest.Version || current.Manifest.FromCommit != previous.Manifest.Commit {
		return deployment.NativeTarget{}, nil, errors.New("上一个版本未通过当前发行版的兼容契约核对")
	}
	return previous, current.Manifest.OnlinePlans[state.Driver], nil
}

func (h *host) expand(ctx context.Context, old, candidate *child, version string, plan json.RawMessage) error {
	if err := h.save(func(s *State) {
		if s.Transition != version {
			s.Checkpoint = ""
		}
		s.Transition, s.Job.Phase = version, "migrating"
	}); err != nil {
		return err
	}
	allowCtx, cancel := context.WithTimeout(ctx, startupBudget)
	_, err := old.call(allowCtx, control.Request{Action: "allow", Plan: plan, Expected: old.prepared.ConfigDigest}, "active")
	cancel()
	if err != nil {
		return err
	}
	migrationCtx, stop := context.WithTimeout(ctx, 5*time.Minute)
	defer stop()
	backupPath, err := h.prepareBackup(migrationCtx, candidate)
	if err != nil {
		return err
	}
	_, err = candidate.call(migrationCtx, control.Request{
		Action: "migrate", Expected: candidate.prepared.ConfigDigest, BackupPath: backupPath, BackupDirectory: filepath.Dir(backupPath),
	}, "prepared")
	return err
}

func (h *host) prepareBackup(ctx context.Context, candidate *child) (string, error) {
	state := h.snapshot()
	backupPath := state.Checkpoint
	if backupPath == "" {
		parent := filepath.Join(h.root, controlDirectory, "backups")
		if err := ensurePrivateDirectory(parent); err != nil {
			return "", err
		}
		directory := filepath.Join(parent, state.Job.ID)
		if err := ensurePrivateDirectory(directory); err != nil {
			return "", err
		}
		response, err := candidate.call(ctx, control.Request{
			Action: "backup", Expected: candidate.prepared.ConfigDigest, BackupDirectory: directory,
		}, "prepared")
		if err != nil {
			return "", err
		}
		if response.Backup == "" || filepath.Dir(filepath.Clean(response.Backup)) != directory {
			return "", errors.New("候选未返回可信的在线备份路径")
		}
		backupPath = response.Backup
	}
	if err := h.save(func(s *State) { s.Checkpoint, s.Job.Backup = backupPath, backupPath }); err != nil {
		return "", err
	}
	return backupPath, nil
}

func (h *host) beginHandoff(ctx context.Context) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	state := cloneState(h.state)
	state.Job.Phase = "handoff"
	return h.saveLocked(state)
}

func (h *host) switchWorker(ctx context.Context, old, candidate *child, action string) error {
	if err := h.beginHandoff(ctx); err != nil {
		return err
	}
	cutover, cancel := context.WithTimeout(h.ctx, handoffBudget)
	defer cancel()
	if err := h.front.drain(cutover); err != nil {
		h.openWorker(old)
		return fmt.Errorf("在途请求未能及时排空，已保留旧版本: %w", err)
	}
	deadline, _ := cutover.Deadline()
	quiesce := time.Until(deadline) - 250*time.Millisecond
	if quiesce < time.Millisecond {
		h.openWorker(old)
		return errors.New("交接预算已用尽，旧版继续服务")
	}
	if response, err := old.call(cutover, control.Request{Action: "quiesce", TimeoutMS: quiesce.Milliseconds()}, "quiescent"); err != nil {
		// An explicit rejection means the worker kept or reopened its own admission.
		if response.Error != "" && response.Phase == "active" {
			h.openWorker(old)
			return err
		}
		return errors.Join(err, h.recoverCurrent())
	}
	if _, err := old.call(cutover, control.Request{Action: "release"}, "old-released"); err != nil {
		return errors.Join(err, h.recoverCurrent())
	}
	if err := candidate.activate(cutover); err != nil {
		return h.recoverUncommittedCandidate(candidate, err)
	}
	err := h.save(func(s *State) {
		s.Current, s.Previous, s.Job.Phase = candidate.prepared.Version, old.prepared.Version, "committed"
		if action == "apply" && s.Transition != s.Current {
			s.Transition = ""
			s.Checkpoint = ""
		}
	})
	if err != nil {
		return h.recoverUncommittedCandidate(candidate, err)
	}
	h.worker = candidate
	h.previousWeb = old.web
	if _, err := candidate.call(cutover, control.Request{Action: "publish"}, "active"); err != nil {
		return errors.Join(err, old.exit(), h.recoverCurrent())
	}
	h.openWorker(candidate)
	return old.exit()
}

func (h *host) recoverUncommittedCandidate(candidate *child, cause error) error {
	stopErr := candidate.kill()
	return errors.Join(cause, stopErr, h.recoverCurrent())
}
