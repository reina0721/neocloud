package nativeupgrade

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"time"

	"github.com/reina0721/neocloud/pkg/cli"
)

// Commands declares the native update entry in the normal application CLI.
func Commands() ([]cli.CommandSpec, error) {
	update := cli.CommandSpec{
		Name: "update", Description: "查询和更新原生托管 Go 服务", Mode: cli.CommandModeApplication,
		SideEffect: cli.SideEffectNone, Positional: cli.PositionalNone,
	}
	for _, action := range []struct{ name, description string }{
		{"check", "查询 GitHub 正式版及平台候选"},
		{"apply", "下载、验签并切换至兼容的正式版"},
		{"status", "查看当前版本与升级任务"},
		{"cancel", "请求取消尚未交接的升级"},
		{"rollback", "切换至兼容的上一个版本并保留数据"},
	} {
		command := cli.CommandSpec{
			Name: action.name, Description: action.description, Mode: cli.CommandModeApplication,
			SideEffect: cli.SideEffectNone, Positional: cli.PositionalNone,
			Flags: []cli.FlagSpec{{Name: "root", Type: cli.FlagTypeString, Default: ".", Description: "原生托管实例目录"}},
			Run: func(ctx *cli.Context) error {
				return executeCommand(ctx.Context, ctx.Stdout, action.name, ctx.GetString("root"), ctx.GetString("version"))
			},
		}
		if action.name != "check" && action.name != "status" {
			command.SideEffect = cli.SideEffectExternalWrite
		}
		if action.name == "apply" {
			command.Flags = append(command.Flags, cli.FlagSpec{
				Name: "version", Type: cli.FlagTypeString, Description: "指定较新的正式版本",
			})
		}
		update.Commands = append(update.Commands, command)
	}
	return []cli.CommandSpec{update}, nil
}

func executeCommand(ctx context.Context, output io.Writer, action, root, target string) error {
	if target != "" && (action != "apply" || !stableTag.MatchString(target)) {
		return errors.New("更新版本需要使用 vX.Y.Z 正式 tag")
	}
	method, path := http.MethodGet, "/"+action
	var input io.Reader
	switch action {
	case "check", "status":
	case "apply", "rollback":
		method, path = http.MethodPost, "/jobs"
		body, err := json.Marshal(jobRequest{Action: action, Target: target})
		if err != nil {
			return err
		}
		input = bytes.NewReader(body)
	case "cancel":
		method = http.MethodPost
	default:
		return errors.New("未知的原生更新命令")
	}
	instance, err := canonicalRoot(root)
	if err != nil {
		return err
	}
	client := &http.Client{
		Timeout: 25 * time.Second,
		Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return dialControl(ctx, instance)
		}},
	}
	defer client.CloseIdleConnections()
	request, err := http.NewRequestWithContext(ctx, method, "http://native-host.local"+path, input)
	if err != nil {
		return err
	}
	if input != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("无法连接原生托管服务，请确认实例目录及宿主状态: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode >= 400 {
		var detail string
		if json.NewDecoder(io.LimitReader(response.Body, 8192)).Decode(&detail) == nil {
			return errors.New(detail)
		}
		return fmt.Errorf("原生宿主拒绝请求（HTTP %d）", response.StatusCode)
	}
	_, err = io.Copy(output, io.LimitReader(response.Body, 2<<20))
	return err
}
