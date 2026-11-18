package deployment

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"time"

	"github.com/gofrs/flock"
)

var (
	ErrBusy     = errors.New("该实例已有维护任务")
	ErrStale    = errors.New("实例版本已变化，请刷新后重试")
	ErrRecovery = errors.New("实例需要恢复，请先恢复完整备份")
	ErrInvalid  = errors.New("无效的维护操作或确认")
)

type Worker struct {
	engine  engine
	ctx     context.Context
	mu      sync.Mutex
	state   State
	wg      sync.WaitGroup
	running *flock.Flock
	faulted bool
}

func NewWorker(ctx context.Context, root string, cfg Config) (*Worker, error) {
	e := engine{root: root, cfg: cfg, releases: NewReleases()}
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	project, err := readText(filepath.Join(root, ".control", "project"))
	if err != nil || project != cfg.Project {
		return nil, errors.New("实例标记与维护配置不匹配")
	}
	current, err := readText(e.currentPath())
	if err != nil || !releasePattern.MatchString(current) {
		return nil, errors.New("实例当前版本无效")
	}
	w := &Worker{engine: e, ctx: ctx, state: State{Current: current, Serving: true}}
	if err := ReadJSON(filepath.Join(e.control(), "state.json"), &w.state); err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if !releasePattern.MatchString(w.state.Current) {
		return nil, errors.New("持久化维护状态无效")
	}
	lock := flock.New(filepath.Join(root, ".control", "lock"))
	locked, err := lock.TryLock()
	if err != nil {
		return nil, err
	}
	if !locked {
		return nil, ErrBusy
	}
	defer lock.Close()
	if err = w.reconcile(current); err != nil {
		return nil, err
	}
	return w, nil
}

func (w *Worker) Wait() { w.wg.Wait() }

func (w *Worker) Status() State {
	w.mu.Lock()
	defer w.mu.Unlock()
	state := w.state.clone()
	if w.faulted {
		state.Serving, state.Recovery = false, true
	}
	return state
}

func (s State) clone() State {
	s.Jobs = slices.Clone(s.Jobs)
	s.Backups = slices.Clone(s.Backups)
	return s
}

func (w *Worker) persist(next State) error {
	if err := WriteJSON(filepath.Join(w.engine.control(), "state.json"), next); err != nil {
		return err
	}
	w.state = next
	return nil
}

func (w *Worker) change(update func(*State)) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	next := w.state.clone()
	update(&next)
	return w.persist(next)
}

func (w *Worker) reconcile(current string) error {
	next := w.state.clone()
	next.Current = current
	for i := range next.Jobs {
		job := &next.Jobs[i]
		if job.Finished != nil {
			continue
		}
		now := time.Now().UTC()
		job.Finished = &now
		target := job.TargetVersion(next)
		switch job.Phase {
		case "queued", "checking", "preparing", "validating-restore":
			job.Result = "已中断，可重试"
		case "committing":
			if current == target {
				if current != job.Original {
					next.Previous = job.Original
				}
				next.Serving, next.Recovery = true, false
				job.Phase, job.Result = "succeeded", "版本已提交"
				break
			}
			fallthrough
		default:
			ctx, cancel := context.WithTimeout(w.ctx, 5*time.Minute)
			next.Serving, next.Recovery = w.recover(ctx, *job, target, State{Serving: job.WasServing, Recovery: job.WasRecovery})
			cancel()
			job.Result = "任务中断，原实例已保留"
			if next.Recovery {
				job.Result = "任务中断，实例等待恢复"
			}
		}
		if job.Phase != "succeeded" {
			job.Phase = "interrupted"
		}
	}
	return w.persist(next)
}

func (j Job) TargetVersion(state State) string {
	if j.Action == "restore" {
		for _, snapshot := range state.Backups {
			if snapshot.ID == j.Target {
				return snapshot.Version
			}
		}
	}
	if releasePattern.MatchString(j.Target) {
		return j.Target
	}
	return j.Original
}

