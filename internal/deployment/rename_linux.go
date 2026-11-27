//go:build linux

package deployment

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/gofrs/flock"
)

const (
	dockerRenameJournal = "docker-rename.json"
	dockerOwnerLabel    = "io.clouddrive.release.owner"
)

var (
	dockerProjectName = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,39}$`)
	dockerWebImage    = regexp.MustCompile(`^(clouddrive|neocloud)-web:v[0-9]+\.[0-9]+\.[0-9]+-(amd64|arm64)$`)
)

// DockerRenameStatus 保存本次停机切换的既有身份、目标和恢复点。
type DockerRenameStatus struct {
	Root       string `json:"root"`
	DataDir    string `json:"dataDir"`
	Source     string `json:"source"`
	Target     string `json:"target"`
	Version    string `json:"version"`
	Phase      string `json:"phase"`
	Backup     string `json:"backup,omitempty"`
	Layout     bool   `json:"hadInstanceLayout"`
	WasServing bool   `json:"wasServing"`
}

type dockerRename struct {
	engine
	webImage string
}

// RenameDockerInstance 在同一数据目录内切换安装器管理的 Compose 身份。
func RenameDockerInstance(ctx context.Context, action, root, target, targetRoot, dockerHost string) (result DockerRenameStatus, resultErr error) {
	if action != "plan" && action != "apply" && action != "status" && action != "rollback" {
		return result, errors.New("改名操作须为 plan、apply、status 或 rollback")
	}
	root, err := dockerRenameRoot(root)
	if err != nil {
		return result, err
	}
	if targetRoot != "" && filepath.Clean(targetRoot) != root {
		return result, errors.New("改名目前要求保留安装目录和数据挂载位置")
	}
	endpoint, err := url.Parse(dockerHost)
	if err != nil || endpoint.Scheme != "unix" || endpoint.Host != "" || endpoint.User != nil || !filepath.IsAbs(endpoint.Path) ||
		endpoint.RawQuery != "" || endpoint.Fragment != "" || endpoint.String() != "unix://"+endpoint.Path {
		return result, errors.New("改名需要本机 Docker Unix socket")
	}
	control := filepath.Join(root, ".control")
	lockPath := filepath.Join(control, "lock")
	if info, statErr := os.Lstat(lockPath); statErr != nil || !info.Mode().IsRegular() {
		return result, errors.Join(errors.New("未找到安装器实例锁"), statErr)
	}
	lock := flock.New(lockPath)
	defer func() { resultErr = errors.Join(resultErr, lock.Close()) }()
	if ok, lockErr := lock.TryLock(); lockErr != nil || !ok {
		return result, errors.Join(ErrBusy, lockErr)
	}
	dataDir, err := instanceDataDir(root)
	if err != nil {
		return result, err
	}
	d := dockerRename{engine: engine{root: root, dataDir: dataDir, local: true, dockerHost: dockerHost}}
	project, err := readText(filepath.Join(control, "project"))
	if err != nil || !dockerProjectName.MatchString(project) {
		return result, errors.Join(errors.New("实例的 Compose 项目标记无效"), err)
	}
	version, err := readText(d.currentPath())
	if err != nil || !versionPattern.MatchString(version) {
		return result, errors.Join(errors.New("改名需要已安装的正式版"), err)
	}
	state, exists, err := d.readJournal()
	if err != nil {
		return result, err
	}
	if action == "status" {
		if exists {
			return state, nil
		}
		return DockerRenameStatus{Root: root, DataDir: dataDir, Source: project, Version: version, Phase: "not-started"}, nil
	}
	if err := d.validateRelease(version); err != nil {
		return result, err
	}
	if action == "rollback" {
		if !exists || target != "" && target != state.Target || version != state.Version || dataDir != state.DataDir || (project != state.Source && project != state.Target) {
			return result, errors.New("实例版本、数据路径或改名记录与回退目标不匹配")
		}
		return d.rollback(ctx, state)
	}
	if exists {
		if state.Phase == "applied" && state.Target == target && project == target && state.Version == version {
			return state, nil
		}
		return result, errors.New("实例已有改名记录，请使用 status 或 rollback")
	}
	if !dockerProjectName.MatchString(target) || target == project {
		return result, errors.New("--target 须是与原实例不同的有效 Compose 项目名")
	}
	state = DockerRenameStatus{Root: root, DataDir: dataDir, Source: project, Target: target, Version: version, Phase: "planned"}
	if err := d.preflight(ctx, &state); err != nil {
		return result, err
	}
	if action == "plan" {
		return state, nil
	}
	return d.apply(ctx, state)
}

func dockerRenameRoot(root string) (string, error) {
	if root == "" {
		return "", errors.New("改名需要 --root")
	}
	path, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	path, err = filepath.EvalSymlinks(path)
	if err != nil || strings.ContainsAny(path, "\r\n,:") || filepath.Dir(path) == path {
		return "", errors.Join(errors.New("安装目录路径无效"), err)
	}
	for _, marker := range []string{".control", ".control/project", ".control/current", "install.sh", "runtime.env"} {
		info, err := os.Lstat(filepath.Join(path, marker))
		if err != nil || marker == ".control" && !info.IsDir() || marker != ".control" && !info.Mode().IsRegular() {
			return "", errors.Join(fmt.Errorf("安装文件无效：%s", marker), err)
		}
	}
	return path, nil
}

func (d dockerRename) path(name string) string { return filepath.Join(d.root, ".control", name) }

func (d dockerRename) readJournal() (DockerRenameStatus, bool, error) {
	var state DockerRenameStatus
	file := d.path(dockerRenameJournal)
	info, err := os.Lstat(file)
	if errors.Is(err, os.ErrNotExist) {
		return state, false, nil
	}
	if err != nil || !info.Mode().IsRegular() {
		return state, false, errors.Join(errors.New("改名记录文件无效"), err)
	}
	if err := ReadJSON(file, &state); err != nil {
		return state, false, err
	}
	if state.Root != d.root || !dockerProjectName.MatchString(state.Source) || !dockerProjectName.MatchString(state.Target) ||
		state.Source == state.Target || !versionPattern.MatchString(state.Version) || state.Backup != "" && !idPattern.MatchString(state.Backup) {
		return state, false, errors.New("改名记录不属于当前实例或包含无效身份")
	}
	switch state.Phase {
	case "stopping", "switching", "applied", "rolling-back", "rolled-back":
		return state, true, nil
	default:
		return state, false, errors.New("改名记录阶段无效")
	}
}

func (d *dockerRename) validateRelease(version string) error {
	for _, path := range []string{d.path("candidate"), filepath.Join(d.control(), "gateway.json")} {
		if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
			return errors.Join(errors.New("存在未完成安装或启用了 systemd 网页维护，不能改名"), err)
		}
	}
	launcher, err := os.ReadFile(filepath.Join(d.root, "install.sh"))
	if err != nil || !strings.Contains(string(launcher), ".control/"+dockerRenameFence) {
		return errors.Join(errors.New("已安装脚本缺少改名中断保护，请先用签名发布包更新维护程序"), err)
	}
	manifest, err := os.ReadFile(d.releaseManifest(version))
	if err != nil || envValue(string(manifest), "INSTANCE_LAYOUT") != "1" {
		return errors.Join(errors.New("当前版本未提供可验证的实例布局协议"), err)
	}
	images, err := os.ReadFile(filepath.Join(d.root, "releases", version, "images.env"))
	if err != nil {
		return err
	}
	d.webImage = envValue(string(images), "WEB_IMAGE")
	if !dockerWebImage.MatchString(d.webImage) {
		return errors.New("当前版本的 Web 镜像标记无效")
	}
	return nil
}

func (d dockerRename) preflight(ctx context.Context, state *DockerRenameStatus) error {
	if _, err := os.Lstat(d.path(dockerRenameFence)); !errors.Is(err, os.ErrNotExist) {
		return errors.Join(errors.New("实例保留有未完成的改名保护标记"), err)
	}
	if _, err := os.Stat(d.path("data-dir")); err == nil {
		state.Layout = true
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	} else if !projectPattern.MatchString(state.Source) {
		return errors.New("旧实例缺少可继续使用的维护身份")
	}
	if err := d.run(ctx, state.Version, "_images"); err != nil {
		return err
	}
	if err := d.run(ctx, state.Version, "_idle"); err != nil {
		return err
	}
	if err := d.targetFree(ctx, state.Target); err != nil {
		return err
	}
	if err := d.checkMounts(ctx, state.Source); err != nil {
		return err
	}
	if err := d.dataMarker(ctx, d.sourceOwner(*state), d.sourceOwner(*state)); err != nil {
		return err
	}
	var err error
	state.WasServing, err = d.serving(ctx, state.Version)
	if err != nil {
		return err
	}
	if !state.WasServing {
		if active, err := d.activeProject(ctx, state.Source); err != nil || active != "" {
			return errors.Join(errors.New("原项目仅部分运行，请先停止或恢复后再改名"), err)
		}
	}
	return nil
}

func dockerRenameOwner(root, project, data string) string {
	return fmt.Sprintf("%x", sha256.Sum256([]byte(root+"\x00"+project+"\x00"+data)))
}

func (d dockerRename) sourceOwner(state DockerRenameStatus) string {
	if !state.Layout {
		return ""
	}
	return dockerRenameOwner(d.root, state.Source, d.dataDir)
}

func (d dockerRename) targetOwner(state DockerRenameStatus) string {
	return dockerRenameOwner(d.root, state.Target, d.dataDir)
}

func (d dockerRename) apply(ctx context.Context, state DockerRenameStatus) (result DockerRenameStatus, resultErr error) {
	state.Phase, state.Backup = "stopping", RandomID()
	if err := WriteJSON(d.path(dockerRenameJournal), state); err != nil {
		return state, err
	}
	if err := atomicWrite(d.path(dockerRenameFence), nil, 0600); err != nil {
		return state, err
	}
	defer func() {
		if resultErr == nil {
			return
		}
		recovery, cancel := context.WithTimeout(context.WithoutCancel(ctx), 4*time.Minute)
		defer cancel()
		if _, err := d.rollback(recovery, state); err != nil {
			resultErr = errors.Join(resultErr, fmt.Errorf("原实例恢复未完成，已保留改名记录：%w", err))
		}
	}()
	if err := d.run(ctx, state.Version, "_stop"); err != nil {
		return state, err
	}
	if err := d.checkMounts(ctx, ""); err != nil {
		return state, err
	}
	if _, err := d.snapshot(ctx, state.Backup, state.Version); err != nil {
		return state, err
	}
	if err := d.targetFree(ctx, state.Target); err != nil {
		return state, err
	}
	if _, err := d.docker(ctx, "volume", "create", "--label", dockerOwnerLabel+"="+d.targetOwner(state), state.Target+"-instance"); err != nil {
		return state, err
	}
	if err := d.verifyClaim(ctx, state.Target, d.targetOwner(state)); err != nil {
		return state, err
	}
	state.Phase = "switching"
	if err := WriteJSON(d.path(dockerRenameJournal), state); err != nil {
		return state, err
	}
	if err := d.dataMarker(ctx, d.sourceOwner(state), d.targetOwner(state)); err != nil {
		return state, err
	}
	if !state.Layout {
		if err := atomicWrite(d.path("data-dir"), []byte(d.dataDir+"\n"), 0600); err != nil {
			return state, err
		}
		if err := atomicWrite(d.path("maintenance-project"), []byte(state.Source+"\n"), 0600); err != nil {
			return state, err
		}
	}
	if err := atomicWrite(d.path("project"), []byte(state.Target+"\n"), 0600); err != nil {
		return state, err
	}
	if err := d.compatible(ctx, state.Version); err != nil {
		return state, fmt.Errorf("原数据与当前版本兼容性检查失败：%w", err)
	}
	if state.WasServing {
		if err := d.start(ctx, state.Version); err != nil {
			return state, err
		}
	}
	state.Phase = "applied"
	return state, d.complete(state)
}

func (d dockerRename) rollback(ctx context.Context, state DockerRenameStatus) (DockerRenameStatus, error) {
	if state.Phase == "rolled-back" {
		return state, d.complete(state)
	}
	current, err := readText(d.path("project"))
	if err != nil || current != state.Source && current != state.Target {
		return state, errors.Join(errors.New("当前项目已变化，不能自动改回"), err)
	}
	if state.Phase == "applied" {
		state.WasServing, err = d.serving(ctx, state.Version)
		if err != nil {
			return state, err
		}
	}
	if state.Layout {
		if err := d.verifyClaim(ctx, state.Source, d.sourceOwner(state)); err != nil {
			return state, err
		}
	}
	stoppingSource := state.Phase == "stopping"
	if err := atomicWrite(d.path(dockerRenameFence), nil, 0600); err != nil {
		return state, err
	}
	state.Phase = "rolling-back"
	if err := WriteJSON(d.path(dockerRenameJournal), state); err != nil {
		return state, err
	}
	if !stoppingSource {
		if err := d.stopProject(ctx, state.Target); err != nil {
			return state, err
		}
	}
	if err := d.stopProject(ctx, state.Source); err != nil {
		return state, err
	}
	if err := d.checkMounts(ctx, ""); err != nil {
		return state, err
	}
	if err := d.dataMarker(ctx, d.targetOwner(state), d.sourceOwner(state)); err != nil {
		return state, err
	}
	if !state.Layout {
		for _, marker := range []struct{ name, value string }{{"data-dir", d.dataDir}, {"maintenance-project", state.Source}} {
			value, err := readText(d.path(marker.name))
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			if err != nil || value != marker.value {
				return state, errors.Join(errors.New("旧实例布局已变化，不能自动改回"), err)
			}
			if err := os.Remove(d.path(marker.name)); err != nil {
				return state, err
			}
		}
	}
	if err := atomicWrite(d.path("project"), []byte(state.Source+"\n"), 0600); err != nil {
		return state, err
	}
	if err := d.compatible(ctx, state.Version); err != nil {
		return state, err
	}
	if state.WasServing {
		if err := d.start(ctx, state.Version); err != nil {
			return state, err
		}
	}
	state.Phase = "rolled-back"
	return state, d.complete(state)
}

func (d dockerRename) complete(state DockerRenameStatus) error {
	if err := WriteJSON(d.path(dockerRenameJournal), state); err != nil {
		return err
	}
	if err := os.Remove(d.path(dockerRenameFence)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return syncDirectory(filepath.Join(d.root, ".control"))
}

func (d dockerRename) docker(ctx context.Context, args ...string) (string, error) {
	// #nosec G204 -- Docker 参数为固定操作与已核对的项目、镜像、路径或容器 ID。
	cmd := exec.CommandContext(ctx, "docker", append([]string{"--host", d.dockerHost}, args...)...)
	cmd.Env = append(os.Environ(), "DOCKER_CONTEXT=")
	cmd.WaitDelay = 5 * time.Second
	value, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("Docker %s 操作失败：%w", args[0], err)
	}
	return strings.TrimSpace(string(value)), nil
}

func (d dockerRename) targetFree(ctx context.Context, project string) error {
	for _, args := range [][]string{
		{"ps", "-aq", "--filter", "label=com.docker.compose.project=" + project},
		{"ps", "-aq", "--filter", "name=^/" + project + "-backend-1$", "--filter", "name=^/" + project + "-web-1$"},
		{"network", "ls", "-q", "--filter", "name=^" + project + "_default$"},
		{"volume", "ls", "-q", "--filter", "name=^" + project + "-instance$"},
	} {
		if value, err := d.docker(ctx, args...); err != nil || value != "" {
			return errors.Join(errors.New("目标 Compose 名称已占用或不能确认空闲"), err)
		}
	}
	return nil
}

func (d dockerRename) verifyClaim(ctx context.Context, project, expected string) error {
	const label = `{{index .Labels "io.clouddrive.release.owner"}}`
	value, err := d.docker(ctx, "volume", "inspect", "--format", label, project+"-instance")
	if err != nil || value != expected {
		return errors.Join(errors.New("不能确认目标实例归属卷"), err)
	}
	return nil
}

func (d dockerRename) activeProject(ctx context.Context, project string) (string, error) {
	return d.docker(ctx, "ps", "-q", "--filter", "label=com.docker.compose.project="+project)
}

func (d dockerRename) stopProject(ctx context.Context, project string) error {
	active, err := d.activeProject(ctx, project)
	if err != nil || active == "" {
		return err
	}
	const template = `{{index .Config.Labels "com.docker.compose.project.working_dir"}}`
	for _, id := range strings.Fields(active) {
		owner, err := d.docker(ctx, "inspect", "--format", template, id)
		if err != nil || owner != d.root {
			return errors.Join(errors.New("发现身份不明的运行中容器，拒绝停止"), err)
		}
		if _, err := d.docker(ctx, "stop", "--time", "60", id); err != nil {
			return err
		}
	}
	return nil
}

func (d dockerRename) checkMounts(ctx context.Context, allowed string) error {
	active, err := d.docker(ctx, "ps", "-q")
	if err != nil {
		return err
	}
	const template = `{{json .Mounts}}{{"\t"}}{{index .Config.Labels "com.docker.compose.project"}}{{"\t"}}{{index .Config.Labels "com.docker.compose.project.working_dir"}}`
	for _, id := range strings.Fields(active) {
		value, err := d.docker(ctx, "inspect", "--format", template, id)
		if err != nil {
			return err
		}
		mountsJSON, owner, _ := strings.Cut(value, "\t")
		project, root, _ := strings.Cut(owner, "\t")
		var mounts []struct{ Type, Source string }
		if err := json.Unmarshal([]byte(mountsJSON), &mounts); err != nil {
			return errors.New("无法确认运行中容器的数据挂载")
		}
		for _, mount := range mounts {
			if mount.Type == "bind" && (pathContains(mount.Source, d.dataDir) || pathContains(d.dataDir, mount.Source)) &&
				(allowed == "" || project != allowed || root != d.root) {
				return errors.New("实例数据仍被运行中容器挂载")
			}
		}
	}
	return nil
}

func pathContains(parent, child string) bool {
	relative, err := filepath.Rel(parent, child)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}

func (d dockerRename) dataMarker(ctx context.Context, from, to string) error {
	// 数据目录权限归容器存储用户。沿用现有签名发布镜像的无网络绑定方式。
	const script = `
