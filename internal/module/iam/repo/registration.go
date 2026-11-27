package repo

import (
	"context"
	"time"

	"gorm.io/gorm"
)

// RegistrationSettings 是 IAM 拥有的公开注册策略，版本用于并发控制。
type RegistrationSettings struct {
	ID            int       `json:"-"`
	Enabled       bool      `json:"enabled"`
	DefaultRoleID string    `json:"defaultRoleId"`
	Version       uint64    `json:"version"`
	UpdatedAt     time.Time `json:"updatedAt"`
}

func (unit *Unit) Registration(ctx context.Context) (RegistrationSettings, error) {
	var value RegistrationSettings
	err := unit.useDB(ctx, func(db *gorm.DB) error {
		return db.Table("iam_registration_settings").Where("id = ?", 1).First(&value).Error
	})
	return value, err
}

func (unit *Unit) UpdateRegistration(ctx context.Context, value RegistrationSettings) error {
	return unit.updateVersioned(ctx, "iam_registration_settings", "id = ? AND version = ?", []any{1, value.Version}, map[string]any{"enabled": value.Enabled, "default_role_id": value.DefaultRoleID, "updated_at": value.UpdatedAt, "version": gorm.Expr("version + 1")})
}

type RegistrationRoleRecord struct {
	Role           RoleRecord
	PermissionKeys []string
}

// ListRegistrationRoles 一次读取可选范围内的角色及其实际授权，保留已配置但失效的角色。
func (unit *Unit) ListRegistrationRoles(ctx context.Context, selectedID string) ([]RegistrationRoleRecord, error) {
	type roleGrant struct {
		RoleRecord    `gorm:"embedded"`
		PermissionKey *string
	}
	var rows []roleGrant
	err := unit.useDB(ctx, func(db *gorm.DB) error {
		return db.Table(roleTable+" AS r").
			Select("r.id, r.name, r.system, r.active, r.archived, p.permission_key").
			Joins("LEFT JOIN "+rolePermissionTable+" AS p ON p.role_id = r.id AND p.active = ?", true).
			Where("(r.active = ? AND r.archived = ?) OR r.id = ?", true, false, selectedID).
			Order("r.code ASC, p.permission_key ASC").Scan(&rows).Error
	})
	if err != nil {
		return nil, err
	}
	roles := []RegistrationRoleRecord{}
	for _, row := range rows {
		if len(roles) == 0 || roles[len(roles)-1].Role.ID != row.ID {
			roles = append(roles, RegistrationRoleRecord{Role: row.RoleRecord, PermissionKeys: []string{}})
		}
		if row.PermissionKey != nil {
			role := &roles[len(roles)-1]
			role.PermissionKeys = append(role.PermissionKeys, *row.PermissionKey)
		}
	}
	return roles, nil
}