func (w *Worker) Submit(req Request) (Job, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.ctx.Err() != nil {
		return Job{}, w.ctx.Err()
	}
	if !idPattern.MatchString(req.ID) || req.Actor == "" || len(req.Actor) > 128 {
		return Job{}, ErrInvalid
	}
	for _, job := range w.state.Jobs {
		if job.ID == req.ID {
			if job.Action != req.Action || job.Actor != req.Actor || job.Target != req.Target || job.Expected != req.Expected ||
				job.Confirm != req.Confirm {
				return Job{}, ErrInvalid
			}
			return job, nil
		}
	}
	if w.faulted {
		return Job{}, ErrRecovery
	}
	if w.running != nil {
		return Job{}, ErrBusy
	}
	if req.Expected != w.state.Current {
		return Job{}, ErrStale
	}
	if w.state.Recovery && req.Action != "restore" && req.Action != "check" {
		return Job{}, ErrRecovery
	}
	switch req.Action {
	case "check", "start", "stop", "restart", "backup":
		if req.Target != "" || req.Confirm != "" {
			return Job{}, ErrInvalid
		}
	case "upgrade":
		if !newer(req.Target, w.state.Current) || req.Confirm != "" {
			return Job{}, ErrInvalid
		}
	case "rollback":
		if req.Target != w.state.Previous || !releasePattern.MatchString(req.Target) || req.Confirm != "" {
			return Job{}, ErrInvalid
		}
	case "restore":
		if !idPattern.MatchString(req.Target) || req.Confirm != req.Target {
			return Job{}, ErrInvalid
		}
		if !slices.ContainsFunc(w.state.Backups, func(s Snapshot) bool { return s.ID == req.Target }) {
			return Job{}, ErrInvalid
		}
	default:
		return Job{}, ErrInvalid
	}
	lock := flock.New(filepath.Join(w.engine.root, ".control", "lock"))
	locked, err := lock.TryLock()
	if err != nil {
		return Job{}, err
	}
	if !locked {
		return Job{}, ErrBusy
	}
	current, err := readText(w.engine.currentPath())
	if err != nil || current != req.Expected {
		lock.Close()
		return Job{}, ErrStale
	}
	job := Job{Request: req, Actor: req.Actor, Submitted: time.Now().UTC(), Phase: "queued", Original: current, WasServing: w.state.Serving, WasRecovery: w.state.Recovery}
	next := w.state.clone()
	next.Jobs = append(next.Jobs, job)
	if err = w.persist(next); err != nil {
		lock.Close()
		return Job{}, err
	}
	w.running = lock
	w.wg.Go(func() {
		defer func() {
			w.mu.Lock()
			defer w.mu.Unlock()
			if err := lock.Close(); err != nil {
				slog.Error("释放实例锁失败", "error", err)
			}
			w.running = nil
		}()
		w.perform(job)
	})
	return job, nil
}

func findJob(s *State, id string) *Job {
	for i := range s.Jobs {
		if s.Jobs[i].ID == id {
			return &s.Jobs[i]
		}
	}
	panic("维护任务必须先持久化")
}

func (w *Worker) checkpoint(id, phase string, serving bool) error {
	return w.change(func(s *State) { findJob(s, id).Phase = phase; s.Serving = serving })
}

func (w *Worker) perform(job Job) {
	ctx, cancel := context.WithTimeout(w.ctx, 4*time.Hour)
	defer cancel()
	initial := w.Status()
	target := job.TargetVersion(initial)
	err := w.execute(ctx, job, target, initial.Serving)
	if w.ctx.Err() != nil {
		return
	}
	serving, recovery := w.Status().Serving, initial.Recovery
	if err != nil {
		slog.Warn("维护任务失败", "id", job.ID, "action", job.Action, "error", err)
		state := w.Status()
		current := findJob(&state, job.ID)
		switch current.Phase {
		case "queued", "checking", "preparing", "validating-restore":
		default:
			recoverCtx, cancel := context.WithTimeout(w.ctx, 5*time.Minute)
			serving, recovery = w.recover(recoverCtx, job, target, initial)
			cancel()
		}
	} else if job.Action == "restore" {
		recovery = false
	}
	if err := w.change(func(s *State) {
		j := findJob(s, job.ID)
		finished := time.Now().UTC()
		j.Finished = &finished
		if err != nil {
			if recovery {
				j.Result = "维护失败，待恢复"
			} else {
				j.Result = failureMessage(j.Phase)
			}
			j.Phase = "failed"
		} else {
			j.Phase, j.Result = "succeeded", "操作完成"
		}
		s.Serving, s.Recovery = serving, recovery
	}); err != nil {
		w.mu.Lock()
		w.faulted = true
		w.mu.Unlock()
		slog.Error("保存维护任务终态失败", "error", err)
	}
}

func failureMessage(phase string) string {
	switch phase {
	case "checking":
		return "无法检查正式版，请稍后重试"
	case "preparing":
		return "正式产物下载、校验或导入失败，业务未停服"
	case "validating-restore":
		return "恢复点验证失败，数据未切换"
	case "snapshot":
		return "完整备份失败，数据库未迁移"
	case "compatibility":
		return "目标版本与当前数据库不兼容，请使用完整恢复点"
	default:
		return "维护未完成，请查看宿主机服务日志"
	}
}

