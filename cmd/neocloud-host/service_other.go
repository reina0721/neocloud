//go:build !windows

package main

import "context"

func runService(ctx context.Context, _ string, run func(context.Context) error) error {
	return run(ctx)
}
