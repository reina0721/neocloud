package deployment

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

const (
	nativeWebDirectory      = "web"
	nativeWebInventory      = "web-files.json"
	nativeWebBuild          = "web-build.json"
	nativeWebInventoryLimit = 8 << 20
	nativeFullPackageLimit  = 512 << 20
	nativeFullExpandedLimit = 1 << 30
	nativeFullEntryLimit    = 32768
)

var nativeDigest = regexp.MustCompile("^[a-f0-9]{64}$")
var nativeWindowsDevice = regexp.MustCompile("^(?i:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:[.]|$)")

// NativeCacheDirectory gives the store root for a profile. Existing Go-only
// installations retain their original cache layout.
func NativeCacheDirectory(versionsRoot string, profile NativeProfile) (string, error) {
	if versionsRoot == "" {
		return "", errors.New("缺少原生版本目录")
	}
	switch profile {
	case NativeGo:
		return versionsRoot, nil
	case NativeFull:
		return filepath.Join(versionsRoot, string(profile)), nil
	default:
		return "", errors.New("不支持的原生发布包类型")
	}
}

func nativePackageLimitFor(profile NativeProfile) int64 {
	if profile == NativeFull {
		return nativeFullPackageLimit
	}
	return nativePackageLimit
}

func belongsToNativeWeb(name string) bool {
	return name == nativeWebInventory || name == nativeWebDirectory || strings.HasPrefix(name, nativeWebDirectory+"/")
}

func portableNativePath(name string) bool {
	if len(name) > 512 || name == "." || !fs.ValidPath(name) {
		return false
	}
	for _, part := range strings.Split(name, "/") {
		if len(part) > 255 || strings.ContainsAny(part, "<>:\"\\|?*") || strings.TrimRight(part, " .") != part ||
			nativeWindowsDevice.MatchString(part) || strings.IndexFunc(part, func(r rune) bool { return r < 32 || r == 127 }) >= 0 {
			return false
		}
	}
	return true
}

