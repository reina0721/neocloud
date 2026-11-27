package composition

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/reina0721/neocloud/internal/deployment"
	"github.com/reina0721/neocloud/internal/kernel"
	kernelalerting "github.com/reina0721/neocloud/internal/kernel/app/alerting"
	cacheapp "github.com/reina0721/neocloud/internal/kernel/app/cache"
	databaseapp "github.com/reina0721/neocloud/internal/kernel/app/database"
	executionapp "github.com/reina0721/neocloud/internal/kernel/app/execution"
	messagingapp "github.com/reina0721/neocloud/internal/kernel/app/messaging"
	rabbitmqapp "github.com/reina0721/neocloud/internal/kernel/app/messaging/rabbitmq"
	scheduleapp "github.com/reina0721/neocloud/internal/kernel/app/schedule"
	storageapp "github.com/reina0721/neocloud/internal/kernel/app/storage"
	kernelcomposition "github.com/reina0721/neocloud/internal/kernel/composition"
	"github.com/reina0721/neocloud/internal/kernel/config"
	kernellogging "github.com/reina0721/neocloud/internal/kernel/logging"
	"github.com/reina0721/neocloud/internal/module"
	"github.com/reina0721/neocloud/internal/module/auth"
	authconfig "github.com/reina0721/neocloud/internal/module/auth/binding/config"
	authhttp "github.com/reina0721/neocloud/internal/module/auth/binding/http"
	"github.com/reina0721/neocloud/internal/module/console"
	"github.com/reina0721/neocloud/internal/module/files"
	filesconfig "github.com/reina0721/neocloud/internal/module/files/binding/config"
	fileshttp "github.com/reina0721/neocloud/internal/module/files/binding/http"
	fileswebdav "github.com/reina0721/neocloud/internal/module/files/binding/webdav"
	"github.com/reina0721/neocloud/internal/module/iam"
	iamconfig "github.com/reina0721/neocloud/internal/module/iam/binding/config"
	iamhttp "github.com/reina0721/neocloud/internal/module/iam/binding/http"
	"github.com/reina0721/neocloud/internal/module/navigation"
	"github.com/reina0721/neocloud/internal/module/navigation/binding/consolecatalog"
	navigationhttp "github.com/reina0721/neocloud/internal/module/navigation/binding/http"
	"github.com/reina0721/neocloud/internal/module/ops"
	opsconfig "github.com/reina0721/neocloud/internal/module/ops/binding/config"
	opsmodel "github.com/reina0721/neocloud/internal/module/ops/model"
	"github.com/reina0721/neocloud/internal/module/organization"
	organizationhttp "github.com/reina0721/neocloud/internal/module/organization/binding/http"
	"github.com/reina0721/neocloud/internal/module/todo"
	configbinding "github.com/reina0721/neocloud/internal/module/todo/binding/config"
	todohttp "github.com/reina0721/neocloud/internal/module/todo/binding/http"
	httptransport "github.com/reina0721/neocloud/internal/transport/http"
	pkgalerting "github.com/reina0721/neocloud/pkg/alerting"
	"github.com/reina0721/neocloud/pkg/clock"
	"github.com/reina0721/neocloud/pkg/httpx"
	"github.com/reina0721/neocloud/pkg/i18n"
	"github.com/reina0721/neocloud/pkg/idgen"
	"github.com/reina0721/neocloud/pkg/logger"
	pkgobservability "github.com/reina0721/neocloud/pkg/observability"
	pkgschedule "github.com/reina0721/neocloud/pkg/schedule"
	"github.com/reina0721/neocloud/pkg/supervisor"
	"github.com/reina0721/neocloud/pkg/validation"
)

type applicationGenerationFactory struct {
	logging         *kernellogging.Manager
	blueprint       *applicationBlueprint
	hub             *httpx.ListenerHub
	managementHub   *httpx.ListenerHub
	scheduleHub     *scheduleapp.Hub
	messagingHub    *messagingapp.Hub
	opsRuntime      *opsRuntimeSource
	applicationName string

	loggerPool    *resourcePool[logger.Logger]
	databasePool  *resourcePool[databaseapp.Access]
	cachePool     *resourcePool[cacheapp.Access]
	i18nPool      *resourcePool[i18n.Translator]
	storagePool   *resourcePool[storageapp.Access]
	executionPool *resourcePool[executionapp.Access]
	metricsPool   *resourcePool[pkgobservability.Metrics]

	nextID    atomic.Uint64
	failures  chan error
	currentMu sync.RWMutex
	current   *applicationGeneration
	build     opsmodel.BuildInfo
	managed   *managedService
}

type applicationGeneration struct {
	factory   *applicationGenerationFactory
	blueprint *applicationBlueprint
	id        uint64
	snapshot  config.Snapshot

	logger    *resourceHandle[logger.Logger]
	database  *resourceHandle[databaseapp.Access]
	cache     *resourceHandle[cacheapp.Access]
	i18n      *resourceHandle[i18n.Translator]
	storage   *resourceHandle[storageapp.Access]
	execution *resourceHandle[executionapp.Access]
	metrics   *resourceHandle[pkgobservability.Metrics]
	telemetry *immutableComponent[pkgobservability.Telemetry]
	alerting  *immutableComponent[pkgalerting.Notifier]
	scheduler *immutableComponent[scheduleapp.Access]
	messaging *immutableComponent[messagingapp.Output]

	module              todo.HTTPModule
	authModule          auth.Module
	iamModule           iam.HTTPModule
	organizationModule  organization.HTTPModule
	navigationModule    navigation.HTTPModule
	opsModule           ops.Module
	participants        []supervisor.Participant
	pendingParticipants []supervisor.Participant
	route               *httpx.PreparedRoute
	routePublished      bool
	server              *httpx.Server
	runDone             chan struct{}
	runErr              error
	managementRoute     *httpx.PreparedRoute
	managementServer    *httpx.Server
	managementRunDone   chan struct{}
	managementRunErr    error

	activeRequests      atomic.Int64
	resourceStats       kernel.GenerationResourceStats
	stopping            atomic.Bool
	settleMu            sync.Mutex
	participantStopDone bool
	participantStopErr  error
	mu                  sync.Mutex
	committed           bool
	current             bool
	settled             bool
	terminalErr         error
}

