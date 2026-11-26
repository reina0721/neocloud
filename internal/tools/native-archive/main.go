// Command native-archive 打包原生 Web 追踪目录或托管 Go 发布产物。
package main

import (
	"archive/zip"
	"compress/flate"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"time"

	"github.com/reina0721/clouddrive/internal/deployment"
)

func main() {
	output := flag.String("output", "", "ZIP 输出路径")
	work := flag.String("work", "", "包含 Go 产物、说明和许可的包根目录")
	web := flag.String("web", "", "Next standalone 追踪目录")
	managed := flag.Bool("managed", false, "打包托管 Go 发布目录")
	verify := flag.String("verify-managed", "", "只读校验托管 Go 发布 ZIP")
	online := flag.String("stage-online", "", "从正式 GitHub 发布获取并验签至验证目录")
	offline := flag.String("stage-offline", "", "从本地已签名发布包验签并导入验证目录")
	releaseDir := flag.String("release-dir", "", "已签名发布包目录")
	trustDir := flag.String("trust-dir", "", "独立获取的 Sigstore 离线信任目录")
	version := flag.String("version", "", "托管发布的正式版本")
	commit := flag.String("commit", "", "托管发布的源码提交")
	goos := flag.String("os", "", "托管发布的目标系统")
	arch := flag.String("arch", "", "托管发布的目标架构")
	flag.Parse()
	if (*offline != "" && (*releaseDir == "" || *trustDir == "" || *online != "")) ||
		(*verify == "" && *online == "" && *offline == "" && (*output == "" || *work == "" || !*managed && *web == "")) {
		flag.Usage()
		os.Exit(2)
	}
	var err error
	switch {
	case *online != "":
		err = stageRelease(*online, "", "", *version, *commit)
	case *offline != "":
		err = stageRelease(*offline, *releaseDir, *trustDir, *version, *commit)
	case *verify != "":
		err = verifyManagedArchive(*verify, *version, *commit, *goos, *arch)
	case *managed:
		err = writeArchive(*output, func(writer *zip.Writer) error {
			return addTree(writer, *work, "", nil)
		})
		if err == nil {
			err = verifyManagedArchive(*output, *version, *commit, *goos, *arch)
		}
	default:
		err = createArchive(*output, *work, *web)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func stageRelease(directory, releaseDir, trustDir, version, commit string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()
	var target deployment.NativeTarget
	var err error
	if releaseDir == "" {
		target, err = deployment.NewReleases().StageNative(ctx, directory, version)
	} else {
		target, err = deployment.ImportNative(ctx, directory, releaseDir, trustDir, version)
	}
	if err != nil {
		return err
	}
	if target.Manifest.Commit != commit {
		return errors.New("原生发布包源码提交与发布版本不一致")
	}
	_, err = deployment.LoadNative(ctx, directory, version)
	return err
}

func verifyManagedArchive(archive, version, commit, goos, arch string) error {
	manifest, err := deployment.InspectNativeArchive(archive, version, goos, arch)
	if err != nil {
		return err
	}
	if manifest.Commit != commit {
		return errors.New("原生发布包源码提交与发布版本不一致")
	}
	return nil
}

func createArchive(output, work, web string) error {
	workDir, err := os.OpenRoot(work)
	if err != nil {
		return err
	}
	manifest, err := workDir.ReadFile(".standalone-links.json")
	err = errors.Join(err, workDir.Close())
	if err != nil {
		return err
	}
	var links []struct{ Path string }
	if err := json.Unmarshal(manifest, &links); err != nil {
		return fmt.Errorf("读取 Web 依赖链接清单: %w", err)
	}
	excluded := make(map[string]struct{}, len(links))
	for _, link := range links {
		excluded[filepath.Clean(link.Path)] = struct{}{}
	}
	return writeArchive(output, func(archive *zip.Writer) error {
		if err := addTree(archive, work, "clouddrive", nil); err != nil {
			return err
		}
		return addTree(archive, web, "clouddrive/web", excluded)
	})
}

func writeArchive(output string, write func(*zip.Writer) error) (result error) {
	// #nosec G304 -- 输出路径由打包命令显式指定，已有文件不会被覆盖。
	file, err := os.OpenFile(output, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer func() { result = errors.Join(result, file.Close()) }()
	archive := zip.NewWriter(file)
	defer func() { result = errors.Join(result, archive.Close()) }()
	compressor, err := flate.NewWriter(io.Discard, flate.BestSpeed)
	if err != nil {
		return err
	}
	// zip.Writer 在开始下一项前结束上一项，可以复用同一个压缩器。
	archive.RegisterCompressor(zip.Deflate, func(writer io.Writer) (io.WriteCloser, error) {
		compressor.Reset(writer)
		return compressor, nil
	})
	return write(archive)
}

func addTree(archive *zip.Writer, directory, prefix string, excluded map[string]struct{}) (result error) {
	root, err := os.OpenRoot(directory)
	if err != nil {
		return err
	}
	defer func() { result = errors.Join(result, root.Close()) }()
	return fs.WalkDir(root.FS(), ".", func(relative string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if prefix == "" && relative == "." {
			return nil
		}
		// Windows junction 可能表现为 ModeIrregular。使用链接清单判断，
		// 解包后由 Web 入口重建链接。
		if _, skipped := excluded[filepath.FromSlash(relative)]; skipped {
			if entry.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !info.IsDir() && !info.Mode().IsRegular() {
			return fmt.Errorf("无法归档文件类型 %s: %s", info.Mode(), relative)
		}
		header, err := zip.FileInfoHeader(info)
		if err != nil {
			return err
		}
		header.Name = path.Join(prefix, relative)
		if info.IsDir() {
			header.Name += "/"
		} else {
			header.Method = zip.Deflate
		}
		writer, err := archive.CreateHeader(header)
		if err != nil || info.IsDir() {
			return err
		}
		input, err := root.Open(filepath.FromSlash(relative))
		if err != nil {
			return err
		}
		_, copyErr := io.Copy(writer, input)
		return errors.Join(copyErr, input.Close())
	})
}
