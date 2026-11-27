package service

import (
	"context"
	"fmt"

	"github.com/reina0721/neocloud/internal/module/iam/model"
	"github.com/reina0721/neocloud/internal/module/iam/repo"
)

// PasswordPolicySettings 包含当前强度规则及实例覆盖的并发版本。
type PasswordPolicySettings struct {
	Policy     model.PasswordPolicy
	Overridden bool
	Version    uint64
}

// PasswordPolicyChange 只覆盖产品设置可调整的强度字段。
type PasswordPolicyChange struct {
	MinLength, MaxLength *int
	RequireComplexity    *bool
}

func (s *Service) PasswordPolicy(ctx context.Context) (PasswordPolicySettings, error) {
	var settings PasswordPolicySettings
	err := s.store.Use(ctx, func(unit *repo.Unit) error {
		var err error
		settings, err = s.readPasswordPolicy(ctx, unit, false)
		return err
	})
	return settings, err
}

// UpdatePasswordPolicy 按版本更新强度。nil 移除实例覆盖并恢复配置默认值。
func (s *Service) UpdatePasswordPolicy(ctx context.Context, version uint64, change *PasswordPolicyChange) (PasswordPolicySettings, error) {
	var updated PasswordPolicySettings
	err := s.store.WithinTx(ctx, func(txCtx context.Context, unit *repo.Unit) error {
		current, err := s.readPasswordPolicy(txCtx, unit, true)
		if err != nil {
			return err
		}
		if current.Version != version {
			return ErrVersionConflict
		}
		record := repo.PasswordPolicySettings{Version: version}
		updated = PasswordPolicySettings{Policy: s.config.PasswordPolicy, Version: version + 1}
		if change != nil {
			policy := current.Policy
			if change.MinLength != nil {
				policy.MinLength = *change.MinLength
			}
			if change.MaxLength != nil {
				policy.MaxLength = *change.MaxLength
			}
			if change.RequireComplexity != nil {
				policy.RequireComplexity = *change.RequireComplexity
			}
			if policy.MinLength < 1 || policy.MaxLength < policy.MinLength || policy.MaxLength > model.MaxPasswordRunes {
				return fmt.Errorf("%w: 密码长度需满足 1 ≤ 最短长度 ≤ 最长长度 ≤ %d", model.ErrInvalidPassword, model.MaxPasswordRunes)
			}
			record.Overridden = true
			record.MinLength, record.MaxLength, record.RequireComplexity = policy.MinLength, policy.MaxLength, policy.RequireComplexity
			updated.Overridden, updated.Policy = true, policy
		}
		return unit.UpdatePasswordPolicy(txCtx, record)
	})
	if err != nil {
		return PasswordPolicySettings{}, err
	}
	return updated, nil
}

func (s *Service) readPasswordPolicy(ctx context.Context, unit *repo.Unit, lock bool) (PasswordPolicySettings, error) {
	record, err := unit.PasswordPolicy(ctx, lock)
	if err != nil {
		return PasswordPolicySettings{}, fmt.Errorf("read IAM password policy: %w", err)
	}
	policy := s.config.PasswordPolicy
	if record.Overridden {
		policy.MinLength = record.MinLength
		policy.MaxLength = record.MaxLength
		policy.RequireComplexity = record.RequireComplexity
	}
	return PasswordPolicySettings{Policy: policy, Overridden: record.Overridden, Version: record.Version}, nil
}

func (s *Service) validatePasswordChange(ctx context.Context, unit *repo.Unit, password string) error {
	settings, err := s.readPasswordPolicy(ctx, unit, true)
	if err != nil {
		return err
	}
	return model.ValidatePasswordWith(password, settings.Policy)
}

func (s *Service) hashNewPassword(ctx context.Context, password string) (string, error) {
	settings, err := s.PasswordPolicy(ctx)
	if err != nil {
		return "", err
	}
	if err := model.ValidatePasswordWith(password, settings.Policy); err != nil {
		return "", err
	}
	return s.passwords.Hash(password)
}
