package tus

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/reina0721/neocloud/internal/module/files/model"
	"github.com/tus/tusd/v2/pkg/filestore"
)

// RelocateInfo updates paths only in the offline copy of the project-owned tus store.
func RelocateInfo(ctx context.Context, previous, copied, target string) error {
	entries, err := os.ReadDir(copied)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return err
		}
		name := entry.Name()
		if !strings.HasSuffix(name, ".info") {
			continue
		}
		id := strings.TrimSuffix(name, ".info")
		if model.ValidateTransferID(id) != nil {
			return fmt.Errorf("无效的上传暂存记录 ID: %s", name)
		}
		if err := relocateInfoFile(filepath.Join(copied, name), id, previous, target); err != nil {
			return fmt.Errorf("迁移上传暂存记录 %s: %w", id, err)
		}
	}
	return nil
}

func relocateInfoFile(path, id, from, to string) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var record map[string]json.RawMessage
	if err := json.Unmarshal(raw, &record); err != nil {
		return err
	}
	var storedID string
	if err := json.Unmarshal(record["ID"], &storedID); err != nil || storedID != id {
		return fmt.Errorf("上传暂存记录与文件名不符")
	}
	var storage map[string]string
	if err := json.Unmarshal(record["Storage"], &storage); err != nil || storage["Type"] != "filestore" {
		return fmt.Errorf("上传暂存记录使用未知存储")
	}
	for key, name := range map[string]string{filestore.StorageKeyPath: id, filestore.StorageKeyInfoPath: id + ".info"} {
		if filepath.Clean(storage[key]) != filepath.Join(from, name) {
			return fmt.Errorf("暂存记录引用原目录之外的路径: %s", key)
		}
		storage[key] = filepath.Join(to, name)
	}
	record["Storage"], err = json.Marshal(storage)
	if err != nil {
		return err
	}
	encoded, err := json.Marshal(record)
	if err != nil {
		return err
	}
	return os.WriteFile(path, encoded, 0600)
}
