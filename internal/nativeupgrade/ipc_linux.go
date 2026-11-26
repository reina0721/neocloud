package nativeupgrade

import (
	"context"
	"errors"
	"net"
	"os"
	"path/filepath"
	"syscall"

	"github.com/reina0721/clouddrive/internal/deployment"
)

func secureDirectory(_ string, info os.FileInfo) error {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || int64(stat.Uid) != int64(os.Geteuid()) || info.Mode().Perm()&0077 != 0 {
		return errors.New("升级控制目录必须属于当前服务用户，且禁止其他用户访问")
	}
	return nil
}

func listenControl(root string) (net.Listener, error) {
	address := filepath.Join(root, controlDirectory, "host.sock")
	listener, err := deployment.SocketListener(address)
	if err != nil {
		return nil, err
	}
	if err := os.Chmod(address, 0600); err != nil {
		return nil, errors.Join(err, listener.Close())
	}
	return listener, nil
}

func dialControl(ctx context.Context, root string) (net.Conn, error) {
	return (&net.Dialer{}).DialContext(ctx, "unix", filepath.Join(root, controlDirectory, "host.sock"))
}
