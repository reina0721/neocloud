package repo

import (
	"context"
	"fmt"
	"path/filepath"
	"testing"
	"time"

	filesmigration "github.com/reina0721/neocloud/internal/module/files/binding/migration"
	"github.com/reina0721/neocloud/internal/module/files/model"
	"github.com/reina0721/neocloud/pkg/clock"
	"github.com/reina0721/neocloud/pkg/database"
	dbmigrate "github.com/reina0721/neocloud/pkg/database/migrate"
	"github.com/reina0721/neocloud/pkg/testkit"
	"gorm.io/gorm"
)

func entryPathFixture(t testing.TB, ctx context.Context, entries int) *Repository {
	t.Helper()
	cfg := database.DefaultConfig()
	cfg.Driver, cfg.DSN = database.DriverSQLite, filepath.Join(testkit.PrivateTempDir(t), "paths.db")
	migrate, err := dbmigrate.New(ctx, dbmigrate.Config{Database: cfg, LockTimeout: 5 * time.Second}, filesmigration.Set())
	if err != nil {
		t.Fatal(err)
	}
	if err := migrate.Up(ctx); err != nil {
		t.Fatal(err)
	}
	if err := migrate.Close(); err != nil {
		t.Fatal(err)
	}
	resource, err := database.NewGORM(ctx, &cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = resource.Close() })
	now := time.Now().UTC()
	store, err := New(archiveTestAccess{resource.Client()}, "entry-path-fixture", clock.Fixed(now))
	if err != nil {
		t.Fatal(err)
	}
	if err := store.ValidateStorage(ctx, "entry-path-fixture"); err != nil {
		t.Fatal(err)
	}
	records := make([]entryRecord, entries)
	for index := range records {
		id := fmt.Sprintf("entry-%06d", index)
		record, err := entryRecordFromModel(model.Entry{
			ID: id, OwnerID: "owner", Kind: model.Folder, Name: id, NormalizedName: id,
			ContentRevision: 1, CreatedAt: now, UpdatedAt: now,
		})
		if err != nil {
			t.Fatal(err)
		}
		records[index] = record
	}
	records[1].ParentID = records[0].ID
	records[2].ParentID = records[1].ID
	if err := database.UseGORM(ctx, resource.Client(), func(db *gorm.DB) error {
		return db.CreateInBatches(records, 250).Error
	}); err != nil {
		t.Fatal(err)
	}
	return store
}

func BenchmarkSQLiteEntryAncestors(b *testing.B) {
	for _, size := range []int{100, 10_000} {
		b.Run(fmt.Sprint(size), func(b *testing.B) {
			store := entryPathFixture(b, b.Context(), size)
			b.Run("full-owner-read", func(b *testing.B) {
				for b.Loop() {
					if _, err := store.Read(b.Context(), "owner"); err != nil {
						b.Fatal(err)
					}
				}
			})
			b.Run("entry-path-read", func(b *testing.B) {
				for b.Loop() {
					if entries, err := store.ReadEntryPath(b.Context(), "owner", "entry-000002"); err != nil || len(entries) != 3 {
						b.Fatalf("entry path: entries=%d, err=%v", len(entries), err)
					}
				}
			})
		})
	}
}

func TestSQLiteEntryPathLimitsRowsAndPreservesAncestorChecks(t *testing.T) {
	ctx := t.Context()
	store := entryPathFixture(t, ctx, 10)
	const target = "entry-000002"
	readVisible := func() bool {
		t.Helper()
		path, err := store.ReadEntryPath(ctx, "owner", target)
		if err != nil {
			t.Fatal(err)
		}
		entry, ok := model.Find(path, target)
		return ok && model.Visible(path, entry)
	}
	if !readVisible() {
		t.Fatal("valid descendant is hidden")
	}
	if entries, err := store.ReadEntryPath(ctx, "another-owner", target); err != nil || len(entries) != 0 {
		t.Fatalf("wrong owner received entries: %d, %v", len(entries), err)
	}
	updateRoot := func(changes map[string]any) {
		t.Helper()
		if err := store.access.Use(ctx, func(client database.Client) error {
			return database.UseGORM(ctx, client, func(db *gorm.DB) error {
				return db.Model(&entryRecord{}).Where("id = ?", "entry-000000").Updates(changes).Error
			})
		}); err != nil {
			t.Fatal(err)
		}
	}
	updateRoot(map[string]any{"trashed_at": time.Now().UTC()})
	if readVisible() {
		t.Fatal("descendant of trashed folder was visible")
	}
	updateRoot(map[string]any{"trashed_at": nil, "parent_id": target})
	if readVisible() {
		t.Fatal("cyclic ancestor chain was visible")
	}
}
