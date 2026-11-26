package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/reina0721/clouddrive/internal/nativeupgrade"
)

func main() {
	root := flag.String("root", ".", "已准备配置与数据的原生实例目录")
	initial := flag.String("initial", "", "首次启动的已发布正式版本")
	releaseDir := flag.String("release-dir", "", "可选的本地签名发布目录")
	trustDir := flag.String("trust-dir", "", "独立准备的 Sigstore 信任目录")
	flag.Parse()
	if flag.NArg() != 0 {
		flag.Usage()
		os.Exit(2)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	bootstrap := nativeupgrade.Bootstrap{Version: *initial, ReleaseDirectory: *releaseDir, TrustDirectory: *trustDir}
	if err := runService(ctx, func(ctx context.Context) error { return nativeupgrade.Run(ctx, *root, bootstrap) }); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
