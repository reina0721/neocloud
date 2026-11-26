package deployment

import (
	"archive/tar"
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/gofrs/flock"
)

const (
	offlineChecksums = "checksums.txt"
	offlineBundle    = "checksums.txt.sigstore.json"
	offlineSmallFile = 1 << 20
	offlineArchive   = 6 << 30
	offlineImagesTar = 24 << 30
)

var offlineTrustNames = []string{"trusted_root.json", "fulcio.pem", "rekor.pub", "ctfe.pub"}

type signedOfflineRelease struct {
	version   string
	checksums []byte
	bundle    []byte
	digests   map[string]string
}

// VerifyOfflineRelease verifies a local signed release for the native host.
func VerifyOfflineRelease(ctx context.Context, dir, version, trustDir string) error {
	return VerifyOfflineReleaseForArch(ctx, dir, version, trustDir, runtime.GOARCH)
}

// VerifyOfflineReleaseForArch verifies a local signed release for a supported Docker architecture.
func VerifyOfflineReleaseForArch(ctx context.Context, dir, version, trustDir, arch string) error {
	source, trust, err := offlineInputs(dir, trustDir)
	if err != nil {
		return err
	}
	defer source.Close()
	release, err := verifyOfflineSignature(ctx, source, version, trust)
	if err != nil {
		return err
	}
	return release.verifyPackage(ctx, source, arch)
}

// VerifyOfflineTooling verifies an installer or the native host maintenance executable.
func VerifyOfflineTooling(ctx context.Context, dir, version, trustDir, asset string) error {
	switch asset {
	case "install.sh", maintenanceAssetName(version, runtime.GOARCH):
	default:
		return fmt.Errorf("不支持的离线工具：%s", asset)
	}
	source, trust, err := offlineInputs(dir, trustDir)
	if err != nil {
		return err
	}
	defer source.Close()
	release, err := verifyOfflineSignature(ctx, source, version, trust)
	if err != nil {
		return err
	}
	limit := int64(offlineSmallFile)
	if asset != "install.sh" {
		limit = 128 << 20
	}
	verified, err := release.openVerified(ctx, source, asset, limit)
	if err != nil {
		return err
	}
	return verified.Close()
}

// OfflineVersions returns the verified native packages in an instance's offline store, latest first.
func OfflineVersions(ctx context.Context, assetsDir, trustDir string) ([]Release, error) {
	store, err := openOfflineDir(assetsDir)
	if errors.Is(err, os.ErrNotExist) {
		return []Release{}, nil
	}
	if err != nil {
		return nil, err
	}
	defer store.Close()
	directory, err := store.Open(".")
	if err != nil {
		return nil, err
	}
	defer directory.Close()
	entries, err := directory.ReadDir(-1)
	if err != nil {
		return nil, err
	}
	versions := make([]Release, 0, len(entries))
	for _, entry := range entries {
		version := entry.Name()
		if !versionPattern.MatchString(version) {
			continue
		}
		if !entry.IsDir() {
			return nil, fmt.Errorf("离线版本须为实际目录：%s", version)
		}
		if err = VerifyOfflineRelease(ctx, filepath.Join(store.Name(), version), version, trustDir); err != nil {
			return nil, fmt.Errorf("本地版本 %s 校验失败: %w", version, err)
		}
		versions = append(versions, Release{Version: version})
	}
	sort.Slice(versions, func(i, j int) bool {
		return newer(versions[i].Version, versions[j].Version)
	})
	return versions, nil
}

