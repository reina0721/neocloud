package composition

import (
	"context"
	"fmt"
	"reflect"

	"github.com/reina0721/neocloud/internal/kernel/app"
	composed "github.com/reina0721/neocloud/internal/kernel/composition"
	"github.com/reina0721/neocloud/internal/kernel/config"
	authconfig "github.com/reina0721/neocloud/internal/module/auth/binding/config"
	"github.com/reina0721/neocloud/internal/module/console"
	filesconfig "github.com/reina0721/neocloud/internal/module/files/binding/config"
	iamconfig "github.com/reina0721/neocloud/internal/module/iam/binding/config"
	migrationconfig "github.com/reina0721/neocloud/internal/module/migration/binding/config"
	opsconfig "github.com/reina0721/neocloud/internal/module/ops/binding/config"
	todoconfig "github.com/reina0721/neocloud/internal/module/todo/binding/config"
)

// DefaultEnvironmentPrefix 是正式进程选取配置覆盖值的环境变量前缀。
const DefaultEnvironmentPrefix = "NEOCLOUD_APP_"

const legacyEnvironmentPrefix = "APP_"

// configurationSource 统一服务与单次命令的实例选择、配置合并顺序和校验规则。
func (a *Application) configurationSource() (*config.Loader, []config.Binding, error) {
	bindings, err := composed.ConfigurationBindings(applicationOwnedConfigurationBindings()...)
	if err != nil {
		return nil, nil, fmt.Errorf("compose instance configuration bindings: %w", err)
	}
	prefix := a.config.EnvironmentPrefix
	var aliases []string
	if prefix == DefaultEnvironmentPrefix {
		aliases = []string{legacyEnvironmentPrefix}
	}
	return config.New(config.FileSource(a.config.ConfigPath), config.EnvSource(prefix, aliases...)), bindings, nil
}

// requireReloadableConfiguration 在创建候选之前保护持久化身份与进程级资源。
func requireReloadableConfiguration(previous, next config.Snapshot) error {
	var changed []app.ID
	for _, section := range []string{"database", "storage", "iam", "auth", "files", "scheduler", "messaging", "http.addr", "management.addr"} {
		before, _ := previous.Value(section)
		after, _ := next.Value(section)
		if !reflect.DeepEqual(before, after) {
			changed = append(changed, app.ID(section))
		}
	}
	if len(changed) != 0 {
		return &app.RestartRequiredError{Components: changed}
	}
	return nil
}

func (a *Application) loadInstanceConfiguration(ctx context.Context) (config.Snapshot, error) {
	loader, bindings, err := a.configurationSource()
	if err != nil {
		return config.Snapshot{}, err
	}
	snapshot, err := loader.Load(ctx)
	if err != nil {
		return config.Snapshot{}, fmt.Errorf("load instance configuration: %w", err)
	}
	if err := config.ValidateCandidate(snapshot, bindings...); err != nil {
		return config.Snapshot{}, fmt.Errorf("validate instance configuration: %w", err)
	}
	return snapshot, nil
}

// applicationOwnedConfigurationBindings 返回统一正式配置中由应用模块拥有的 section。
// Bootstrap、Service 与 one-shot CLI 必须调用本函数，避免各入口复制集合后发生漂移。
func applicationOwnedConfigurationBindings() []config.Binding {
	return []config.Binding{
		authconfig.Binding(),
		console.Binding(),
		filesconfig.Binding(),
		iamconfig.Binding(),
		migrationconfig.Binding(),
		todoconfig.Binding(),
		opsconfig.Binding(),
		composed.ObservabilityConfiguration(),
		composed.AlertingConfiguration(),
	}
}
