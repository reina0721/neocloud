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

	"github.com/reina0721/clouddrive/internal/deployment"
)

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if err := run(ctx, os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "CloudDrive 维护:", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string) error {
	if len(args) == 0 {
		return errors.New("需要 enable、worker、gateway 或 client")
	}
	flags := flag.NewFlagSet(args[0], flag.ContinueOnError)
	root := flags.String("root", "", "安装目录")
	config := flags.String("config", "", "网关配置")
	cosign := flags.String("cosign", "cosign", "cosign 命令")
	dockerHost := flags.String("docker-host", "unix:///var/run/docker.sock", "本机 Docker socket")
	trusted := flags.String("trusted-proxy", "", "代理 IP")
	action := flags.String("action", "status", "操作")
	target := flags.String("target", "", "版本或恢复点")
	confirm := flags.String("confirm", "", "恢复点确认")
	if err := flags.Parse(args[1:]); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("多余参数")
	}
	if args[0] == "enable" {
		ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
		defer cancel()
		return deployment.Enable(ctx, *root, *trusted, *cosign, *dockerHost)
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
	switch args[0] {
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
		credential := filepath.Join(os.Getenv("CREDENTIALS_DIRECTORY"), "session-key")
		key, err := os.ReadFile(credential)
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
		return call(ctx, deployment.NewClient(cfg.Socket()), *action, *target, *confirm)
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
		timeout, cancel := context.WithTimeout(context.Background(), 10*time.Second)
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

func call(ctx context.Context, c *deployment.Client, action, target, confirm string) error {
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
		if err := submit(ctx, c, state.Current, "check", "", ""); err != nil {
			return err
		}
		state, err = c.Status(ctx)
		if err != nil {
			return err
		}
		if state.Update == nil || state.Update.Version == state.Current {
			fmt.Println("已是最新正式版")
			return nil
		}
		target = state.Update.Version
	}
	switch action {
	case "rollback":
		target = state.Previous
	case "restore", "upgrade":
	default:
		target = ""
	}
	return submit(ctx, c, state.Current, action, target, confirm)
}

func submit(ctx context.Context, c *deployment.Client, current, action, target, confirm string) error {
	request := deployment.Request{ID: deployment.RandomID(), Expected: current, Action: action, Target: target, Confirm: confirm, Actor: "host"}
	job, err := c.Submit(ctx, request)
	if err != nil {
		return err
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
				return errors.New(job.Result)
			}
			if job.Action == "check" {
				state, err := c.Status(ctx)
				if err != nil {
					return err
				}
				return json.NewEncoder(os.Stdout).Encode(state.Update)
			}
			return json.NewEncoder(os.Stdout).Encode(job)
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("停止等待，任务继续在宿主机运行: %w", ctx.Err())
		case <-tick.C:
			state, err := c.Status(ctx)
			if err != nil {
				return err
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
