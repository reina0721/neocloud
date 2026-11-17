package kernel

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

// watcher 的短暂读取不允许删除共享；仅对 Win32 共享冲突重试原子替换，
// 不先删除旧配置，也不修改 watcher 恢复断言的等待预算。
func renameWatchRecoveryConfig(from, to string) error {
	for attempt := 0; ; attempt++ {
		err := os.Rename(from, to)
		transient := errors.Is(err, windows.ERROR_SHARING_VIOLATION) || errors.Is(err, windows.ERROR_ACCESS_DENIED)
		if err == nil || !transient || attempt == 19 {
			return err
		}
		time.Sleep(25 * time.Millisecond)
	}
}

func TestRecoveryPublishPreservesBothFilesWhenReaderKeepsDeleteLocked(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	next := path + ".next"
	if err := os.WriteFile(path, []byte("original"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(next, []byte("candidate"), 0o600); err != nil {
		t.Fatal(err)
	}
	reader, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = reader.Close() })
	done := make(chan error, 1)
	go func() { done <- renameWatchRecoveryConfig(next, path) }()
	select {
	case err := <-done:
		if !errors.Is(err, windows.ERROR_SHARING_VIOLATION) && !errors.Is(err, windows.ERROR_ACCESS_DENIED) {
			t.Fatalf("publish while locked = %v, want sharing violation", err)
		}
	case <-time.After(3 * time.Second):
		_ = reader.Close()
		<-done
		t.Fatal("publish did not stop after bounded sharing retries")
	}
	for file, want := range map[string]string{path: "original", next: "candidate"} {
		got, err := os.ReadFile(file)
		if err != nil || string(got) != want {
			t.Fatalf("read %s = %q, %v; want %q", file, got, err, want)
		}
	}
}
