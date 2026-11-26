//go:build linux

package deployment

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/gofrs/flock"
)

func gatewayGroup(project string) string { return project + "-gw" }

func Enable(ctx context.Context, root, trustedProxy, cosign, dockerHost string) (result error) {
	if _, err := os.Stat("/run/systemd/system"); err != nil {
		return errors.New("需要正在运行的 systemd")
	}
	root, err := filepath.EvalSymlinks(root)
	if err != nil || !filepath.IsAbs(root) || strings.ContainsAny(root, "\n\r,:") {
		return errors.New("实例目录无效")
	}
	owner, err := user.LookupId(strconv.Itoa(os.Geteuid()))
	if err != nil {
		return err
	}
	cosign, err = exec.LookPath(cosign)
	if err != nil {
		return errors.New("找不到 cosign")
	}
	cosign, err = filepath.Abs(cosign)
	if err != nil {
		return err
	}
	if err = exec.CommandContext(ctx, cosign, "version").Run(); err != nil {
		return errors.New("无法执行 cosign")
	}
	project, err := maintenanceProject(root)
	if err != nil {
		return err
	}
	dataDir, err := instanceDataDir(root)
	if err != nil {
		return err
	}
	lock := flock.New(filepath.Join(root, ".control", "lock"))
	defer lock.Close()
	locked, err := lock.TryLock()
	if err != nil || !locked {
		return errors.Join(err, ErrBusy)
	}
	cfg := Config{Project: project, TrustedProxy: trustedProxy}
	e := engine{root: root, dataDir: dataDir, cfg: cfg}
	configPath := filepath.Join(e.control(), "gateway.json")
	if _, err := os.Stat(configPath); err == nil {
		return errors.New("此实例已启用网页运维")
	}
	version, err := readText(e.currentPath())
	if err != nil || !versionPattern.MatchString(version) {
		return errors.New("实例必须已安装正式版")
	}
	env, err := os.ReadFile(filepath.Join(root, "runtime.env"))
	if err != nil {
		return err
	}
	bind := envValue(string(env), "WEB_BIND")
	if bind == "" {
		bind = "127.0.0.1"
	}
	cfg.Listen = net.JoinHostPort(strings.Trim(bind, "[]"), envValue(string(env), "WEB_PORT"))
	cfg.Origin = envValue(string(env), "PUBLIC_ORIGIN")
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return err
	}
	cfg.Upstream = listener.Addr().String()
	if err = listener.Close(); err != nil {
		return err
	}
	if err = cfg.Validate(); err != nil {
		return err
	}
	e.cfg = cfg
	if err = os.MkdirAll(e.control(), 0700); err != nil {
		return err
	}
	registered, switched, marked := false, false, false
	workerUnit, gatewayUnit := project+"-maintenance.service", project+"-gateway.service"
	configRoot := filepath.Join("/etc/clouddrive", project)
	binRoot := filepath.Join("/usr/local/lib/clouddrive", project)
	installed := filepath.Join(binRoot, "clouddrive-maintenance")
	defer func() {
		if result == nil {
			return
		}
		recovery, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
		defer cancel()
		var undo error
		if marked {
			undo = errors.Join(undo, os.Remove(configPath))
		}
		if registered {
			undo = errors.Join(undo, privileged(recovery, "systemctl", "disable", "--now", gatewayUnit, workerUnit))
		}
		if switched {
			ok, err := lock.TryLock()
			if err != nil || !ok {
				undo = errors.Join(undo, err, ErrBusy)
			} else if err = e.run(recovery, version, "_stop"); err == nil {
				direct := e.tool(recovery, version, "_start")
				direct.Env = append(direct.Env, "CLOUDDRIVE_MAINTENANCE_COMPOSE=")
				err = direct.Run()
				if err == nil {
					err = e.run(recovery, version, "_probe")
				}
				undo = errors.Join(undo, err)
			} else {
				undo = errors.Join(undo, err)
			}
		}
		if undo != nil {
			result = errors.Join(result, fmt.Errorf("原端口恢复失败: %w", undo))
		}
	}()
	stage, err := os.MkdirTemp("", "clouddrive-systemd-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(stage)
	if err = WriteJSON(filepath.Join(stage, "gateway.json"), cfg); err != nil {
		return err
	}
	recoveryToken := filepath.Join(e.control(), "recovery-token")
	if _, err = os.Stat(recoveryToken); errors.Is(err, os.ErrNotExist) {
		err = atomicWrite(recoveryToken, []byte(RandomID()+RandomID()+"\n"), 0600)
	}
	if err != nil {
		return err
	}
	if err = atomicWrite(filepath.Join(stage, "session-key"), []byte(RandomID()+RandomID()), 0600); err != nil {
		return err
	}
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	launcher, err := os.ReadFile(filepath.Join(root, "install.sh"))
	if err != nil {
		return err
	}
	if err = atomicWrite(filepath.Join(e.control(), "engine.sh"), launcher, 0700); err != nil {
		return err
	}
	// Only replace the published port. Keep the original Web port visible to
	// Compose interpolation for existing Origin policies and WebDAV URLs.
	override := fmt.Sprintf("services:\n  web:\n    ports: !override\n      - %q\n", cfg.Upstream+":4173")
	if err = atomicWrite(filepath.Join(e.control(), "gateway.compose.yaml"), []byte(override), 0600); err != nil {
		return err
	}
	if err = e.run(ctx, version, "_config"); err != nil {
		return fmt.Errorf("网页运维需要支持 ports !override 的 Docker Compose（>=2.24.4）: %w", err)
	}
	// #nosec G304 -- 路径由 os.Executable 返回，复制正在运行的已验证安装工具。
	exeBytes, err := os.ReadFile(executable)
	if err != nil {
		return err
	}
	if err = atomicWrite(filepath.Join(e.control(), "client"), exeBytes, 0700); err != nil {
		return err
	}
	if _, err = user.LookupGroup(gatewayGroup(project)); err != nil {
		if err = privileged(ctx, "groupadd", "--system", gatewayGroup(project)); err != nil {
			return err
		}
	}
	worker, gateway := units(cfg, root, owner.Username, installed, configRoot, cosign, dockerHost)
	for name, contents := range map[string]string{workerUnit: worker, gatewayUnit: gateway} {
		if err = atomicWrite(filepath.Join(stage, name), []byte(contents), 0600); err != nil {
			return err
		}
	}
	for _, cmd := range [][]string{
		{"install", "-d", "-m", "0755", binRoot, configRoot},
		{"install", "-m", "0755", executable, installed},
		{"install", "-m", "0644", filepath.Join(stage, "gateway.json"), filepath.Join(configRoot, "gateway.json")},
		{"install", "-m", "0600", filepath.Join(stage, "session-key"), filepath.Join(configRoot, "session-key")},
		{"install", "-m", "0644", filepath.Join(stage, workerUnit), filepath.Join(stage, gatewayUnit), "/etc/systemd/system/"},
		{"systemctl", "daemon-reload"},
	} {
		if err = privileged(ctx, cmd[0], cmd[1:]...); err != nil {
			return err
		}
	}
	registered = true
	switched = true
	if err = e.run(ctx, version, "_stop"); err != nil {
		return err
	}
	if err = e.start(ctx, version); err != nil {
		return err
	}
	if err = privileged(ctx, "systemctl", "enable", "--now", gatewayUnit); err != nil {
		return err
	}
	if err = waitFor(ctx, func(ctx context.Context) bool { return gatewayReady(ctx, cfg) }); err != nil {
		return err
	}
	if err = WriteJSON(configPath, cfg); err != nil {
		return err
	}
	marked = true
	if err = lock.Unlock(); err != nil {
		return err
	}
	if err = privileged(ctx, "systemctl", "enable", "--now", workerUnit); err != nil {
		return err
	}
	client := NewClient(cfg.Socket())
	if err = waitFor(ctx, client.Gate); err != nil {
		return err
	}
	fmt.Printf("网页运维已启用：原站点 /maintenance\n恢复凭据：%s\n", recoveryToken)
	return nil
}

