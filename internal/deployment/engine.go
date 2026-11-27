package deployment

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

type engine struct {
	root     string
	dataDir  string
	cfg      Config
	releases *Releases
	local    bool
}

func (e engine) control() string     { return filepath.Join(e.root, ".control", "maintenance") }
func (e engine) currentPath() string { return filepath.Join(e.root, ".control", "current") }

func instanceDataDir(root string) (string, error) {
	// #nosec G304 -- 只读取安装目录下的固定实例标记。
	value, err := os.ReadFile(filepath.Join(root, ".control", "data-dir"))
	if errors.Is(err, os.ErrNotExist) {
		return filepath.Join(root, "data"), nil
	}
	if err != nil {
		return "", fmt.Errorf("读取实例数据目录标记: %w", err)
	}
	// 恢复中断时数据目录可能尚未换回。这里只验证持久化路径。
	dataDir := strings.TrimSuffix(string(value), "\n")
	if !filepath.IsAbs(dataDir) || filepath.Clean(dataDir) != dataDir || dataDir == root || filepath.Dir(dataDir) == dataDir ||
		strings.HasPrefix(root, dataDir+string(filepath.Separator)) || strings.ContainsAny(dataDir, "\x00\r\n,:") {
		return "", errors.New("实例的数据目录标记无效")
	}
	if relative, ok := strings.CutPrefix(dataDir, root+string(filepath.Separator)); ok {
		branch, _, _ := strings.Cut(relative, string(filepath.Separator))
		switch branch {
		case ".control", "releases", "backups", "runtime.env", "install.sh":
			return "", errors.New("实例数据目录与安装文件重叠")
		}
	}
	return dataDir, nil
}

func (e engine) restoreStash(journal string) string {
	if e.dataDir == filepath.Join(e.root, "data") {
		return journal
	}
	// 数据换入和换回的重命名都必须留在数据目录所在的文件系统。
	return filepath.Join(filepath.Dir(e.dataDir), ".neocloud-"+filepath.Base(journal))
}

func (e engine) tool(ctx context.Context, version, action string, params ...string) *exec.Cmd {
	launcher := filepath.Join(e.control(), "engine.sh")
	override := filepath.Join(e.control(), "gateway.compose.yaml")
	if e.local {
		launcher, override = filepath.Join(e.root, "install.sh"), ""
	}
	arguments := []string{launcher, action, "--dir", e.root, "--version", version}
	// #nosec G204 -- engine.sh 来自已安装发布包，操作名由执行器选取，参数按 argv 传递。
	cmd := exec.CommandContext(ctx, "bash", append(arguments, params...)...)
	cmd.WaitDelay = 5 * time.Second
	cmd.Env = append(os.Environ(), "NEOCLOUD_MAINTENANCE_ENGINE=1",
		"NEOCLOUD_MAINTENANCE_COMPOSE="+override,
		"NEOCLOUD_MAINTENANCE_STAGE=", "NEOCLOUD_MAINTENANCE_CONFIG=")
	return cmd
}

func (e engine) run(ctx context.Context, version, action string, params ...string) error {
	if !releasePattern.MatchString(version) {
		return errors.New("无效的已安装版本")
	}
	cmd := e.tool(ctx, version, action, params...)
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("%s %s: %w", action, version, err)
	}
	return nil
}

func (e engine) assetRoot() string    { return filepath.Join(e.control(), "assets") }
func (e engine) trustRoot() string    { return filepath.Join(e.control(), "trust") }
func (e engine) downloadRoot() string { return filepath.Join(e.assetRoot(), ".downloaded") }

