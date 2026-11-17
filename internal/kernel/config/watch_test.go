package config

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"testing/synctest"
	"time"

	"github.com/fsnotify/fsnotify"
)

func TestWatchFilesDebouncesChanges(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "config.yaml")
		backend := &fakeWatchBackend{events: make(chan fsnotify.Event), errors: make(chan error)}
		ctx, cancel := context.WithCancel(t.Context())
		defer cancel()
		changes := make(chan struct{}, 2)
		ready := make(chan struct{})
		done := make(chan error, 1)
		go func() {
			done <- watchFiles(ctx, []string{path}, 50*time.Millisecond, WatchCallbacks{
				OnReady: func() { close(ready) }, OnChange: func() { changes <- struct{}{} },
			}, func() (watchBackend, error) { return backend, nil })
		}()
		synctest.Wait()
		select {
		case <-ready:
		default:
			t.Fatal("watcher did not register before changes")
		}
		assertQuiet := func() {
			t.Helper()
			select {
			case <-changes:
				t.Fatal("watcher emitted a change before the quiet interval or repeated a debounced change")
			default:
			}
		}
		// 虚拟时钟明确证明三次事件都在防抖区间内，不假定 CI 能在 50ms 内完成三次磁盘写入。
		for range 3 {
			backend.events <- fsnotify.Event{Name: path, Op: fsnotify.Write}
			synctest.Wait()
			assertQuiet()
			time.Sleep(10 * time.Millisecond)
		}
		time.Sleep(39 * time.Millisecond)
		synctest.Wait()
		assertQuiet()
		time.Sleep(time.Millisecond)
		synctest.Wait()
		select {
		case <-changes:
		default:
			t.Fatal("watcher did not emit after the quiet interval")
		}
		time.Sleep(150 * time.Millisecond)
		synctest.Wait()
		assertQuiet()
		// 区间结束后的真实新事件必须产生下一次通知，不能被错误去重。
		backend.events <- fsnotify.Event{Name: path, Op: fsnotify.Write}
		synctest.Wait()
		time.Sleep(50 * time.Millisecond)
		synctest.Wait()
		select {
		case <-changes:
		default:
			t.Fatal("watcher dropped a later change")
		}
		cancel()
		synctest.Wait()
		if err := <-done; err != nil {
			t.Fatalf("watcher shutdown: %v", err)
		}
	})
}

func TestWatchFilesReportsReadyBeforeChangesAndSupportsRenameSave(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "config.yaml")
	if err := os.WriteFile(path, []byte("value: one\n"), 0o600); err != nil {
		t.Fatalf("write initial config: %v", err)
	}

	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	events := make(chan string, 2)
	done := make(chan error, 1)
	go func() {
		done <- WatchFiles(ctx, []string{path}, 20*time.Millisecond, WatchCallbacks{
			OnReady:  func() { events <- "ready" },
			OnChange: func() { events <- "change" },
		})
	}()

	select {
	case event := <-events:
		if event != "ready" {
			t.Fatalf("first event = %q, want ready", event)
		}
	case err := <-done:
		t.Fatalf("WatchFiles() returned before ready: %v", err)
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for watcher ready")
	}

	temporary := filepath.Join(directory, "config.yaml.next")
	if err := os.WriteFile(temporary, []byte("value: two\n"), 0o600); err != nil {
		t.Fatalf("write replacement config: %v", err)
	}
	if err := os.Rename(temporary, path); err != nil {
		t.Fatalf("rename replacement config: %v", err)
	}
	select {
	case event := <-events:
		if event != "change" {
			t.Fatalf("second event = %q, want change", event)
		}
	case err := <-done:
		t.Fatalf("WatchFiles() returned before change: %v", err)
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for rename-save change")
	}

	if err := os.Remove(path); err != nil {
		t.Fatalf("remove config: %v", err)
	}
	if err := os.WriteFile(path, []byte("value: three\n"), 0o600); err != nil {
		t.Fatalf("recreate config: %v", err)
	}
	select {
	case event := <-events:
		if event != "change" {
			t.Fatalf("third event = %q, want change", event)
		}
	case err := <-done:
		t.Fatalf("WatchFiles() returned before remove-create change: %v", err)
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for remove-create change")
	}

	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("WatchFiles() shutdown error = %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("timed out stopping config watcher")
	}
}

func TestWatchFilesValidatesCallbacks(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte("value: one\n"), 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}
	if err := WatchFiles(t.Context(), []string{path}, time.Millisecond, WatchCallbacks{}); err == nil {
		t.Fatal("WatchFiles(nil ready callback) error = nil")
	}
	if err := WatchFiles(t.Context(), []string{path}, time.Millisecond, WatchCallbacks{OnReady: func() {}}); err == nil {
		t.Fatal("WatchFiles(nil change callback) error = nil")
	}
}

func TestWatchFilesFailsWhenParentDirectoryCannotBeRegistered(t *testing.T) {
	path := filepath.Join(t.TempDir(), "missing", "config.yaml")
	err := WatchFiles(t.Context(), []string{path}, time.Millisecond, WatchCallbacks{
		OnReady:  func() {},
		OnChange: func() {},
	})
	if err == nil {
		t.Fatal("WatchFiles(missing parent) error = nil")
	}
}

func TestWatchFilesPreservesAddAndCloseErrors(t *testing.T) {
	addErr := errors.New("add failed")
	closeErr := errors.New("close failed")
	backend := &fakeWatchBackend{
		events:   make(chan fsnotify.Event),
		errors:   make(chan error),
		addErr:   addErr,
		closeErr: closeErr,
	}
	err := watchFiles(t.Context(), []string{filepath.Join(t.TempDir(), "config.yaml")}, time.Millisecond, WatchCallbacks{
		OnReady: func() {}, OnChange: func() {},
	}, func() (watchBackend, error) { return backend, nil })
	if !errors.Is(err, addErr) || !errors.Is(err, closeErr) {
		t.Fatalf("watchFiles() error = %v, want add and close errors", err)
	}
}

type fakeWatchBackend struct {
	events   chan fsnotify.Event
	errors   chan error
	addErr   error
	closeErr error
}

func (b *fakeWatchBackend) Add(string) error              { return b.addErr }
func (b *fakeWatchBackend) Events() <-chan fsnotify.Event { return b.events }
func (b *fakeWatchBackend) Errors() <-chan error          { return b.errors }
func (b *fakeWatchBackend) Close() error                  { return b.closeErr }