func newApplicationGenerationFactory(logging *kernellogging.Manager, applicationName string, provided ...*applicationBlueprint) (*applicationGenerationFactory, error) {
	if logging == nil {
		return nil, fmt.Errorf("application generation logging manager is nil")
	}
	if applicationName == "" {
		return nil, fmt.Errorf("application generation application name is empty")
	}
	var blueprint *applicationBlueprint
	if len(provided) > 1 {
		return nil, fmt.Errorf("application generation accepts at most one blueprint")
	}
	if len(provided) == 1 {
		blueprint = provided[0]
	}
	if blueprint == nil {
		var err error
		blueprint, err = newApplicationBlueprint()
		if err != nil {
			return nil, err
		}
	}
	hub, err := httpx.NewListenerHub(0)
	if err != nil {
		return nil, err
	}
	managementHub, err := httpx.NewListenerHub(0)
	if err != nil {
		return nil, err
	}
	factory := &applicationGenerationFactory{
		logging: logging, blueprint: blueprint, hub: hub, managementHub: managementHub,
		scheduleHub: scheduleapp.NewHub(), messagingHub: messagingapp.NewHub(), applicationName: applicationName,
		build:         opsmodel.BuildInfo{Version: "test", Commit: "unknown", BuildTime: "unknown", GoVersion: runtime.Version(), Dirty: true},
		loggerPool:    newResourcePool[logger.Logger]("logger"),
		databasePool:  newResourcePool[databaseapp.Access]("database"),
		cachePool:     newResourcePool[cacheapp.Access]("cache"),
		i18nPool:      newResourcePool[i18n.Translator]("i18n"),
		storagePool:   newResourcePool[storageapp.Access]("storage"),
		executionPool: newResourcePool[executionapp.Access]("execution"),
		metricsPool:   newResourcePool[pkgobservability.Metrics]("observability.metrics"),
		failures:      make(chan error, 8),
	}
	factory.opsRuntime = &opsRuntimeSource{}
	return factory, nil
}

