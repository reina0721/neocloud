package nativeupgrade

import (
	"context"
	"crypto/sha256"
	"fmt"
	"net"
	"os"
	"strings"

	"github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
)

func secureDirectory(path string, _ os.FileInfo) error {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return err
	}
	descriptor, err := windows.SecurityDescriptorFromString("D:P(A;OICI;FA;;;" + user.User.Sid.String() + ")(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)")
	if err != nil {
		return err
	}
	dacl, _, err := descriptor.DACL()
	if err != nil {
		return err
	}
	return windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, dacl, nil)
}

func pipePath(root string) string {
	digest := sha256.Sum256([]byte(strings.ToLower(root)))
	return fmt.Sprintf(`\\.\pipe\CloudDrive-%x`, digest[:16])
}

func listenControl(root string) (net.Listener, error) {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return nil, err
	}
	return winio.ListenPipe(pipePath(root), &winio.PipeConfig{
		SecurityDescriptor: "D:P(A;;GA;;;" + user.User.Sid.String() + ")(A;;GA;;;BA)(A;;GA;;;SY)",
	})
}

func dialControl(ctx context.Context, root string) (net.Conn, error) {
	return winio.DialPipeAccessImpLevel(ctx, pipePath(root), windows.GENERIC_READ|windows.GENERIC_WRITE, winio.PipeImpLevelIdentification)
}
