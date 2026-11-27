package composition

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"

	databaseapp "github.com/reina0721/neocloud/internal/kernel/app/database"
	storageapp "github.com/reina0721/neocloud/internal/kernel/app/storage"
	"github.com/reina0721/neocloud/internal/module/files"
	filesconfig "github.com/reina0721/neocloud/internal/module/files/binding/config"
	"github.com/reina0721/neocloud/internal/nativeupgrade"
	"github.com/reina0721/neocloud/pkg/cli"
	pkgdatabase "github.com/reina0721/neocloud/pkg/database"
)

func (a *Application) renameCommands() ([]cli.CommandSpec, error) {
	rename := cli.CommandSpec{
		Name: "rename-instance", Description: "计划、执行或回退原生托管实例停机改名",
		Mode: cli.CommandModeApplication, SideEffect: cli.SideEffectNone, Positional: cli.PositionalNone,
	}
	for _, action := range []struct {
		name, description string
		effect            cli.SideEffect
	}{
		{"plan", "只读核对源实例、目标目录、签名和空间", cli.SideEffectNone},
		{"status", "查看停机改名日志", cli.SideEffectNone},
		{"apply", "停服后将已验证实例复制到新目录", cli.SideEffectExternalWrite},
		{"rollback", "停服后将当前数据复制回原目录", cli.SideEffectExternalWrite},
	} {
		rename.Commands = append(rename.Commands, cli.CommandSpec{
			Name: action.name, Description: action.description, Mode: cli.CommandModeApplication,
			SideEffect: action.effect, Positional: cli.PositionalNone,
			Flags: []cli.FlagSpec{
				{Name: "root", Type: cli.FlagTypeString, Description: "旧实例目录"},
				{Name: "target", Type: cli.FlagTypeString, Description: "新的同级实例目录"},
			},
			Run: func(ctx *cli.Context) error {
				from, to := ctx.GetString("root"), ctx.GetString("target")
				if from == "" || to == "" {
					return errors.New("请明确指定 --root 与 --target")
				}
				result, err := nativeupgrade.RenameInstance(ctx.Context, action.name, from, to, a.rebindRenamedInstance)
				if err != nil {
					return err
				}
				return json.NewEncoder(ctx.Stdout).Encode(result)
			},
		})
	}
	return []cli.CommandSpec{rename}, nil
}

func (a *Application) rebindRenamedInstance(ctx context.Context, source, target string, offline bool) (func(string) error, func() error, error) {
	from := *a
	from.config.ConfigPath = filepath.Join(source, filepath.Base(a.config.ConfigPath))
	snapshot, err := from.loadInstanceConfiguration(ctx)
	if err != nil {
		return nil, nil, err
	}
	var storage storageapp.Config
	if err := snapshot.DecodeSection(storageapp.ConfigPath, &storage); err != nil {
		return nil, nil, err
	}
	fileConfig, err := filesconfig.Decode(snapshot)
	if err != nil {
		return nil, nil, err
	}
	oldContent, newContent, err := instancePathPair(storage.Local.BasePath, source, target)
	if err != nil {
		return nil, nil, fmt.Errorf("内容位置: %w", err)
	}
	oldStaging, newStaging, err := instancePathPair(fileConfig.Transfers.StagingPath, source, target)
	if err != nil {
		return nil, nil, fmt.Errorf("上传暂存: %w", err)
	}
	storage.Local.BasePath = oldContent
	oldIdentity, err := filesStorageIdentity(storage)
	if err != nil {
		return nil, nil, err
	}
	storage.Local.BasePath = newContent
	newIdentity, err := filesStorageIdentity(storage)
	if err != nil {
		return nil, nil, err
	}

	db, err := databaseapp.Decode(snapshot)
	if err != nil {
		return nil, nil, err
	}
	cfg := db.PackageConfig()
	moveLocalDB := false
	if cfg.Driver == pkgdatabase.DriverSQLite {
		path, err := pkgdatabase.ConfiguredSQLitePath(cfg)
		if err != nil {
			return nil, nil, err
		}
		fromPath, toPath, err := instancePathPair(path, source, target)
		if err != nil {
			return nil, nil, fmt.Errorf("SQLite 位置: %w", err)
		}
		cfg.DSN = fromPath
		moveLocalDB = fromPath != toPath
	}
	if !moveLocalDB && (oldIdentity != newIdentity || oldStaging != newStaging) {
		return nil, nil, errors.New("数据库位于实例目录外时，内容和上传暂存也必须沿用原有外部路径")
	}

	if err := checkRenameBindings(ctx, cfg, oldIdentity, oldStaging); err != nil {
		return nil, nil, err
	}
	if !offline {
		return nil, nil, nil
	}
	lease, err := acquireManagedLease(ctx, cfg)
	if err != nil {
		return nil, nil, err
	}
	return func(staged string) error {
		if !moveLocalDB {
			return nil
		}
		config := cfg
		rel, err := filepath.Rel(source, config.DSN)
		if err != nil {
			return err
		}
		config.DSN = filepath.Join(staged, rel)
		stagingCopy := oldStaging
		if oldStaging != newStaging {
			rel, err := filepath.Rel(source, oldStaging)
			if err != nil {
				return err
			}
			stagingCopy = filepath.Join(staged, rel)
		}
		resource, err := pkgdatabase.OpenExistingGORM(ctx, &config)
		if err != nil {
			return err
		}
		err = files.RebindManagedPaths(ctx, resource.Client(), oldIdentity, newIdentity, oldStaging, stagingCopy, newStaging)
		return errors.Join(err, resource.Close())
	}, lease.close, nil
}

func checkRenameBindings(ctx context.Context, cfg pkgdatabase.Config, content, staging string) error {
	resource, err := pkgdatabase.OpenInspectionGORM(ctx, &cfg)
	if err != nil {
		return err
	}
	initialized, err := files.CheckManagedPaths(ctx, resource.Client(), content, staging)
	if err == nil && !initialized {
		err = errors.New("实例尚未建立可迁移的内容存储和暂存记录")
	}
	return errors.Join(err, resource.Close())
}

func instancePathPair(path, from, to string) (string, string, error) {
	if filepath.IsAbs(path) {
		path = filepath.Clean(path)
		if rel, err := filepath.Rel(from, path); err == nil && filepath.IsLocal(rel) {
			return "", "", errors.New("实例内绝对路径需先改为等效相对路径")
		}
		return path, path, nil
	}
	if !filepath.IsLocal(path) || filepath.Clean(path) == "." {
		return "", "", errors.New("请选择实例内相对路径或明确的外部绝对路径")
	}
	return filepath.Join(from, path), filepath.Join(to, path), nil
}
