package service

import (
	"context"
	"errors"

	"github.com/reina0721/clouddrive/internal/module/iam/model"
	iampermission "github.com/reina0721/clouddrive/internal/module/iam/permission"
	"github.com/reina0721/clouddrive/internal/module/iam/repo"
	permissioncatalog "github.com/reina0721/clouddrive/internal/permission"
)

var ErrRegistrationClosed = errors.New("public registration is disabled")

type RegistrationRoleReason string

const (
	registrationRoleProtected  RegistrationRoleReason = "protected-role"
	registrationRoleInactive   RegistrationRoleReason = "inactive-role"
	registrationRoleRestricted RegistrationRoleReason = "restricted-permissions"
	registrationRoleMissing    RegistrationRoleReason = "missing-role"
)

type RegistrationRoleError struct {
	Reason RegistrationRoleReason
	cause  error
}

func (e *RegistrationRoleError) Error() string { return string(e.Reason) + ": " + e.cause.Error() }
func (e *RegistrationRoleError) Unwrap() error { return e.cause }

type RegistrationRoleOption struct {
	ID, Name       string
	PermissionKeys []string
	Ineligible     RegistrationRoleReason
}

// Registration 返回服务端注册策略，调用方不能用前端配置取代它。
func (s *Service) Registration(ctx context.Context) (repo.RegistrationSettings, error) {
	var result repo.RegistrationSettings
	err := s.store.Use(ctx, func(r *repo.Unit) error {
		var err error
		result, err = r.Registration(ctx)
		return err
	})
	return result, err
}

// RegistrationWithRoleOptions 返回设置界面所需的当前策略和角色判断。
func (s *Service) RegistrationWithRoleOptions(ctx context.Context) (repo.RegistrationSettings, []RegistrationRoleOption, error) {
	var settings repo.RegistrationSettings
	var roles []repo.RegistrationRoleRecord
	err := s.store.Use(ctx, func(r *repo.Unit) error {
		var err error
		settings, err = r.Registration(ctx)
		if err != nil {
			return err
		}
		roles, err = r.ListRegistrationRoles(ctx, settings.DefaultRoleID)
		return err
	})
	if err != nil {
		return repo.RegistrationSettings{}, nil, err
	}
	options := make([]RegistrationRoleOption, len(roles))
	for i, item := range roles {
		options[i] = RegistrationRoleOption{
			ID: item.Role.ID, Name: item.Role.Name, PermissionKeys: item.PermissionKeys,
			Ineligible: s.registrationRoleReason(item.Role, item.PermissionKeys),
		}
	}
	return settings, options, nil
}

// UpdateRegistration 仅在关闭注册时允许保留后来失效的现有角色。
func (s *Service) UpdateRegistration(ctx context.Context, value repo.RegistrationSettings) error {
	if value.Enabled && value.DefaultRoleID == "" {
		return model.ErrInvalidID
	}
	return s.store.WithinTx(ctx, func(txCtx context.Context, r *repo.Unit) error {
		validateRole := value.DefaultRoleID != ""
		if validateRole && !value.Enabled {
			current, err := r.Registration(txCtx)
			if err != nil {
				return err
			}
			validateRole = current.DefaultRoleID != value.DefaultRoleID
		}
		if validateRole {
			if err := s.registrationRole(txCtx, r, value.DefaultRoleID); err != nil {
				return err
			}
		}
		value.UpdatedAt = s.clock.Now().UTC()
		return r.UpdateRegistration(txCtx, value)
	})
}

func (s *Service) registrationRole(ctx context.Context, r *repo.Unit, id string) error {
	role, err := r.RoleByID(ctx, id)
	if errors.Is(err, repo.ErrNotFound) {
		return &RegistrationRoleError{Reason: registrationRoleMissing, cause: err}
	}
	if err != nil {
		return err
	}
	permissions, err := r.ListRolePermissions(ctx, id, true)
	if err != nil {
		return err
	}
	keys := make([]string, len(permissions))
	for i, grant := range permissions {
		keys[i] = grant.PermissionKey
	}
	if reason := s.registrationRoleReason(role, keys); reason != "" {
		return &RegistrationRoleError{Reason: reason, cause: ErrImmutableOwner}
	}
	return nil
}

func (s *Service) registrationRoleReason(role repo.RoleRecord, keys []string) RegistrationRoleReason {
	if role.System {
		return registrationRoleProtected
	}
	if role.Archived || !role.Active {
		return registrationRoleInactive
	}
	for _, key := range keys {
		definition, ok := s.catalog.Lookup(permissioncatalog.Key(key))
		if !ok || (definition.Risk != permissioncatalog.RiskStandard && definition.Key != iampermission.SelfPasswordWrite && definition.Key != iampermission.SelfArchive) {
			return registrationRoleRestricted
		}
	}
	return ""
}
