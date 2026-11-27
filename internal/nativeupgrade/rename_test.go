package nativeupgrade

import (
	"os"
	"path/filepath"
	"testing"
)

func TestRenameCopyPreservesDataWithoutCopyingFence(t *testing.T) {
	source, target := t.TempDir(), t.TempDir()
	if err := os.Mkdir(filepath.Join(source, ".native-upgrade"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := setRenameFence(source, target, false); err != nil {
		t.Fatal(err)
	}
	data := []byte("pending upload bytes")
	if err := os.WriteFile(filepath.Join(source, "blob"), data, 0600); err != nil {
		t.Fatal(err)
	}
	size, err := renameTree(t.Context(), source, target)
	if err != nil || size != int64(len(data)) {
		t.Fatalf("copy: %d, %v", size, err)
	}
	copied, err := os.ReadFile(filepath.Join(target, "blob"))
	if err != nil || string(copied) != string(data) {
		t.Fatalf("copied data: %q, %v", copied, err)
	}
	if _, err := os.Stat(filepath.Join(target, renameFence)); !os.IsNotExist(err) {
		t.Fatalf("stale fence copied: %v", err)
	}
	if checkRenameFence(source, target, false) != nil || checkRenameFence(source, target, true) == nil {
		t.Fatal("retired copy must not be recognized as a prepared copy")
	}
}
