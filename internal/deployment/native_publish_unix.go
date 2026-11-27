//go:build !windows

package deployment

import (
	"errors"
	"os"
	"path/filepath"
)

func syncNativeWeb(root *os.Root, directories []string) error {
	// Child directory entries must reach disk before their parent and the
	// containing version directory are published.
	for index := len(directories) - 1; index >= 0; index-- {
		if err := syncNativeRelativeDirectory(root, directories[index]); err != nil {
			return err
		}
	}
	return syncNativeRelativeDirectory(root, ".")
}

func syncNativeRelativeDirectory(root *os.Root, name string) error {
	dir, err := root.Open(name)
	if err != nil {
		return err
	}
	return errors.Join(dir.Sync(), dir.Close())
}

func publishNativeDirectory(store *os.Root, stageName, version string) error {
	if err := syncDirectory(filepath.Join(store.Name(), stageName)); err != nil {
		return err
	}
	if err := store.Rename(stageName, version); err != nil {
		return err
	}
	return syncDirectory(store.Name())
}

func replaceDeploymentFile(source, target string) error {
	if err := os.Rename(source, target); err != nil {
		return err
	}
	return syncDirectory(filepath.Dir(target))
}
