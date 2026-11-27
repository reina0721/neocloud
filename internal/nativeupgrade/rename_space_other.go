//go:build !windows && !linux

package nativeupgrade

import "errors"

func renameFreeBytes(string) (uint64, error) {
	return 0, errors.New("当前平台不支持原生实例停机改名")
}