func envValue(contents, key string) string {
	for line := range strings.SplitSeq(contents, "\n") {
		if value, ok := strings.CutPrefix(line, key+"="); ok {
			return strings.Trim(strings.TrimSpace(value), "'\x22")
		}
	}
	return ""
}

func gatewayReady(ctx context.Context, cfg Config) bool {
	host, port, _ := net.SplitHostPort(cfg.Listen)
	switch host {
	case "0.0.0.0":
		host = "127.0.0.1"
	case "::":
		host = "::1"
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodHead, "http://"+net.JoinHostPort(host, port)+MaintenancePath, nil)
	if err != nil {
		return false
	}
	client := &http.Client{Timeout: 2 * time.Second}
	res, err := client.Do(req)
	if err != nil {
		return false
	}
	defer res.Body.Close()
	return res.StatusCode == 200 && res.Header.Get("X-CloudDrive-Maintenance") == "1"
}

func waitFor(ctx context.Context, check func(context.Context) bool) error {
	ctx, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()
	tick := time.NewTicker(250 * time.Millisecond)
	defer tick.Stop()
	for {
		if check(ctx) {
			return nil
		}
		select {
		case <-ctx.Done():
			return errors.New("维护服务未通过就绪检查")
		case <-tick.C:
		}
	}
}

func privileged(ctx context.Context, name string, args ...string) error {
	if os.Geteuid() != 0 {
		name, args = "sudo", append([]string{"--", name}, args...)
	}
	// #nosec G204 -- 仅供本地启用使用，调用方构造固定的 systemd/安装命令及独立 argv。
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Stdin, cmd.Stderr, cmd.Stdout = os.Stdin, os.Stderr, os.Stdout
	return cmd.Run()
}

func unitWords(values ...string) string {
	result := make([]string, 0, len(values))
	for _, value := range values {
		result = append(result, strconv.Quote(strings.NewReplacer("%", "%%", "$", "$$").Replace(value)))
	}
	return strings.Join(result, " ")
}

func units(cfg Config, root, owner, executable, configRoot, cosign, dockerHost string) (string, string) {
	config := filepath.Join(configRoot, "gateway.json")
	worker := fmt.Sprintf(`[Unit]
Description=CloudDrive deployment worker (%s)
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=simple
User=%s
Group=%s
UMask=0077
RuntimeDirectory=%s
RuntimeDirectoryMode=0750
Environment=%s
ExecStart=%s
Restart=on-failure
RestartSec=2s
TimeoutStopSec=40s

[Install]
WantedBy=multi-user.target
`, cfg.Project, owner, gatewayGroup(cfg.Project), cfg.Project, unitWords("DOCKER_HOST="+dockerHost, "DOCKER_CONTEXT=", "CLOUDDRIVE_COSIGN="+cosign),
		unitWords(executable, "worker", "--root", root, "--config", config))
	gateway := fmt.Sprintf(`[Unit]
Description=CloudDrive same-origin gateway (%s)
After=network.target

[Service]
Type=simple
DynamicUser=yes
SupplementaryGroups=%s
LoadCredential=session-key:%s
ExecStart=%s
Restart=on-failure
RestartSec=2s
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6

[Install]
WantedBy=multi-user.target
`, cfg.Project, gatewayGroup(cfg.Project), filepath.Join(configRoot, "session-key"), unitWords(executable, "gateway", "--config", config))
	return worker, gateway
}
