package deployment

import (
	"os"
	"path/filepath"

	"golang.org/x/sys/windows"
)

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
