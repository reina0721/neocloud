// Command native-archive 将 Windows Web 追踪树和 Go 产物直接写入 ZIP。
package main

import (
	"archive/zip"
	"compress/flate"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
)

func main() {
	output := flag.String("output", "", "ZIP 输出路径")
	work := flag.String("work", "", "包含 Go 产物、说明和许可的包根目录")
	web := flag.String("web", "", "Next standalone 追踪目录")
	flag.Parse()
	if *output == "" || *work == "" || *web == "" {
		flag.Usage()
		os.Exit(2)
	}
	if err := createArchive(*output, *work, *web); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func createArchive(output, work, web string) (result error) {
	manifest, err := os.ReadFile(filepath.Join(work, ".standalone-links.json"))
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
	file, err := os.OpenFile(output, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
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
	if err := addTree(archive, work, "clouddrive", nil); err != nil {
		return err
	}
	return addTree(archive, web, "clouddrive/web", excluded)
}

func addTree(archive *zip.Writer, root, prefix string, excluded map[string]struct{}) error {
	return filepath.WalkDir(root, func(source string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, err := filepath.Rel(root, source)
		if err != nil {
			return err
		}
		// Windows junction 可能表现为 ModeIrregular。使用链接清单判断，
		// 解包后由 Web 入口重建链接。
		if _, skipped := excluded[relative]; skipped {
			if entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !info.IsDir() && !info.Mode().IsRegular() {
			return fmt.Errorf("无法归档文件类型 %s: %s", info.Mode(), source)
		}
		header, err := zip.FileInfoHeader(info)
		if err != nil {
			return err
		}
		header.Name = path.Join(prefix, filepath.ToSlash(relative))
		if info.IsDir() {
			header.Name += "/"
		} else {
			header.Method = zip.Deflate
		}
		writer, err := archive.CreateHeader(header)
		if err != nil || info.IsDir() {
			return err
		}
		input, err := os.Open(source)
		if err != nil {
			return err
		}
		_, copyErr := io.Copy(writer, input)
		return errors.Join(copyErr, input.Close())
	})
}
