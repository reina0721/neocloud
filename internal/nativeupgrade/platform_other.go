//go:build !windows && !linux

package nativeupgrade

import (
	"context"
	"errors"
	"net"
	"os"
	"os/exec"
)

var errUnsupported = errors.New("原生自升级仅支持 Windows 和 Linux")

func configureChild(*exec.Cmd)                              {}
func ownChildTree(*exec.Cmd) (func() error, error)          { return nil, errUnsupported }
func listenControl(string) (net.Listener, error)            { return nil, errUnsupported }
func dialControl(context.Context, string) (net.Conn, error) { return nil, errUnsupported }
func secureDirectory(string, os.FileInfo) error             { return errUnsupported }