func (f *applicationGenerationFactory) Prepare(
	ctx context.Context,
	snapshot config.Snapshot,
	previous kernel.ActiveGeneration,
) (kernel.PreparedGeneration, error) {
	if ctx == nil {
		return nil, fmt.Errorf("application generation prepare context is nil")
	}
	if f.managed != nil {
		if err := f.managed.checkSnapshot(snapshot, previous == nil); err != nil {
			return nil, err
		}
	}
	if previous != nil {
		if err := requireReloadableConfiguration(previous.Snapshot(), snapshot); err != nil {
			return nil, err
		}
	}
	generation := &applicationGeneration{
		factory: f, blueprint: f.blueprint, id: f.nextID.Add(1), snapshot: snapshot, runDone: make(chan struct{}), managementRunDone: make(chan struct{}),
	}
	abort := func(cause error) (kernel.PreparedGeneration, error) {
		cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), kernel.DefaultReloadTimeout)
		defer cancel()
		cleanupErr := generation.abort(cleanupCtx)
		return nil, errors.Join(cause, cleanupErr)
	}

	loggerDigest, err := snapshot.SectionDigest("logger")
	if err != nil {
		return abort(err)
	}
	var reused bool
	generation.logger, reused, err = f.loggerPool.acquire(ctx, loggerDigest, func(ctx context.Context) (logger.Logger, func(context.Context) error, error) {
		component, buildErr := startImmutableLogger(ctx, snapshot, f.logging)
		if buildErr != nil {
			return nil, nil, buildErr
		}
		return component.output, component.close, nil
	})
	if err != nil {
		return abort(err)
	}
	generation.recordResource("logger", reused)

	databaseDigest, err := snapshot.SectionDigest("database")
	if err != nil {
		return abort(err)
	}
	generation.database, reused, err = f.databasePool.acquire(ctx, databaseDigest, func(ctx context.Context) (databaseapp.Access, func(context.Context) error, error) {
		definition, buildErr := databaseDefinition()
		if buildErr != nil {
			return nil, nil, buildErr
		}
		component, buildErr := startImmutableComponent(ctx, snapshot, f.logging, definition)
		if buildErr != nil {
			return nil, nil, buildErr
		}
		return component.output, component.close, nil
	})
	if err != nil {
		return abort(err)
	}
	generation.recordResource("database", reused)

	cacheDigest, err := snapshot.SectionDigest("cache")
	if err != nil {
		return abort(err)
	}
	generation.cache, reused, err = f.cachePool.acquire(ctx, cacheDigest, func(ctx context.Context) (cacheapp.Access, func(context.Context) error, error) {
		definition, buildErr := cacheDefinition()
		if buildErr != nil {
			return nil, nil, buildErr
		}
		component, buildErr := startImmutableComponent(ctx, snapshot, f.logging, definition)
		if buildErr != nil {
			return nil, nil, buildErr
		}
		return component.output, component.close, nil
	})
	if err != nil {
		return abort(err)
	}
	generation.recordResource("cache", reused)

	i18nDigest, err := snapshot.SectionDigest("i18n")
	if err != nil {
		return abort(err)
	}
	generation.i18n, reused, err = f.i18nPool.acquire(ctx, i18nDigest, func(ctx context.Context) (i18n.Translator, func(context.Context) error, error) {
		definition, buildErr := i18nDefinition()
		if buildErr != nil {
			return nil, nil, buildErr
		}
		component, buildErr := startImmutableComponent(ctx, snapshot, f.logging, definition)
		if buildErr != nil {
			return nil, nil, buildErr
		}
		return component.output, component.close, nil
	})
	if err != nil {
		return abort(err)
	}
	generation.recordResource("i18n", reused)

	storageDigest, err := snapshot.SectionDigest("storage")
	if err != nil {
		return abort(err)
	}
	generation.storage, reused, err = f.storagePool.acquire(ctx, storageDigest, func(ctx context.Context) (storageapp.Access, func(context.Context) error, error) {
		definition, buildErr := storageDefinition()
		if buildErr != nil {
			return nil, nil, buildErr
		}
		component, buildErr := startImmutableComponent(ctx, snapshot, f.logging, definition)
		if buildErr != nil {
			return nil, nil, buildErr
		}
		return component.output, component.close, nil
	})
	if err != nil {
		return abort(err)
	}
	generation.recordResource("storage", reused)

	generation.metrics, reused, err = f.metricsPool.acquire(ctx, "process", func(ctx context.Context) (pkgobservability.Metrics, func(context.Context) error, error) {
		definition, buildErr := kernelcomposition.ObservabilityMetricsDefinition()
		if buildErr != nil {
			return nil, nil, buildErr
		}
		component, buildErr := startFixedComponent(ctx, f.logging, definition)
		if buildErr != nil {
			return nil, nil, buildErr
		}
		return component.output, component.close, nil
	})
	if err != nil {
		return abort(err)
	}
	generation.recordResource("observability.metrics", reused)
	telemetryDefinition, err := kernelcomposition.ObservabilityTelemetryDefinition(generation.metrics.value())
	if err != nil {
		return abort(err)
	}
	generation.telemetry, err = startImmutableComponent(ctx, snapshot, f.logging, telemetryDefinition)
	if err != nil {
		return abort(err)
	}
	generation.resourceStats.Built = append(generation.resourceStats.Built, "observability.telemetry")
	alertingDefinition, err := kernelcomposition.AlertingDefinition(kernelalerting.Dependencies{Logger: generation.logger.value()})
	if err != nil {
		return abort(err)
	}
	generation.alerting, err = startImmutableComponent(ctx, snapshot, f.logging, alertingDefinition)
	if err != nil {
		return abort(err)
	}
	generation.resourceStats.Built = append(generation.resourceStats.Built, "application.alerting")

	authConfig, err := authconfig.Decode(snapshot)
	if err != nil {
		return abort(err)
	}
	httpConfig, err := kernelcomposition.HTTPServerConfig(snapshot)
	if err != nil {
		return abort(err)
	}
	databaseAccess, err := adaptDatabaseAccess(generation.database.value())
	if err != nil {
		return abort(err)
	}
	databaseConfig, err := databaseapp.Decode(snapshot)
	if err != nil {
		return abort(err)
	}
	if err := f.verifyMigration(ctx, snapshot, databaseConfig); err != nil {
		return abort(fmt.Errorf("verify application migration compatibility: %w", err))
	}
	iamConfig, err := iamconfig.Decode(snapshot)
	if err != nil {
		return abort(err)
	}
	identity, err := composeIdentityAccess(ctx, identityAccessInput{
		Database: databaseAccess, Logger: generation.logger.value(),
		IAMConfig: iamConfig, AuthConfig: authConfig,
		Permissions: generation.blueprint.permissions, Policies: generation.blueprint.policyCopy(),
		AllowedOrigins:  httpConfig.CORS.AllowedOrigins,
		ReconcileOwners: previous == nil && f.managed == nil,
		AlertNotifier:   generation.alerting.output,
	})
	if err != nil {
		return abort(err)
	}
	generation.iamModule = identity.IAM
	generation.authModule = identity.Auth
	operationGate := identity.OperationGate
	mutationGuard := identity.MutationGuard

	generation.organizationModule, err = organization.NewHTTP(organization.Dependencies{Database: databaseAccess, Clock: clock.System(), IDGenerator: idgen.UUID(), AccountDirectory: identity.AccountDirectory})
	if err != nil {
		return abort(err)
	}
	generation.organizationModule.Service.WithOperationAudit(organizationOperationAuditAdapter{writer: identity.Auth.OperationAudit})
	navigationCatalog, err := consolecatalog.New()
	if err != nil {
		return abort(err)
	}
	generation.navigationModule, err = navigation.NewHTTP(navigation.Dependencies{Database: databaseAccess, Clock: clock.System(), Catalog: navigationCatalog})
	if err != nil {
		return abort(err)
	}
	generation.navigationModule.Service.WithOperationAudit(navigationOperationAuditAdapter{writer: identity.Auth.OperationAudit})
	authorizer, err := newTodoAuthorizerAdapter(generation.authModule.Service)
	if err != nil {
		return abort(err)
	}

	todoConfig, err := configbinding.Decode(snapshot)
	if err != nil {
		return abort(err)
	}
	if err := generation.navigationModule.Service.Compatible(ctx); err != nil {
		return abort(fmt.Errorf("verify navigation catalog compatibility: %w", err))
	}

	executionDigest, err := snapshot.SectionDigest("execution")
	if err != nil {
		return abort(err)
	}
	generation.execution, reused, err = f.executionPool.acquire(ctx, executionDigest, func(ctx context.Context) (executionapp.Access, func(context.Context) error, error) {
		component, buildErr := startImmutableExecution(ctx, snapshot, f.logging)
		if buildErr != nil {
			return nil, nil, buildErr
		}
		return component.output, component.close, nil
	})
	if err != nil {
		return abort(err)
	}
	generation.recordResource("execution", reused)

	messagingDefinition, err := messagingapp.Definition(messagingapp.Dependencies{
		Generation: generation.id, Logger: generation.logger.value(), Clock: clock.System(),
		Execution: generation.execution.value(), ExecutionHealth: generation.execution.value().Health,
		Telemetry: generation.telemetry.output,
		Factories: []messagingapp.Factory{rabbitmqapp.Factory()},
		Admit:     f.workAdmission(),
	})
	if err != nil {
		return abort(fmt.Errorf("define messaging app: %w", err))
	}
	generation.messaging, err = startImmutableComponent(ctx, snapshot, f.logging, messagingDefinition)
	if err != nil {
		return abort(fmt.Errorf("start messaging candidate: %w", err))
	}
	generation.resourceStats.Built = append(generation.resourceStats.Built, "messaging")

	generation.module, err = todo.NewHTTP(todo.HTTPDependencies{
		Dependencies: todo.Dependencies{
			Database: databaseAccess, Clock: clock.System(), IDGenerator: idgen.UUID(),
			Config: todoConfig, Authorizer: authorizer,
			Executor: todoExecutionAdapter(generation.execution.value()),
		},
		Translator: generation.i18n.value(), Actors: todoActorAccessAdapter{},
	})
	if err != nil {
		return abort(err)
	}
	generation.resourceStats.Built = append(generation.resourceStats.Built, "todo")

	opsConfig, err := opsconfig.Decode(snapshot)
	if err != nil {
		return abort(err)
	}
	if authConfig.Mode == authconfig.ModeDevelopmentAnonymous && !opsconfig.ManagementIsLoopback(opsConfig.Management.Addr) {
		return abort(fmt.Errorf("development anonymous auth requires loopback management HTTP"))
	}
	if f.managed != nil {
		httpConfig.Addr = managedPrivateAddress
		opsConfig.Management.Addr = managedPrivateAddress
	}
	generation.opsModule, err = ops.New(ctx, ops.Dependencies{
		Runtime: generationOpsSource{process: f.opsRuntime, generation: generation}, Build: f.build, Config: opsConfig,
		Logger:        generation.logger.value(),
		Observability: pkgobservability.Capabilities{Metrics: generation.metrics.value(), Telemetry: generation.telemetry.output},
		Access:        opsAccessAdapter{auth: generation.authModule}, Operations: generation.blueprint.operationCopy(),
	})
	if err != nil {
		return abort(err)
	}

	consoleConfig, err := console.Decode(snapshot)
	if err != nil {
		return abort(err)
	}
	filesPolicy, err := filesconfig.Decode(snapshot)
	if err != nil {
		return abort(err)
	}
	var storageConfig storageapp.Config
	if err := snapshot.DecodeSection(storageapp.ConfigPath, &storageConfig); err != nil {
		return abort(err)
	}
	storageIdentity, err := filesStorageIdentity(storageConfig)
	if err != nil {
		return abort(err)
	}
	storageBackend, err := filesStorageBackend(storageConfig.Driver)
	if err != nil {
		return abort(err)
	}
	filesSession, err := newIAMSessionAuthAdapter(generation.iamModule.Sessions, generation.iamModule.SessionCookieName())
	if err != nil {
		return abort(err)
	}
	filesModule, err := files.PrepareRuntime(ctx, filesPolicy, files.RuntimeDependencies{
		Database: databaseAccess, StorageIdentity: storageIdentity, StorageBackend: storageBackend,
		Content:        filesContentAdapter{access: generation.storage.value()},
		Authority:      filesConnectionAuthority{access: generation.iamModule.AccountAuthorization, audience: generation.iamModule.Collaboration},
		Authentication: fileOptionalSessionAuth{session: filesSession},
		Actors:         filesActorAdapter{}, Passwords: iam.NewCredentialDigests(), Clock: clock.System(), IDs: idgen.UUID(),
		Logger: generation.logger.value(), PublicOrigins: httpConfig.CORS.AllowedOrigins,
		TaskEnabled: func(id pkgschedule.TaskID) (bool, error) { return scheduleapp.TaskConfiguredEnabled(snapshot, id) },
	}, previous == nil && (f.managed == nil || f.managed.initializeStorage))
	if err != nil {
		return abort(err)
	}
	filesHandler := filesModule.Handler
	contributions := []module.Contribution{generation.authModule.Contribution, generation.iamModule.Contribution, generation.organizationModule.Contribution, generation.navigationModule.Contribution, generation.module.Contribution, generation.opsModule.Contribution, filesModule.Contribution}
	if err := module.ValidateContributions(contributions...); err != nil {
		return abort(fmt.Errorf("validate application module contributions: %w", err))
	}
	messages, err := module.MessageBindings(contributions...)
	if err != nil {
		return abort(fmt.Errorf("collect application module messages: %w", err))
	}
	if err := generation.messaging.output.Control.Freeze(messages); err != nil {
		return abort(fmt.Errorf("freeze messaging candidate: %w", err))
	}
	apiRoutes, err := httptransport.NewRouteBinding(operationGate,
		fileshttp.HumaRegistration(filesHandler, mutationGuard),
		authhttp.HumaRegistration(generation.authModule.AuditHandler),
		iamhttp.HumaRegistration(generation.iamModule.Handler),
		todohttp.HumaRegistration(generation.module.Operations),
		organizationhttp.HumaRegistration(generation.organizationModule.Operations, mutationGuard),
		navigationhttp.HumaRegistration(generation.navigationModule.Operations, mutationGuard),
	)
	if err != nil {
		return abort(err)
	}
	consoleHandler, err := console.New(console.Dependencies{
		Runtime: generation.consoleRuntime, DeploymentOwner: (consoleIAMPort{generation.iamModule.Service}).deploymentOwner,
		IAM: consoleIAMPort{generation.iamModule.Service}, CookieName: generation.iamModule.SessionCookieName(),
		Cookies: generation.iamModule.Cookies,
		Native:  httptransport.IsolatedRoutes(apiRoutes), Origins: httpConfig.CORS.AllowedOrigins, SiteOrigins: consoleConfig.SiteOrigins,
		Database: databaseAccess, Logger: generation.logger.value(), Relay: consoleConfig.Relay, Executor: generation.execution.value(),
		Authenticate: consoleAuthenticate(generation.authModule.SessionSource.AuthenticateRequest), Todos: consoleTodoPort{generation.module.Operations},
		Navigation: consoleNavigationPort{generation.navigationModule.Operations}, ReleaseCatalog: http.HandlerFunc(deployment.NewReleases().ServeReleaseCatalog),
	})
	if err != nil {
		return abort(err)
	}
	nativeRoutes := apiRoutes
	apiRoutes = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, console.Prefix+"/") || r.URL.Path == console.ReleaseCatalogPath {
			consoleHandler.ServeHTTP(w, r)
			return
		}
		nativeRoutes.ServeHTTP(w, r)
	})
	schedules, err := module.ScheduleBindings(contributions...)
	if err != nil {
		return abort(fmt.Errorf("collect application module schedules: %w", err))
	}
	consoleBinding, err := consoleHandler.ScheduleBinding()
	if err != nil {
		return abort(err)
	}
	schedules = append(schedules, consoleBinding)
	coordinationManager, err := cacheapp.Coordination(generation.cache.value())
	if err != nil {
		return abort(fmt.Errorf("compose scheduler coordination: %w", err))
	}
	schedulerDefinition, err := scheduleapp.Definition(scheduleapp.Dependencies{
		ApplicationName: schedulerApplicationIdentity(f.applicationName), Generation: generation.id,
		Logger: generation.logger.value(), Clock: clock.System(), Execution: generation.execution.value(), Coordination: coordinationManager,
		Telemetry: generation.telemetry.output, Bindings: schedules,
		ReportFailure: generation.reportScheduleFailure,
		Admit:         f.workAdmission(),
	})
	if err != nil {
		return abort(fmt.Errorf("define scheduler app: %w", err))
	}
	generation.scheduler, err = startImmutableComponent(ctx, snapshot, f.logging, schedulerDefinition)
	if err != nil {
		return abort(fmt.Errorf("start scheduler candidate: %w", err))
	}
	generation.resourceStats.Built = append(generation.resourceStats.Built, "scheduler")
	generation.resourceStats.Built = append(generation.resourceStats.Built, "auth")
	generation.resourceStats.Built = append(generation.resourceStats.Built, "iam")
	generation.resourceStats.Built = append(generation.resourceStats.Built, "organization")
	generation.resourceStats.Built = append(generation.resourceStats.Built, "navigation")
	generation.resourceStats.Built = append(generation.resourceStats.Built, "ops")
	for _, contribution := range contributions {
		generation.pendingParticipants = append(generation.pendingParticipants, contribution.Participants...)
		if f.managed != nil && !f.managed.published.Load() && contribution.ID == generation.authModule.Contribution.ID {
			// JWKS fetching is part of private readiness; it does not mutate the
			// database or admit user requests.
			if err := generation.startParticipants(ctx); err != nil {
				return abort(err)
			}
		}
	}
	if f.managed == nil || f.managed.published.Load() {
		if err := generation.startParticipants(ctx); err != nil {
			return abort(err)
		}
	}

	transferRoutes, err := transferBudgetMatcher(f.blueprint.httpDefinitions, fileswebdav.Metadata().TransferRequest)
	if err != nil {
		return abort(err)
	}
	router, err := applicationRouter(kernelcomposition.Capabilities{
		Logger: generation.logger.value(), Clock: clock.System(), IDGenerator: idgen.UUID(), Validator: validation.New(),
		Database: generation.database.value(), Cache: generation.cache.value(),
		I18n: generation.i18n.value(), Storage: generation.storage.value(),
	}, httpConfig, apiRoutes, generation.opsModule.ManagementHTTP, transferRoutes, filesHandler.WebDAV)
	if err != nil {
		return abort(err)
	}
	observedAPIRouter := generation.opsModule.HTTPMiddleware(router)
	generation.route, err = f.hub.Prepare(ctx, httpConfig.Addr)
	if err != nil {
		return abort(err)
	}
	business := generation.trackRequests(observedAPIRouter)
	management := generation.opsModule.ManagementHTTP
	if f.managed != nil {
		ingress, err := newBrowserIngress(filesPolicy.Connections.PublicOrigin, httpConfig)
		if err != nil {
			return abort(err)
		}
		business = f.managed.handler(ingress.wrap(business), false)
		management = f.managed.handler(management, true)
	}
	generation.server, err = httpx.NewServer(&httpConfig, business)
	if err != nil {
		return abort(err)
	}
	generation.resourceStats.Built = append(generation.resourceStats.Built, "http")
	if err := generation.server.StartWithListener(ctx, generation.route.Listener()); err != nil {
		return abort(err)
	}
	// #nosec G118 -- generation 拥有 server、停止信号和 runDone，ctx 仅治理候选构造窗口。
	go generation.runServer()
	generation.managementRoute, err = f.managementHub.Prepare(ctx, generation.opsModule.Management.Addr)
	if err != nil {
		return abort(err)
	}
	generation.managementServer, err = httpx.NewServer(&generation.opsModule.Management, management)
	if err != nil {
		return abort(err)
	}
	if err := generation.managementServer.StartWithListener(ctx, generation.managementRoute.Listener()); err != nil {
		return abort(err)
	}
	// #nosec G118 -- management server 由同一 generation Stop/Wait 生命周期回收。
	go generation.runManagementServer()
	select {
	case <-ctx.Done():
		return abort(ctx.Err())
	case <-generation.server.Running():
		select {
		case <-ctx.Done():
			return abort(ctx.Err())
		case <-generation.managementServer.Running():
			return generation, nil
		case <-generation.managementRunDone:
			return abort(fmt.Errorf("candidate management HTTP server exited before ready: %w", generation.managementServerRunError()))
		}
	case <-generation.runDone:
		return abort(fmt.Errorf("candidate HTTP server exited before ready: %w", generation.serverRunError()))
	case <-generation.managementRunDone:
		return abort(fmt.Errorf("candidate management HTTP server exited before ready: %w", generation.managementServerRunError()))
	}
}

