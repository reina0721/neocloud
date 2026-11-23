package composition

import (
	"context"
	"errors"
	"fmt"

	"github.com/reina0721/clouddrive/internal/kernel"
	databaseapp "github.com/reina0721/clouddrive/internal/kernel/app/database"
	kernelcomposition "github.com/reina0721/clouddrive/internal/kernel/composition"
	"github.com/reina0721/clouddrive/internal/kernel/config"
	"github.com/reina0721/clouddrive/internal/module/iam"
	iamcli "github.com/reina0721/clouddrive/internal/module/iam/binding/cli"
	iamconfig "github.com/reina0721/clouddrive/internal/module/iam/binding/config"
	iammodel "github.com/reina0721/clouddrive/internal/module/iam/model"
	iamservice "github.com/reina0721/clouddrive/internal/module/iam/service"
	"github.com/reina0721/clouddrive/pkg/clock"
	"github.com/reina0721/clouddrive/pkg/idgen"
	"github.com/reina0721/clouddrive/pkg/supervisor"
)

type iamExecutor struct{ application *Application }

func (e iamExecutor) ResetPassword(ctx context.Context, username, password string) error {
	return e.application.executeIAMResetPassword(ctx, username, password)
}

func (e iamExecutor) RecoverOwner(ctx context.Context, selectRecovery iamcli.SelectOwnerRecovery) (resultErr error) {
	a := e.application
	bindings, err := kernelcomposition.ConfigurationBindings(applicationOwnedConfigurationBindings()...)
	if err != nil {
		return err
	}
	snapshot, err := config.New(config.FileSource(a.config.ConfigPath), config.EnvSource(a.config.EnvironmentPrefix)).Load(ctx)
	if err != nil {
		return fmt.Errorf("加载实例配置: %w", err)
	}
	if err := config.ValidateCandidate(snapshot, bindings...); err != nil {
		return fmt.Errorf("校验实例配置: %w", err)
	}
	iamConfig, err := iamconfig.Decode(snapshot)
	if err != nil {
		return err
	}
	databaseConfig, err := databaseapp.Decode(snapshot)
	if err != nil {
		return err
	}
	definition, err := databaseapp.ExistingDefinition()
	if err != nil {
		return err
	}
	component, err := startImmutableComponent(ctx, snapshot, a.config.Logging, definition)
	if err != nil {
		return fmt.Errorf("打开现有实例数据库: %w", err)
	}
	defer func() {
		stopCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), kernel.DefaultReloadTimeout)
		defer cancel()
		resultErr = errors.Join(resultErr, component.close(stopCtx))
	}()
	migrationService, err := applicationMigrationService(snapshot, databaseConfig.PackageConfig())
	if err != nil {
		return err
	}
	if err := migrationService.Compatible(ctx); err != nil {
		return fmt.Errorf("校验实例迁移兼容性: %w", err)
	}
	databaseAccess, err := adaptDatabaseAccess(component.output)
	if err != nil {
		return err
	}
	iamModule, err := iam.New(iam.Dependencies{
		Database: databaseAccess, Clock: clock.System(), IDGenerator: idgen.UUID(), Config: iamConfig, Permissions: a.blueprint.permissions,
	})
	if err != nil {
		return err
	}
	owners, err := iamModule.Administration.RecoverableOwners(ctx)
	if err != nil {
		return err
	}
	id, password, err := selectRecovery(ctx, owners, iammodel.PasswordPolicy(iamConfig.Local.PasswordPolicy))
	if err != nil {
		return err
	}
	err = iamModule.Administration.RecoverOwnerPassword(ctx, id, password)
	if errors.Is(err, iamservice.ErrPasswordReused) {
		return fmt.Errorf("新密码与近期用过的密码相同，请换一个后重试: %w", err)
	}
	return err
}

func (a *Application) executeIAMResetPassword(ctx context.Context, username, password string) error {
	if a == nil {
		return fmt.Errorf("application is nil")
	}
	loader := config.New(
		config.FileSource(a.config.ConfigPath),
		config.EnvSource(a.config.EnvironmentPrefix),
	)
	runtime, err := kernel.New(loader, kernel.Options{Logging: a.config.Logging})
	if err != nil {
		return fmt.Errorf("create kernel: %w", err)
	}
	capabilities, err := kernelcomposition.Compose(runtime, kernelcomposition.Options{
		Logger: kernelcomposition.ConfiguredLoggerReplacement,
	})
	if err != nil {
		return fmt.Errorf("compose application capabilities: %w", err)
	}
	bindings := append([]config.Binding{
		kernelcomposition.HTTPConfiguration(),
	}, applicationOwnedConfigurationBindings()...)
	coordinator, err := kernel.NewCoordinator(runtime, bindings...)
	if err != nil {
		return fmt.Errorf("create configuration coordinator: %w", err)
	}
	candidate, err := coordinator.Prepare(ctx)
	if err != nil {
		return fmt.Errorf("prepare application configuration: %w", err)
	}
	iamConfig, err := iamconfig.Decode(candidate)
	if err != nil {
		return err
	}
	databaseConfig, err := databaseapp.Decode(candidate)
	if err != nil {
		return err
	}
	databaseAccess, err := adaptDatabaseAccess(capabilities.Database)
	if err != nil {
		return err
	}
	migrationService, err := applicationMigrationService(candidate, databaseConfig.PackageConfig())
	if err != nil {
		return err
	}
	permissions := a.blueprint.permissions
	iamModule, err := iam.New(iam.Dependencies{
		Database: databaseAccess, Clock: capabilities.Clock, IDGenerator: idgen.UUID(), Config: iamConfig, Permissions: permissions,
	})
	if err != nil {
		return fmt.Errorf("compose local iam module: %w", err)
	}
	owner, err := newTodoOperationSupervisor([]supervisor.Participant{coordinator})
	if err != nil {
		return fmt.Errorf("create webui operation supervisor: %w", err)
	}
	if err := owner.RunOperation(ctx, func(operationCtx context.Context) error {
		if err := migrationService.Compatible(operationCtx); err != nil {
			return fmt.Errorf("verify application migration compatibility: %w", err)
		}
		if err := iamModule.Administration.ReconcileOwnerCatalog(operationCtx); err != nil {
			return fmt.Errorf("reconcile iam owner catalog: %w", err)
		}
		if err := iamModule.Administration.Compatible(operationCtx); err != nil {
			return fmt.Errorf("verify iam catalog compatibility: %w", err)
		}
		return iamModule.Administration.ResetPasswordByUsername(operationCtx, username, password)
	}); err != nil {
		return fmt.Errorf("execute webui password reset: %w", err)
	}
	return nil
}
