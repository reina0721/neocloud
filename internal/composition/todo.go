package composition

import (
	"context"
	"fmt"
	executionapp "github.com/reina0721/neocloud/internal/kernel/app/execution"
	"github.com/reina0721/neocloud/internal/module/auth"
	authmodel "github.com/reina0721/neocloud/internal/module/auth/model"
	"github.com/reina0721/neocloud/internal/module/todo"
	configbinding "github.com/reina0721/neocloud/internal/module/todo/binding/config"
	"github.com/reina0721/neocloud/internal/module/todo/model"
	"github.com/reina0721/neocloud/internal/module/todo/service"
	"github.com/reina0721/neocloud/pkg/clock"
	pkgexecution "github.com/reina0721/neocloud/pkg/execution"
	"github.com/reina0721/neocloud/pkg/idgen"
	"github.com/reina0721/neocloud/pkg/supervisor"
)

func (a *Application) executeTodo(ctx context.Context, actor service.Actor, operation func(context.Context, service.UseCases) error) (resultErr error) {
	if operation == nil {
		return fmt.Errorf("todo application operation is nil")
	}
	snapshot, err := a.loadInstanceConfiguration(ctx)
	if err != nil {
		return err
	}
	todoConfig, err := configbinding.Decode(snapshot)
	if err != nil {
		return err
	}
	database, err := a.openInstanceDatabase(ctx, snapshot)
	if err != nil {
		return err
	}
	defer closeInstanceComponent(ctx, database.close, &resultErr)
	execution, err := startImmutableExecution(ctx, snapshot, a.config.Logging)
	if err != nil {
		return err
	}
	defer closeInstanceComponent(ctx, execution.close, &resultErr)
	databaseAccess, err := adaptDatabaseAccess(database.output)
	if err != nil {
		return err
	}
	currentClock := clock.System()
	authModule, err := auth.NewLocal(auth.Dependencies{
		Clock: currentClock, Logger: a.config.Logging.Logger(), Policies: a.blueprint.policyCopy(),
	})
	if err != nil {
		return fmt.Errorf("compose local auth module: %w", err)
	}
	authorizer, err := newTodoAuthorizerAdapter(authModule.Service)
	if err != nil {
		return err
	}
	module, err := todo.New(todo.Dependencies{
		Database: databaseAccess, Clock: currentClock, IDGenerator: idgen.UUID(),
		Config: todoConfig, Authorizer: authorizer, Executor: todoExecutionAdapter(execution.output),
	})
	if err != nil {
		return fmt.Errorf("compose todo module: %w", err)
	}
	owner, err := newTodoOperationSupervisor(module.Contribution.Participants)
	if err != nil {
		return fmt.Errorf("create todo operation supervisor: %w", err)
	}
	return owner.RunOperation(ctx, func(operationCtx context.Context) error {
		scopes := make([]authmodel.Scope, len(actor.Scopes))
		for index, scope := range actor.Scopes {
			scopes[index] = authmodel.Scope(scope)
		}
		principal, err := authModule.Service.LocalPrincipal(operationCtx, actor.Subject, scopes)
		if err != nil {
			return fmt.Errorf("construct Todo CLI actor: %w", err)
		}
		return operation(authmodel.WithPrincipal(operationCtx, principal), module.Service)
	})
}
func newTodoOperationSupervisor(participants []supervisor.Participant) (*supervisor.Supervisor, error) {
	return supervisor.New(supervisor.Config{}, participants...)
}

// todoExecutionAdapter 把底层 execution 能力（Capabilities.Execution）适配为 Todo Service 的窄 port。
// 使用已配置的默认执行策略，幂等键透传；重复完成（Duplicate）不重跑写操作。
func todoExecutionAdapter(access executionapp.Access) service.Executor {
	return func(ctx context.Context, key string, operation func(context.Context) (model.Todo, error)) (saved model.Todo, duplicate bool, err error) {
		result, execErr := access.Execute(ctx, pkgexecution.Execution{
			Key: pkgexecution.Key(key),
			Operation: func(operationCtx context.Context) (any, error) {
				value, opErr := operation(operationCtx)
				if opErr == nil {
					saved = value
				}
				return value, opErr
			},
		})
		if execErr != nil {
			return model.Todo{}, false, execErr
		}
		if result.Duplicate {
			return model.Todo{}, true, nil
		}
		return saved, false, nil
	}
}

type todoExecutor struct{ application *Application }

func (e todoExecutor) Create(ctx context.Context, command service.CreateCommand) (model.Todo, error) {
	var result model.Todo
	err := e.application.executeTodo(ctx, command.Actor, func(operationCtx context.Context, useCases service.UseCases) error {
		var err error
		result, err = useCases.Create(operationCtx, command)
		return err
	})
	return result, err
}

func (e todoExecutor) Get(ctx context.Context, query service.GetQuery) (model.Todo, error) {
	var result model.Todo
	err := e.application.executeTodo(ctx, query.Actor, func(operationCtx context.Context, useCases service.UseCases) error {
		var err error
		result, err = useCases.Get(operationCtx, query)
		return err
	})
	return result, err
}

func (e todoExecutor) List(ctx context.Context, query service.ListQuery) (service.ListResult, error) {
	var result service.ListResult
	err := e.application.executeTodo(ctx, query.Actor, func(operationCtx context.Context, useCases service.UseCases) error {
		var err error
		result, err = useCases.List(operationCtx, query)
		return err
	})
	return result, err
}

func (e todoExecutor) Complete(ctx context.Context, command service.CompleteCommand) (model.Todo, error) {
	var result model.Todo
	err := e.application.executeTodo(ctx, command.Actor, func(operationCtx context.Context, useCases service.UseCases) error {
		var err error
		result, err = useCases.Complete(operationCtx, command)
		return err
	})
	return result, err
}