func (f *applicationGenerationFactory) Failures() <-chan error { return f.failures }

func (f *applicationGenerationFactory) workAdmission() func() (func(), bool) {
	if f.managed == nil {
		return nil
	}
	return f.managed.admitWork
}

func (f *applicationGenerationFactory) verifyMigration(ctx context.Context, snapshot config.Snapshot, databaseConfig databaseapp.Config) error {
	if f.managed != nil {
		return f.managed.application.CheckOnlineMigration(ctx, snapshot, f.managed.plan.Load())
	}
	service, err := applicationMigrationService(snapshot, databaseConfig.PackageConfig())
	if err != nil {
		return err
	}
	return service.Compatible(ctx)
}

func (f *applicationGenerationFactory) Stop(ctx context.Context) error {
	var joined error
	joined = errors.Join(joined, f.messagingHub.Stop(ctx))
	joined = errors.Join(joined, f.scheduleHub.Stop(ctx))
	joined = errors.Join(joined, f.hub.Stop(ctx))
	joined = errors.Join(joined, f.managementHub.Stop(ctx))
	remaining := map[string]int{
		"logger": f.loggerPool.remaining(), "database": f.databasePool.remaining(),
		"cache": f.cachePool.remaining(), "i18n": f.i18nPool.remaining(), "storage": f.storagePool.remaining(),
		"execution": f.executionPool.remaining(), "observability.metrics": f.metricsPool.remaining(),
	}
	for owner, count := range remaining {
		if count != 0 {
			joined = errors.Join(joined, fmt.Errorf("resource pool %s retains %d entries", owner, count))
		}
	}
	return joined
}