// ImportOfflineRelease stores a signed version without overwriting existing version or trust material.
func ImportOfflineRelease(ctx context.Context, root, dir, version, trustDir string) (Release, error) {
	if !versionPattern.MatchString(version) {
		return Release{}, errors.New("导入需要明确的正式版本号")
	}
	instance, err := openOfflineDir(root)
	if err != nil {
		return Release{}, err
	}
	defer instance.Close()
	control := filepath.Join(instance.Name(), ".control", "maintenance")
	savedTrust := filepath.Join(control, "trust")
	if trustDir == "" {
		trustDir = savedTrust
	}
	source, trust, err := offlineInputs(dir, trustDir)
	if err != nil {
		return Release{}, err
	}
	defer source.Close()
	for _, path := range []string{".control", filepath.Join(".control", "maintenance"), filepath.Join(".control", "maintenance", "assets")} {
		if err = ensureOfflineDir(instance, path); err != nil {
			return Release{}, err
		}
	}
	maintenance, err := instance.OpenRoot(filepath.Join(".control", "maintenance"))
	if err != nil {
		return Release{}, err
	}
	defer maintenance.Close()
	if info, statErr := maintenance.Lstat(".import.lock"); statErr == nil && !info.Mode().IsRegular() {
		return Release{}, errors.New("离线导入锁文件无效")
	} else if statErr != nil && !errors.Is(statErr, os.ErrNotExist) {
		return Release{}, statErr
	}
	lock := flock.New(filepath.Join(control, ".import.lock"), flock.SetPermissions(0600))
	defer lock.Close()
	locked, err := lock.TryLock()
	if err != nil || !locked {
		return Release{}, errors.Join(err, ErrBusy)
	}
	trustExists, additions, err := mergeSavedTrust(savedTrust, trust)
	if err != nil {
		return Release{}, err
	}
	release, err := verifyOfflineSignature(ctx, source, version, trust)
	if err != nil {
		return Release{}, err
	}
	store, err := maintenance.OpenRoot("assets")
	if err != nil {
		return Release{}, err
	}
	defer store.Close()
	stageName := ".import-" + RandomID()
	if err = store.Mkdir(stageName, 0700); err != nil {
		return Release{}, err
	}
	defer store.RemoveAll(stageName)
	stage, err := store.OpenRoot(stageName)
	if err != nil {
		return Release{}, err
	}
	defer stage.Close()
	names, err := release.copyAssets(ctx, source, stage, runtime.GOARCH)
	if err != nil {
		return Release{}, err
	}
	if err = release.verifyPackage(ctx, stage, runtime.GOARCH); err != nil {
		return Release{}, err
	}
	existing, err := existingOfflineVersion(ctx, store, stage, version, names)
	if err != nil {
		return Release{}, err
	}
	if len(additions) > 0 {
		if err = saveOfflineTrust(maintenance, additions, trustExists); err != nil {
			return Release{}, err
		}
	}
	if !existing {
		if err = syncDirectory(stage.Name()); err != nil {
			return Release{}, err
		}
		if err = store.Rename(stageName, version); err != nil {
			return Release{}, err
		}
		if err = syncDirectory(store.Name()); err != nil {
			return Release{}, err
		}
	}
	return Release{Version: version}, nil
}

func openOfflineDir(dir string) (*os.Root, error) {
	if dir == "" {
		return nil, errors.New("缺少离线目录")
	}
	absolute, err := filepath.Abs(dir)
	if err != nil {
		return nil, err
	}
	physical, err := filepath.EvalSymlinks(absolute)
	if err != nil {
		return nil, fmt.Errorf("无法读取离线目录 %s: %w", absolute, err)
	}
	if absolute != physical {
		return nil, fmt.Errorf("离线目录须使用实际路径：%s", absolute)
	}
	return os.OpenRoot(absolute)
}

func offlineInputs(dir, trustDir string) (*os.Root, map[string][]byte, error) {
	source, err := openOfflineDir(dir)
	if err != nil {
		return nil, nil, err
	}
	trust, err := openOfflineDir(trustDir)
	if err != nil {
		source.Close()
		return nil, nil, fmt.Errorf("需要宿主机独立的离线信任目录: %w", err)
	}
	defer trust.Close()
	relative, err := filepath.Rel(source.Name(), trust.Name())
	if err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		source.Close()
		return nil, nil, errors.New("离线信任目录必须独立于产物目录")
	}
	materials, err := loadOfflineTrust(trust)
	if err != nil {
		source.Close()
		return nil, nil, err
	}
	return source, materials, nil
}

func ensureOfflineDir(root *os.Root, path string) error {
	info, err := root.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		err = root.Mkdir(path, 0700)
		if !errors.Is(err, os.ErrExist) {
			return err
		}
		info, err = root.Lstat(path)
	}
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return fmt.Errorf("离线目录须为实际目录：%s", path)
	}
	return nil
}

