package nativeupgrade

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/gofrs/flock"
	"github.com/reina0721/neocloud/internal/deployment"
)

const renameFence = ".native-upgrade/rename-fence.json"

type RenamePlan struct {
	Source  string `json:"source"`
	Target  string `json:"target"`
	Version string `json:"version,omitempty"`
	Profile string `json:"profile,omitempty"`
	Bytes   int64  `json:"bytes,omitempty"`
	Phase   string `json:"phase"`
	Backup  string `json:"backup,omitempty"`
}

// RenameData 核对存储位置，并在执行时取得数据库所有权后返回副本修改操作。
type RenameData func(ctx context.Context, source, target string, offline bool) (apply func(string) error, finish func() error, err error)

type renameFenceState struct {
	Peer    string
	Pending bool
}

// RenameInstance 只迁移已停止的签名托管实例。服务注册由宿主运维入口管理。
func RenameInstance(ctx context.Context, action, source, target string, rebind RenameData) (result RenamePlan, resultErr error) {
	source, err := canonicalRoot(source)
	if err != nil {
		return result, err
	}
	target, err = canonicalRoot(target)
	if err != nil {
		return result, err
	}
	if samePath(source, target) || !samePath(filepath.Dir(source), filepath.Dir(target)) {
		return result, errors.New("新旧实例目录须为同一父目录下的不同路径")
	}
	journalName := fmt.Sprintf(".neocloud-rename-%x.json", sha256.Sum256([]byte(target)))
	journalPath := filepath.Join(filepath.Dir(target), journalName)
	plan := RenamePlan{Source: source, Target: target, Phase: "planned"}
	var previous RenamePlan
	err = deployment.ReadJSON(journalPath, &previous)
	if err == nil && (previous.Source != source || previous.Target != target) {
		return result, errors.New("实例改名日志与指定目录不符")
	}
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return result, fmt.Errorf("读取实例改名日志: %w", err)
	}
	if action == "status" {
		if err != nil {
			return plan, nil
		}
		return previous, nil
	}
	if action != "plan" && action != "apply" && action != "rollback" {
		return result, errors.New("未知的实例改名操作")
	}
	if action == "rollback" && previous.Phase == "rolled-back" {
		return previous, clearRenameFence(source, target, true)
	}
	if action == "rollback" && previous.Phase != "published" && previous.Phase != "rollback-staged" {
		return result, errors.New("未找到可回退的已提交改名")
	}
	if rebind == nil {
		return result, errors.New("缺少文件存储重绑定能力")
	}
	if action == "apply" && previous.Phase == "published" {
		return previous, clearRenameFence(target, source, true)
	}

	active, destination := source, target
	if action == "rollback" {
		active, destination = target, source
	}
	if _, err := os.Lstat(filepath.Join(active, renameFence)); err == nil {
		if previous.Phase != "staged" && previous.Phase != "rollback-staged" ||
			checkRenameFence(active, destination, false) != nil {
			return result, errors.New("源实例已退役或由另一项改名任务占用")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return result, err
	}
	activeRoot, err := filepath.EvalSymlinks(active)
	if err != nil || !samePath(activeRoot, active) {
		return result, errors.New("源实例须为已存在的真实目录")
	}
	if action == "rollback" {
		if err := checkRenameFence(destination, active, false); err != nil && previous.Phase != "rollback-staged" {
			return result, err
		}
	} else if _, err := os.Lstat(destination); err == nil {
		if action != "apply" || previous.Phase != "staged" {
			return result, errors.New("目标实例目录已占用")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return result, err
	}

	nativeState, err := inspectRenameState(ctx, active)
	if err != nil {
		return result, err
	}
	if nativeState.Transition != "" || nativeState.Job != nil && nativeState.Job.EndedAt == nil {
		return result, errors.New("实例仍有在途升级或恢复任务")
	}
	plan.Version, plan.Profile = nativeState.Current, nativeState.Profile
	if !stableTag.MatchString(plan.Version) {
		return result, errors.New("实例没有可核验的正式版本")
	}
	if previous.Phase != "staged" && previous.Phase != "rollback-staged" {
		plan.Bytes, err = renameTree(ctx, active, "")
		if err != nil {
			return result, err
		}
		free, err := renameFreeBytes(filepath.Dir(destination))
		if err != nil {
			return result, fmt.Errorf("检查目标空间: %w", err)
		}
		if uint64(plan.Bytes) > free {
			return result, errors.New("目标空间无法保留经过校验的数据副本")
		}
	}
	if action == "plan" {
		if _, err := loadRenameRelease(ctx, active, plan); err != nil {
			return result, err
		}
		_, _, err := rebind(ctx, active, destination, false)
		return plan, err
	}

	jobLock := flock.New(journalPath + ".lock")
	defer func() { resultErr = errors.Join(resultErr, jobLock.Close()) }()
	if ok, err := jobLock.TryLock(); err != nil || !ok {
		return result, errors.Join(errors.New("实例改名已在执行"), err)
	}
	hostLock := flock.New(filepath.Join(active, controlDirectory, "host.lock"))
	defer func() { resultErr = errors.Join(resultErr, hostLock.Close()) }()
	if ok, err := hostLock.TryLock(); err != nil || !ok {
		return result, errors.Join(errors.New("请先停止原生宿主及业务进程"), err)
	}

	lockedState, err := inspectRenameState(ctx, active)
	if err != nil {
		return result, err
	}
	if lockedState.Current != nativeState.Current || lockedState.Profile != nativeState.Profile ||
		lockedState.Transition != "" || lockedState.Job != nil && lockedState.Job.EndedAt == nil {
		return result, errors.New("实例版本或任务已变化，请重新预检")
	}
	if _, err := loadRenameRelease(ctx, active, plan); err != nil {
		return result, err
	}
	if (previous.Phase == "staged" || previous.Phase == "rollback-staged") && checkRenameFence(destination, active, true) == nil {
		if err := verifyRenamedWorker(ctx, destination, previous); err != nil {
			return result, err
		}
		return finishRenameDeployment(previous, journalPath, action, active, destination)
	}
	apply, finish, err := rebind(ctx, active, destination, true)
	if err != nil {
		return result, err
	}
	defer func() { resultErr = errors.Join(resultErr, finish()) }()
	if _, err := os.Lstat(destination); err == nil && action != "rollback" {
		return result, errors.New("目标目录在执行前已被占用")
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return result, err
	}

	stage, err := os.MkdirTemp(filepath.Dir(destination), ".neocloud-rename-")
	if err != nil {
		return result, err
	}
	defer func() { resultErr = errors.Join(resultErr, os.RemoveAll(stage)) }()
	if _, err := renameTree(ctx, active, stage); err != nil {
		return result, err
	}
	if err := apply(stage); err != nil {
		return result, err
	}
	if _, err := loadRenameRelease(ctx, stage, plan); err != nil {
		return result, err
	}
	if err := setRenameFence(stage, active, true); err != nil {
		return result, err
	}
	plan.Phase = "staged"
	if action == "rollback" {
		plan.Phase = "rollback-staged"
		plan.Backup = previous.Backup
		if plan.Backup == "" {
			plan.Backup = filepath.Join(filepath.Dir(source), ".neocloud-original-"+deployment.RandomID())
		}
		if !samePath(filepath.Dir(plan.Backup), filepath.Dir(source)) ||
			!strings.HasPrefix(filepath.Base(plan.Backup), ".neocloud-original-") {
			return result, errors.New("原实例恢复副本的路径不符")
		}
	}
	if err := deployment.WriteJSON(journalPath, plan); err != nil {
		return result, err
	}
	if err := setRenameFence(active, destination, false); err != nil {
		return result, err
	}
	if action == "rollback" {
		_, backupErr := os.Lstat(plan.Backup)
		if errors.Is(backupErr, os.ErrNotExist) {
			if err := os.Rename(destination, plan.Backup); err != nil {
				return result, errors.Join(err, clearRenameFence(active, destination, false))
			}
		} else if backupErr != nil {
			return result, backupErr
		} else if _, err := os.Lstat(destination); !errors.Is(err, os.ErrNotExist) {
			return result, errors.New("恢复副本已存在且目标未释放")
		}
	}
	if err := os.Rename(stage, destination); err != nil {
		if plan.Backup != "" {
			err = errors.Join(err, os.Rename(plan.Backup, destination))
		}
		return result, errors.Join(err, clearRenameFence(active, destination, false))
	}
	if err := verifyRenamedWorker(ctx, destination, plan); err != nil {
		// Keep the failed, fenced copy for diagnostics and restore the original route.
		failed := filepath.Join(filepath.Dir(destination), ".neocloud-failed-"+deployment.RandomID())
		if moveErr := os.Rename(destination, failed); moveErr != nil {
			return result, errors.Join(err, moveErr)
		}
		if plan.Backup != "" {
			if restoreErr := os.Rename(plan.Backup, destination); restoreErr != nil {
				return result, errors.Join(err, restoreErr)
			}
		}
		return result, errors.Join(err, clearRenameFence(active, destination, false))
	}
	return finishRenameDeployment(plan, journalPath, action, active, destination)
}

func loadRenameRelease(ctx context.Context, root string, plan RenamePlan) (deployment.NativeTarget, error) {
	profile := deployment.NativeGo
	if plan.Profile == fullProfile {
		profile = deployment.NativeFull
	}
	return deployment.LoadNativeFor(ctx, filepath.Join(root, controlDirectory, "versions"), plan.Version, profile)
}

func verifyRenamedWorker(ctx context.Context, root string, plan RenamePlan) error {
	probe, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	target, err := loadRenameRelease(probe, root, plan)
	if err != nil {
		return err
	}
	process, err := launch(probe, root, target, nil, false)
	if err != nil {
		return fmt.Errorf("新路径的签名业务进程未完成预检: %w", err)
	}
	return process.exit()
}

func finishRenameDeployment(plan RenamePlan, journal, action, source, target string) (RenamePlan, error) {
	plan.Phase = "published"
	if action == "rollback" {
		plan.Phase = "rolled-back"
	}
	if err := deployment.WriteJSON(journal, plan); err != nil {
		return plan, err
	}
	return plan, clearRenameFence(target, source, true)
}

func samePath(left, right string) bool {
	left, right = filepath.Clean(left), filepath.Clean(right)
	if runtime.GOOS == "windows" {
		return strings.EqualFold(left, right)
	}
	return left == right
}

func setRenameFence(root, peer string, pending bool) error {
	return deployment.WriteJSON(filepath.Join(root, renameFence), renameFenceState{Peer: peer, Pending: pending})
}

func checkRenameFence(root, peer string, pending bool) error {
	var fence renameFenceState
	if err := deployment.ReadJSON(filepath.Join(root, renameFence), &fence); err != nil || fence.Peer != peer || fence.Pending != pending {
		return errors.Join(errors.New("目标目录没有匹配的实例改名隔离标记"), err)
	}
	return nil
}

func clearRenameFence(root, peer string, pending bool) error {
	path := filepath.Join(root, renameFence)
	if _, err := os.Lstat(path); errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	if err := checkRenameFence(root, peer, pending); err != nil {
		return err
	}
	return os.Remove(path)
}

func inspectRenameState(ctx context.Context, root string) (State, error) {
	path := filepath.ToSlash(filepath.Join(root, controlDirectory, "state.db"))
	if filepath.VolumeName(path) != "" {
		path = "/" + path
	}
	dsn := url.URL{Scheme: "file", Path: path, RawQuery: "mode=ro"}
	db, err := sql.Open("sqlite", dsn.String())
	if err != nil {
		return State{}, err
	}
	result, err := (&journal{db: db}).load(ctx)
	return result, errors.Join(err, db.Close())
}

func renameTree(ctx context.Context, source, destination string) (int64, error) {
	root, err := os.OpenRoot(source)
	if err != nil {
		return 0, err
	}
	defer root.Close()
	var bytesNeeded int64
	var directories []struct {
		name string
		mode fs.FileMode
	}
	err = fs.WalkDir(root.FS(), ".", func(path string, item fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if path == "." || path == renameFence || path == ".native-upgrade/host.lock" ||
			path == ".native-upgrade/host.sock" && item.Type()&os.ModeSocket != 0 ||
			strings.HasSuffix(path, ".clouddrive-workload.lock") {
			return nil
		}
		info, err := item.Info()
		if err != nil {
			return err
		}
		if !info.IsDir() && !info.Mode().IsRegular() {
			return fmt.Errorf("实例含无法复制的文件类型: %s", path)
		}
		if !info.IsDir() {
			bytesNeeded += info.Size()
		}
		if destination == "" {
			return nil
		}
		target := filepath.Join(destination, filepath.FromSlash(path))
		if info.IsDir() {
			directories = append(directories, struct {
				name string
				mode fs.FileMode
			}{target, info.Mode().Perm()})
			return os.Mkdir(target, 0700)
		}
		return copyRenameFile(root, path, target, info.Mode())
	})
	if err == nil {
		for i := len(directories) - 1; i >= 0; i-- {
			if err = os.Chmod(directories[i].name, directories[i].mode); err != nil {
				break
			}
		}
	}
	return bytesNeeded, err
}

func copyRenameFile(root *os.Root, name, target string, mode os.FileMode) error {
	in, err := root.Open(name)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	original, copied := sha256.New(), sha256.New()
	if _, err = io.Copy(io.MultiWriter(out, original), in); err == nil {
		err = out.Sync()
	}
	if err == nil {
		_, err = out.Seek(0, io.SeekStart)
	}
	if err == nil {
		_, err = io.Copy(copied, out)
	}
	if err == nil && !bytes.Equal(original.Sum(nil), copied.Sum(nil)) {
		err = fmt.Errorf("实例数据校验不符: %s", name)
	}
	if err == nil {
		err = out.Chmod(mode.Perm())
	}
	return errors.Join(err, out.Close())
}