func (f *applicationGenerationFactory) currentGeneration() *applicationGeneration {
	f.currentMu.RLock()
	defer f.currentMu.RUnlock()
	return f.current
}

func (f *applicationGenerationFactory) setCurrent(generation *applicationGeneration) {
	f.currentMu.Lock()
	f.current = generation
	f.currentMu.Unlock()
}

func (f *applicationGenerationFactory) clearCurrent(generation *applicationGeneration) {
	f.currentMu.Lock()
	if f.current == generation {
		f.current = nil
	}
	f.currentMu.Unlock()
}

func (g *applicationGeneration) ID() uint64 { return g.id }

func (g *applicationGeneration) Snapshot() config.Snapshot { return g.snapshot }

func (g *applicationGeneration) ConfiguredAddress() string {
	if g.route == nil {
		return ""
	}
	return g.route.ConfiguredAddress()
}

func (g *applicationGeneration) BoundAddress() string {
	if g.route == nil || g.route.BoundAddress() == nil {
		return ""
	}
	return g.route.BoundAddress().String()
}

func (g *applicationGeneration) ManagementBoundAddress() string {
	if g.managementRoute == nil || g.managementRoute.BoundAddress() == nil {
		return ""
	}
	return g.managementRoute.BoundAddress().String()
}

func (g *applicationGeneration) ActiveRequests() int64 { return g.activeRequests.Load() }

