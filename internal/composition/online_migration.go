package composition

import (
	"context"

	databaseapp "github.com/reina0721/clouddrive/internal/kernel/app/database"
	"github.com/reina0721/clouddrive/internal/kernel/config"
	"github.com/reina0721/clouddrive/internal/module/migration"
	dbmigrate "github.com/reina0721/clouddrive/pkg/database/migrate"
)

func backupOnlineMigrationSnapshot(ctx context.Context, snapshot config.Snapshot, directory string) (string, error) {
	settings, err := databaseapp.Decode(snapshot)
	if err != nil {
		return "", err
	}
	return dbmigrate.BackupOnline(ctx, settings.PackageConfig(), directory)
}

func applyOnlineMigrationSnapshot(ctx context.Context, snapshot config.Snapshot, plan migration.OnlinePlan) error {
	service, err := onlineMigrationService(snapshot)
	if err != nil {
		return err
	}
	return service.ApplyOnline(ctx, plan)
}

// CheckOnlineMigration 校验活动启动的已有数据库。保留的签名计划只用于已验证的源版本。
func (a *Application) CheckOnlineMigration(ctx context.Context, snapshot config.Snapshot, plan *migration.OnlinePlan) error {
	service, err := onlineMigrationService(snapshot)
	if err != nil {
		return err
	}
	if plan == nil {
		return service.CheckOnlineBaseline(ctx)
	}
	return service.CompatibleWithOnlinePlan(ctx, *plan)
}

// CheckOnlineMigrationCandidate 只读校验候选 Release 与当前迁移前缀，供预启动使用。
func (a *Application) CheckOnlineMigrationCandidate(ctx context.Context, snapshot config.Snapshot, plan migration.OnlinePlan) error {
	service, err := onlineMigrationService(snapshot)
	if err != nil {
		return err
	}
	return service.CheckOnlineCandidate(ctx, plan)
}

func onlineMigrationService(snapshot config.Snapshot) (*migration.Service, error) {
	settings, err := databaseapp.Decode(snapshot)
	if err != nil {
		return nil, err
	}
	return applicationMigrationService(snapshot, settings.PackageConfig())
}
