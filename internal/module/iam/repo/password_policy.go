package repo

import (
	"context"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

const passwordPolicyTable = "iam_password_policy"

type PasswordPolicySettings struct {
	Overridden        bool
	MinLength         int
	MaxLength         int
	RequireComplexity bool
	Version           uint64
}

func (unit *Unit) PasswordPolicy(ctx context.Context, forUpdate bool) (PasswordPolicySettings, error) {
	var record PasswordPolicySettings
	err := unit.useDB(ctx, func(db *gorm.DB) error {
		query := db.Table(passwordPolicyTable).Where("id = ?", 1)
		if forUpdate {
			query = query.Clauses(clause.Locking{Strength: "UPDATE"})
		}
		return query.Take(&record).Error
	})
	return record, err
}

func (unit *Unit) UpdatePasswordPolicy(ctx context.Context, record PasswordPolicySettings) error {
	return unit.updateVersioned(ctx, passwordPolicyTable, "id = ? AND version = ?", []any{1, record.Version}, map[string]any{
		"overridden": record.Overridden, "min_length": record.MinLength, "max_length": record.MaxLength,
		"require_complexity": record.RequireComplexity, "version": gorm.Expr("version + 1"),
	})
}