func (g *applicationGeneration) ActiveConnections() int64 {
	if g.route == nil {
		return 0
	}
	return g.route.ActiveConnections()
}

func (g *applicationGeneration) ResourceStats() kernel.GenerationResourceStats {
	return kernel.GenerationResourceStats{
		Reused: append([]string(nil), g.resourceStats.Reused...),
		Built:  append([]string(nil), g.resourceStats.Built...),
	}
}

func (g *applicationGeneration) recordResource(owner string, reused bool) {
	if reused {
		g.resourceStats.Reused = append(g.resourceStats.Reused, owner)
		return
	}
	g.resourceStats.Built = append(g.resourceStats.Built, owner)
}

func (g *applicationGeneration) Commit(previous kernel.ActiveGeneration) (kernel.ActiveGeneration, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.committed || g.settled {
		return nil, fmt.Errorf("application generation %d is already settled", g.id)
	}
	var previousGeneration *applicationGeneration
	if previous != nil {
		var ok bool
		previousGeneration, ok = previous.(*applicationGeneration)
		if !ok || previousGeneration.factory != g.factory {
			return nil, fmt.Errorf("previous application generation is incompatible")
		}
	}
	var previousRoute *httpx.PreparedRoute
	var previousManagementRoute *httpx.PreparedRoute
	if previousGeneration != nil {
		previousRoute = previousGeneration.route
		previousManagementRoute = previousGeneration.managementRoute
	}
	if g.messaging == nil {
		return nil, fmt.Errorf("application generation %d messaging is missing", g.id)
	}
	if g.scheduler == nil {
		return nil, fmt.Errorf("application generation %d scheduler is missing", g.id)
	}
	ctx, cancel := context.WithTimeout(context.Background(), kernel.DefaultReloadTimeout)
	defer cancel()
	if g.factory.managed == nil || g.factory.managed.published.Load() {
		if err := g.openBackground(ctx); err != nil {
			return nil, err
		}
	}
	if _, err := g.factory.hub.Commit(g.route, previousRoute); err != nil {
		return nil, g.failPublication(err)
	}
	g.routePublished = true
	if _, err := g.factory.managementHub.Commit(g.managementRoute, previousManagementRoute); err != nil {
		return nil, g.failPublication(errors.Join(err, g.factory.hub.Retire(g.route)))
	}
	g.factory.logging.Replace(g.logger.value())
	g.committed = true
	g.current = true
	if previousGeneration != nil {
		previousGeneration.mu.Lock()
		previousGeneration.current = false
		previousGeneration.mu.Unlock()
	}
	g.factory.setCurrent(g)
	return g, nil
}

