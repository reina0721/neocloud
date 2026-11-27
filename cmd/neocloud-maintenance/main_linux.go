//go:build linux

package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/reina0721/neocloud/internal/deployment"
)

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if err := run(ctx, os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "NeoCloud 维护:", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string) error {
	if len(args) == 0 {
		return errors.New("需要 enable、worker、gateway、client、local、import-release 或 verify-release")
	}
	flags := flag.NewFlagSet(args[0], flag.ContinueOnError)
	root := flags.String("root", "", "安装目录")
	config := flags.String("config", "", "网关配置")
	cosign := flags.String("cosign", "", "cosign 命令")
	dockerHost := flags.String("docker-host", "unix:///var/run/docker.sock", "本机 Docker socket")
	trusted := flags.String("trusted-proxy", "", "代理 IP")
	action := flags.String("action", "status", "操作")
	target := flags.String("target", "", "版本或恢复点")
	confirm := flags.String("confirm", "", "恢复点确认")
	offline := flags.Bool("offline", false, "只使用已校验的本地发布包")
	releaseDir := flags.String("release-dir", "", "离线发布资产目录")
	version := flags.String("version", "", "正式发布版本")
	trustDir := flags.String("trust-dir", "", "本地 Sigstore 信任材料目录")
	arch := flags.String("arch", "", "待校验镜像架构")
	asset := flags.String("asset", "", "额外校验的安装器或维护工具文件名")
	if err := flags.Parse(args[1:]); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("多余参数")
	}
	mode := args[0]
	if mode == "enable" {
		ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
		defer cancel()
		if *cosign == "" {
			*cosign = "cosign"
		}
		return deployment.Enable(ctx, *root, *trusted, *cosign, *dockerHost)
	}
	if *cosign != "" {
		if err := os.Setenv("NEOCLOUD_COSIGN", *cosign); err != nil {
			return err
		}
	}
	switch mode {
	case "verify-release":
		if *releaseDir == "" || *version == "" || *trustDir == "" {
			return errors.New("验证离线发布包需要 --release-dir、--version 和 --trust-dir")
		}
		var err error
		if *arch == "" {
			err = deployment.VerifyOfflineRelease(ctx, *releaseDir, *version, *trustDir)
		} else {
			err = deployment.VerifyOfflineReleaseForArch(ctx, *releaseDir, *version, *trustDir, *arch)
		}
		if err != nil {
			return err
		}
		if *asset != "" {
			if err := deployment.VerifyOfflineTooling(ctx, *releaseDir, *version, *trustDir, *asset); err != nil {
				return err
			}
		}
		return json.NewEncoder(os.Stdout).Encode(deployment.Release{Version: *version})
	case "import-release":
		if *root == "" || *releaseDir == "" || *version == "" {
			return errors.New("导入离线发布包需要 --root、--release-dir 和 --version，首次导入还需要 --trust-dir")
		}
		release, err := deployment.ImportOfflineRelease(ctx, *root, *releaseDir, *version, *trustDir)
		if err != nil {
			return err
		}
		return json.NewEncoder(os.Stdout).Encode(release)
	case "local":
		if *root == "" {
			return errors.New("本机维护需要 --root")
		}
		if _, err := os.Stat(filepath.Join(*root, ".control", "maintenance", "gateway.json")); err == nil {
			return errors.New("此实例已启用网页运维，请通过 client 提交维护任务")
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
		workerCtx, cancel := context.WithCancel(ctx)
		defer cancel()
		worker, err := deployment.NewLocalWorker(workerCtx, *root)
		if err != nil {
			return err
		}
		defer func() {
			cancel()
			worker.Wait()
		}()
		return call(ctx, localWorker{worker}, *action, *target, *confirm, *offline)
	case "worker", "gateway", "client":
	default:
		return errors.New("未知的维护入口")
	}
	cfgPath := *config
	if cfgPath == "" {
		cfgPath = filepath.Join(*root, ".control", "maintenance", "gateway.json")
	}
	var cfg deployment.Config
	if err := deployment.ReadJSON(cfgPath, &cfg); err != nil {
		return err
	}
	if err := cfg.Validate(); err != nil {
		return err
	}
	switch mode {
	case "worker":
		socket, err := deployment.SocketListener(cfg.Socket())
		if err != nil {
			return err
		}
		defer socket.Close()
		worker, err := deployment.NewWorker(ctx, *root, cfg)
		if err != nil {
			return err
		}
		defer worker.Wait()
		return serve(ctx, socket, deployment.WorkerHandler(worker))
	case "gateway":
		credentials, err := os.OpenRoot(os.Getenv("CREDENTIALS_DIRECTORY"))
		if err != nil {
			return err
		}
		defer credentials.Close()
		key, err := credentials.ReadFile("session-key")
		if err != nil {
			return err
		}
		gateway, err := deployment.NewGateway(cfg, key)
		if err != nil {
			return err
		}
		listener, err := net.Listen("tcp", cfg.Listen)
		if err != nil {
			return err
		}
		defer listener.Close()
		return serve(ctx, listener, gateway)
	case "client":
		err := call(ctx, deployment.NewClient(cfg.Socket()), *action, *target, *confirm, *offline)
		if err != nil && ctx.Err() != nil && errors.Is(err, ctx.Err()) {
			return fmt.Errorf("停止等待，已提交的任务继续在宿主机运行: %w", err)
		}
		return err
	default:
		return errors.New("未知的维护入口")
	}
}

