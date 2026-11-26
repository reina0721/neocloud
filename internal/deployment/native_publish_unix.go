//go:build !windows

package deployment

import (
	"os"
	"path/filepath"
)

func publishNativeDirectory(store *os.Root, stageName, version string) error {
	if err := syncDirectory(filepath.Join(store.Name(), stageName)); err != nil {
		return err
	}
	if err := store.Rename(stageName, version); err != nil {
		return err
	}
	return syncDirectory(store.Name())
}
