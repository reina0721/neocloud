package repo

import (
	"context"

	"github.com/reina0721/neocloud/internal/module/files/model"
	"github.com/reina0721/neocloud/pkg/database"
	"gorm.io/gorm"
)

// SQLite 的递归查询只读取指定账号的目标和祖先。UNION 对循环中重复出现的
// 节点去重，最终可见性仍由 Files 的祖先校验决定。
const sqliteEntryPath = `
WITH RECURSIVE entry_path(id, parent_id) AS (
	SELECT id, parent_id FROM files_entries WHERE id = ? AND owner_id = ?
	UNION
	SELECT parent.id, parent.parent_id
	FROM entry_path AS child
	CROSS JOIN files_entries AS parent
	WHERE parent.id = child.parent_id AND parent.owner_id = ?
)
SELECT entry.*
FROM entry_path AS path
CROSS JOIN files_entries AS entry
WHERE entry.id = path.id AND entry.owner_id = ?
`

func (r *Repository) ReadEntryPath(ctx context.Context, owner, id string) ([]model.Entry, error) {
	var entries []model.Entry
	err := r.access.Use(ctx, func(client database.Client) error {
		return database.UseGORM(ctx, client, func(db *gorm.DB) error {
			var err error
			if db.Dialector.Name() == "sqlite" {
				var records []entryRecord
				if err := db.Raw(sqliteEntryPath, id, owner, owner, owner).Scan(&records).Error; err != nil {
					return err
				}
				entries, err = entryModels(records)
			} else {
				entries, err = loadEntries(db, owner)
			}
			if err != nil {
				return err
			}
			return r.checkStorage(db)
		})
	})
	return entries, err
}
