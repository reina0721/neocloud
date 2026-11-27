package tus

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/tus/tusd/v2/pkg/filestore"
)

func TestRelocateInfoPreservesUploadAndOriginalPaths(t *testing.T) {
	source, copied, target := t.TempDir(), t.TempDir(), t.TempDir()
	id := "86d3c40a-f48b-4daa-8b40-79027658fafe"
	record := struct {
		ID      string
		Offset  int
		Storage map[string]string
	}{
		ID: id, Offset: 8,
		Storage: map[string]string{
			"Type": "filestore", filestore.StorageKeyPath: filepath.Join(source, id),
			filestore.StorageKeyInfoPath: filepath.Join(source, id+".info"),
		},
	}
	raw, err := json.Marshal(record)
	if err != nil {
		t.Fatal(err)
	}
	for _, dir := range []string{source, copied} {
		if err := os.WriteFile(filepath.Join(dir, id+".info"), raw, 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := RelocateInfo(t.Context(), source, copied, target); err != nil {
		t.Fatal(err)
	}
	migrated, err := os.ReadFile(filepath.Join(copied, id+".info"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(migrated, &record); err != nil {
		t.Fatal(err)
	}
	if record.Offset != 8 || record.Storage[filestore.StorageKeyPath] != filepath.Join(target, id) ||
		record.Storage[filestore.StorageKeyInfoPath] != filepath.Join(target, id+".info") {
		t.Fatalf("migration changed upload data: %+v", record)
	}
	prior, err := os.ReadFile(filepath.Join(source, id+".info"))
	if err != nil || string(prior) != string(raw) {
		t.Fatalf("original upload record changed: %v", err)
	}
}
