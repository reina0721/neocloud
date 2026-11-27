package repo

import (
	"context"
	"database/sql"

	"github.com/reina0721/clouddrive/internal/module/files/model"
	"github.com/reina0721/clouddrive/internal/module/files/service"
	"github.com/reina0721/clouddrive/pkg/database"
	"gorm.io/gorm"
)

// readFileSnapshot 让分页、祖先、配额或待删除条目来自同一次读取。
func (r *Repository) readFileSnapshot(ctx context.Context, read func(*gorm.DB) error) error {
	return r.access.Use(ctx, func(client database.Client) error {
		return database.UseGORM(ctx, client, func(db *gorm.DB) error {
			// SQLite 在只读事务中使用延迟的 BEGIN，避开写事务的 immediate 锁。
			options := sql.TxOptions{ReadOnly: true}
			if driver := db.Dialector.Name(); driver == "postgres" || driver == "mysql" {
				options.Isolation = sql.LevelRepeatableRead
			}
			return db.Transaction(func(tx *gorm.DB) error {
				if err := read(tx); err != nil {
					return err
				}
				return r.checkStorage(tx)
			}, &options)
		})
	})
}

// ReadBounded 不将截断结果伪装为完整文件树，且读取后复核内容位置。
func (r *Repository) ReadBounded(ctx context.Context, owner string, limit int) ([]model.Entry, error) {
	if owner == "" {
		return nil, model.ErrMissing
	}
	if limit < 1 || limit > service.DefaultSearchTreeEntries {
		return nil, model.ErrInvalid
	}
	var result []model.Entry
	err := r.access.Use(ctx, func(client database.Client) error {
		return database.UseGORM(ctx, client, func(db *gorm.DB) error {
			entries, err := loadBoundedEntries(db, owner, limit)
			if err != nil {
				return err
			}
			if err := r.checkStorage(db); err != nil {
				return err
			}
			result = entries
			return nil
		})
	})
	return result, err
}