func (w *Worker) execute(ctx context.Context, job Job, target string, serving bool) error {
	e := w.engine
	old := job.Original
	switch job.Action {
	case "check":
		if err := w.checkpoint(job.ID, "checking", serving); err != nil {
			return err
		}
		release, err := e.releases.Latest(ctx)
		if err != nil {
			return err
		}
		return w.change(func(s *State) { s.Update = &release })
	case "upgrade":
		if err := w.checkpoint(job.ID, "preparing", serving); err != nil {
			return err
		}
		if err := e.prepare(ctx, target); err != nil {
			return err
		}
	case "restore":
		return w.restore(ctx, job, target, serving)
	}
	if err := w.checkpoint(job.ID, "stopping", false); err != nil {
		return err
	}
	if job.Action != "start" {
		if err := e.run(ctx, old, "_stop"); err != nil {
			return err
		}
	}
	if job.Action == "stop" {
		return nil
	}
	switch job.Action {
	case "backup", "upgrade":
		if err := w.checkpoint(job.ID, "snapshot", false); err != nil {
			return err
		}
		meta, err := e.snapshot(ctx, job.ID, old)
		if err != nil {
			return err
		}
		if err = w.change(func(s *State) { s.Backups = append(s.Backups, meta); findJob(s, job.ID).Backup = meta.ID }); err != nil {
			return err
		}
	}
	if job.Action == "upgrade" {
		if err := w.checkpoint(job.ID, "migrating", false); err != nil {
			return err
		}
		if err := e.run(ctx, target, "_migrate"); err != nil {
			return err
		}
	}
	if err := w.checkpoint(job.ID, "compatibility", false); err != nil {
		return err
	}
	if err := e.compatible(ctx, target); err != nil {
		return err
	}
	if job.Action == "backup" && !serving {
		return nil
	}
	if err := w.checkpoint(job.ID, "starting", false); err != nil {
		return err
	}
	if err := e.start(ctx, target); err != nil {
		return err
	}
	return w.commit(job, target)
}

func (w *Worker) restore(ctx context.Context, job Job, target string, serving bool) error {
	e := w.engine
	if err := w.checkpoint(job.ID, "validating-restore", serving); err != nil {
		return err
	}
	var meta Snapshot
	for _, snapshot := range w.Status().Backups {
		if snapshot.ID == job.Target {
			meta = snapshot
			break
		}
	}
	if meta.Version != target || !idPattern.MatchString(meta.ID) {
		return ErrInvalid
	}
	stage, err := os.MkdirTemp(e.root, ".restore-")
	if err != nil {
		return err
	}
	// A failed extraction can leave container-owned files. Preserve that directory
	// for the host operator instead of pretending it can be removed by this user.
	defer os.Remove(stage)
	if err = e.prepareRestore(ctx, meta, stage); err != nil {
		return err
	}
	if err = e.run(ctx, job.Original, "_idle"); err != nil {
		return err
	}
	if err = w.checkpoint(job.ID, "restore-switch", false); err != nil {
		return err
	}
	if err = e.run(ctx, job.Original, "_stop"); err != nil {
		return err
	}
	if err = e.beginSwap(job.ID, meta, stage); err != nil {
		return err
	}
	if err = e.start(ctx, target); err != nil {
		return err
	}
	return w.commit(job, target)
}

func (w *Worker) commit(job Job, target string) error {
	if err := w.checkpoint(job.ID, "committing", false); err != nil {
		return err
	}
	if err := atomicWrite(w.engine.currentPath(), []byte(target+"\n"), 0600); err != nil {
		return err
	}
	return w.change(func(s *State) {
		if s.Current != target {
			s.Previous, s.Current = s.Current, target
		}
		s.Serving, s.Recovery = true, false
	})
}

func (w *Worker) recover(ctx context.Context, job Job, target string, original State) (serving, recovery bool) {
	e := w.engine
	if current, err := readText(e.currentPath()); err == nil && current == target && target != job.Original {
		// commit is durable. Startup reconciliation will finish a journal update.
		return false, true
	}
	if err := e.run(ctx, job.Original, "_idle"); err != nil {
		return false, true
	}
	if err := e.run(ctx, target, "_stop"); err != nil {
		return false, true
	}
	if job.Action == "restore" {
		if err := e.undoSwap(job.ID); err != nil {
			slog.Error("恢复原实例目录失败", "error", err)
			return false, true
		}
	}
	if err := e.compatible(ctx, job.Original); err != nil {
		return false, true
	}
	if !original.Serving {
		return false, original.Recovery
	}
	if err := e.start(ctx, job.Original); err != nil {
		return false, true
	}
	return true, false
}

func (w *Worker) ValidateRecovery(secret string) bool {
	return matchSecret(filepath.Join(w.engine.control(), "recovery-token"), secret)
}
