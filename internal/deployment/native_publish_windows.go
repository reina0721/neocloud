package deployment

import (
	"os"
	"path/filepath"

	"golang.org/x/sys/windows"
)

// Each extracted file is flushed before the containing directory is moved
// into the version store with MOVEFILE_WRITE_THROUGH.
func syncNativeWeb(_ *os.Root, _ []string) error {
	return nil
}

func publishNativeDirectory(store *os.Root, stageName, version string) error {
	from, err := windows.UTF16PtrFromString(filepath.Join(store.Name(), stageName))
	if err != nil {
		return err
	}
	to, err := windows.UTF16PtrFromString(filepath.Join(store.Name(), version))
	if err != nil {
		return err
	}
	return windows.MoveFileEx(from, to, windows.MOVEFILE_WRITE_THROUGH)
}
