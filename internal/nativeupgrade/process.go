package nativeupgrade

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"sync"
	"time"

	"github.com/reina0721/clouddrive/internal/deployment"
	"github.com/reina0721/clouddrive/internal/nativeupgrade/control"
)

type child struct {
	cmd      *exec.Cmd
	input    io.WriteCloser
	replies  <-chan control.Response
	done     chan struct{}
	token    string
	prepared control.Response
	routes   [2]http.Handler
	stopTree func() error
}

func launch(ctx context.Context, root string, target deployment.NativeTarget, plan json.RawMessage, candidate bool) (*child, error) {
	// #nosec G204 -- 入口来自已验签的固定资产文件，参数为进程私有协议标记。
	cmd := exec.Command(target.Executable, control.WorkerArgument)
	cmd.Dir = root
	cmd.Stderr = os.Stderr
	configureChild(cmd)
	input, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, errors.Join(err, input.Close())
	}
	if err := cmd.Start(); err != nil {
		return nil, errors.Join(err, input.Close(), stdout.Close())
	}
	stopTree, err := ownChildTree(cmd)
	if err != nil {
		return nil, errors.Join(err, cmd.Process.Kill(), cmd.Wait())
	}
	stopTree = sync.OnceValue(stopTree)
	replies := make(chan control.Response, 4)
	done := make(chan struct{})
	c := &child{cmd: cmd, input: input, replies: replies, done: done, token: deployment.RandomID() + deployment.RandomID(), stopTree: stopTree}
	go func() {
		defer close(done)
		defer close(replies)
		defer func() { _ = stopTree() }()
		scanner := bufio.NewScanner(stdout)
		scanner.Buffer(make([]byte, 4096), 64<<10)
		for scanner.Scan() {
			var response control.Response
			if json.Unmarshal(scanner.Bytes(), &response) != nil {
				select {
				case replies <- control.Response{Error: "私有控制管道收到了无效的业务进程响应"}:
				default:
				}
				_ = cmd.Process.Kill()
				break
			}
			select {
			case replies <- response:
			default:
				_ = cmd.Process.Kill()
			}
		}
		_ = cmd.Wait()
	}()
	c.prepared, err = c.call(ctx, control.Request{Action: "prepare", Token: c.token, Plan: plan, Candidate: candidate}, "prepared")
	if err == nil && (c.prepared.Version != target.Manifest.Version || c.prepared.Commit != target.Manifest.Commit || c.prepared.ConfigDigest == "") {
		err = errors.New("候选运行版本或配置与预期不符")
	}
	if err != nil {
		return nil, errors.Join(err, c.kill())
	}
	return c, nil
}

func (c *child) call(ctx context.Context, request control.Request, phase string) (control.Response, error) {
	if err := ctx.Err(); err != nil {
		return control.Response{}, err
	}
	request.ID = deployment.RandomID()
	if request.TimeoutMS == 0 {
		if deadline, ok := ctx.Deadline(); ok {
			request.TimeoutMS = max(1, time.Until(deadline).Milliseconds())
		}
	}
	written := make(chan error, 1)
	go func() { written <- json.NewEncoder(c.input).Encode(request) }()
	select {
	case err := <-written:
		if err != nil {
			return control.Response{}, err
		}
	case <-ctx.Done():
		_ = c.input.Close()
		return control.Response{}, ctx.Err()
	}
	for {
		select {
		case response, ok := <-c.replies:
			if !ok {
				return control.Response{}, errors.New("业务进程已退出")
			}
			if response.ID == "" {
				return control.Response{}, fmt.Errorf("业务进程 %s 的控制响应无效：%s", request.Action, response.Error)
			}
			if response.ID != request.ID {
				continue
			}
			if response.Protocol != control.Protocol {
				return control.Response{}, fmt.Errorf("业务进程 %s 的协议版本不符", request.Action)
			}
			if response.Error != "" {
				return response, fmt.Errorf("业务进程 %s：%s", request.Action, response.Error)
			}
			if response.Phase != phase {
				return response, fmt.Errorf("业务进程 %s 的确认不符", request.Action)
			}
			return response, nil
		case <-ctx.Done():
			return control.Response{}, ctx.Err()
		}
	}
}

func (c *child) activate(ctx context.Context) error {
	response, err := c.call(ctx, control.Request{Action: "activate", Expected: c.prepared.ConfigDigest}, "active-ready")
	if err != nil {
		return err
	}
	if !isLoopback(response.BusinessAddr) || !isLoopback(response.ManagementAddr) || response.Version != c.prepared.Version || response.Commit != c.prepared.Commit {
		return errors.New("接管进程的私有地址或版本不符")
	}
	c.routes = [2]http.Handler{newProxy(response.BusinessAddr, c.token), newProxy(response.ManagementAddr, c.token)}
	return nil
}

func (c *child) exited() bool {
	select {
	case <-c.done:
		return true
	default:
		return false
	}
}

func (c *child) kill() error {
	if c.exited() {
		return nil
	}
	_ = c.input.Close()
	err := c.cmd.Process.Kill()
	if errors.Is(err, os.ErrProcessDone) {
		err = nil
	}
	err = errors.Join(err, c.stopTree())
	timer := time.NewTimer(handoffBudget)
	defer timer.Stop()
	select {
	case <-c.done:
		return err
	case <-timer.C:
		return errors.Join(err, errors.New("等待旧进程退出超时"))
	}
}

func (c *child) exit() error {
	ctx, cancel := context.WithTimeout(context.Background(), handoffBudget)
	defer cancel()
	_, err := c.call(ctx, control.Request{Action: "exit"}, "exiting")
	_ = c.input.Close()
	select {
	case <-c.done:
		return nil
	case <-ctx.Done():
		return errors.Join(err, c.kill())
	}
}