const fs = require('node:fs');
const {randomUUID} = require('node:crypto');
const [from, to] = process.argv.slice(1);
const marker = '/data/.clouddrive-installation';
let existing = '';
try {
  if (!fs.lstatSync(marker).isFile()) throw Error('invalid ownership marker');
  existing = fs.readFileSync(marker, 'utf8');
} catch (error) { if (error.code !== 'ENOENT') throw error; }
if (existing === to) process.exit(0);
if (existing !== from) throw Error('unexpected ownership marker');
if (to === '') {
  fs.unlinkSync(marker);
} else {
  const stage = '/data/.neocloud-ownership-' + randomUUID();
  const file = fs.openSync(stage, 'wx', 0o600);
  try { fs.writeFileSync(file, to); fs.fsyncSync(file); } finally { fs.closeSync(file); }
  try { fs.renameSync(stage, marker); } finally { if (fs.existsSync(stage)) fs.unlinkSync(stage); }
}
const directory = fs.openSync('/data', 'r');
try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
`
	mount := "type=bind,source=" + d.dataDir + ",target=/data"
	if from == to {
		mount += ",readonly"
	}
	if _, err := d.docker(ctx, "run", "--rm", "--pull", "never", "--network", "none", "--user", "0:0", "--mount", mount, d.webImage, "node", "-e", script, "--", from, to); err != nil {
		return fmt.Errorf("不能验证或换入数据目录归属标记：%w", err)
	}
	return nil
}
