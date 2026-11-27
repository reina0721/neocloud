package main

import (
	"context"
	"encoding/json"
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
	full := flag.Bool("full", false, "首次启动原生 Go 与 Web 整包")
	adopt := flag.Bool("adopt-full", false, "接管已有 Go-only 实例并启动签名整包")
	prepare := flag.Bool("prepare-full", false, "提前验签整包并只读检查实例")
	webAddress := flag.String("web-addr", "", "沿用已有站点的监听地址，默认使用 Go 业务地址")
	flag.Parse()
	if flag.NArg() != 0 {
		flag.Usage()
		os.Exit(2)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	bootstrap := nativeupgrade.Bootstrap{
		Version: *initial, ReleaseDirectory: *releaseDir, TrustDirectory: *trustDir,
		Full: *full, AdoptFull: *adopt, WebAddress: *webAddress,
	}
	if *prepare {
		result, err := nativeupgrade.PrepareFull(ctx, *root, bootstrap)
		if err == nil {
			err = json.NewEncoder(os.Stdout).Encode(result)
		}
		if err != nil {
			_, _ = fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	if err := runService(ctx, func(ctx context.Context) error { return nativeupgrade.Run(ctx, *root, bootstrap) }); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
