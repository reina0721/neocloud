package clibinding

import (
	"fmt"

	"github.com/reina0721/clouddrive/internal/module/iam/service"
	"github.com/reina0721/clouddrive/pkg/cli"
)

func (c *Contract) passwordPolicyCommand() cli.CommandSpec {
	run := func(ctx *cli.Context, update bool, change *service.PasswordPolicyChange) error {
		value, err := c.executor.PasswordPolicy(ctx.Context, update, change)
		if err != nil {
			return err
		}
		source := "实例配置"
		if value.Overridden {
			source = "实例设置覆盖"
		}
		complexity := "无需混合字符"
		if value.Policy.RequireComplexity {
			complexity = "同时包含大写字母、小写字母和数字"
		}
		_, err = fmt.Fprintf(ctx.Stdout, "当前密码要求（%s）：%d–%d 个字符，%s。\n", source, value.Policy.MinLength, value.Policy.MaxLength, complexity)
		return err
	}
	return cli.CommandSpec{
		Name: "password-policy", Description: "查看或调整当前实例的密码强度",
		Mode: cli.CommandModeApplication, SideEffect: cli.SideEffectExternalWrite, Positional: cli.PositionalNone,
		Commands: []cli.CommandSpec{
			{Name: "show", Description: "查看生效的密码规则", Mode: cli.CommandModeApplication,
				SideEffect: cli.SideEffectNone, Positional: cli.PositionalNone, Run: func(ctx *cli.Context) error { return run(ctx, false, nil) }},
			{Name: "set", Description: "调整指定的密码规则", Mode: cli.CommandModeApplication, SideEffect: cli.SideEffectExternalWrite,
				Positional: cli.PositionalNone, Flags: []cli.FlagSpec{
					{Name: "min-length", Type: cli.FlagTypeInt, Description: "最少字符数"},
					{Name: "max-length", Type: cli.FlagTypeInt, Description: "最多字符数"},
					{Name: "require-complexity", Type: cli.FlagTypeBool, Description: "是否要求大写、小写和数字"},
				}, Run: func(ctx *cli.Context) error {
					var change service.PasswordPolicyChange
					if ctx.IsFlagChanged("min-length") {
						value := ctx.GetInt("min-length")
						change.MinLength = &value
					}
					if ctx.IsFlagChanged("max-length") {
						value := ctx.GetInt("max-length")
						change.MaxLength = &value
					}
					if ctx.IsFlagChanged("require-complexity") {
						value := ctx.GetBool("require-complexity")
						change.RequireComplexity = &value
					}
					if change == (service.PasswordPolicyChange{}) {
						return &cli.UsageError{Command: ctx.CommandPath, Message: "请至少指定一项密码规则"}
					}
					return run(ctx, true, &change)
				},
			},
			{Name: "reset", Description: "清除实例覆盖，恢复配置中的密码规则", Mode: cli.CommandModeApplication,
				SideEffect: cli.SideEffectExternalWrite, Positional: cli.PositionalNone,
				Run: func(ctx *cli.Context) error { return run(ctx, true, nil) }},
		},
	}
}
