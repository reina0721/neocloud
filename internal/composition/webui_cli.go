package composition

import (
	"context"
	"errors"
	"fmt"

	"github.com/reina0721/clouddrive/internal/kernel"
	databaseapp "github.com/reina0721/clouddrive/internal/kernel/app/database"
	"github.com/reina0721/clouddrive/internal/kernel/config"
	"github.com/reina0721/clouddrive/internal/module/iam"
	iamcli "github.com/reina0721/clouddrive/internal/module/iam/binding/cli"
	iamconfig "github.com/reina0721/clouddrive/internal/module/iam/binding/config"
	iamservice "github.com/reina0721/clouddrive/internal/module/iam/service"
	"github.com/reina0721/clouddrive/pkg/clock"
	"github.com/reina0721/clouddrive/pkg/idgen"
)

type iamExecutor struct{ application *Application }

func (e iamExecutor) ResetPassword(ctx context.Context, username, password string) error {
	return e.application.useInstanceIAM(ctx, func(administration iam.Administration) error {
		return administration.ResetPasswordByUsername(ctx, username, password)
	})
}

func (e iamExecutor) RecoverOwner(ctx context.Context, selectRecovery iamcli.SelectOwnerRecovery) error {
	return e.application.useInstanceIAM(ctx, func(administration iam.Administration) error {
		owners, err := administration.RecoverableOwners(ctx)
		if err != nil {
			return err
		}
		settings, err := administration.PasswordPolicy(ctx)
		if err != nil {
			return err
		}
		id, password, err := selectRecovery(ctx, owners, settings.Policy)
		if err != nil {
			return err
		}
		err = administration.RecoverOwnerPassword(ctx, id, password)
		if errors.Is(err, iamservice.ErrPasswordReused) {
			return fmt.Errorf("新密码与近期用过的密码相同，请换一个后重试: %w", err)
		}
		return err
	})
}

func (e iamExecutor) PasswordPolicy(ctx context.Context, update bool, change *iamservice.PasswordPolicyChange) (iamservice.PasswordPolicySettings, error) {
	var settings iamservice.PasswordPolicySettings
	err := e.application.useInstanceIAM(ctx, func(administration iam.Administration) error {
		var err error
		settings, err = administration.PasswordPolicy(ctx)
		if err != nil || !update {
			return err
		}
		settings, err = administration.UpdatePasswordPolicy(ctx, settings.Version, change)
		return err
	})
	return settings, err
}

func (a *Application) useInstanceIAM(ctx context.Context, use func(iam.Administration) error) (resultErr error) {
	snapshot, err := a.loadInstanceConfiguration(ctx)
	if err != nil {
		return err
	}
	iamConfig, err := iamconfig.Decode(snapshot)
	if err != nil {
		return err
	}
	component, err := a.openInstanceDatabase(ctx, snapshot)
	if err != nil {
		return err
	}
	defer closeInstanceComponent(ctx, component.close, &resultErr)
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
	return use(iamModule.Administration)
}

func (a *Application) openInstanceDatabase(ctx context.Context, snapshot config.Snapshot) (*immutableComponent[databaseapp.Access], error) {
	databaseConfig, err := databaseapp.Decode(snapshot)
	if err != nil {
		return nil, err
	}
	migrations, err := applicationMigrationService(snapshot, databaseConfig.PackageConfig())
	if err != nil {
		return nil, err
	}
	definition, err := databaseapp.ExistingDefinition()
	if err != nil {
		return nil, err
	}
	component, err := startImmutableComponent(ctx, snapshot, a.config.Logging, definition)
	if err != nil {
		return nil, fmt.Errorf("open instance database: %w", err)
	}
	if err := migrations.Compatible(ctx); err != nil {
		resultErr := fmt.Errorf("verify application migration compatibility: %w", err)
		closeInstanceComponent(ctx, component.close, &resultErr)
		return nil, resultErr
	}
	return component, nil
}

func closeInstanceComponent(ctx context.Context, close func(context.Context) error, result *error) {
	stopCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), kernel.DefaultReloadTimeout)
	defer cancel()
	*result = errors.Join(*result, close(stopCtx))
}