func (e engine) prepare(ctx context.Context, version string, offline bool) error {
	for _, store := range []string{e.assetRoot(), e.downloadRoot()} {
		cache := filepath.Join(store, version)
		if _, err := os.Lstat(cache); errors.Is(err, os.ErrNotExist) {
			continue
		} else if err != nil {
			return err
		}
		_, trustErr := os.Stat(e.trustRoot())
		if offline || !errors.Is(trustErr, os.ErrNotExist) {
			if err := VerifyOfflineRelease(ctx, cache, version, e.trustRoot()); err != nil {
				return err
			}
		} else {
			release, err := verifyOnlineRelease(ctx, cache, version)
			if err != nil {
				return err
			}
			asset, err := release.dockerAsset(runtime.GOARCH)
			if err != nil {
				return err
			}
			if err := release.verifyDockerDigest(ctx, cache, asset); err != nil {
				return err
			}
		}
		return e.run(ctx, version, "_prepare", "--release-dir", cache)
	}
	if offline {
		return fmt.Errorf("本地缺少 %s 的已签名发布包", version)
	}

	store := e.downloadRoot()
	if err := os.MkdirAll(store, 0700); err != nil {
		return err
	}
	dir, err := os.MkdirTemp(store, ".release-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	if err = e.releases.Package(ctx, dir, version); err != nil {
		return err
	}
	cache := filepath.Join(store, version)
	if err = e.retainDownload(dir, cache, version); err != nil {
		return err
	}
	return e.run(ctx, version, "_prepare", "--release-dir", cache)
}

