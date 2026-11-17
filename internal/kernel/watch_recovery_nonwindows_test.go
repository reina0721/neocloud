//go:build !windows

package kernel

import "os"

func renameWatchRecoveryConfig(from, to string) error { return os.Rename(from, to) }
