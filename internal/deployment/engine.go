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
	cfg      Config
	releases *Releases
}

func (e engine) control() string     { return filepath.Join(e.root, ".control", "maintenance") }
func (e engine) currentPath() string { return filepath.Join(e.root, ".control", "current") }
func (e engine) tool(ctx context.Context, version, action string, params ...string) *exec.Cmd {
	arguments := []string{filepath.Join(e.control(), "engine.sh"), action, "--dir", e.root, "--version", version}
	cmd := exec.CommandContext(ctx, "bash", append(arguments, params...)...)
	cmd.WaitDelay = 5 * time.Second
	cmd.Env = append(os.Environ(), "CLOUDDRIVE_MAINTENANCE_ENGINE=1",
		"CLOUDDRIVE_MAINTENANCE_COMPOSE="+filepath.Join(e.control(), "gateway.compose.yaml"),
		"CLOUDDRIVE_MAINTENANCE_STAGE=", "CLOUDDRIVE_MAINTENANCE_CONFIG=")
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

func (e engine) prepare(ctx context.Context, version string) error {
	// Only the host operator can stage signed draft or offline assets here.
	cache := filepath.Join(e.control(), "assets", version)
	if _, err := os.Stat(cache); err == nil {
		if err = VerifyRelease(ctx, cache, version); err != nil {
			return err
		}
		asset := fmt.Sprintf("clouddrive_%s_linux_%s_docker.tar.gz", version, runtime.GOARCH)
		if err = VerifyAsset(cache, asset); err != nil {
			return err
		}
		return e.run(ctx, version, "_prepare", "--release-dir", cache)
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}

	dir, err := os.MkdirTemp(e.control(), "release-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	if err = e.releases.Package(ctx, dir, version); err != nil {
		return err
	}
	return e.run(ctx, version, "_prepare", "--release-dir", dir)
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
	file, err := os.OpenFile(filepath.Join(dir, "data.tar.gz"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
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
	tool.Env = append(tool.Env, "CLOUDDRIVE_MAINTENANCE_STAGE="+stage)
	tool.Stdin = f
	if err = tool.Run(); err != nil {
		return err
	}
	tool = e.tool(ctx, meta.Version, "_compat")
	tool.Env = append(tool.Env, "CLOUDDRIVE_MAINTENANCE_STAGE="+stage, "CLOUDDRIVE_MAINTENANCE_CONFIG="+filepath.Join(e.backupDir(meta.ID), "runtime.env"))
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
	config := filepath.Join(e.root, "runtime.env")
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
	data := filepath.Join(e.root, "data")
	if err = os.Rename(data, filepath.Join(dir, "original-data")); err != nil {
		return err
	}
	if err = os.Rename(stage, data); err != nil {
		return err
	}
	if err = errors.Join(syncDirectory(dir), syncDirectory(e.root)); err != nil {
		return err
	}
	return atomicWrite(config, replacement, 0600)
}

func (e engine) undoSwap(jobID string) error {
	dir := filepath.Join(e.control(), "restore-"+jobID)
	original := filepath.Join(dir, "original-data")
	if _, err := os.Lstat(original); errors.Is(err, os.ErrPermission) {
		// The data directory is owned by the container UID; its parent owns renames.
	} else if errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	config, err := os.ReadFile(filepath.Join(dir, "original.env"))
	if err != nil {
		return err
	}
	data := filepath.Join(e.root, "data")
	if _, err := os.Lstat(data); err == nil {
		if err = os.Rename(data, filepath.Join(dir, "failed-data")); err != nil {
			return err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err = atomicWrite(filepath.Join(e.root, "runtime.env"), config, 0600); err != nil {
		return err
	}
	if err = os.Rename(original, data); err != nil {
		return err
	}
	return errors.Join(syncDirectory(dir), syncDirectory(e.root))
}