func openOfflineFile(root *os.Root, name string, limit int64) (*os.File, error) {
	info, err := root.Lstat(name)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() < 1 || info.Size() > limit {
		return nil, fmt.Errorf("离线产物须为大小有效的普通文件：%s", name)
	}
	file, err := root.Open(name)
	if err != nil {
		return nil, err
	}
	opened, err := file.Stat()
	if err != nil || !os.SameFile(info, opened) {
		file.Close()
		return nil, errors.Join(err, fmt.Errorf("离线产物读取时发生变化：%s", name))
	}
	return file, nil
}

func readOfflineFile(root *os.Root, name string) ([]byte, error) {
	file, err := openOfflineFile(root, name, offlineSmallFile)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, offlineSmallFile+1))
	if len(data) == 0 || len(data) > offlineSmallFile {
		return nil, errors.Join(err, fmt.Errorf("离线产物大小不合法：%s", name))
	}
	return data, err
}

func loadOfflineTrust(root *os.Root) (map[string][]byte, error) {
	materials := make(map[string][]byte, len(offlineTrustNames))
	for _, name := range offlineTrustNames {
		data, err := readOfflineFile(root, name)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, err
		}
		materials[name] = data
	}
	return materials, nil
}

func verifyOfflineSignature(ctx context.Context, source *os.Root, version string, trust map[string][]byte) (signedOfflineRelease, error) {
	release := signedOfflineRelease{version: version}
	if !versionPattern.MatchString(version) {
		return release, errors.New("离线验签需要明确的正式版本号")
	}
	var err error
	if release.checksums, err = readOfflineFile(source, offlineChecksums); err != nil {
		return release, err
	}
	if release.bundle, err = readOfflineFile(source, offlineBundle); err != nil {
		return release, err
	}
	if err = verifyOfflineBundle(ctx, release, trust); err != nil {
		return release, err
	}
	release.digests = make(map[string]string)
	scanner := bufio.NewScanner(bytes.NewReader(release.checksums))
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) != 2 || !lowerHex(fields[0], sha256.Size) {
			return release, errors.New("已签名的校验清单格式无效")
		}
		name := strings.TrimPrefix(fields[1], "*")
		if !filepath.IsLocal(name) || filepath.Base(name) != name || strings.ContainsAny(name, "\\:") || release.digests[name] != "" {
			return release, fmt.Errorf("已签名的校验清单含无效或重复附件：%s", name)
		}
		release.digests[name] = fields[0]
	}
	return release, scanner.Err()
}

func verifyBundleFormat(bundle []byte) (modern bool, err error) {
	var header struct {
		MediaType       string          `json:"mediaType"`
		Cert            string          `json:"cert"`
		Base64Signature string          `json:"base64Signature"`
		RekorBundle     json.RawMessage `json:"rekorBundle"`
	}
	if err := json.Unmarshal(bundle, &header); err != nil {
		return false, fmt.Errorf("签名包格式无效: %w", err)
	}
	if strings.HasPrefix(header.MediaType, "application/vnd.dev.sigstore.bundle") {
		return true, nil
	}
	certificate := []byte(header.Cert)
	if decoded, err := base64.StdEncoding.DecodeString(header.Cert); err == nil {
		certificate = decoded
	}
	block, _ := pem.Decode(certificate)
	if header.MediaType != "" || header.Base64Signature == "" || len(header.RekorBundle) == 0 ||
		header.RekorBundle[0] != '{' || block == nil || block.Type != "CERTIFICATE" {
		return false, errors.New("旧格式签名包须包含 X.509 证书、签名及 Rekor 记录")
	}
	if _, err := x509.ParseCertificate(block.Bytes); err != nil {
		return false, fmt.Errorf("旧格式签名包的 X.509 证书无效: %w", err)
	}
	return false, nil
}

