package composition

import (
	"bufio"
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"time"

	databaseapp "github.com/reina0721/clouddrive/internal/kernel/app/database"
	storageapp "github.com/reina0721/clouddrive/internal/kernel/app/storage"
	kernelcomposition "github.com/reina0721/clouddrive/internal/kernel/composition"
	"github.com/reina0721/clouddrive/internal/kernel/config"
	"github.com/reina0721/clouddrive/internal/module/files"
	filesconfig "github.com/reina0721/clouddrive/internal/module/files/binding/config"
	"github.com/reina0721/clouddrive/internal/module/migration"
	opsconfig "github.com/reina0721/clouddrive/internal/module/ops/binding/config"
	"github.com/reina0721/clouddrive/internal/nativeupgrade/control"
	pkgdatabase "github.com/reina0721/clouddrive/pkg/database"
	pkgstorage "github.com/reina0721/clouddrive/pkg/storage"
	"github.com/reina0721/clouddrive/pkg/supervisor"
)

type managedWorker struct {
	application *Application
	managed     *managedService
	runtime     *serviceRuntime
	lease       *managedLease
	done        chan struct{}
	stop        context.CancelFunc
	runErr      error
	metadata    control.Response
	candidate   bool
}

func (a *Application) runManagedWorker(ctx context.Context) (runErr error) {
	if a.config.Stdin == nil || a.config.Stdout == nil {
		return fmt.Errorf("managed worker requires supervisor-owned control pipes")
	}
	worker := managedWorker{application: a, metadata: control.Response{
		Protocol: control.Protocol, Version: a.config.Build.Version, Commit: a.config.Build.Commit,
	}}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
		defer cancel()
		runErr = errors.Join(runErr, worker.stopRuntime(cleanup))
	}()
	if pipe, ok := a.config.Stdin.(io.Closer); ok {
		defer pipe.Close()
	}
	commandsCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	commands := make(chan workerCommand)
	go readWorkerCommands(commandsCtx, a.config.Stdin, commands)
	output := json.NewEncoder(a.config.Stdout)
	for {
		var command workerCommand
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-worker.done:
			return errors.Join(fmt.Errorf("managed worker runtime stopped unexpectedly"), worker.runErr)
		case incoming, open := <-commands:
			if !open {
				return nil
			}
			command = incoming
		}
		if command.err != nil {
			return command.err
		}
		err := worker.perform(ctx, command.request)
		response := worker.metadata
		response.ID = command.request.ID
		if err != nil {
			response.Error = err.Error()
		}
		if err := output.Encode(response); err != nil {
			return err
		}
		if response.Phase == "exiting" {
			return nil
		}
	}
}

type workerCommand struct {
	request control.Request
	err     error
}

func readWorkerCommands(ctx context.Context, reader io.Reader, commands chan<- workerCommand) {
	defer close(commands)
	input := bufio.NewScanner(reader)
	input.Buffer(make([]byte, 4096), 1<<20)
	for input.Scan() {
		var command workerCommand
		command.err = decodeControl(input.Bytes(), &command.request)
		select {
		case <-ctx.Done():
			return
		case commands <- command:
		}
		if command.err != nil {
			return
		}
	}
	if err := input.Err(); err != nil {
		select {
		case <-ctx.Done():
		case commands <- workerCommand{err: err}:
		}
	}
}

func decodeControl(data []byte, value any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		return fmt.Errorf("invalid managed worker control request")
	}
	if err := decoder.Decode(new(json.RawMessage)); !errors.Is(err, io.EOF) {
		return fmt.Errorf("unexpected trailing managed worker data")
	}
	return nil
}

