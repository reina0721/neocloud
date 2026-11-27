package clibinding

import (
	"bytes"
	"context"
	"errors"
	"io"
	"strings"
	"testing"

	"github.com/reina0721/neocloud/internal/module/iam/model"
	"github.com/reina0721/neocloud/internal/module/iam/service"
	"github.com/reina0721/neocloud/pkg/cli"
	"golang.org/x/term"
)

func (*recoveryExecutorStub) PasswordPolicy(context.Context, bool, *service.PasswordPolicyChange) (service.PasswordPolicySettings, error) {
	return service.PasswordPolicySettings{}, errors.New("unexpected password policy command")
}

func TestOwnerRecoveryPromptsRequireConfirmationAndSuppressPasswordEcho(t *testing.T) {
	const password = "fictional-Recovery-123"
	owners := []model.RecoveryOwner{{ID: "first", Username: "first-owner"}, {ID: "second", Username: "second-owner"}}
	for _, tc := range []struct {
		name, input string
		owners      []model.RecoveryOwner
		wantID      string
		wantError   error
	}{
		{"selects and confirms an owner", "2\ry\r" + password + "\r" + password + "\r", owners, "second", nil},
		{"confirms a single owner", "y\r" + password + "\r" + password + "\r", owners[:1], "first", nil},
		{"empty confirmation cancels", "\r", owners[:1], "", errRecoveryCanceled},
		{"Ctrl+C during password cancels", "y\r" + password + "\x03", owners[:1], "", io.EOF},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var output bytes.Buffer
			terminal := term.NewTerminal(struct {
				io.Reader
				io.Writer
			}{strings.NewReader(tc.input), &output}, "")
			owner, value, err := promptOwnerRecovery(t.Context(), terminal, tc.owners, model.DefaultPasswordPolicy())
			if !errors.Is(err, tc.wantError) || owner.ID != tc.wantID || (tc.wantError == nil && value != password) {
				t.Fatal("恢复提示未按选择、确认或取消的结果结束")
			}
			if strings.Contains(output.String(), password) || strings.Contains(output.String(), "fictional-Recovery") {
				t.Fatal("恢复提示回显了输入密码")
			}
			if tc.wantError == nil && !strings.Contains(output.String(), "再次输入新临时密码") {
				t.Fatal("未显示二次输入密码提示")
			}
		})
	}
	var output bytes.Buffer
	terminal := term.NewTerminal(struct {
		io.Reader
		io.Writer
	}{strings.NewReader("y\r" + password + "\rshort-other-password\r"), &output}, "")
	if _, _, err := promptOwnerRecovery(t.Context(), terminal, owners[:1], model.DefaultPasswordPolicy()); err == nil {
		t.Fatal("接受了不一致的密码")
	}
	if strings.Contains(output.String(), password) || strings.Contains(output.String(), "short-other-password") {
		t.Fatal("密码不一致时回显了输入密码")
	}
}

func TestOwnerRecoveryRetriesAgainstActivePolicy(t *testing.T) {
	var output bytes.Buffer
	terminal := term.NewTerminal(struct {
		io.Reader
		io.Writer
	}{strings.NewReader("y\ra\rsolo\rother\rsolo\rsolo\r"), &output}, "")
	policy := model.PasswordPolicy{MinLength: 4, MaxLength: 12}
	_, password, err := promptOwnerRecovery(t.Context(), terminal, []model.RecoveryOwner{{ID: "owner", Username: "fixture"}}, policy)
	if err != nil || password != "solo" || !strings.Contains(output.String(), "至少需要 4 个字符") || !strings.Contains(output.String(), "两次输入不同") {
		t.Fatalf("恢复未在同次交互中应用配置的长度要求: %v", err)
	}
	if strings.Contains(output.String(), "solo") {
		t.Fatal("重试时回显了密码")
	}
}

func TestOwnerRecoveryRejectsNonTerminalBeforeOpeningInstance(t *testing.T) {
	executor := &recoveryExecutorStub{}
	contract := Contract{executor: executor}
	err := contract.recoverOwnerCommand().Run(&cli.Context{
		Context: t.Context(), CommandPath: "clouddrive iam recover-owner", Stdin: strings.NewReader("y\n"), Stdout: io.Discard,
	})
	var usage *cli.UsageError
	if !errors.As(err, &usage) || executor.recoveryCalled {
		t.Fatal("非终端输入必须在访问实例前拒绝")
	}
}

type recoveryExecutorStub struct{ recoveryCalled bool }

func (*recoveryExecutorStub) ResetPassword(context.Context, string, string) error { return nil }

func (s *recoveryExecutorStub) RecoverOwner(context.Context, SelectOwnerRecovery) error {
	s.recoveryCalled = true
	return nil
}
