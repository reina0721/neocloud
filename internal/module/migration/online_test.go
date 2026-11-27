package migration_test

import (
	"crypto/sha256"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/google/uuid"
	"github.com/reina0721/neocloud/internal/module/migration"
	migrationconfig "github.com/reina0721/neocloud/internal/module/migration/binding/config"
	"github.com/reina0721/neocloud/pkg/database"
	dbmigrate "github.com/reina0721/neocloud/pkg/database/migrate"
)

func TestOnlineMigrationKeepsOldVersionCompatible(t *testing.T) {
	for _, dialect := range []struct {
		name   database.Driver
		sql    string
		dsnEnv string
	}{
		{name: database.DriverSQLite, sql: "sqlite"},
		{name: database.DriverPostgres, sql: "pgx", dsnEnv: "TEST_MIGRATION_POSTGRES_DSN"},
		{name: database.DriverMySQL, sql: "mysql", dsnEnv: "TEST_MIGRATION_MYSQL_DSN"},
	} {
		t.Run(string(dialect.name), func(t *testing.T) {
			cfg := database.DefaultConfig()
			cfg.Driver = dialect.name
			if dialect.dsnEnv == "" {
				cfg.DSN = filepath.Join(t.TempDir(), "online.db")
			} else {
				cfg.DSN = os.Getenv(dialect.dsnEnv)
				if cfg.DSN == "" {
					t.Skipf("%s is not configured", dialect.dsnEnv)
				}
			}
			table := "online_fixture_" + strings.ReplaceAll(uuid.NewString(), "-", "")
			base, candidate, plan := onlineServices(t, cfg, table)
			if _, err := base.UpSerialized(t.Context()); err != nil {
				t.Fatalf("prepare source schema: %v", err)
			}
			app, err := sql.Open(dialect.sql, cfg.DSN)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				if cfg.Driver != database.DriverSQLite {
					_, _ = app.Exec("DROP TABLE IF EXISTS " + table)
					_, _ = app.Exec("DROP TABLE IF EXISTS " + table + "_v")
					if cfg.Driver == database.DriverMySQL {
						_, _ = app.Exec("DELETE FROM clouddrive_online_migration_steps WHERE version_table = ?", table+"_v")
					}
				}
				_ = app.Close()
			})
			if cfg.Driver == database.DriverSQLite {
				if _, err := app.Exec("PRAGMA journal_mode = WAL"); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := app.Exec("INSERT INTO " + table + " (id) VALUES (1)"); err != nil {
				t.Fatal(err)
			}
			if cfg.Driver == database.DriverSQLite {
				assertSQLiteOnlineBackup(t, cfg, table)
			}
			if err := candidate.CheckOnlineCandidate(t.Context(), plan); err != nil {
				t.Fatalf("standby rejects source schema: %v", err)
			}
			wrong := plan
			wrong.Steps = append([]migration.OnlineStep(nil), plan.Steps...)
			wrong.Steps[0].SHA256 = strings.Repeat("0", 64)
			if err := candidate.ApplyOnline(t.Context(), wrong); err == nil {
				t.Fatal("wrong embedded migration digest accepted")
			}
			if err := base.CheckOnlineBaseline(t.Context()); err != nil {
				t.Fatalf("blocked candidate changed source schema: %v", err)
			}
			lock, err := dbmigrate.OpenOnlineSession(t.Context(), cfg)
			if err != nil {
				t.Fatalf("take online migration fixture lock: %v", err)
			}
			err = candidate.ApplyOnline(t.Context(), plan)
			_, offlineErr := candidate.UpSerialized(t.Context())
			if closeErr := lock.Close(); closeErr != nil {
				t.Fatalf("release fixture lock: %v", closeErr)
			}
			if !errors.Is(err, dbmigrate.ErrOnlineBusy) || !errors.Is(offlineErr, dbmigrate.ErrOnlineBusy) {
				t.Fatalf("online and legacy runner must coordinate ownership: %v, %v", err, offlineErr)
			}
			if cfg.Driver == database.DriverMySQL {
				stageCommittedMySQLDDL(t, app, table, plan.Steps[0])
			}
			if cfg.Driver == database.DriverSQLite {
				assertSQLiteDDLAndVersionRollbackTogether(t, app, candidate, table, plan)
			}
			if err := candidate.ApplyOnline(t.Context(), plan); err != nil {
				t.Fatalf("apply online while source connection stays open: %v", err)
			}
			if _, err := app.Exec("INSERT INTO " + table + " (id) VALUES (2)"); err != nil {
				t.Fatalf("existing source write shape changed: %v", err)
			}
			if err := base.CompatibleWithOnlinePlan(t.Context(), plan); err != nil {
				t.Fatalf("old restart with verified expanded schema: %v", err)
			}
			if err := base.CheckOnlineBaseline(t.Context()); err == nil {
				t.Fatal("ordinary startup admitted mismatched schema without signed plan")
			}
			if err := candidate.ApplyOnline(t.Context(), plan); err != nil {
				t.Fatalf("retry of committed plan is not idempotent: %v", err)
			}
			var rows int
			if err := app.QueryRow("SELECT COUNT(*) FROM " + table + " WHERE note IS NULL").Scan(&rows); err != nil || rows != 2 {
				t.Fatalf("preserved old business rows = %d, %v", rows, err)
			}
		})
	}
}