// retainDownload is called within the instance lock after checking the signed bytes.
func (e engine) retainDownload(dir, cache, version string) error {
	asset, err := dockerAssetInChecksums(dir, version, runtime.GOARCH)
	if err != nil {
		return err
	}
	for _, name := range []string{offlineChecksums, offlineBundle, asset} {
		// #nosec G304 -- 仅同步刚下载并校验的固定发布附件。
		file, err := os.Open(filepath.Join(dir, name))
		if err != nil {
			return err
		}
		if err = errors.Join(file.Sync(), file.Close()); err != nil {
			return err
		}
	}
	if err := syncDirectory(dir); err != nil {
		return err
	}
	if _, err := os.Lstat(cache); err == nil {
		return errors.New("此版本已存在已验证的下载，不会覆盖")
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.Rename(dir, cache); err != nil {
		return err
	}
	return errors.Join(syncDirectory(e.downloadRoot()), syncDirectory(e.assetRoot()), syncDirectory(e.control()))
}

func (e engine) ensureImages(ctx context.Context, version string, offline bool) error {
	if err := e.run(ctx, version, "_images"); err != nil {
		if prepareErr := e.prepare(ctx, version, offline); prepareErr != nil {
			return errors.Join(err, prepareErr)
		}
		return e.run(ctx, version, "_images")
	}
	return nil
}

func (e engine) serving(ctx context.Context, version string) (bool, error) {
	output, err := e.tool(ctx, version, "_serving").Output()
	if err != nil {
		return false, fmt.Errorf("读取实例运行状态: %w", err)
	}
	switch strings.TrimSpace(string(output)) {
	case "true":
		return true, nil
	case "false":
		return false, nil
	default:
		return false, errors.New("宿主机运行状态响应无效")
	}
}

func (e engine) commitReceiptPath() string { return filepath.Join(e.control(), "commit") }

func (e engine) hasCommitReceipt(id, target string) (bool, error) {
	receipt, err := readText(e.commitReceiptPath())
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	boundID, version, ok := strings.Cut(receipt, " ")
	if !ok || !idPattern.MatchString(boundID) || !releasePattern.MatchString(version) {
		return false, errors.New("持久化版本提交记录无效")
	}
	if boundID == id && version != target {
		return false, errors.New("持久化版本提交记录与维护目标不匹配")
	}
	return boundID == id, nil
}

func (e engine) setCurrent(job Job, target string) error {
	current, err := readText(e.currentPath())
	if err != nil || (current != job.Original && current != target) {
		return errors.Join(ErrStale, err)
	}
	if current == target {
		return nil
	}
	return atomicWrite(e.currentPath(), []byte(target+"\n"), 0600)
}

func (e engine) start(ctx context.Context, version string) error {
	if err := e.run(ctx, version, "_start"); err != nil {
		return err
	}
	return e.run(ctx, version, "_probe")
}

func (e engine) compatible(ctx context.Context, version string) error {
	return e.run(ctx, version, "_compat")
}

func (e engine) backupDir(id string) string { return filepath.Join(e.root, "backups", "full-"+id) }
func (e engine) releaseManifest(version string) string {
	return filepath.Join(e.root, "releases", version, "manifest.txt")
}

func (e engine) snapshot(ctx context.Context, id, version string) (Snapshot, error) {
	if !releasePattern.MatchString(version) || !idPattern.MatchString(id) {
		return Snapshot{}, errors.New("无效的恢复点身份")
	}
	dir, err := os.MkdirTemp(filepath.Join(e.root, "backups"), ".snapshot-")
	if err != nil {
		return Snapshot{}, err
	}
	defer os.RemoveAll(dir)
	meta := Snapshot{ID: id, Version: version, Created: time.Now().UTC()}
	for _, item := range []struct {
		source, name string
		checksum     *string
	}{
		{filepath.Join(e.root, "runtime.env"), "runtime.env", &meta.ConfigDigest},
		{e.releaseManifest(version), "manifest.txt", &meta.ManifestDigest},
	} {
		contents, err := os.ReadFile(item.source)
		if err != nil {
			return Snapshot{}, err
		}
		target := filepath.Join(dir, item.name)
		if err = atomicWrite(target, contents, 0600); err != nil {
			return Snapshot{}, err
		}
		if *item.checksum, err = fileDigest(target); err != nil {
			return Snapshot{}, err
		}
	}
	snapshotRoot, err := os.OpenRoot(dir)
	if err != nil {
		return Snapshot{}, err
	}
	defer snapshotRoot.Close()
	file, err := snapshotRoot.OpenFile("data.tar.gz", os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return Snapshot{}, err
	}
	command := e.tool(ctx, version, "_capture")
	// Use a Go writer so a full disk is reported even if Docker exits first.
	command.Stdout = struct{ io.Writer }{file}
	err = errors.Join(command.Run(), file.Sync(), file.Close())
	if err != nil {
		return Snapshot{}, err
	}
	meta.Digest, err = inspectArchive(ctx, filepath.Join(dir, "data.tar.gz"))
	if err != nil {
		return Snapshot{}, err
	}
	if err = WriteJSON(filepath.Join(dir, "snapshot.json"), meta); err != nil {
		return Snapshot{}, err
	}
	if err = os.Rename(dir, e.backupDir(id)); err != nil {
		return Snapshot{}, err
	}
	return meta, syncDirectory(filepath.Join(e.root, "backups"))
}

func inspectArchive(ctx context.Context, filename string) (string, error) {
	// #nosec G304 -- 恢复点编号由执行器生成并校验，归档文件名固定。
	f, err := os.Open(filename)
	if err != nil {
		return "", err
	}
	defer f.Close()
	hash := sha256.New()
	gz, err := gzip.NewReader(io.TeeReader(f, hash))
	if err != nil {
		return "", err
	}
	defer gz.Close()
	reader := tar.NewReader(gz)
	foundDB := false
	for {
		if err = ctx.Err(); err != nil {
			return "", err
		}
		h, err := reader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", err
		}
		name := path.Clean(h.Name)
		if path.IsAbs(h.Name) || name == ".." || strings.HasPrefix(name, "../") ||
			(h.Typeflag != tar.TypeDir && h.Typeflag != tar.TypeReg) {
			return "", errors.New("恢复点包含不受支持的路径或文件类型")
		}
		if name == "app.db" && h.Typeflag == tar.TypeReg && h.Size > 0 {
			foundDB = true
		}
		// Drain large members with cancellation instead of tar.Next's implicit drain.
		if _, err = io.Copy(io.Discard, &contextReader{ctx, reader}); err != nil {
			return "", err
		}
	}
	if _, err = io.Copy(io.Discard, &contextReader{ctx, gz}); err != nil {
		return "", err
	}
	if !foundDB {
		return "", errors.New("恢复点缺少 SQLite 数据库")
	}
	return fmt.Sprintf("%x", hash.Sum(nil)), nil
}

type contextReader struct {
	ctx context.Context
	io.Reader
}

func (r *contextReader) Read(b []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.Reader.Read(b)
}

