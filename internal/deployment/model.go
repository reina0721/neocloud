// Package deployment owns the host-side protocol and state of an installer-managed instance.
package deployment

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	SocketDirectory   = "/run"
	MaintenancePath   = "/maintenance"
	OwnerPath         = "/api/console/v1/deployment/owner"
	dockerRenameFence = "rename-in-progress"
)

var (
	versionPattern = regexp.MustCompile(`^v(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$`)
	releasePattern = regexp.MustCompile(`^v[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.-]+)?$`)
	projectPattern = regexp.MustCompile(`^(clouddrive|neocloud)-[a-f0-9]{12}$`)
	idPattern      = regexp.MustCompile(`^[0-9a-f]{32}$`)
)

type Config struct {
	Project      string `json:"project"`
	Listen       string `json:"listen"`
	Upstream     string `json:"upstream"`
	Origin       string `json:"origin,omitempty"`
	TrustedProxy string `json:"trustedProxy,omitempty"`
}

func (c Config) Validate() error {
	host, port, err := net.SplitHostPort(c.Listen)
	if err != nil || net.ParseIP(host) == nil || !validPort(port) {
		return errors.New("无效的站点监听地址")
	}
	upstreamHost, upstreamPort, err := net.SplitHostPort(c.Upstream)
	if err != nil || upstreamHost != "127.0.0.1" || !validPort(upstreamPort) || port == upstreamPort || !projectPattern.MatchString(c.Project) {
		return errors.New("无效的实例或 Web Host 回环地址")
	}
	if c.TrustedProxy != "" {
		if _, err := netip.ParseAddr(c.TrustedProxy); err != nil {
			return errors.New("可信反向代理须为单个 IP 地址")
		}
		if !strings.HasPrefix(c.Origin, "https://") || !validOrigin(c.Origin) {
			return errors.New("可信代理需要明确的 HTTPS 站点 Origin")
		}
	}
	return nil
}

func validPort(s string) bool {
	port, err := strconv.Atoi(s)
	return err == nil && port >= 1024 && port <= 65535
}

func (c Config) Socket() string { return filepath.Join(SocketDirectory, c.Project, "worker.sock") }

type Release struct {
	Version string `json:"version"`
	Notes   string `json:"notes"`
	URL     string `json:"url"`
}

type Request struct {
	ID       string `json:"id"`
	Action   string `json:"action"`
	Target   string `json:"target,omitempty"`
	Expected string `json:"expected,omitempty"`
	Confirm  string `json:"confirm,omitempty"`
	Offline  bool   `json:"offline,omitempty"`
	Actor    string `json:"-"`
}

type Job struct {
	Request
	Submitted   time.Time  `json:"submitted"`
	Finished    *time.Time `json:"finished,omitempty"`
	Phase       string     `json:"phase"`
	Result      string     `json:"result,omitempty"`
	Backup      string     `json:"backup,omitempty"`
	Original    string     `json:"original,omitempty"`
	Actor       string     `json:"actor"`
	WasServing  bool       `json:"wasServing,omitempty"`
	WasRecovery bool       `json:"wasRecovery,omitempty"`
	UsesReceipt bool       `json:"usesReceipt,omitempty"`
}

type Snapshot struct {
	ID             string    `json:"id"`
	Version        string    `json:"version"`
	Created        time.Time `json:"created"`
	Digest         string    `json:"digest"`
	ConfigDigest   string    `json:"configDigest"`
	ManifestDigest string    `json:"manifestDigest"`
}

type State struct {
	Current       string     `json:"current"`
	Previous      string     `json:"previous,omitempty"`
	Serving       bool       `json:"serving"`
	Recovery      bool       `json:"recoveryRequired"`
	Jobs          []Job      `json:"jobs"`
	Backups       []Snapshot `json:"backups"`
	Update        *Release   `json:"update,omitempty"`
	LocalReleases []Release  `json:"localReleases,omitempty"`
}

func (s State) LatestLocalUpgrade() (Release, bool) {
	latest := Release{Version: s.Current}
	for _, candidate := range s.LocalReleases {
		if newer(candidate.Version, latest.Version) {
			latest = candidate
		}
	}
	return latest, latest.Version != s.Current
}

func RandomID() string {
	var data [16]byte
	_, _ = rand.Read(data[:])
	return hex.EncodeToString(data[:])
}

func readText(path string) (string, error) {
	// #nosec G304 -- 只读取宿主机控制目录的固定标记或凭据文件。
	b, err := os.ReadFile(path)
	return strings.TrimSpace(string(b)), err
}

func maintenanceProject(root string) (string, error) {
	name, err := readText(filepath.Join(root, ".control", "maintenance-project"))
	if errors.Is(err, os.ErrNotExist) {
		name, err = readText(filepath.Join(root, ".control", "project"))
	}
	if err != nil {
		return "", fmt.Errorf("读取实例维护标记: %w", err)
	}
	if !projectPattern.MatchString(name) {
		return "", errors.New("实例维护标记无效")
	}
	return name, nil
}

func requireNoDockerRename(root string) error {
	_, err := os.Lstat(filepath.Join(root, ".control", dockerRenameFence))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return errors.Join(ErrRecovery, errors.New("实例名称迁移尚未完成，请先查询状态或回退"), err)
}

func ReadJSON(path string, value any) error {
	// #nosec G304 -- 只读取本地 CLI/systemd 指定的配置或实例状态。
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return json.NewDecoder(io.LimitReader(f, 16<<20)).Decode(value)
}

// WriteJSON replaces the state only after the temporary file has been flushed.
func WriteJSON(path string, value any) error {
	b, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return atomicWrite(path, append(b, '\n'), 0600)
}

func atomicWrite(path string, data []byte, mode os.FileMode) error {
	f, err := os.CreateTemp(filepath.Dir(path), ".write-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if err = f.Chmod(mode); err == nil {
		_, err = f.Write(data)
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err = errors.Join(err, closeErr); err != nil {
		return err
	}
	return replaceDeploymentFile(f.Name(), path)
}

func syncDirectory(path string) error {
	// #nosec G304 -- 同步本地执行器刚写入的受控目录。
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return f.Sync()
}

func newer(a, b string) bool {
	left, right := versionPattern.FindStringSubmatch(a), versionPattern.FindStringSubmatch(b)
	if left == nil || right == nil {
		return false
	}
	for i := 1; i < len(left); i++ {
		if len(left[i]) != len(right[i]) {
			return len(left[i]) > len(right[i])
		}
		if left[i] != right[i] {
			return left[i] > right[i]
		}
	}
	return false
}

// NewerStableVersion compares two official release tags without accepting prereleases.
func NewerStableVersion(candidate, current string) bool { return newer(candidate, current) }