func onlineServices(t *testing.T, cfg database.Config, table string) (*migration.Service, *migration.Service, migration.OnlinePlan) {
	t.Helper()
	op := dbmigrate.OnlineOperation{Kind: dbmigrate.OnlineAddColumn, Table: table,
		Columns: []dbmigrate.OnlineColumn{{Name: "note", Type: "text", Nullable: true}}}
	ddl, err := dbmigrate.OnlineSQL(cfg.Driver, op)
	if err != nil {
		t.Fatal(err)
	}
	plan := migration.OnlinePlan{Driver: cfg.Driver, Steps: []migration.OnlineStep{{
		ModuleID: "todo", From: 1, To: 2, SHA256: onlineDigest(ddl), Operation: op,
	}}}
	service := func(version uint, files map[string]string) *migration.Service {
		t.Helper()
		fsys, digests := fstest.MapFS{}, map[string]string{}
		for name, body := range files {
			filename := string(cfg.Driver) + "/" + name
			fsys[filename] = &fstest.MapFile{Data: []byte(body)}
			digests[filename] = onlineDigest(body)
		}
		set := dbmigrate.Set{Name: table, MigrationsTable: table + "_v", CurrentVersion: version,
			DriverPaths: map[database.Driver]string{cfg.Driver: string(cfg.Driver)}, FS: fsys, SHA256ByFile: digests}
		catalog, err := migration.BuildCatalog(migration.Registration{ModuleID: "todo", Source: "test/todo", Set: set})
		if err != nil {
			t.Fatal(err)
		}
		svc, err := migration.New(cfg, migrationconfig.Config{LockTimeout: 5 * time.Second, OperationTimeout: 15 * time.Second},
			catalog, migration.NewDefaultFactory, migration.DefaultPreflight)
		if err != nil {
			t.Fatal(err)
		}
		return svc
	}
	files := map[string]string{"000001_create.up.sql": "CREATE TABLE " + table + " (id INTEGER PRIMARY KEY)"}
	source := service(1, files)
	files["000002_notes.up.sql"] = ddl
	return source, service(2, files), plan
}

func onlineDigest(body string) string { return fmt.Sprintf("%x", sha256.Sum256([]byte(body))) }

func assertSQLiteOnlineBackup(t *testing.T, cfg database.Config, table string) {
	t.Helper()
	path, err := dbmigrate.BackupOnline(t.Context(), cfg, t.TempDir())
	if err != nil {
		t.Fatalf("SQLite online backup: %v", err)
	}
	restored := openSQLite(t, path)
	defer restored.Close()
	var id int
	if err := restored.QueryRow("SELECT id FROM " + table).Scan(&id); err != nil || id != 1 {
		t.Fatalf("SQLite reopened checkpoint = %d, %v", id, err)
	}
}

func assertSQLiteDDLAndVersionRollbackTogether(t *testing.T, app *sql.DB, candidate *migration.Service, table string, plan migration.OnlinePlan) {
	t.Helper()
	if _, err := app.Exec("CREATE TRIGGER force_version_failure BEFORE UPDATE OF version ON " + table +
		"_v BEGIN SELECT RAISE(ABORT, 'version fixture failure'); END;"); err != nil {
		t.Fatal(err)
	}
	if err := candidate.ApplyOnline(t.Context(), plan); err == nil {
		t.Fatal("migration unexpectedly committed after version update failure")
	}
	var present bool
	if err := app.QueryRow("SELECT EXISTS(SELECT 1 FROM pragma_table_info(?) WHERE name = 'note')", table).Scan(&present); err != nil || present {
		t.Fatalf("SQLite did not roll back DDL together with version (column present = %t, %v)", present, err)
	}
	if _, err := app.Exec("DROP TRIGGER force_version_failure"); err != nil {
		t.Fatal(err)
	}
}

func stageCommittedMySQLDDL(t *testing.T, app *sql.DB, table string, step migration.OnlineStep) {
	t.Helper()
	if _, err := app.Exec(`CREATE TABLE IF NOT EXISTS clouddrive_online_migration_steps (
		version_table VARCHAR(63) NOT NULL, target_version BIGINT NOT NULL,
		source_version BIGINT NOT NULL, digest CHAR(64) NOT NULL, completed BOOLEAN NOT NULL,
		PRIMARY KEY (version_table, target_version)
	) ENGINE=InnoDB`); err != nil {
		t.Fatal(err)
	}
	if _, err := app.Exec(`INSERT INTO clouddrive_online_migration_steps
		(version_table,target_version,source_version,digest,completed) VALUES(?,?,?,?, FALSE)`, table+"_v", step.To, step.From, step.SHA256); err != nil {
		t.Fatal(err)
	}
	ddl, err := dbmigrate.OnlineSQL(database.DriverMySQL, step.Operation)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := app.Exec(ddl); err != nil {
		t.Fatal(err)
	}
}