func serve(ctx context.Context, l net.Listener, handler http.Handler) error {
	server := &http.Server{Handler: handler, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 90 * time.Second}
	done := make(chan struct{})
	go func() {
		defer close(done)
		<-ctx.Done()
		timeout, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
		defer cancel()
		_ = server.Shutdown(timeout)
	}()
	err := server.Serve(l)
	if errors.Is(err, http.ErrServerClosed) {
		<-done
		return nil
	}
	return err
}

type maintenanceClient interface {
	Status(context.Context) (deployment.State, error)
	Submit(context.Context, deployment.Request) (deployment.Job, error)
}

type localWorker struct{ worker *deployment.Worker }

func (c localWorker) Status(ctx context.Context) (deployment.State, error) {
	return c.worker.Status(), ctx.Err()
}

func (c localWorker) Submit(ctx context.Context, request deployment.Request) (deployment.Job, error) {
	if err := ctx.Err(); err != nil {
		return deployment.Job{}, err
	}
	return c.worker.Submit(request)
}

func call(ctx context.Context, c maintenanceClient, action, target, confirm string, offline bool) error {
	state, err := c.Status(ctx)
	if err != nil {
		return err
	}
	if action == "status" {
		return json.NewEncoder(os.Stdout).Encode(state)
	}
	if action == "check-update" {
		action = "check"
	}
	if action == "upgrade" && (target == "" || target == "latest") {
		if _, err := submit(ctx, c, state.Current, "check", "", "", offline); err != nil {
			return err
		}
		state, err = c.Status(ctx)
		if err != nil {
			return err
		}
		if offline {
			if release, ok := state.LatestLocalUpgrade(); ok {
				target = release.Version
			} else {
				fmt.Fprintln(os.Stderr, "没有高于当前版本的本地发布包，正在检查当前版本镜像")
				target = state.Current
			}
		} else if state.Update == nil || state.Update.Version == state.Current {
			fmt.Println("已是最新正式版")
			return nil
		} else {
			target = state.Update.Version
		}
	}
	switch action {
	case "rollback":
		target = state.Previous
		offline = true
	case "restore":
		offline = true
	case "upgrade":
	default:
		target = ""
	}
	job, err := submit(ctx, c, state.Current, action, target, confirm, offline)
	if err != nil {
		return err
	}
	if job.Action == "check" {
		state, err := c.Status(ctx)
		if err != nil {
			return err
		}
		if offline {
			releases := state.LocalReleases
			if releases == nil {
				releases = []deployment.Release{}
			}
			return json.NewEncoder(os.Stdout).Encode(releases)
		}
		return json.NewEncoder(os.Stdout).Encode(state.Update)
	}
	return json.NewEncoder(os.Stdout).Encode(job)
}

func submit(ctx context.Context, c maintenanceClient, current, action, target, confirm string, offline bool) (deployment.Job, error) {
	request := deployment.Request{ID: deployment.RandomID(), Expected: current, Action: action, Target: target, Confirm: confirm, Offline: offline, Actor: "host"}
	job, err := c.Submit(ctx, request)
	if err != nil {
		return deployment.Job{}, err
	}
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	phase := ""
	for {
		if phase != job.Phase {
			phase = job.Phase
			fmt.Fprintf(os.Stderr, "[%s] %s\n", job.ID, phase)
		}
		if job.Finished != nil {
			if job.Phase != "succeeded" {
				return job, errors.New(job.Result)
			}
			return job, nil
		}
		select {
		case <-ctx.Done():
			return job, ctx.Err()
		case <-tick.C:
			state, err := c.Status(ctx)
			if err != nil {
				return job, err
			}
			for _, candidate := range state.Jobs {
				if candidate.ID == job.ID {
					job = candidate
					break
				}
			}
		}
	}
}