type nativeWebFile struct {
	Path   string `json:"path"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
	entry  *zip.File
}

type nativeWebPackage struct {
	files []nativeWebFile
	dirs  []string
}

func inspectNativeWeb(manifest NativeManifest, entries []*zip.File) (nativeWebPackage, error) {
	var build nativeWebPackage
	var inventory *zip.File
	web := make(map[string]*zip.File, len(entries))
	for _, entry := range entries {
		name := strings.TrimSuffix(entry.Name, "/")
		if name == nativeWebInventory {
			inventory = entry
			continue
		}
		if entry.FileInfo().IsDir() {
			continue
		}
		if !strings.HasPrefix(name, nativeWebDirectory+"/") {
			return build, errors.New("整包的 Web 根不是目录")
		}
		web[strings.TrimPrefix(name, nativeWebDirectory+"/")] = entry
	}
	index, err := readNativeZipFile(inventory, nativeWebInventoryLimit)
	if err != nil {
		return build, err
	}
	sum := sha256.Sum256(index)
	if hex.EncodeToString(sum[:]) != manifest.WebInventorySHA256 {
		return build, errors.New("整包的 Web 文件清单摘要不匹配")
	}
	if err := decodeNativeJSON(index, &build.files); err != nil || len(build.files) == 0 || len(build.files) != len(web) {
		return build, errors.Join(err, errors.New("整包的 Web 文件清单无效"))
	}
	paths, dirs := make(map[string]string), make(map[string]bool)
	for index := range build.files {
		file := &build.files[index]
		entry, ok := web[file.Path]
		if !ok || !portableNativePath(file.Path) || file.Size < 0 || file.Size > nativeBinaryLimit ||
			uint64(file.Size) != entry.UncompressedSize64 || !nativeDigest.MatchString(file.SHA256) {
			return build, fmt.Errorf("整包的 Web 文件条目无效：%q", file.Path)
		}
		delete(web, file.Path)
		file.entry = entry
		for parent := path.Dir(file.Path); parent != "."; parent = path.Dir(parent) {
			dirs[parent] = true
		}
		paths[strings.ToLower(file.Path)] = file.Path
	}
	for dir := range dirs {
		fold := strings.ToLower(dir)
		if paths[fold] != "" {
			return build, fmt.Errorf("整包 Web 路径大小写或文件目录冲突：%q", dir)
		}
		paths[fold] = dir
		build.dirs = append(build.dirs, dir)
	}
	if err := build.checkIdentity(manifest.WebID); err != nil {
		return build, err
	}
	sort.Strings(build.dirs)
	return build, nil
}

func (build nativeWebPackage) checkIdentity(id string) error {
	required := map[string]bool{"index.html": false, "404.html": false, "login.html": false, "home.html": false, "workspace.html": false}
	var metadata *zip.File
	script := false
	for _, file := range build.files {
		if file.Size == 0 {
			continue
		}
		if file.Path == nativeWebBuild {
			metadata = file.entry
		}
		if strings.HasPrefix(file.Path, "_next/static/") && strings.HasSuffix(file.Path, ".js") {
			script = true
		}
		if _, exists := required[file.Path]; exists {
			required[file.Path] = true
		}
	}
	for route, present := range required {
		if !present {
			return fmt.Errorf("整包缺少 Web 页面 %s", route)
		}
	}
	if !script {
		return errors.New("整包缺少 Web 静态脚本")
	}
	data, err := readNativeZipFile(metadata, 1024)
	if err != nil {
		return err
	}
	var identity struct {
		BuildID string `json:"buildId"`
	}
	if err := decodeNativeJSON(data, &identity); err != nil || identity.BuildID != id {
		return errors.Join(err, errors.New("整包包含其他源码提交的 Web 构建"))
	}
	return nil
}

func readNativeZipFile(entry *zip.File, limit int64) ([]byte, error) {
	if entry == nil || !entry.Mode().IsRegular() || entry.UncompressedSize64 == 0 {
		return nil, errors.New("整包缺少有效的 Web 构建或文件清单")
	}
	reader, err := entry.Open()
	if err != nil {
		return nil, err
	}
	data, err := io.ReadAll(io.LimitReader(reader, limit+1))
	err = errors.Join(err, reader.Close())
	if err == nil && (int64(len(data)) > limit || uint64(len(data)) != entry.UncompressedSize64) {
		err = errors.New("整包 Web 清单文件大小不匹配")
	}
	return data, err
}

func decodeNativeJSON(data []byte, value any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		return err
	}
	if decoder.Decode(new(json.RawMessage)) != io.EOF {
		return errors.New("整包 Web 清单包含多余内容")
	}
	return nil
}

func (build nativeWebPackage) verifyArchive() error {
	for _, file := range build.files {
		if err := file.verify(context.Background(), io.Discard, file.entry.Open); err != nil {
			return err
		}
	}
	return nil
}

func (build nativeWebPackage) prepare(ctx context.Context, stage *os.Root, create bool) (result error) {
	if create {
		if err := stage.Mkdir(nativeWebDirectory, 0700); err != nil {
			return err
		}
	} else {
		info, err := stage.Lstat(nativeWebDirectory)
		if err != nil || !info.IsDir() {
			return errors.Join(err, errors.New("已缓存的 Web 根不是实际目录"))
		}
	}
	web, err := stage.OpenRoot(nativeWebDirectory)
	if err != nil {
		return err
	}
	defer func() { result = errors.Join(result, web.Close()) }()
	if !create {
		return build.verifyCached(ctx, web)
	}
	for _, dir := range build.dirs {
		if err := web.Mkdir(dir, 0700); err != nil {
			return err
		}
	}
	for _, file := range build.files {
		if err := file.extract(ctx, web); err != nil {
			return err
		}
	}
	return syncNativeWeb(web, build.dirs)
}

func (build nativeWebPackage) verifyCached(ctx context.Context, web *os.Root) error {
	existing := make(map[string]nativeWebFile, len(build.files))
	for _, file := range build.files {
		existing[file.Path] = file
	}
	dirs := make(map[string]bool, len(build.dirs))
	for _, dir := range build.dirs {
		dirs[dir] = true
	}
	err := fs.WalkDir(web.FS(), ".", func(name string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if name == "." || (entry.IsDir() && dirs[name]) {
			return ctx.Err()
		}
		file, listed := existing[name]
		if !listed || !entry.Type().IsRegular() {
			return fmt.Errorf("已缓存的 Web 发布存在无效条目：%q", name)
		}
		delete(existing, name)
		return file.verify(ctx, io.Discard, func() (io.ReadCloser, error) { return web.Open(name) })
	})
	if err == nil && len(existing) != 0 {
		err = errors.New("已缓存的 Web 发布缺少签名清单中的文件")
	}
	return err
}

func (file nativeWebFile) extract(ctx context.Context, web *os.Root) error {
	target, err := web.OpenFile(file.Path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0400)
	if err != nil {
		return err
	}
	err = file.verify(ctx, target, file.entry.Open)
	if err == nil {
		err = target.Sync()
	}
	return errors.Join(err, target.Close())
}

func (file nativeWebFile) verify(ctx context.Context, to io.Writer, open func() (io.ReadCloser, error)) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	source, err := open()
	if err != nil {
		return err
	}
	hash := sha256.New()
	read, copyErr := io.Copy(io.MultiWriter(to, hash), &contextReader{ctx: ctx, Reader: io.LimitReader(source, file.Size+1)})
	err = errors.Join(copyErr, source.Close())
	if err == nil && (read != file.Size || hex.EncodeToString(hash.Sum(nil)) != file.SHA256) {
		err = fmt.Errorf("整包 Web 文件长度或摘要不匹配：%q", file.Path)
	}
	return err
}
