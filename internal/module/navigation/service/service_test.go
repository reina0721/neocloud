package service_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/reina0721/neocloud/internal/module/navigation/binding/consolecatalog"
	migrationbinding "github.com/reina0721/neocloud/internal/module/navigation/binding/migration"
	"github.com/reina0721/neocloud/internal/module/navigation/model"
	"github.com/reina0721/neocloud/internal/module/navigation/repo"
	"github.com/reina0721/neocloud/internal/module/navigation/service"
	"github.com/reina0721/neocloud/pkg/clock"
	"github.com/reina0721/neocloud/pkg/database"
	dbmigrate "github.com/reina0721/neocloud/pkg/database/migrate"

	"github.com/reina0721/neocloud/pkg/testkit"
)

func TestDefaultsUpdateRevisionAndCycleRollback(t *testing.T) {
	catalog := &fakeCatalog{snapshot: service.CatalogSnapshot{Revision: "catalog-a", Definitions: []model.Definition{{ID: "root", ModuleID: "ops", RouteID: "root", DefaultOrder: 10, Manageable: true}, {ID: "child", ModuleID: "ops", RouteID: "child", DefaultParentID: "root", DefaultOrder: 20, Manageable: true}}}}
	navigation, resource := newService(t, catalog)
	defer resource.Close()
	menus, err := navigation.Menus(t.Context())
	if err != nil || len(menus) != 2 || menus[0].ID != "root" || menus[1].ParentID != "root" {
		t.Fatalf("defaults = %#v, %v", menus, err)
	}
	before, err := navigation.Snapshot(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	order := 5
	updated, err := navigation.Update(t.Context(), service.UpdateCommand{NavigationID: "child", Enabled: false, OrderOverride: &order})
	if err != nil {
		t.Fatal(err)
	}
	if before.NavigationRevision == updated.NavigationRevision {
		t.Fatal("policy mutation did not change revision")
	}
	parent := "child"
	if _, err := navigation.Update(t.Context(), service.UpdateCommand{NavigationID: "root", Enabled: true, ParentOverride: &parent}); !errors.Is(err, model.ErrCycle) {
		t.Fatalf("cycle error = %v", err)
	}
	after, err := navigation.Menus(t.Context())
	rootParent := "missing"
	childOrderOverridden := false
	for _, menu := range after {
		if menu.ID == "root" {
			rootParent = menu.ParentID
		}
		if menu.ID == "child" {
			childOrderOverridden = menu.OrderOverridden && !menu.ParentOverridden
		}
	}
	if err != nil || rootParent != "" || !childOrderOverridden {
		t.Fatalf("cycle left partial state: %#v, %v", after, err)
	}
}

func TestUnknownAndCatalogChangeFailClosed(t *testing.T) {
	catalog := &fakeCatalog{snapshot: service.CatalogSnapshot{Revision: "catalog-a", Definitions: []model.Definition{{ID: "root", Manageable: true}, {ID: "draft", Manageable: false}}}}
	navigation, resource := newService(t, catalog)
	defer resource.Close()
	if _, err := navigation.Update(t.Context(), service.UpdateCommand{NavigationID: "missing", Enabled: true}); !errors.Is(err, model.ErrUnknown) {
		t.Fatalf("unknown error = %v", err)
	}
	if _, err := navigation.Update(t.Context(), service.UpdateCommand{NavigationID: "draft", Enabled: true}); !errors.Is(err, model.ErrNotManageable) {
		t.Fatalf("not manageable error = %v", err)
	}
	if _, err := navigation.Update(t.Context(), service.UpdateCommand{NavigationID: "root", Enabled: false}); err != nil {
		t.Fatal(err)
	}
	catalog.snapshot.Revision = "catalog-b"
	if err := navigation.Compatible(t.Context()); !errors.Is(err, model.ErrCatalogChanged) {
		t.Fatalf("catalog change error = %v", err)
	}
	if _, err := navigation.Update(t.Context(), service.UpdateCommand{NavigationID: "root", Enabled: true, Version: 1}); !errors.Is(err, model.ErrCatalogChanged) {
		t.Fatalf("update with unknown catalog revision = %v", err)
	}
	catalog.snapshot.Revision = "catalog-a"
	after, err := navigation.Snapshot(t.Context())
	if err != nil || len(after.Policies) != 1 || after.Policies[0].Enabled || after.Policies[0].Version != 1 {
		t.Fatalf("rejected update changed the original policy: %#v, %v", after.Policies, err)
	}
}

func TestPresentationCatalogPreservesPoliciesAcrossUpgradeAndRollback(t *testing.T) {
	const previousRevision = "71b1e8f16b4b55c335ded8adf0de79c1c6e846d2d81db5b78e7b702711158ee6"
	const workbenchID = "api-workbench.root"
	ctx := t.Context()
	catalog, err := consolecatalog.New()
	if err != nil {
		t.Fatal(err)
	}
	current := catalog.Snapshot()
	if current.Revision == previousRevision || current.PolicyRevision != previousRevision {
		t.Fatalf("content and rollback policy revisions = %q, %q", current.Revision, current.PolicyRevision)
	}
	previous := catalog.Snapshot()
	previous.Revision = previousRevision
	previous.PolicyRevision = ""
	for index := range previous.Definitions {
		if previous.Definitions[index].ID == workbenchID {
			previous.Definitions[index].DefaultParentID = "group:development"
			previous.Definitions[index].DefaultOrder = 45
		}
	}
	rollbackCatalog := &fakeCatalog{snapshot: previous}
	older, resource := newService(t, rollbackCatalog)
	defer resource.Close()
	parent := "group:management"
	order := 12
	command := service.UpdateCommand{
		NavigationID: workbenchID, Enabled: true, Label: "自定义工作台",
		ParentOverride: &parent, OrderOverride: &order, PresentationPermission: "console:workbench:read",
	}
	before, err := older.Update(ctx, command)
	if err != nil {
		t.Fatal(err)
	}
	upgraded := serviceWithResource(t, catalog, resource)
	menus, upgradeSnapshot, err := upgraded.MenuSnapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if upgradeSnapshot.CatalogRevision != current.Revision || upgradeSnapshot.NavigationRevision == before.NavigationRevision {
		t.Fatalf("upgrade revisions = %q, %q", upgradeSnapshot.CatalogRevision, upgradeSnapshot.NavigationRevision)
	}
	var found bool
	for _, menu := range menus {
		if menu.ID != workbenchID {
			continue
		}
		found = true
		if menu.DefaultParentID != "group:administration" || menu.DefaultOrder != 52 ||
			menu.ParentID != parent || menu.Order != model.Order(order) || !menu.ParentOverridden || !menu.OrderOverridden ||
			menu.Label != command.Label || menu.PresentationPermission != command.PresentationPermission || !menu.Enabled || menu.Version != 1 {
			t.Fatalf("upgrade lost menu defaults or overrides: %#v", menu)
		}
	}
	if !found {
		t.Fatal("workbench missing from upgraded catalog")
	}
	if _, err := upgraded.Update(ctx, command); !errors.Is(err, model.ErrConflict) {
		t.Fatalf("stale policy version = %v", err)
	}
	command.Version = 1
	command.Enabled = false
	if _, err := upgraded.Update(ctx, command); err != nil {
		t.Fatal(err)
	}
	// 首次在升级版本新增的覆写也必须可由旧版本读取。
	if _, err := upgraded.Update(ctx, service.UpdateCommand{NavigationID: "system-tools.runtime", Enabled: false}); err != nil {
		t.Fatal(err)
	}
	rolledBack := serviceWithResource(t, rollbackCatalog, resource)
	back, err := rolledBack.Snapshot(ctx)
	if err != nil || len(back.Policies) != 2 {
		t.Fatalf("rollback cannot read both policies: %#v, %v", back, err)
	}
	for _, policy := range back.Policies {
		if policy.CatalogRevision != previousRevision || policy.Enabled {
			t.Fatalf("rollback policy = %#v", policy)
		}
	}
	command.Version = 2
	if _, err := rolledBack.Update(ctx, command); err != nil {
		t.Fatalf("rollback cannot edit the policy version written on upgrade: %v", err)
	}

	// 接受以精确当前内容版本保存的策略，下次编辑写入回退兼容版本。
	strictCurrent := current
	strictCurrent.PolicyRevision = ""
	strictService, otherResource := newService(t, &fakeCatalog{snapshot: strictCurrent})
	defer otherResource.Close()
	command.Version = 0
	if _, err := strictService.Update(ctx, command); err != nil {
		t.Fatal(err)
	}
	upgradedOther := serviceWithResource(t, catalog, otherResource)
	if err := upgradedOther.Compatible(ctx); err != nil {
		t.Fatal(err)
	}
	command.Version = 1
	if _, err := upgradedOther.Update(ctx, command); err != nil {
		t.Fatal(err)
	}
	if err := serviceWithResource(t, rollbackCatalog, otherResource).Compatible(ctx); err != nil {
		t.Fatal(err)
	}
}

type fakeCatalog struct{ snapshot service.CatalogSnapshot }

func (catalog *fakeCatalog) Snapshot() service.CatalogSnapshot { return catalog.snapshot }
func (*fakeCatalog) Validate(snapshot service.CatalogSnapshot, policies []model.Policy) (string, error) {
	payload, err := json.Marshal(struct {
		Revision string
		Policies []model.Policy
	}{snapshot.Revision, policies})
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(payload)
	return hex.EncodeToString(digest[:]), nil
}
func newService(t *testing.T, catalog service.NavigationCatalog) (*service.Service, database.Resource) {
	t.Helper()
	config := database.DefaultConfig()
	config.Driver = database.DriverSQLite
	config.DSN = filepath.Join(testkit.PrivateTempDir(t), "navigation.db")
	runner, err := dbmigrate.New(t.Context(), dbmigrate.Config{Database: config, LockTimeout: 5 * time.Second}, migrationbinding.Set())
	if err != nil {
		t.Fatal(err)
	}
	if err := runner.Up(t.Context()); err != nil {
		t.Fatal(err)
	}
	if err := runner.Close(); err != nil {
		t.Fatal(err)
	}
	resource, err := database.NewGORM(t.Context(), &config)
	if err != nil {
		t.Fatal(err)
	}
	return serviceWithResource(t, catalog, resource), resource
}

func serviceWithResource(t *testing.T, catalog service.NavigationCatalog, resource database.Resource) *service.Service {
	t.Helper()
	store, err := repo.New(resourceAccess{resource})
	if err != nil {
		t.Fatal(err)
	}
	navigation, err := service.New(store, clock.Fixed(time.Date(2026, 8, 22, 9, 0, 0, 0, time.UTC)), catalog)
	if err != nil {
		t.Fatal(err)
	}
	return navigation
}

type resourceAccess struct{ resource database.Resource }

func (access resourceAccess) Use(ctx context.Context, use func(database.Client) error) error {
	return database.Borrow(ctx, access.resource.Client(), use)
}
func (access resourceAccess) WithinTx(ctx context.Context, use func(context.Context, database.Client, database.Tx) error) error {
	return access.Use(ctx, func(client database.Client) error {
		return client.WithinTx(ctx, func(txCtx context.Context, tx database.Tx) error { return use(txCtx, client, tx) })
	})
}

type recordingOperationAudit struct {
	requests []service.OperationAuditRequest
}

func (r *recordingOperationAudit) RecordOperation(_ context.Context, request service.OperationAuditRequest) error {
	r.requests = append(r.requests, request)
	return nil
}

func TestMenuPolicyUpdateAuditsOperation(t *testing.T) {
	catalog := &fakeCatalog{snapshot: service.CatalogSnapshot{Revision: "catalog-a", Definitions: []model.Definition{{ID: "root", ModuleID: "ops", RouteID: "root", DefaultOrder: 10, Manageable: true}}}}
	navigation, resource := newService(t, catalog)
	defer resource.Close()
	audit := &recordingOperationAudit{}
	navigation.WithOperationAudit(audit)

	order := 15
	if _, err := navigation.Update(t.Context(), service.UpdateCommand{NavigationID: "root", Enabled: true, OrderOverride: &order}); err != nil {
		t.Fatal(err)
	}
	if len(audit.requests) != 1 {
		t.Fatalf("menu policy update audit count = %d: %#v", len(audit.requests), audit.requests)
	}
	request := audit.requests[0]
	if request.Operation != "navigation.menus.update" || request.ResourceType != "menu" || request.ResourceID != "root" || request.Outcome != service.OperationSucceeded {
		t.Fatalf("menu policy update audit abnormal: %#v", request)
	}
}