func (w *managedWorker) perform(ctx context.Context, request control.Request) error {
	timeout := 30 * time.Second
	if request.Action == "migrate" || request.Action == "backup" {
		timeout = 2 * time.Minute
	}
	if request.TimeoutMS != 0 {
		if request.TimeoutMS < 1 || request.TimeoutMS > int64((5*time.Minute).Milliseconds()) {
			return fmt.Errorf("invalid worker operation timeout")
		}
		timeout = time.Duration(request.TimeoutMS) * time.Millisecond
	}
	operation, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	if request.Action == "prepare" && w.managed == nil {
		return w.prepare(operation, request)
	}
	if w.managed == nil {
		return fmt.Errorf("managed worker is not prepared")
	}
	if request.Expected != "" && request.Expected != w.metadata.ConfigDigest {
		return fmt.Errorf("managed worker configuration differs from the expected snapshot")
	}
	phase := w.metadata.Phase
	if err := w.checkRuntime(); err != nil && request.Action != "exit" && request.Action != "release" {
		return err
	}
	switch request.Action {
	case "allow":
		if phase != "active" && phase != "prepared" {
			break
		}
		return w.allow(operation, request)
	case "migrate":
		if phase != "prepared" || w.runtime != nil {
			break
		}
		return w.migrate(operation, request)
	case "backup":
		if phase != "prepared" || w.runtime != nil {
			break
		}
		return w.backup(operation, request.BackupDirectory)
	case "activate":
		if phase != "prepared" || w.runtime != nil {
			break
		}
		return w.activate(ctx, operation, request)
	case "publish":
		if phase != "active-ready" {
			break
		}
		return w.publish(operation)
	case "quiesce":
		if phase != "active" {
			break
		}
		if err := w.managed.quiesce(operation); err != nil {
			w.managed.admission(true, false)
			return fmt.Errorf("managed worker still has admitted work: %w", err)
		}
		w.metadata.Phase = "quiescent"
		return nil
	case "resume":
		if phase != "quiescent" {
			break
		}
		w.managed.admission(true, false)
		w.metadata.Phase = "active"
		return nil
	case "release":
		if phase != "quiescent" {
			break
		}
		if err := w.stopRuntime(operation); err != nil {
			// Quiescence is no longer reversible once the runtime starts to stop.
			w.metadata.Phase = "release-failed"
			return err
		}
		w.metadata.Phase = "old-released"
		return nil
	case "exit":
		if err := w.stopRuntime(operation); err != nil {
			return err
		}
		w.metadata.Phase = "exiting"
		return nil
	}
	return fmt.Errorf("managed worker cannot run %q in phase %s", request.Action, phase)
}

func (w *managedWorker) prepare(ctx context.Context, request control.Request) error {
	key, err := hex.DecodeString(request.Token)
	if err != nil || len(key) < 16 || len(key) > 32 {
		return fmt.Errorf("managed worker requires a private supervisor token")
	}
	snapshot, err := w.application.loadInstanceConfiguration(ctx)
	if err != nil {
		return err
	}
	if request.Expected != "" && request.Expected != snapshot.Digest() {
		return fmt.Errorf("candidate configuration differs from the active snapshot")
	}
	plan, err := readManagedPlan(request.Plan)
	if err != nil {
		return err
	}
	if request.Candidate && plan != nil {
		err = w.application.CheckOnlineMigrationCandidate(ctx, snapshot, *plan)
	} else {
		err = w.application.CheckOnlineMigration(ctx, snapshot, plan)
	}
	if err != nil {
		return err
	}
	httpConfig, err := kernelcomposition.HTTPServerConfig(snapshot)
	if err != nil {
		return err
	}
	ops, err := opsconfig.Decode(snapshot)
	if err != nil {
		return err
	}
	database, err := databaseapp.Decode(snapshot)
	if err != nil {
		return err
	}
	initialized, err := checkManagedStorage(ctx, snapshot, database.PackageConfig(), request.Candidate)
	if err != nil {
		return err
	}
	w.managed = &managedService{application: w.application, token: request.Token, initialDigest: snapshot.Digest(), initializeStorage: !initialized, publishedSignal: make(chan struct{})}
	w.candidate = request.Candidate
	w.managed.plan.Store(plan)
	w.metadata.Phase = "prepared"
	w.metadata.ConfigDigest = snapshot.Digest()
	w.metadata.Driver = string(database.Driver)
	w.metadata.ConfiguredBusinessAddr = httpConfig.Addr
	w.metadata.ConfiguredManagementAddr = ops.Management.Addr
	return nil
}

func checkManagedStorage(ctx context.Context, snapshot config.Snapshot, cfg pkgdatabase.Config, candidate bool) (initialized bool, resultErr error) {
	var storage storageapp.Config
	if err := snapshot.DecodeSection(storageapp.ConfigPath, &storage); err != nil {
		return false, err
	}
	identity, err := filesStorageIdentity(storage)
	if err != nil {
		return false, err
	}
	policy, err := filesconfig.Decode(snapshot)
	if err != nil {
		return false, err
	}
	resource, err := pkgdatabase.OpenInspectionGORM(ctx, &cfg)
	if err != nil {
		return false, err
	}
	defer func() { resultErr = errors.Join(resultErr, resource.Close()) }()
	initialized, err = files.CheckManagedPaths(ctx, resource.Client(), identity, policy.Transfers.StagingPath)
	if err != nil || !candidate {
		return initialized, err
	}
	if !initialized {
		return false, fmt.Errorf("online update requires existing storage and transfer identities")
	}
	if err := checkManagedDirectory(policy.Transfers.StagingPath); err != nil {
		return false, fmt.Errorf("transfer staging: %w", err)
	}
	switch storage.Driver {
	case pkgstorage.DriverLocal, pkgstorage.DriverLocalS3, pkgstorage.DriverLocalMinIO:
		if err := checkManagedDirectory(storage.Local.BasePath); err != nil {
			return false, fmt.Errorf("local content storage: %w", err)
		}
	}
	return true, nil
}

