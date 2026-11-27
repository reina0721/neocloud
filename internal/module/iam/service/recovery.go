package service

import (
	"context"
	"errors"

	"github.com/reina0721/neocloud/internal/module/iam/model"
	"github.com/reina0721/neocloud/internal/module/iam/repo"
)

var ErrOwnerRecoveryUnavailable = errors.New("所选账号已不是有效系统所有者")

// RecoverableOwners 只读取当前实例中可用于本机恢复的系统所有者。
func (s *Service) RecoverableOwners(ctx context.Context) ([]model.RecoveryOwner, error) {
	var result []model.RecoveryOwner
	err := s.store.Use(ctx, func(unit *repo.Unit) error {
		role, err := recoveryOwnerRole(ctx, unit)
		if errors.Is(err, ErrOwnerRecoveryUnavailable) {
			return nil
		}
		if err != nil {
			return err
		}
		accounts, err := unit.ListAccountIdentities(ctx, repo.AccountFilter{
			RoleID: role.ID, Status: string(model.AccountActive), Archived: boolPointer(false),
		})
		if err != nil {
			return err
		}
		for _, account := range accounts {
			result = append(result, model.RecoveryOwner(account))
		}
		return nil
	})
	return result, err
}

// RecoverOwnerPassword 复用密码重置事务，并在事务中复核系统所有者身份。
func (s *Service) RecoverOwnerPassword(ctx context.Context, accountID, newPassword string) error {
	return s.resetPassword(ctx, accountID, newPassword, true)
}

func recoveryOwnerRole(ctx context.Context, unit *repo.Unit) (repo.RoleRecord, error) {
	role, err := unit.OwnerRole(ctx)
	if repo.IsNotFound(err) || (err == nil && (!role.System || !role.Active || role.Archived)) {
		return repo.RoleRecord{}, ErrOwnerRecoveryUnavailable
	}
	return role, err
}

func requireRecoveryOwner(ctx context.Context, unit *repo.Unit, account repo.AccountRecord) error {
	if account.Archived || account.Status != string(model.AccountActive) {
		return ErrOwnerRecoveryUnavailable
	}
	role, err := recoveryOwnerRole(ctx, unit)
	if err != nil {
		return err
	}
	hasRole, err := unit.HasRole(ctx, account.ID, role.ID)
	if err != nil {
		return err
	}
	if !hasRole {
		return ErrOwnerRecoveryUnavailable
	}
	return nil
}