func verifyOfflineBundle(ctx context.Context, release signedOfflineRelease, trust map[string][]byte) error {
	modern, err := verifyBundleFormat(release.bundle)
	if err != nil {
		return err
	}
	materials := []string{"trusted_root.json"}
	if !modern {
		materials = []string{"fulcio.pem", "rekor.pub", "ctfe.pub"}
	}
	staging, err := os.MkdirTemp("", "clouddrive-offline-signature-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(staging)
	for _, name := range materials {
		if len(trust[name]) == 0 {
			return fmt.Errorf("离线信任目录缺少 %s", name)
		}
		// #nosec G306 -- 验证只使用私有临时目录中复制的宿主机信任材料。
		if err = os.WriteFile(filepath.Join(staging, name), trust[name], 0600); err != nil {
			return err
		}
	}
	bundle := filepath.Join(staging, offlineBundle)
	if err = os.WriteFile(bundle, release.bundle, 0600); err != nil {
		return err
	}
	args := []string{
		"verify-blob", "--offline", "--bundle", bundle,
		"--certificate-identity", releaseOrigin + "/.github/workflows/release.yml@refs/tags/" + release.version,
		"--certificate-oidc-issuer", "https://token.actions.githubusercontent.com",
	}
	environment := []string{"PATH=" + os.Getenv("PATH")}
	if modern {
		args = append(args, "--new-bundle-format", "--trusted-root", filepath.Join(staging, "trusted_root.json"))
	} else {
		environment = append(environment,
			"SIGSTORE_ROOT_FILE="+filepath.Join(staging, "fulcio.pem"),
			"SIGSTORE_REKOR_PUBLIC_KEY="+filepath.Join(staging, "rekor.pub"),
			"SIGSTORE_CT_LOG_PUBLIC_KEY_FILE="+filepath.Join(staging, "ctfe.pub"),
		)
	}
	cosign := os.Getenv("CLOUDDRIVE_COSIGN")
	if cosign == "" {
		cosign = "cosign"
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	// #nosec G204 G702 -- 安装者配置 cosign；产物标签已限定，校验清单原始字节经标准输入传入。
	command := exec.CommandContext(ctx, cosign, append(args, "-")...)
	command.Env = environment
	command.Stdin = bytes.NewReader(release.checksums)
	if output, err := command.CombinedOutput(); err != nil {
		return fmt.Errorf("正式产物离线签名验证失败: %w: %s", errors.Join(err, ctx.Err()), strings.TrimSpace(string(output)))
	}
	return nil
}

func (r signedOfflineRelease) openVerified(ctx context.Context, root *os.Root, name string, limit int64) (*os.File, error) {
	digest := r.digests[name]
	if digest == "" {
		return nil, fmt.Errorf("已签名的校验清单缺少附件：%s", name)
	}
	file, err := openOfflineFile(root, name, limit)
	if err != nil {
		return nil, err
	}
	hash := sha256.New()
	read, err := io.Copy(hash, &contextReader{ctx: ctx, Reader: io.LimitReader(file, limit+1)})
	if err != nil || read > limit || hex.EncodeToString(hash.Sum(nil)) != digest {
		file.Close()
		return nil, errors.Join(err, fmt.Errorf("正式产物摘要不匹配：%s", name))
	}
	if _, err = file.Seek(0, io.SeekStart); err != nil {
		file.Close()
		return nil, err
	}
	return file, nil
}

func dockerAssetName(version, arch string) string {
	return fmt.Sprintf("clouddrive_%s_linux_%s_docker.tar.gz", version, arch)
}

func maintenanceAssetName(version, arch string) string {
	return fmt.Sprintf("clouddrive-maintenance_%s_linux_%s", version, arch)
}

func (r signedOfflineRelease) verifyPackage(ctx context.Context, dir *os.Root, arch string) error {
	if arch != "amd64" && arch != "arm64" {
		return fmt.Errorf("不支持的 Linux 镜像架构：%s", arch)
	}
	archive, err := r.openVerified(ctx, dir, dockerAssetName(r.version, arch), offlineArchive)
	if err != nil {
		return err
	}
	defer archive.Close()
	if err = verifyOfflineArchive(ctx, archive, r, arch); err != nil {
		return err
	}
	if _, err = dir.Lstat("version.txt"); errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	versionFile, err := r.openVerified(ctx, dir, "version.txt", offlineSmallFile)
	if err != nil {
		return err
	}
	defer versionFile.Close()
	contents, err := io.ReadAll(io.LimitReader(versionFile, offlineSmallFile))
	if strings.TrimSpace(string(contents)) != r.version {
		return errors.Join(err, errors.New("离线产物的 version.txt 与所选版本不符"))
	}
	return err
}

func verifyOfflineArchive(ctx context.Context, input io.Reader, release signedOfflineRelease, arch string) error {
	gzipReader, err := gzip.NewReader(input)
	if err != nil {
		return fmt.Errorf("无法读取离线 Docker 归档: %w", err)
	}
	defer gzipReader.Close()
	archive := tar.NewReader(&contextReader{ctx: ctx, Reader: gzipReader})
	files := map[string][]byte{"compose.yaml": nil, "images.env": nil, "images.tar": nil, "install.sh": nil, "manifest.txt": nil}
	for {
		entry, err := archive.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return err
		}
		content, expected := files[entry.Name]
		if !expected || content != nil || entry.Typeflag != tar.TypeReg || entry.Size < 1 {
			return fmt.Errorf("离线 Docker 归档含无效或重复条目：%s", entry.Name)
		}
		if entry.Name == "images.tar" {
			if entry.Size > offlineImagesTar {
				return errors.New("离线 Docker 镜像超过归档大小上限")
			}
			files[entry.Name] = []byte{}
			continue
		}
		if entry.Size > offlineSmallFile {
			return fmt.Errorf("离线 Docker 归档元数据过大：%s", entry.Name)
		}
		if files[entry.Name], err = io.ReadAll(archive); err != nil {
			return err
		}
	}
	for name, content := range files {
		if content == nil {
			return fmt.Errorf("离线 Docker 归档缺少 %s", name)
		}
	}
	tail := &contextReader{ctx: ctx, Reader: io.LimitReader(gzipReader, offlineSmallFile+1)}
	remaining, err := io.Copy(io.Discard, tail)
	if err != nil || remaining > offlineSmallFile {
		return errors.Join(err, errors.New("离线 Docker 归档结尾无效"))
	}
	manifest := make(map[string]string)
	for _, line := range strings.Split(strings.TrimSpace(string(files["manifest.txt"])), "\n") {
		key, value, found := strings.Cut(line, "=")
		if !found || key == "" || value == "" || manifest[key] != "" {
			return errors.New("离线 Docker 归档版本清单无效")
		}
		manifest[key] = value
	}
	for key, expected := range map[string]string{"FORMAT": "1", "VERSION": release.version, "ARCH": arch} {
		if manifest[key] != expected {
			return fmt.Errorf("离线 Docker 归档的 %s 与所选版本或平台不符", key)
		}
	}
	apiID, apiDigest := strings.CutPrefix(manifest["API_ID"], "sha256:")
	webID, webDigest := strings.CutPrefix(manifest["WEB_ID"], "sha256:")
	if !lowerHex(manifest["COMMIT"], 20) || !apiDigest || !lowerHex(apiID, sha256.Size) || !webDigest || !lowerHex(webID, sha256.Size) {
		return errors.New("离线 Docker 归档的源码或镜像标识无效")
	}
	for _, flag := range []string{"NETWORK", "ENTRYPOINT", "INSTANCE_LAYOUT", "OFFLINE_MAINTENANCE"} {
		if value := manifest[flag]; value != "" && value != "1" {
			return fmt.Errorf("离线 Docker 归档的 %s 标记无效", flag)
		}
	}
	tag := release.version + "-" + arch
	if string(files["images.env"]) != "API_IMAGE=clouddrive-api:"+tag+"\nWEB_IMAGE=clouddrive-web:"+tag+"\n" {
		return errors.New("离线 Docker 归档的镜像引用不匹配")
	}
	if digest := release.digests["install.sh"]; digest != "" {
		installerHash := sha256.Sum256(files["install.sh"])
		if hex.EncodeToString(installerHash[:]) != digest {
			return errors.New("离线 Docker 归档的安装脚本与已签名安装附件不匹配")
		}
	}
	return nil
}

func lowerHex(text string, bytes int) bool {
	if len(text) != bytes*2 || text != strings.ToLower(text) {
		return false
	}
	_, err := hex.DecodeString(text)
	return err == nil
}

func (r signedOfflineRelease) copyAssets(ctx context.Context, source, stage *os.Root, arch string) ([]string, error) {
	for name, data := range map[string][]byte{offlineChecksums: r.checksums, offlineBundle: r.bundle} {
		if err := writeOfflineFile(stage, name, bytes.NewReader(data)); err != nil {
			return nil, err
		}
	}
	asset := dockerAssetName(r.version, arch)
	archive, err := openOfflineFile(source, asset, offlineArchive)
	if err != nil {
		return nil, err
	}
	defer archive.Close()
	if err = writeOfflineFile(stage, asset, &contextReader{ctx: ctx, Reader: io.LimitReader(archive, offlineArchive+1)}); err != nil {
		return nil, err
	}
	names := []string{offlineChecksums, offlineBundle, asset}
	for _, name := range []string{"version.txt", "install.sh", maintenanceAssetName(r.version, arch)} {
		limit := int64(offlineSmallFile)
		if name == maintenanceAssetName(r.version, arch) {
			limit = 128 << 20
		}
		if _, err = source.Lstat(name); errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, err
		}
		input, err := openOfflineFile(source, name, limit)
		if err != nil {
			return nil, err
		}
		err = errors.Join(writeOfflineFile(stage, name, &contextReader{ctx: ctx, Reader: io.LimitReader(input, limit+1)}), input.Close())
		if err != nil {
			return nil, err
		}
		verified, err := r.openVerified(ctx, stage, name, limit)
		if err != nil {
			return nil, err
		}
		if err = verified.Close(); err != nil {
			return nil, err
		}
		names = append(names, name)
	}
	return names, nil
}