func checkManagedDirectory(directory string) error {
	info, err := os.Stat(directory)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return fmt.Errorf("configured directory is not a directory")
	}
	return nil
}

func readManagedPlan(data json.RawMessage) (*migration.OnlinePlan, error) {
	if len(data) == 0 {
		return nil, nil
	}
	var plan migration.OnlinePlan
	if err := decodeControl(data, &plan); err != nil {
		return nil, err
	}
	return &plan, nil
}

func (w *managedWorker) snapshot(ctx context.Context) (config.Snapshot, error) {
	snapshot, err := w.application.loadInstanceConfiguration(ctx)
	if err != nil {
		return config.Snapshot{}, err
	}
	if err := w.managed.checkSnapshot(snapshot, true); err != nil {
		return config.Snapshot{}, err
	}
	return snapshot, nil
}

func (w *managedWorker) allow(ctx context.Context, request control.Request) error {
	plan, err := readManagedPlan(request.Plan)
	if err != nil {
		return err
	}
	snapshot, err := w.snapshot(ctx)
	if err != nil {
		return err
	}
	if err := w.application.CheckOnlineMigration(ctx, snapshot, plan); err != nil {
		return err
	}
	w.managed.plan.Store(plan)
	return nil
}

func (w *managedWorker) migrate(ctx context.Context, request control.Request) error {
	snapshot, err := w.snapshot(ctx)
	if err != nil {
		return err
	}
	plan := w.managed.plan.Load()
	if plan == nil {
		return fmt.Errorf("managed worker has no online migration plan")
	}
	if len(request.Plan) != 0 {
		expected, err := readManagedPlan(request.Plan)
		if err != nil || !reflect.DeepEqual(plan, expected) {
			return fmt.Errorf("online migration plan changed after preparation")
		}
	}
	if len(plan.Steps) > 0 {
		if err := verifyManagedBackup(request.BackupDirectory, request.BackupPath); err != nil {
			return err
		}
		w.metadata.Backup = request.BackupPath
	}
	return applyOnlineMigrationSnapshot(ctx, snapshot, *plan)
}

func (w *managedWorker) backup(ctx context.Context, directory string) error {
	snapshot, err := w.snapshot(ctx)
	if err != nil {
		return err
	}
	plan := w.managed.plan.Load()
	if plan == nil || len(plan.Steps) == 0 || !filepath.IsAbs(directory) {
		return fmt.Errorf("managed recovery checkpoint requires a staged online migration")
	}
	backup, err := backupOnlineMigrationSnapshot(ctx, snapshot, directory)
	if err != nil {
		return err
	}
	if err := verifyManagedBackup(directory, backup); err != nil {
		return err
	}
	w.metadata.Backup = backup
	return nil
}

func verifyManagedBackup(directory, path string) error {
	if !filepath.IsAbs(directory) || !filepath.IsAbs(path) || filepath.Dir(filepath.Clean(path)) != filepath.Clean(directory) {
		return fmt.Errorf("online schema changes require the verified local recovery checkpoint")
	}
	root, err := os.Lstat(directory)
	if err != nil || !root.IsDir() || root.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("managed recovery checkpoint directory is invalid")
	}
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() == 0 {
		return fmt.Errorf("managed recovery checkpoint file is invalid")
	}
	return nil
}

