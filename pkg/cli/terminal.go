package cli

import (
	"errors"
	"fmt"
	"io"
	"os"

	"golang.org/x/term"
)

// SecureTerminal 用于同一次交互中的普通输入和无回显密码输入。
type SecureTerminal interface {
	io.Writer
	SetPrompt(string)
	ReadLine() (string, error)
	ReadPassword(string) (string, error)
}

func IsInteractiveTerminal(input io.Reader, output io.Writer) bool {
	stdin, inputOK := input.(*os.File)
	stdout, outputOK := output.(*os.File)
	return inputOK && outputOK && term.IsTerminal(int(stdin.Fd())) && term.IsTerminal(int(stdout.Fd()))
}

// OpenSecureTerminal 启用交互模式，调用方须在操作完成时调用 restore。
func OpenSecureTerminal(input io.Reader, output io.Writer) (terminal SecureTerminal, restore func() error, err error) {
	if !IsInteractiveTerminal(input, output) {
		return nil, nil, errors.New("交互操作需要终端")
	}
	stdin, stdout := input.(*os.File), output.(*os.File)
	fd := int(stdin.Fd())
	state, err := term.MakeRaw(fd)
	if err != nil {
		return nil, nil, fmt.Errorf("启用安全终端输入: %w", err)
	}
	restore = func() error {
		if err := term.Restore(fd, state); err != nil {
			return fmt.Errorf("恢复终端状态: %w", err)
		}
		return nil
	}
	value := term.NewTerminal(struct {
		io.Reader
		io.Writer
	}{stdin, stdout}, "")
	if width, height, err := term.GetSize(int(stdout.Fd())); err == nil {
		if err := value.SetSize(width, height); err != nil {
			return nil, nil, errors.Join(fmt.Errorf("设置终端尺寸: %w", err), restore())
		}
	}
	return value, restore, nil
}