func (g *applicationGeneration) startParticipants(ctx context.Context) error {
	for _, participant := range g.pendingParticipants {
		if err := participant.Start(ctx); err != nil {
			return fmt.Errorf("start generation participant %s: %w", participant.Name(), err)
		}
		g.participants = append(g.participants, participant)
	}
	g.pendingParticipants = nil
	return nil
}

func (g *applicationGeneration) openBackground(ctx context.Context) error {
	if err := g.startParticipants(ctx); err != nil {
		return err
	}
	if err := g.messaging.output.Control.OpenPublisher(ctx); err != nil {
		return fmt.Errorf("open messaging publisher admission: %w", err)
	}
	if err := g.factory.messagingHub.Commit(ctx, g.messaging.output.Control); err != nil {
		return g.failPublication(err)
	}
	if err := g.factory.scheduleHub.Commit(ctx, g.scheduler.output); err != nil {
		return g.failPublication(err)
	}
	return nil
}

func (g *applicationGeneration) failPublication(err error) error {
	failure := fmt.Errorf("publish application generation %d: %w", g.id, errors.Join(kernel.ErrGenerationPublication, err))
	select {
	case g.factory.failures <- failure:
	default:
	}
	return failure
}

func (g *applicationGeneration) Abort(ctx context.Context) error { return g.abort(ctx) }

func (g *applicationGeneration) abort(ctx context.Context) error {
	if g == nil {
		return nil
	}
	g.settleMu.Lock()
	defer g.settleMu.Unlock()
	g.mu.Lock()
	if g.committed {
		g.mu.Unlock()
		return fmt.Errorf("cannot abort committed application generation %d", g.id)
	}
	if g.settled {
		terminalErr := g.terminalErr
		g.mu.Unlock()
		return terminalErr
	}
	g.stopping.Store(true)
	g.mu.Unlock()
	var joined error
	if g.messaging != nil {
		joined = errors.Join(joined, g.factory.messagingHub.Retire(ctx, g.messaging.output.Control))
	}
	if g.scheduler != nil {
		joined = errors.Join(joined, g.factory.scheduleHub.Retire(ctx, g.scheduler.output))
	}
	if g.managementServer != nil {
		joined = errors.Join(joined, g.managementServer.Stop(ctx))
		joined = errors.Join(joined, g.waitManagementRun(ctx))
	}
	if g.server != nil {
		joined = errors.Join(joined, g.server.Stop(ctx))
		joined = errors.Join(joined, g.waitRun(ctx))
	}
	if g.route != nil {
		if g.routePublished {
			joined = errors.Join(joined, g.factory.hub.Release(g.route))
		} else {
			joined = errors.Join(joined, g.factory.hub.Abort(g.route))
		}
	}
	if g.managementRoute != nil {
		joined = errors.Join(joined, g.factory.managementHub.Abort(g.managementRoute))
	}
	joined = errors.Join(joined, g.stopParticipants(ctx))
	joined = errors.Join(joined, g.releaseResources(ctx))
	g.mu.Lock()
	g.settled = true
	g.terminalErr = joined
	g.mu.Unlock()
	return joined
}

func (g *applicationGeneration) Retire(ctx context.Context) error {
	return g.stop(ctx, false)
}

func (g *applicationGeneration) Stop(ctx context.Context) error {
	return g.stop(ctx, true)
}

func (g *applicationGeneration) stop(ctx context.Context, retireCurrentRoute bool) error {
	if g == nil {
		return nil
	}
	g.settleMu.Lock()
	defer g.settleMu.Unlock()
	g.mu.Lock()
	if !g.committed {
		g.mu.Unlock()
		return fmt.Errorf("application generation %d is not committed", g.id)
	}
	if g.settled {
		terminalErr := g.terminalErr
		g.mu.Unlock()
		return terminalErr
	}
	wasCurrent := g.current
	g.stopping.Store(true)
	g.mu.Unlock()
	var joined error
	if g.messaging != nil {
		joined = errors.Join(joined, g.factory.messagingHub.Retire(ctx, g.messaging.output.Control))
	}
	if g.scheduler != nil {
		joined = errors.Join(joined, g.factory.scheduleHub.Retire(ctx, g.scheduler.output))
	}
	if retireCurrentRoute && wasCurrent {
		joined = errors.Join(joined, g.factory.hub.Retire(g.route))
		joined = errors.Join(joined, g.factory.managementHub.Retire(g.managementRoute))
	}
	if g.route != nil {
		joined = errors.Join(joined, g.route.WaitDrained(ctx))
	}
	if g.managementRoute != nil {
		joined = errors.Join(joined, g.managementRoute.WaitDrained(ctx))
	}
	if joined == nil && g.server != nil {
		joined = errors.Join(joined, g.server.Stop(ctx), g.waitRun(ctx))
	}
	if joined == nil && g.managementServer != nil {
		joined = errors.Join(joined, g.managementServer.Stop(ctx), g.waitManagementRun(ctx))
	}
	if joined == nil && g.route != nil {
		joined = errors.Join(joined, g.factory.hub.Release(g.route))
	}
	if joined == nil && g.managementRoute != nil {
		joined = errors.Join(joined, g.factory.managementHub.Release(g.managementRoute))
	}
	if joined == nil {
		joined = errors.Join(joined, g.stopParticipants(ctx))
	}
	terminal := false
	if joined == nil {
		terminal = true
		g.factory.clearCurrent(g)
		if wasCurrent {
			g.factory.logging.Restore()
		}
		joined = g.releaseResources(ctx)
	}
	if terminal {
		g.mu.Lock()
		g.settled = true
		g.terminalErr = joined
		g.mu.Unlock()
	}
	return joined
}

