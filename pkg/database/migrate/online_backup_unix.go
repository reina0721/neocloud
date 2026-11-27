//go:build !windows

package migrate

import (
	"errors"
	"os"
	"path/filepath"
)

func publishOnlineBackup(temporary, ready string) error {
	if err := os.Rename(temporary, ready); err != nil {
		return err
	}
	directory, err := os.Open(filepath.Dir(ready))
	if err != nil {
		return err
	}
	return errors.Join(directory.Sync(), directory.Close())
}
