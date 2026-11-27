package repo

import (
	"context"
	"slices"

	"github.com/reina0721/clouddrive/internal/module/files/model"
	"github.com/reina0721/clouddrive/internal/module/files/service"
	"gorm.io/gorm"
)

func (r *Repository) ReadDirectory(ctx context.Context, owner string, query service.DirectoryQuery) (service.DirectoryPage, error) {
	if owner == "" {
		return service.DirectoryPage{}, model.ErrMissing
	}
	var page service.DirectoryPage
	err := r.readFileSnapshot(ctx, func(db *gorm.DB) error {
		var err error
		page.Ancestors, err = readDirectoryAncestors(db, owner, query.ParentID, query.Trash)
		if err != nil {
			return err
		}
		base := db.Model(&entryRecord{}).Where("owner_id = ?", owner)
		if !query.AllTrash {
			base = base.Where("parent_id = ?", query.ParentID)
		}
		if query.Trash {
			base = base.Where("trashed_at IS NOT NULL")
		} else {
			base = base.Where("trashed_at IS NULL")
		}
		id := directoryBinaryColumn(db.Dialector.Name(), "id")
		orderBy := directoryOrderBy(db.Dialector.Name(), query.Sort, query.Desc, query.FoldersFirst, id)
		var total int64
		if err := base.Session(&gorm.Session{}).Count(&total).Error; err != nil {
			return err
		}
		page.Total, page.Offset = int(total), query.Offset
		limit := query.PageSize
		if limit == 0 {
			if total > service.DefaultSearchTreeEntries {
				return model.ErrTooLarge
			}
			limit = service.DefaultSearchTreeEntries
		}
		if query.AnchorID != "" {
			var anchor entryRecord
			found := base.Session(&gorm.Session{}).Where("id = ?", query.AnchorID).Limit(1).Find(&anchor)
			if found.Error != nil {
				return found.Error
			}
			if found.RowsAffected != 1 || anchor.ID != query.AnchorID {
				return model.ErrConflict
			}
			page.Anchor, err = anchor.model()
			if err != nil {
				return err
			}
			before, args := orderBy.before(anchor)
			var preceding int64
			if err := base.Session(&gorm.Session{}).Where(before, args...).Count(&preceding).Error; err != nil {
				return err
			}
			if query.BeforeAnchor {
				limit = min(limit, int(preceding))
				page.Offset = int(preceding) - limit
			} else {
				page.Offset = int(preceding) + 1
			}
		}
		var records []entryRecord
		if limit > 0 && page.Offset < page.Total {
			if err := base.Order(orderBy.sql()).Offset(page.Offset).Limit(limit).Find(&records).Error; err != nil {
				return err
			}
		}
		page.Entries, err = entryModels(records)
		if err != nil {
			return err
		}
		page.UsedBytes, err = readDirectoryUsage(db, owner)
		return err
	})
	return page, err
}

func readDirectoryAncestors(db *gorm.DB, owner, parent string, trash bool) ([]model.Entry, error) {
	var records []entryRecord
	seen := make(map[string]bool)
	for parent != "" {
		if seen[parent] || len(records) == service.DefaultSearchTreeEntries {
			return nil, model.ErrMissing
		}
		var record entryRecord
		found := db.Where("owner_id = ? AND id = ?", owner, parent).Limit(1).Find(&record)
		if found.Error != nil {
			return nil, found.Error
		}
		if found.RowsAffected != 1 || record.ID != parent || record.Kind != model.Folder || !trash && record.TrashedAt != nil {
			return nil, model.ErrMissing
		}
		records = append(records, record)
		seen[parent] = true
		parent = record.ParentID
	}
	slices.Reverse(records)
	return entryModels(records)
}

// readDirectoryUsage 只聚合账号自己的逻辑字节，包含回收站及每个历史关联。
func readDirectoryUsage(db *gorm.DB, owner string) (int64, error) {
	cte, args, err := blobReferenceCTEForOwner(db.Dialector.Name(), "", owner)
	if err != nil {
		return 0, err
	}
	var total int64
	err = db.Raw(cte+`
SELECT (SELECT COALESCE(SUM(size_bytes), 0) FROM files_entries WHERE owner_id = ?)
     + (SELECT COALESCE(SUM(size_bytes), 0) FROM blob_refs WHERE is_current = 0)`, append(args, owner)...).Scan(&total).Error
	return total, err
}

// 字符串 Go 排序使用 UTF-8 字节顺序，不采用部署数据库的语言排序规则。
func directoryBinaryColumn(driver, column string) string {
	switch driver {
	case "mysql":
		return "CAST(" + column + " AS BINARY)"
	case "postgres":
		return column + ` COLLATE "C"`
	default:
		return column + " COLLATE BINARY"
	}
}

const directoryFolderRank = "CASE WHEN kind = 'folder' THEN 0 ELSE 1 END"

type directoryOrdering struct {
	column       string
	id           string
	sort         service.SortKey
	desc         bool
	foldersFirst bool
}

func directoryOrderBy(driver string, sort service.SortKey, desc, foldersFirst bool, id string) directoryOrdering {
	column := directoryBinaryColumn(driver, "normalized_name")
	switch sort {
	case service.SortSize:
		column = "size_bytes"
	case service.SortCreated:
		column = "created_at"
	case service.SortUpdated:
		column = "updated_at"
	}
	return directoryOrdering{column, id, sort, desc, foldersFirst}
}

func (o directoryOrdering) sql() string {
	direction := " ASC"
	if o.desc {
		direction = " DESC"
	}
	order := o.column + direction + ", " + o.id + direction
	if o.foldersFirst {
		order = directoryFolderRank + " ASC, " + order
	}
	return order
}

func (o directoryOrdering) before(anchor entryRecord) (string, []any) {
	var value any = anchor.NormalizedName
	switch o.sort {
	case service.SortSize:
		value = anchor.SizeBytes
	case service.SortCreated:
		value = anchor.CreatedAt
	case service.SortUpdated:
		value = anchor.UpdatedAt
	}
	op := " < ?"
	if o.desc {
		op = " > ?"
	}
	before := "(" + o.column + op + " OR (" + o.column + " = ? AND " + o.id + op + "))"
	args := []any{value, value, anchor.ID}
	if o.foldersFirst {
		rank := 1
		if anchor.Kind == model.Folder {
			rank = 0
		}
		before = "(" + directoryFolderRank + " < ? OR (" + directoryFolderRank + " = ? AND " + before + "))"
		args = append([]any{rank, rank}, args...)
	}
	return before, args
}
