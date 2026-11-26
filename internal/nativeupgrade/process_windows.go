package nativeupgrade

import (
	"errors"
	"os/exec"
	"runtime"
	"unsafe"

	"golang.org/x/sys/windows"
)

func configureChild(*exec.Cmd) {}

func ownChildTree(cmd *exec.Cmd) (func() error, error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return nil, err
	}
	limits := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	limits.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	// #nosec G103 -- 此 Windows API 同步读取固定 ABI 结构，调用期间保留 Go 对象。
	_, err = windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&limits)), uint32(unsafe.Sizeof(limits)))
	runtime.KeepAlive(limits)
	if err == nil {
		var assignErr error
		err = errors.Join(cmd.Process.WithHandle(func(handle uintptr) {
			assignErr = windows.AssignProcessToJobObject(job, windows.Handle(handle))
		}), assignErr)
	}
	if err != nil {
		_ = windows.CloseHandle(job)
		return nil, err
	}
	return func() error { return windows.CloseHandle(job) }, nil
}
