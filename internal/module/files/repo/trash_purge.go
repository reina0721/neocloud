package repo

import (
	"context"
	"fmt"
	"math"
	"slices"
	"time"

	"github.com/reina0721/clouddrive/internal/module/files/model"
	"github.com/reina0721/clouddrive/internal/module/files/service"
	"github.com/reina0721/clouddrive/pkg/database"
	"gorm.io/gorm"
)

// trashRemovalBatchSize 为所有支持的数据库保留绑定参数余量。
const trashRemovalBatchSize = 200

func (r *Repository) ReadTrashTargets(ctx context.Context, owner string, roots []string, limit int) ([]model.Entry, error) {
	var entries []model.Entry
	err := r.readFileSnapshot(ctx, func(db *gorm.DB) error {
		var err error
		entries, err = readTrashTargets(db, owner, roots, limit)
		return err
	})
	return entries, err
}

// RemoveTrashTargets 在现有事务内重读选区、移除目录项并登记失去引用的候选。
func (r *Repository) RemoveTrashTargets(ctx context.Context, owner string, roots []string, limit int, plan func([]model.Entry) ([]string, error)) error {
	if plan == nil {
		return model.ErrInvalid
	}
	return r.access.WithinTx(ctx, func(ctx context.Context, _ database.Client, tx database.Tx) error {
		return database.UseGORMTx(ctx, tx, func(db *gorm.DB) error {
			if err := r.lockOwner(db, owner); err != nil {
				return err
			}
			entries, err := readTrashTargets(db, owner, roots, limit)
			if err != nil {
				return err
			}
			ids, err := plan(entries)
			if err != nil {
				return err
			}
			removedIDs := make(map[string]bool, len(ids))
			for _, id := range ids {
				removedIDs[id] = true
			}
			now := r.clock.Now().UTC().Truncate(time.Second)
			var detached []blobCandidateRecord
			for _, entry := range entries {
				if removedIDs[entry.ID] {
					detached = append(detached, detachedBlobRecords(entry, model.Entry{}, now)...)
				}
			}
			if err := queueDetachedBlobs(db, detached); err != nil {
				return err
			}
			pinsRemoved := false
			for batch := range slices.Chunk(ids, trashRemovalBatchSize) {
				if err := db.Where("owner_id = ? AND entry_id IN ?", owner, batch).Delete(&directLinkRecord{}).Error; err != nil {
					return err
				}
				deleted := db.Where("owner_id = ? AND id IN ?", owner, batch).Delete(&entryRecord{})
				if deleted.Error != nil {
					return deleted.Error
				}
				if deleted.RowsAffected != int64(len(batch)) {
					return model.ErrConflict
				}
				pins := db.Where("owner_id = ? AND target_kind IN ? AND target_id IN ?", owner, []model.PinKind{model.PinFolder, model.PinShortcut}, batch).Delete(&pinRecord{})
				if pins.Error != nil {
					return pins.Error
				}
				pinsRemoved = pinsRemoved || pins.RowsAffected != 0
			}
			if pinsRemoved {
				return bumpPinRevision(db, owner)
			}
			return nil
		})
	})
}

// readTrashTargets 只展开选中项及后代。根列表为空表示整篮清理。
func readTrashTargets(db *gorm.DB, owner string, roots []string, limit int) ([]model.Entry, error) {
	if owner == "" {
		return nil, model.ErrMissing
	}
	if limit < 1 || limit > service.MaxTrashPurgeEntries {
		return nil, model.ErrInvalid
	}
	var records []entryRecord
	base := db.Where("owner_id = ?", owner)
	if len(roots) == 0 {
		if err := base.Session(&gorm.Session{}).Where("trashed_at IS NOT NULL").Limit(limit + 1).Find(&records).Error; err != nil {
			return nil, err
		}
	} else {
		for batch := range slices.Chunk(roots, trashRemovalBatchSize) {
			var selected []entryRecord
			if err := base.Session(&gorm.Session{}).Where("id IN ?", batch).Find(&selected).Error; err != nil {
				return nil, err
			}
			records = append(records, selected...)
		}
	}
	if len(records) > limit {
		return nil, model.ErrTooLarge
	}
	// 未回收的选中项供确认检查使用，只在确为回收根后代时展开。
	pending := make([]string, 0, len(records))
	enqueued := make(map[string]bool, len(records))
	for _, record := range records {
		enqueued[record.ID] = record.TrashedAt != nil
		if record.TrashedAt != nil {
			pending = append(pending, record.ID)
		}
	}
	for start := 0; start < len(pending); {
		end := min(len(pending), start+trashRemovalBatchSize)
		var children []entryRecord
		if err := base.Session(&gorm.Session{}).Where("parent_id IN ?", pending[start:end]).Limit(limit + 1).Find(&children).Error; err != nil {
			return nil, err
		}
		start = end
		// 查询结果不包含重复 ID，单批满额即说明选区超过上限。
		if len(children) > limit {
			return nil, model.ErrTooLarge
		}
		for _, record := range children {
			queued, known := enqueued[record.ID]
			if !known {
				if len(records) == limit {
					return nil, model.ErrTooLarge
				}
				records = append(records, record)
			}
			if !queued {
				enqueued[record.ID] = true
				pending = append(pending, record.ID)
			}
		}
	}
	return entryModels(records)
}

func bumpPinRevision(db *gorm.DB, owner string) error {
	updated := db.Model(&navigationState{}).Where("owner_id = ? AND revision < ?", owner, int64(math.MaxInt64)).Update("revision", gorm.Expr("revision + 1"))
	if updated.Error != nil {
		return updated.Error
	}
	if updated.RowsAffected != 1 {
		return fmt.Errorf("file pin cleanup revision invariant")
	}
	return nil
}