func writeOfflineFile(stage *os.Root, name string, input io.Reader) error {
	output, err := stage.OpenFile(name, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	_, err = io.Copy(output, input)
	return errors.Join(err, output.Sync(), output.Close())
}

func existingOfflineVersion(ctx context.Context, store, stage *os.Root, version string, names []string) (bool, error) {
	info, err := store.Lstat(version)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil || !info.IsDir() {
		return false, errors.Join(err, fmt.Errorf("离线版本目录无效：%s", version))
	}
	existing, err := store.OpenRoot(version)
	if err != nil {
		return false, err
	}
	defer existing.Close()
	for _, name := range names {
		same, err := sameOfflineFile(ctx, existing, stage, name)
		if err != nil || !same {
			return false, errors.Join(err, fmt.Errorf("离线版本 %s 的同名产物已有不同内容：%s", version, name))
		}
	}
	return true, nil
}

func sameOfflineFile(ctx context.Context, existing, stage *os.Root, name string) (bool, error) {
	oldDigest, err := offlineFileDigest(ctx, existing, name)
	if err != nil {
		return false, err
	}
	newDigest, err := offlineFileDigest(ctx, stage, name)
	return oldDigest == newDigest, err
}

func offlineFileDigest(ctx context.Context, root *os.Root, name string) (string, error) {
	file, err := openOfflineFile(root, name, offlineArchive)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hash := sha256.New()
	_, err = io.Copy(hash, &contextReader{ctx: ctx, Reader: file})
	return hex.EncodeToString(hash.Sum(nil)), err
}

func mergeSavedTrust(path string, trust map[string][]byte) (bool, map[string][]byte, error) {
	saved, err := openOfflineDir(path)
	if errors.Is(err, os.ErrNotExist) {
		return false, trust, nil
	}
	if err != nil {
		return false, nil, err
	}
	defer saved.Close()
	current, err := loadOfflineTrust(saved)
	if err != nil {
		return false, nil, err
	}
	additions := make(map[string][]byte)
	for _, name := range offlineTrustNames {
		newMaterial, provided := trust[name]
		if oldMaterial, exists := current[name]; exists {
			if provided && !bytes.Equal(oldMaterial, newMaterial) {
				return false, nil, fmt.Errorf("离线信任材料已存在且内容不同：%s", name)
			}
			trust[name] = oldMaterial
		} else if provided {
			additions[name] = newMaterial
		}
	}
	return true, additions, nil
}

func saveOfflineTrust(maintenance *os.Root, additions map[string][]byte, exists bool) error {
	stage := ".trust-" + RandomID()
	if err := maintenance.Mkdir(stage, 0700); err != nil {
		return err
	}
	defer maintenance.RemoveAll(stage)
	dir, err := maintenance.OpenRoot(stage)
	if err != nil {
		return err
	}
	defer dir.Close()
	for name, data := range additions {
		if err := writeOfflineFile(dir, name, bytes.NewReader(data)); err != nil {
			return err
		}
	}
	if err = syncDirectory(dir.Name()); err != nil {
		return err
	}
	if exists {
		for name := range additions {
			if err = maintenance.Link(filepath.Join(stage, name), filepath.Join("trust", name)); err != nil {
				return err
			}
		}
		return syncDirectory(filepath.Join(maintenance.Name(), "trust"))
	}
	if err = maintenance.Rename(stage, "trust"); err != nil {
		return err
	}
	return syncDirectory(maintenance.Name())
}