func (e engine) verifySnapshot(ctx context.Context, meta Snapshot) error {
	dir := e.backupDir(meta.ID)
	for _, item := range []struct{ name, digest string }{{"runtime.env", meta.ConfigDigest}, {"manifest.txt", meta.ManifestDigest}} {
		digest, err := fileDigest(filepath.Join(dir, item.name))
		if err != nil || digest != item.digest {
			return errors.New("恢复点配置或版本清单校验失败")
		}
	}
	digest, err := inspectArchive(ctx, filepath.Join(dir, "data.tar.gz"))
	if err != nil {
		return err
	}
	if digest != meta.Digest {
		return errors.New("恢复点数据校验失败")
	}
	digest, err = fileDigest(e.releaseManifest(meta.Version))
	if err != nil || digest != meta.ManifestDigest {
		return errors.New("恢复点与本地发布清单不匹配")
	}
	return nil
}

func (e engine) prepareRestore(ctx context.Context, meta Snapshot, stage string) error {
	if err := e.verifySnapshot(ctx, meta); err != nil {
		return err
	}
	f, err := os.Open(filepath.Join(e.backupDir(meta.ID), "data.tar.gz"))
	if err != nil {
		return err
	}
	defer f.Close()
	tool := e.tool(ctx, meta.Version, "_extract")
	tool.Env = append(tool.Env, "NEOCLOUD_MAINTENANCE_STAGE="+stage)
	tool.Stdin = f
	if err = tool.Run(); err != nil {
		return err
	}
	tool = e.tool(ctx, meta.Version, "_compat")
	tool.Env = append(tool.Env, "NEOCLOUD_MAINTENANCE_STAGE="+stage, "NEOCLOUD_MAINTENANCE_CONFIG="+filepath.Join(e.backupDir(meta.ID), "runtime.env"))
	if err = tool.Run(); err != nil {
		return errors.New("恢复点与目标程序的数据库结构不兼容")
	}
	return nil
}

func (e engine) beginSwap(jobID string, meta Snapshot, stage string) error {
	dir := filepath.Join(e.control(), "restore-"+jobID)
	if err := os.Mkdir(dir, 0700); err != nil {
		return err
	}
	stash := e.restoreStash(dir)
	if stash != dir {
		if err := os.Mkdir(stash, 0700); err != nil {
			return err
		}
	}
	config := filepath.Join(e.root, "runtime.env")
	// #nosec G304 -- runtime.env 固定在安装者指定的实例根下。
	original, err := os.ReadFile(config)
	if err != nil {
		return err
	}
	replacement, err := os.ReadFile(filepath.Join(e.backupDir(meta.ID), "runtime.env"))
	if err != nil {
		return err
	}
	if err = atomicWrite(filepath.Join(dir, "original.env"), original, 0600); err != nil {
		return err
	}
	if err = syncDirectory(e.control()); err != nil {
		return err
	}
	if err = os.Rename(e.dataDir, filepath.Join(stash, "original-data")); err != nil {
		return err
	}
	dataParent := filepath.Dir(e.dataDir)
	if err = errors.Join(syncDirectory(stash), syncDirectory(dataParent)); err != nil {
		return err
	}
	if err = os.Rename(stage, e.dataDir); err != nil {
		return err
	}
	if err = syncDirectory(dataParent); err != nil {
		return err
	}
	return atomicWrite(config, replacement, 0600)
}

func (e engine) undoSwap(jobID string) error {
	dir := filepath.Join(e.control(), "restore-"+jobID)
	stash := e.restoreStash(dir)
	original := filepath.Join(stash, "original-data")
	if _, err := os.Lstat(original); errors.Is(err, os.ErrPermission) {
		// The data directory is owned by the container UID; its parent owns renames.
	} else if errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	// #nosec G304 -- 恢复目录使用本实例生成的任务 ID，配置文件名固定。
	config, err := os.ReadFile(filepath.Join(dir, "original.env"))
	if err != nil {
		return err
	}
	if _, err := os.Lstat(e.dataDir); err == nil {
		failed := filepath.Join(stash, "failed-data")
		if _, err = os.Lstat(failed); err == nil {
			return errors.New("恢复失败的数据和当前数据均存在，请检查宿主机目录")
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
		if err = os.Rename(e.dataDir, failed); err != nil {
			return err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err = atomicWrite(filepath.Join(e.root, "runtime.env"), config, 0600); err != nil {
		return err
	}
	if err = os.Rename(original, e.dataDir); err != nil {
		return err
	}
	return errors.Join(syncDirectory(stash), syncDirectory(filepath.Dir(e.dataDir)))
}
