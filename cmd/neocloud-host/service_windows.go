package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows/svc"
)

type handler struct {
	ctx context.Context
	run func(context.Context) error
}

func runService(ctx context.Context, name string, run func(context.Context) error) error {
	service, err := svc.IsWindowsService()
	if err != nil {
		return err
	}
	if !service {
		return run(ctx)
	}
	if name == "" {
		name = "NeoCloudNative"
		if strings.EqualFold(filepath.Base(os.Args[0]), "clouddrive-host.exe") {
			name = "CloudDriveNative"
		}
	}
	return svc.Run(name, handler{ctx: ctx, run: run})
}

func (h handler) Execute(_ []string, changes <-chan svc.ChangeRequest, statuses chan<- svc.Status) (bool, uint32) {
	ctx, stop := context.WithCancel(h.ctx)
	defer stop()
	status := svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}
	statuses <- status
	done := make(chan error, 1)
	go func() { done <- h.run(ctx) }()
	for {
		select {
		case request := <-changes:
			switch request.Cmd {
			case svc.Interrogate:
				statuses <- status
			case svc.Stop, svc.Shutdown:
				status = svc.Status{State: svc.StopPending, WaitHint: 30000}
				statuses <- status
				stop()
			}
		case err := <-done:
			if err != nil {
				_, _ = fmt.Fprintln(os.Stderr, err)
				return true, 1
			}
			return false, 0
		}
	}
}
