package clibinding

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/reina0721/clouddrive/internal/module/iam/model"
	"github.com/reina0721/clouddrive/pkg/cli"
	"golang.org/x/term"
)

// SelectOwnerRecovery 由本机 CLI 选定账号并读取经确认的临时密码。
type SelectOwnerRecovery func(context.Context, []model.RecoveryOwner, model.PasswordPolicy) (accountID, password string, err error)

var errRecoveryCanceled = errors.New("已取消所有者恢复")

func (c *Contract) recoverOwnerCommand() cli.CommandSpec {
	return cli.CommandSpec{
		Name: "recover-owner", Description: "在本机交互终端恢复系统所有者的登录密码",
		Mode: cli.CommandModeApplication, SideEffect: cli.SideEffectExternalWrite, Positional: cli.PositionalNone,
		Run: func(ctx *cli.Context) error {
			stdin, inputOK := ctx.Stdin.(*os.File)
			stdout, outputOK := ctx.Stdout.(*os.File)
			if !inputOK || !outputOK || !term.IsTerminal(int(stdin.Fd())) || !term.IsTerminal(int(stdout.Fd())) {
				return &cli.UsageError{Command: ctx.CommandPath, Message: "所有者恢复需要交互式终端"}
			}
			var selected model.RecoveryOwner
			err := c.executor.RecoverOwner(ctx.Context, func(operationCtx context.Context, owners []model.RecoveryOwner, policy model.PasswordPolicy) (string, string, error) {
				owner, password, err := readOwnerRecovery(operationCtx, stdin, stdout, owners, policy)
				selected = owner
				return owner.ID, password, err
			})
			if err != nil {
				return err
			}
			_, err = fmt.Fprintf(stdout, "已重置系统所有者 %q 的密码。之前的网页会话已失效。请登录并修改临时密码。\n", selected.Username)
			return err
		},
	}
}

func readOwnerRecovery(ctx context.Context, stdin, stdout *os.File, owners []model.RecoveryOwner, policy model.PasswordPolicy) (_ model.RecoveryOwner, _ string, resultErr error) {
	if len(owners) == 0 {
		return model.RecoveryOwner{}, "", errors.New("当前实例没有可恢复的系统所有者")
	}
	if err := ctx.Err(); err != nil {
		return model.RecoveryOwner{}, "", err
	}
	inputFd := int(stdin.Fd())
	state, err := term.MakeRaw(inputFd)
	if err != nil {
		return model.RecoveryOwner{}, "", fmt.Errorf("启用安全终端输入: %w", err)
	}
	defer func() {
		if err := term.Restore(inputFd, state); err != nil {
			resultErr = errors.Join(resultErr, fmt.Errorf("恢复终端状态: %w", err))
		}
	}()
	terminal := term.NewTerminal(struct {
		io.Reader
		io.Writer
	}{stdin, stdout}, "")
	if width, height, err := term.GetSize(int(stdout.Fd())); err == nil {
		if err := terminal.SetSize(width, height); err != nil {
			return model.RecoveryOwner{}, "", fmt.Errorf("设置终端尺寸: %w", err)
		}
	}
	owner, password, err := promptOwnerRecovery(ctx, terminal, owners, policy)
	if errors.Is(err, io.EOF) {
		return model.RecoveryOwner{}, "", errors.Join(errRecoveryCanceled, err)
	}
	return owner, password, err
}

func promptOwnerRecovery(ctx context.Context, terminal *term.Terminal, owners []model.RecoveryOwner, policy model.PasswordPolicy) (model.RecoveryOwner, string, error) {
	selected := owners[0]
	if len(owners) > 1 {
		for index, owner := range owners {
			if _, err := fmt.Fprintf(terminal, "%d. %q\n", index+1, owner.Username); err != nil {
				return model.RecoveryOwner{}, "", err
			}
		}
		terminal.SetPrompt("请选择系统所有者的序号 > ")
		answer, err := terminal.ReadLine()
		if err != nil {
			return model.RecoveryOwner{}, "", err
		}
		index, err := strconv.Atoi(strings.TrimSpace(answer))
		if err != nil || index < 1 || index > len(owners) {
			return model.RecoveryOwner{}, "", errors.New("无效的系统所有者序号")
		}
		selected = owners[index-1]
	}
	terminal.SetPrompt(fmt.Sprintf("重置系统所有者 %q 的密码并退出该账号的既有会话？[y/N] ", selected.Username))
	answer, err := terminal.ReadLine()
	if err != nil {
		return model.RecoveryOwner{}, "", err
	}
	answer = strings.ToLower(strings.TrimSpace(answer))
	if answer != "y" && answer != "yes" && answer != "是" {
		return model.RecoveryOwner{}, "", errRecoveryCanceled
	}
	if err := ctx.Err(); err != nil {
		return model.RecoveryOwner{}, "", err
	}
	password, err := promptRecoveryPassword(ctx, terminal, policy)
	if err != nil {
		return model.RecoveryOwner{}, "", err
	}
	return selected, password, nil
}

func promptRecoveryPassword(ctx context.Context, terminal *term.Terminal, policy model.PasswordPolicy) (string, error) {
	rule := fmt.Sprintf("新临时密码需为 %d–%d 个字符", policy.MinLength, policy.MaxLength)
	if policy.RequireComplexity {
		rule += "，并同时包含大写字母、小写字母和数字"
	}
	if _, err := fmt.Fprintln(terminal, rule+"。"); err != nil {
		return "", err
	}
	for {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		password, err := terminal.ReadPassword("输入新临时密码 > ")
		if err != nil {
			return "", err
		}
		if model.ValidatePasswordWith(password, policy) == nil {
			if err := ctx.Err(); err != nil {
				return "", err
			}
			confirmation, err := terminal.ReadPassword("再次输入新临时密码 > ")
			if err != nil {
				return "", err
			}
			if password == confirmation {
				return password, ctx.Err()
			}
			if _, err := fmt.Fprintln(terminal, "两次输入不同，请重新输入临时密码。"); err != nil {
				return "", err
			}
			continue
		}
		length := utf8.RuneCountInString(password)
		switch {
		case length < policy.MinLength:
			_, err = fmt.Fprintf(terminal, "密码太短，至少需要 %d 个字符。\n", policy.MinLength)
		case length > policy.MaxLength:
			_, err = fmt.Fprintf(terminal, "密码太长，最多允许 %d 个字符。\n", policy.MaxLength)
		default:
			_, err = fmt.Fprintln(terminal, "密码需同时包含大写字母、小写字母和数字。")
		}
		if err != nil {
			return "", err
		}
	}
}