func (g *applicationGeneration) ForceStop(ctx context.Context) error {
	if g == nil {
		return nil
	}
	g.settleMu.Lock()
	defer g.settleMu.Unlock()
	g.mu.Lock()
	if !g.committed {
		g.mu.Unlock()
		return fmt.Errorf("application generation %d is not committed", g.id)
	}
	if g.settled {
		terminalErr := g.terminalErr
		g.mu.Unlock()
		return terminalErr
	}
	wasCurrent := g.current
	g.stopping.Store(true)
	g.mu.Unlock()
	var joined error
	if g.messaging != nil {
		joined = errors.Join(joined, g.factory.messagingHub.Retire(ctx, g.messaging.output.Control))
	}
	if g.scheduler != nil {
		joined = errors.Join(joined, g.factory.scheduleHub.Retire(ctx, g.scheduler.output))
	}
	joined = errors.Join(joined, g.factory.hub.Retire(g.route))
	joined = errors.Join(joined, g.factory.managementHub.Retire(g.managementRoute))
	if g.server != nil {
		joined = errors.Join(joined, g.server.ForceStop(ctx), g.waitRun(ctx))
	}
	if g.managementServer != nil {
		joined = errors.Join(joined, g.managementServer.ForceStop(ctx), g.waitManagementRun(ctx))
	}
	if joined == nil && g.route != nil {
		joined = errors.Join(joined, g.factory.hub.Release(g.route))
	}
	if joined == nil && g.managementRoute != nil {
		joined = errors.Join(joined, g.factory.managementHub.Release(g.managementRoute))
	}
	if joined == nil {
		joined = errors.Join(joined, g.stopParticipants(ctx))
	}
	terminal := false
	if joined == nil {
		terminal = true
		g.factory.clearCurrent(g)
		if wasCurrent {
			g.factory.logging.Restore()
		}
		joined = g.releaseResources(ctx)
	}
	if terminal {
		g.mu.Lock()
		g.settled = true
		g.terminalErr = joined
		g.mu.Unlock()
	}
	return joined
}

func (g *applicationGeneration) runServer() {
	err := g.server.Run(context.Background())
	g.mu.Lock()
	g.runErr = err
	close(g.runDone)
	g.mu.Unlock()
	if err != nil && !g.stopping.Load() {
		select {
		case g.factory.failures <- fmt.Errorf("run HTTP generation %d: %w", g.id, err):
		default:
		}
	}
}

func (g *applicationGeneration) runManagementServer() {
	err := g.managementServer.Run(context.Background())
	g.mu.Lock()
	g.managementRunErr = err
	close(g.managementRunDone)
	g.mu.Unlock()
	if err != nil && !g.stopping.Load() {
		select {
		case g.factory.failures <- fmt.Errorf("run management HTTP generation %d: %w", g.id, err):
		default:
		}
	}
}

func (g *applicationGeneration) waitRun(ctx context.Context) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-g.runDone:
		return g.serverRunError()
	}
}

func (g *applicationGeneration) serverRunError() error {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.runErr
}

func (g *applicationGeneration) waitManagementRun(ctx context.Context) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-g.managementRunDone:
		return g.managementServerRunError()
	}
}

func (g *applicationGeneration) managementServerRunError() error {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.managementRunErr
}

func (g *applicationGeneration) releaseResources(ctx context.Context) error {
	var joined error
	if g.scheduler != nil {
		joined = errors.Join(joined, g.scheduler.close(ctx))
	}
	if g.messaging != nil {
		joined = errors.Join(joined, g.messaging.close(ctx))
	}
	if g.telemetry != nil {
		joined = errors.Join(joined, g.telemetry.close(ctx))
	}
	if g.alerting != nil {
		joined = errors.Join(joined, g.alerting.close(ctx))
	}
	if g.metrics != nil {
		joined = errors.Join(joined, g.metrics.release(ctx))
	}
	joined = errors.Join(joined, releaseGenerationResources(ctx, g.storage, g.i18n, g.cache, g.database, g.logger, g.execution))
	return joined
}

func (g *applicationGeneration) reportScheduleFailure(err error) {
	if err == nil || g.stopping.Load() {
		return
	}
	select {
	case g.factory.failures <- fmt.Errorf("run scheduler generation %d: %w", g.id, err):
	default:
	}
}

func (g *applicationGeneration) stopParticipants(ctx context.Context) error {
	if g.participantStopDone {
		return g.participantStopErr
	}
	g.participantStopDone = true
	var joined error
	for index := len(g.participants) - 1; index >= 0; index-- {
		participant := g.participants[index]
		if participant == nil {
			continue
		}
		if err := participant.Stop(ctx); err != nil {
			joined = errors.Join(joined, fmt.Errorf("stop generation participant %s: %w", participant.Name(), err))
		}
	}
	g.participantStopErr = joined
	return g.participantStopErr
}

func (g *applicationGeneration) trackRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		g.activeRequests.Add(1)
		defer g.activeRequests.Add(-1)
		next.ServeHTTP(response, request)
	})
}

var _ kernel.GenerationFactory = (*applicationGenerationFactory)(nil)
var _ kernel.PreparedGeneration = (*applicationGeneration)(nil)
var _ kernel.ActiveGeneration = (*applicationGeneration)(nil)

// schedulerApplicationIdentity 让桥接和切换版本共用执行租约。
func schedulerApplicationIdentity(name string) string {
	if name == "neocloud" {
		return "clouddrive"
	}
	return name
}
