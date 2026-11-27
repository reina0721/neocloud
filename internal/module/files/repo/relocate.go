package repo

import (
	"context"
	"fmt"

	"github.com/reina0721/neocloud/pkg/database"
	"gorm.io/gorm"
)

// RebindManagedPaths replaces both known binding rows atomically on an isolated copy.
func RebindManagedPaths(ctx context.Context, client database.Client, contentOld, contentNew, stagingOld, stagingNew string) error {
	return client.WithinTx(ctx, func(ctx context.Context, tx database.Tx) error {
		return database.UseGORMTx(ctx, tx, func(db *gorm.DB) error {
			for _, binding := range []struct {
				model any
				from  string
				to    string
			}{
				{&storageBinding{}, contentOld, contentNew},
				{&transferStagingBinding{}, stagingOld, stagingNew},
			} {
				result := db.Model(binding.model).Where("id = ? AND identity = ?", primaryStorageID, binding.from).
					UpdateColumn("identity", binding.to)
				if result.Error != nil {
					return result.Error
				}
				if result.RowsAffected != 1 {
					return fmt.Errorf("内容存储或上传暂存的源位置与实例记录不符")
				}
			}
			return nil
		})
	})
}
