package repo

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/reina0721/clouddrive/internal/module/files/model"
	"gorm.io/gorm"
)

func TestSQLiteFileReadSnapshotDoesNotBlockWriters(t *testing.T) {
	ctx := t.Context()
	store := entryPathFixture(t, ctx, 3)
	const target = "entry-000002"
	const changed = "changed"
	readName := func(db *gorm.DB) (string, error) {
		var row entryRecord
		err := db.First(&row, "id = ?", target).Error
		return row.Name, err
	}
	err := store.readFileSnapshot(ctx, func(db *gorm.DB) error {
		before, err := readName(db)
		if err != nil {
			return err
		}
		writeCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
		defer cancel()
		_, err = store.Change(writeCtx, "owner", func(entries []model.Entry) (model.Entry, error) {
			entry, ok := model.Find(entries, target)
			if !ok {
				return model.Entry{}, model.ErrMissing
			}
			entry.Name, entry.NormalizedName = changed, changed
			return entry, nil
		})
		if err != nil {
			return fmt.Errorf("读快照期间写入未提交: %w", err)
		}
		after, err := readName(db)
		if err == nil && after != before {
			return fmt.Errorf("同一快照读取到变化后的名称 %q", after)
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	err = store.readFileSnapshot(ctx, func(db *gorm.DB) error {
		name, err := readName(db)
		if err == nil && name != changed {
			return fmt.Errorf("新快照未读取到已提交名称 %q", name)
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
}