func (w *managedWorker) activate(parent, operation context.Context, request control.Request) error {
	snapshot, err := w.snapshot(operation)
	if err != nil {
		return err
	}
	if len(request.Plan) != 0 {
		plan, err := readManagedPlan(request.Plan)
		if err != nil {
			return err
		}
		w.managed.plan.Store(plan)
	}
	if w.candidate {
		// The candidate can prepare against the old schema. Production activation
		// requires that every migration of the candidate is now fully applied.
		w.managed.plan.Store(nil)
	}
	if err := w.application.CheckOnlineMigration(operation, snapshot, w.managed.plan.Load()); err != nil {
		return err
	}
	database, err := databaseapp.Decode(snapshot)
	if err != nil {
		return err
	}
	w.lease, err = acquireManagedLease(operation, database.PackageConfig())
	if err != nil {
		return err
	}
	w.runtime, err = w.application.newManagedServiceRuntime(w.managed)
	if err != nil {
		return errors.Join(err, w.stopRuntime(operation))
	}
	w.managed.admission(false, true)
	serviceContext, stop := context.WithCancel(parent)
	w.stop, w.done = stop, make(chan struct{})
	go w.serveRuntime(serviceContext)
	select {
	case <-w.runtime.supervisor.Ready():
	case <-w.done:
		return errors.Join(fmt.Errorf("managed worker service did not start"), w.stopRuntime(operation))
	case <-operation.Done():
		return errors.Join(operation.Err(), w.stopRuntime(operation))
	}
	generation := w.runtime.factory.currentGeneration()
	if generation == nil {
		return errors.Join(fmt.Errorf("managed worker has no active generation"), w.stopRuntime(operation))
	}
	w.metadata.BusinessAddr = generation.BoundAddress()
	w.metadata.ManagementAddr = generation.ManagementBoundAddress()
	if err := w.probeRuntime(operation); err != nil {
		return errors.Join(err, w.stopRuntime(operation))
	}
	w.metadata.Phase = "active-ready"
	return nil
}

func (w *managedWorker) serveRuntime(ctx context.Context) {
	defer close(w.done)
	if w.lease.check != nil {
		if err := w.runtime.supervisor.AddTask("native-ownership-monitor", w.monitorLease); err != nil {
			w.runErr = err
			return
		}
	}
	w.runErr = w.runtime.supervisor.Run(ctx)
}

func (w *managedWorker) monitorLease(ctx context.Context) error {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			check, cancel := context.WithTimeout(ctx, 500*time.Millisecond)
			err := w.lease.check(check)
			cancel()
			if err != nil && ctx.Err() == nil {
				w.managed.admission(false, false)
				return err
			}
		}
	}
}

func (w *managedWorker) checkRuntime() error {
	if w.done != nil {
		select {
		case <-w.done:
			return errors.Join(fmt.Errorf("managed worker service exited"), w.runErr)
		default:
		}
	}
	return nil
}

func (w *managedWorker) probeRuntime(ctx context.Context) error {
	for _, route := range []string{"/readyz", "/build"} {
		address := w.metadata.ManagementAddr
		host, _, err := net.SplitHostPort(address)
		if err != nil || host != "127.0.0.1" {
			return fmt.Errorf("managed worker management address is invalid")
		}
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+address+route, nil)
		if err != nil {
			return err
		}
		request.Header.Set(control.TokenHeader, w.managed.token)
		response, err := managedProbeClient.Do(request)
		if err != nil {
			return fmt.Errorf("managed worker probe failed: %w", err)
		}
		var value map[string]any
		decodeErr := json.NewDecoder(io.LimitReader(response.Body, 4096)).Decode(&value)
		closeErr := response.Body.Close()
		if decodeErr != nil || closeErr != nil || response.StatusCode != http.StatusOK {
			return fmt.Errorf("managed worker probe %s did not pass", route)
		}
		if route == "/readyz" && value["status"] != "pass" {
			return fmt.Errorf("managed worker is not ready")
		}
		if route == "/build" && (value["version"] != w.metadata.Version || value["commit"] != w.metadata.Commit) {
			return fmt.Errorf("managed worker build does not match the prepared worker")
		}
	}
	return nil
}

var managedProbeClient = &http.Client{
	Transport:     &http.Transport{DisableKeepAlives: true},
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
}

func (w *managedWorker) publish(ctx context.Context) error {
	generation := w.runtime.factory.currentGeneration()
	if generation == nil || w.runtime.supervisor.Snapshot().State != supervisor.StateRunning {
		return fmt.Errorf("managed worker service is no longer ready")
	}
	generation.settleMu.Lock()
	defer generation.settleMu.Unlock()
	if err := generation.openBackground(ctx); err != nil {
		w.stop()
		return err
	}
	w.managed.published.Store(true)
	w.managed.admission(true, false)
	close(w.managed.publishedSignal)
	w.metadata.Phase = "active"
	return nil
}

func (w *managedWorker) stopRuntime(ctx context.Context) error {
	var joined error
	if w.managed != nil {
		w.managed.admission(false, false)
	}
	if w.stop != nil {
		w.stop()
		select {
		case <-w.done:
			joined = w.runErr
		case <-ctx.Done():
			return ctx.Err()
		}
		w.stop, w.done = nil, nil
	}
	w.runtime = nil
	if w.lease != nil {
		joined = errors.Join(joined, w.lease.close())
		w.lease = nil
	}
	w.metadata.BusinessAddr, w.metadata.ManagementAddr = "", ""
	return joined
}
