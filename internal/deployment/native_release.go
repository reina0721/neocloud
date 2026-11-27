package deployment

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"debug/buildinfo"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/gofrs/flock"
)

const (
	nativeManifestFile     = "manifest.json"
	nativeTrustFile        = "trusted_root.json"
	nativePackageLimit     = 192 << 20
	nativeBinaryLimit      = 128 << 20
	NativeHostProtocol     = 1
	NativeFullHostProtocol = 2
)

var nativeCommit = regexp.MustCompile(`^[a-f0-9]{40}$`)

// NativeProfile selects a distinct signed package and local version store.
type NativeProfile string

const (
	NativeGo   NativeProfile = "managed-go"
	NativeFull NativeProfile = "managed-full"
)

// NativeManifest binds the worker to a platform and the managed-host protocol.
// Migration descriptors are opaque to deployment and interpreted by the application.
type NativeManifest struct {
	Version            string                     `json:"version"`
	Commit             string                     `json:"commit"`
	OS                 string                     `json:"os"`
	Arch               string                     `json:"arch"`
	HostProtocol       int                        `json:"hostProtocol"`
	Profile            NativeProfile              `json:"profile,omitempty"`
	WebID              string                     `json:"webId,omitempty"`
	WebInventorySHA256 string                     `json:"webInventorySha256,omitempty"`
	FromVersion        string                     `json:"fromVersion,omitempty"`
	FromCommit         string                     `json:"fromCommit,omitempty"`
	OnlinePlans        map[string]json.RawMessage `json:"onlinePlans,omitempty"`
}

type NativeTarget struct {
	Manifest       NativeManifest
	Directory      string
	Executable     string
	HostExecutable string
	WebDirectory   string
	WebID          string
}

func nativeAssetName(version, goos, arch string) (string, error) {
	return nativeAssetNameFor(version, goos, arch, NativeGo)
}

func nativeAssetNameFor(version, goos, arch string, profile NativeProfile) (string, error) {
	if profile != NativeGo && profile != NativeFull {
		return "", errors.New("不支持的原生发布包类型")
	}
	if !versionPattern.MatchString(version) {
		return "", errors.New("原生升级需要明确的正式版本号")
	}
	if !(goos == "windows" && arch == "amd64" || goos == "linux" && (arch == "amd64" || arch == "arm64")) {
		return "", fmt.Errorf("不支持的托管原生平台 %s/%s", goos, arch)
	}
	return fmt.Sprintf("clouddrive_%s_%s_%s_%s.zip", version, goos, arch, profile), nil
}

func nativeExecutables(goos string) [2]string {
	if goos == "windows" {
		return [2]string{"clouddrive.exe", "clouddrive-host.exe"}
	}
	return [2]string{"clouddrive", "clouddrive-host"}
}

func (m NativeManifest) validate(version, goos, arch string, profile NativeProfile) error {
	if m.Version != version || m.OS != goos || m.Arch != arch || !nativeCommit.MatchString(m.Commit) {
		return errors.New("原生发布清单版本、提交或平台不匹配")
	}
	if profile == NativeFull {
		if m.Profile != NativeFull || m.HostProtocol != NativeFullHostProtocol || m.WebID != m.Commit || !nativeDigest.MatchString(m.WebInventorySHA256) {
			return errors.New("整包清单的宿主协议或 Web 构建身份不匹配")
		}
	} else if (m.Profile != "" && m.Profile != NativeGo) || m.HostProtocol != NativeHostProtocol || m.WebID != "" || m.WebInventorySHA256 != "" {
		return errors.New("Go 后端包清单的宿主协议或包类型不匹配")
	}
	if m.FromVersion != "" || m.FromCommit != "" || len(m.OnlinePlans) > 0 {
		if !newer(m.Version, m.FromVersion) || !nativeCommit.MatchString(m.FromCommit) {
			return errors.New("迁移清单缺少可验证的源版本或提交")
		}
	}
	for driver, plan := range m.OnlinePlans {
		if driver != "sqlite" && driver != "postgres" && driver != "mysql" {
			return fmt.Errorf("不支持的发布迁移驱动 %s", driver)
		}
		if body := bytes.TrimSpace(plan); len(body) < 2 || body[0] != '{' || body[len(body)-1] != '}' {
			return fmt.Errorf("无效的发布迁移描述 %s", driver)
		}
	}
	return nil
}

// NativeCandidates discovers published stable releases for the running platform.
// Discovery only identifies candidate tags; callers must authenticate each staged manifest.
func (s *Releases) NativeCandidates(ctx context.Context, current string) ([]string, error) {
	return s.NativeCandidatesFor(ctx, current, NativeGo)
}

// NativeCandidatesFor discovers newer stable releases for one package profile.
func (s *Releases) NativeCandidatesFor(ctx context.Context, current string, profile NativeProfile) ([]string, error) {
	if _, err := nativeAssetNameFor(current, runtime.GOOS, runtime.GOARCH, profile); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	const pageSize, pageBudget = 30, 3
	var tags []string
	seen := make(map[string]bool)
	for page := 1; page <= pageBudget; page++ {
		address := fmt.Sprintf("https://api.github.com/repos/%s/releases?per_page=%d&page=%d", repository, pageSize, page)
		releases, err := s.readNativeReleasePage(ctx, address)
		if err != nil {
			return nil, err
		}
		for _, release := range releases {
			if release.Draft || release.Prerelease || !newer(release.Tag, current) || seen[release.Tag] {
				continue
			}
			asset, err := nativeAssetNameFor(release.Tag, runtime.GOOS, runtime.GOARCH, profile)
			if err != nil {
				return nil, err
			}
			for _, file := range release.Assets {
				if file.State == "uploaded" && file.Name == asset {
					seen[release.Tag] = true
					tags = append(tags, release.Tag)
					break
				}
			}
		}
		if len(releases) < pageSize {
			break
		}
	}
	sort.Slice(tags, func(i, j int) bool { return newer(tags[i], tags[j]) })
	return tags, nil
}

type nativeReleaseSummary struct {
	Tag        string `json:"tag_name"`
	Draft      bool   `json:"draft"`
	Prerelease bool   `json:"prerelease"`
	Assets     []struct {
		Name  string `json:"name"`
		State string `json:"state"`
	} `json:"assets"`
}

func (s *Releases) readNativeReleasePage(ctx context.Context, address string) ([]nativeReleaseSummary, error) {
	response, err := s.get(ctx, address)
	if err != nil {
		return nil, err
	}
	defer response.Close()
	const limit = 8 << 20
	body, err := io.ReadAll(io.LimitReader(response, limit+1))
	if err != nil {
		return nil, err
	}
	if len(body) == 0 || len(body) > limit {
		return nil, errors.New("原生发布列表大小无效")
	}
	var releases []nativeReleaseSummary
	if err := json.Unmarshal(body, &releases); err != nil {
		return nil, err
	}
	return releases, nil
}

// StageNative fetches an exact GitHub Release and publishes a per-version directory
// after signature, archive and executable checks finish in private staging.
func (s *Releases) StageNative(ctx context.Context, versionsRoot, version string) (NativeTarget, error) {
	return s.StageNativeFor(ctx, versionsRoot, version, NativeGo)
}

// StageNativeFor verifies and stages one package profile from GitHub Releases.
func (s *Releases) StageNativeFor(ctx context.Context, versionsRoot, version string, profile NativeProfile) (NativeTarget, error) {
	return stageNative(ctx, versionsRoot, version, profile, func(stage *os.Root, asset string) (signedOfflineRelease, error) {
		for _, name := range []string{offlineChecksums, offlineBundle} {
			if err := s.download(ctx, stage.Name(), version, name, offlineSmallFile); err != nil {
				return signedOfflineRelease{}, err
			}
		}
		root, err := nativeTrustedRoot(ctx, stage.Name())
		if err != nil {
			return signedOfflineRelease{}, err
		}
		release, err := verifyAndStoreNativeTrust(ctx, stage, version, root)
		if err != nil {
			return signedOfflineRelease{}, err
		}
		if err = s.download(ctx, stage.Name(), version, asset, nativePackageLimitFor(profile)); err != nil {
			return signedOfflineRelease{}, err
		}
		for _, name := range []string{offlineChecksums, offlineBundle, asset} {
			file, err := stage.OpenFile(name, os.O_RDWR, 0)
			if err != nil {
				return signedOfflineRelease{}, err
			}
			if err := errors.Join(file.Sync(), file.Close()); err != nil {
				return signedOfflineRelease{}, err
			}
		}
		return release, nil
	})
}

// ImportNative prepares a local formal release using operator-provisioned,
// independently obtained Sigstore trust, for initial install or offline staging.
func ImportNative(ctx context.Context, versionsRoot, releaseDir, trustDir, version string) (NativeTarget, error) {
	return ImportNativeFor(ctx, versionsRoot, releaseDir, trustDir, version, NativeGo)
}

// ImportNativeFor stages a local signed package against separately provisioned trust.
func ImportNativeFor(ctx context.Context, versionsRoot, releaseDir, trustDir, version string, profile NativeProfile) (NativeTarget, error) {
	return stageNative(ctx, versionsRoot, version, profile, func(stage *os.Root, asset string) (signedOfflineRelease, error) {
		source, trust, err := offlineInputs(releaseDir, trustDir)
		if err != nil {
			return signedOfflineRelease{}, err
		}
		defer source.Close()
		for _, name := range []string{offlineChecksums, offlineBundle} {
			data, err := readOfflineFile(source, name)
			if err != nil {
				return signedOfflineRelease{}, err
			}
			if err := writeNativeFile(stage, name, bytes.NewReader(data), offlineSmallFile, 0600); err != nil {
				return signedOfflineRelease{}, err
			}
		}
		release, err := verifyAndStoreNativeTrust(ctx, stage, version, trust[nativeTrustFile])
		if err != nil {
			return signedOfflineRelease{}, err
		}
		limit := nativePackageLimitFor(profile)
		input, err := openOfflineFile(source, asset, limit)
		if err != nil {
			return signedOfflineRelease{}, err
		}
		defer input.Close()
		if err = writeNativeFile(stage, asset, &contextReader{ctx: ctx, Reader: input}, limit, 0600); err != nil {
			return signedOfflineRelease{}, err
		}
		return release, nil
	})
}

func verifyAndStoreNativeTrust(ctx context.Context, stage *os.Root, version string, root []byte) (signedOfflineRelease, error) {
	release, err := verifyOfflineSignature(ctx, stage, version, map[string][]byte{nativeTrustFile: root})
	if err != nil {
		return signedOfflineRelease{}, err
	}
	return release, writeNativeFile(stage, nativeTrustFile, bytes.NewReader(root), offlineSmallFile, 0600)
}

func stageNative(ctx context.Context, versionsRoot, version string, profile NativeProfile, acquire func(*os.Root, string) (signedOfflineRelease, error)) (NativeTarget, error) {
	asset, err := nativeAssetNameFor(version, runtime.GOOS, runtime.GOARCH, profile)
	if err != nil {
		return NativeTarget{}, err
	}
	view, err := NativeCacheDirectory(versionsRoot, profile)
	if err != nil {
		return NativeTarget{}, err
	}
	if err = os.MkdirAll(view, 0700); err != nil {
		return NativeTarget{}, err
	}
	store, err := openOfflineDir(view)
	if err != nil {
		return NativeTarget{}, err
	}
	defer store.Close()
	const lockName = ".stage.lock"
	if info, statErr := store.Lstat(lockName); statErr == nil && !info.Mode().IsRegular() {
		return NativeTarget{}, errors.New("原生发布暂存锁须为普通文件")
	} else if statErr != nil && !errors.Is(statErr, os.ErrNotExist) {
		return NativeTarget{}, statErr
	}
	lock := flock.New(filepath.Join(store.Name(), lockName), flock.SetPermissions(0600))
	defer lock.Close()
	if locked, err := lock.TryLock(); err != nil || !locked {
		return NativeTarget{}, errors.Join(err, ErrBusy)
	}
	if _, err = store.Lstat(version); err == nil {
		return loadNative(ctx, store, version, asset, profile)
	} else if !errors.Is(err, os.ErrNotExist) {
		return NativeTarget{}, err
	}
	stageName := ".candidate-" + RandomID()
	if err = store.Mkdir(stageName, 0700); err != nil {
		return NativeTarget{}, err
	}
	defer store.RemoveAll(stageName)
	stage, err := store.OpenRoot(stageName)
	if err != nil {
		return NativeTarget{}, err
	}
	defer stage.Close()
	release, err := acquire(stage, asset)
	if err != nil {
		return NativeTarget{}, err
	}
	manifest, err := unpackNativeTarget(ctx, stage, release, asset, profile, true)
	if err != nil {
		return NativeTarget{}, err
	}
	if err = stage.Close(); err != nil {
		return NativeTarget{}, err
	}
	if err = publishNativeDirectory(store, stageName, version); err != nil {
		return NativeTarget{}, err
	}
	return nativeTarget(store, manifest), nil
}

// LoadNative rechecks retained local assets using the independently obtained
// trust root. A host restart does not need to fetch GitHub or TUF again.
func LoadNative(ctx context.Context, versionsRoot, version string) (NativeTarget, error) {
	return LoadNativeFor(ctx, versionsRoot, version, NativeGo)
}

// LoadNativeFor verifies a cached package without reaching GitHub or TUF.
func LoadNativeFor(ctx context.Context, versionsRoot, version string, profile NativeProfile) (NativeTarget, error) {
	asset, err := nativeAssetNameFor(version, runtime.GOOS, runtime.GOARCH, profile)
	if err != nil {
		return NativeTarget{}, err
	}
	view, err := NativeCacheDirectory(versionsRoot, profile)
	if err != nil {
		return NativeTarget{}, err
	}
	store, err := openOfflineDir(view)
	if err != nil {
		return NativeTarget{}, err
	}
	defer store.Close()
	return loadNative(ctx, store, version, asset, profile)
}

func loadNative(ctx context.Context, store *os.Root, version, asset string, profile NativeProfile) (NativeTarget, error) {
	info, err := store.Lstat(version)
	if err != nil {
		return NativeTarget{}, err
	}
	if !info.IsDir() {
		return NativeTarget{}, errors.New("原生版本须为实际目录")
	}
	stage, err := store.OpenRoot(version)
	if err != nil {
		return NativeTarget{}, err
	}
	defer stage.Close()
	root, err := readOfflineFile(stage, nativeTrustFile)
	if err != nil {
		return NativeTarget{}, err
	}
	release, err := verifyOfflineSignature(ctx, stage, version, map[string][]byte{nativeTrustFile: root})
	if err != nil {
		return NativeTarget{}, err
	}
	manifest, err := unpackNativeTarget(ctx, stage, release, asset, profile, false)
	if err != nil {
		return NativeTarget{}, err
	}
	return nativeTarget(store, manifest), nil
}

func nativeTarget(store *os.Root, manifest NativeManifest) NativeTarget {
	dir := filepath.Join(store.Name(), manifest.Version)
	names := nativeExecutables(manifest.OS)
	target := NativeTarget{Manifest: manifest, Directory: dir, Executable: filepath.Join(dir, names[0]), HostExecutable: filepath.Join(dir, names[1])}
	if manifest.Profile == NativeFull {
		target.WebDirectory = filepath.Join(dir, nativeWebDirectory)
		target.WebID = manifest.WebID
	}
	return target
}

func nativeTrustedRoot(ctx context.Context, stage string) ([]byte, error) {
	tuf, err := os.MkdirTemp(stage, ".tuf-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(tuf)
	cosign := os.Getenv("CLOUDDRIVE_COSIGN")
	if cosign == "" {
		cosign = "cosign"
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	// #nosec G204 G702 -- 宿主管理员选择 Cosign，信任服务和参数固定，不能由发布包重定向。
	command := exec.CommandContext(ctx, cosign, "initialize", "--mirror", "https://tuf-repo-cdn.sigstore.dev")
	command.Env = append(withoutTUFOverrides(command.Environ()), "TUF_ROOT="+tuf)
	if err := command.Run(); err != nil {
		return nil, fmt.Errorf("初始化 Sigstore 原生升级信任失败: %w", errors.Join(err, ctx.Err()))
	}
	downloaded, err := openOfflineDir(filepath.Join(tuf, "tuf-repo-cdn.sigstore.dev", "targets"))
	if err != nil {
		return nil, err
	}
	defer downloaded.Close()
	return readOfflineFile(downloaded, nativeTrustFile)
}

func withoutTUFOverrides(env []string) []string {
	var filtered []string
	for _, value := range env {
		name, _, _ := strings.Cut(value, "=")
		if strings.HasPrefix(strings.ToUpper(name), "TUF_") {
			continue
		}
		filtered = append(filtered, value)
	}
	return filtered
}

func unpackNativeTarget(ctx context.Context, stage *os.Root, release signedOfflineRelease, asset string, profile NativeProfile, create bool) (NativeManifest, error) {
	file, err := release.openVerified(ctx, stage, asset, nativePackageLimitFor(profile))
	if err != nil {
		return NativeManifest{}, err
	}
	defer file.Close()
	manifest, entries, err := inspectNativeFileFor(file, release.version, runtime.GOOS, runtime.GOARCH, profile)
	if err != nil {
		return NativeManifest{}, err
	}
	for _, entry := range entries[:3] {
		if err := handleNativeEntry(ctx, stage, entry, create); err != nil {
			return NativeManifest{}, err
		}
	}
	if create {
		for index, name := range nativeExecutables(manifest.OS) {
			binary, err := openOfflineFile(stage, name, nativeBinaryLimit)
			if err != nil {
				return NativeManifest{}, err
			}
			if err = errors.Join(verifyNativeBinary(binary, manifest, index), binary.Close()); err != nil {
				return NativeManifest{}, err
			}
		}
	}
	if profile == NativeFull {
		web, err := inspectNativeWeb(manifest, entries[3:])
		if err != nil {
			return NativeManifest{}, err
		}
		if err := web.prepare(ctx, stage, create); err != nil {
			return NativeManifest{}, err
		}
	}
	return manifest, nil
}

// InspectNativeArchive checks the archive layout and manifest for release CI.
// It does not authenticate the archive. StageNative and LoadNative verify its signed digest.
func InspectNativeArchive(archive, version, goos, arch string) (NativeManifest, error) {
	return InspectNativeArchiveFor(archive, version, goos, arch, NativeGo)
}

// InspectNativeArchiveFor checks one profile locally before its release is signed.
func InspectNativeArchiveFor(archive, version, goos, arch string, profile NativeProfile) (NativeManifest, error) {
	if _, err := nativeAssetNameFor(version, goos, arch, profile); err != nil {
		return NativeManifest{}, err
	}
	// #nosec G304 -- CLI caller provides a local build artifact, not a download URL.
	file, err := os.Open(archive)
	if err != nil {
		return NativeManifest{}, err
	}
	defer file.Close()
	manifest, entries, err := inspectNativeFileFor(file, version, goos, arch, profile)
	if err != nil {
		return NativeManifest{}, err
	}
	for index, entry := range entries[1:3] {
		binary, err := entry.Open()
		if err != nil {
			return NativeManifest{}, err
		}
		data, readErr := io.ReadAll(io.LimitReader(binary, nativeBinaryLimit+1))
		if err = errors.Join(readErr, binary.Close()); err != nil || uint64(len(data)) != entry.UncompressedSize64 {
			return NativeManifest{}, errors.Join(err, fmt.Errorf("原生二进制长度不符：%s", entry.Name))
		}
		if err = verifyNativeBinary(bytes.NewReader(data), manifest, index); err != nil {
			return NativeManifest{}, err
		}
	}
	if profile == NativeFull {
		web, err := inspectNativeWeb(manifest, entries[3:])
		if err != nil {
			return NativeManifest{}, err
		}
		if err := web.verifyArchive(); err != nil {
			return NativeManifest{}, err
		}
	}
	return manifest, nil
}

func verifyNativeBinary(input io.ReaderAt, manifest NativeManifest, index int) error {
	info, err := buildinfo.Read(input)
	if err != nil {
		return fmt.Errorf("无法核对 Go 二进制身份: %w", err)
	}
	const module = "github.com/reina0721/clouddrive"
	expected := [2]string{module + "/cmd/app", module + "/cmd/clouddrive-host"}
	settings := make(map[string]string, len(info.Settings))
	for _, setting := range info.Settings {
		settings[setting.Key] = setting.Value
	}
	if info.Path != expected[index] || settings["GOOS"] != manifest.OS || settings["GOARCH"] != manifest.Arch || settings["CGO_ENABLED"] != "0" {
		return fmt.Errorf("原生发布的二进制身份或平台不匹配：%s", nativeExecutables(manifest.OS)[index])
	}
	return nil
}

func inspectNativeFile(file *os.File, version, goos, arch string) (NativeManifest, []*zip.File, error) {
	return inspectNativeFileFor(file, version, goos, arch, NativeGo)
}

func inspectNativeFileFor(file *os.File, version, goos, arch string, profile NativeProfile) (NativeManifest, []*zip.File, error) {
	info, err := file.Stat()
	if err != nil {
		return NativeManifest{}, nil, err
	}
	if !info.Mode().IsRegular() || info.Size() < 1 || info.Size() > nativePackageLimitFor(profile) {
		return NativeManifest{}, nil, errors.New("原生发布包的文件类型或大小无效")
	}
	archive, err := zip.NewReader(file, info.Size())
	if err != nil {
		return NativeManifest{}, nil, err
	}
	entryLimit := 4096
	if profile == NativeFull {
		entryLimit = nativeFullEntryLimit
	}
	if len(archive.File) > entryLimit {
		return NativeManifest{}, nil, errors.New("原生发布包条目过多")
	}
	names := nativeExecutables(goos)
	required := []string{nativeManifestFile, names[0], names[1]}
	found := make(map[string]*zip.File, len(required))
	seen := make(map[string]bool, len(archive.File))
	var fullEntries []*zip.File
	var fullSize uint64
	for _, entry := range archive.File {
		name := strings.TrimSuffix(entry.Name, "/")
		fold := strings.ToLower(name)
		if !fs.ValidPath(name) || name == "." || strings.ContainsAny(name, `\:`) || seen[fold] || (!entry.Mode().IsRegular() && !entry.Mode().IsDir()) {
			return NativeManifest{}, nil, fmt.Errorf("原生发布包的条目无效：%q", entry.Name)
		}
		seen[fold] = true
		if profile == NativeFull {
			if !portableNativePath(name) {
				return NativeManifest{}, nil, fmt.Errorf("整包的文件路径不能跨平台使用：%q", name)
			}
			if entry.UncompressedSize64 > nativeFullExpandedLimit-fullSize {
				return NativeManifest{}, nil, errors.New("整包解压后的大小超出限制")
			}
			fullSize += entry.UncompressedSize64
			if belongsToNativeWeb(name) {
				fullEntries = append(fullEntries, entry)
			}
		}
		for _, expected := range required {
			if name != expected {
				continue
			}
			size := entry.UncompressedSize64
			if !entry.Mode().IsRegular() || size == 0 || size > math.MaxInt64 || int64(size) > nativeEntryLimit(expected) {
				return NativeManifest{}, nil, fmt.Errorf("原生发布包的必要条目大小或类型无效：%s", name)
			}
			found[name] = entry
		}
	}
	for _, name := range required {
		if found[name] == nil {
			return NativeManifest{}, nil, fmt.Errorf("原生发布包缺少 %s", name)
		}
	}
	manifest, err := decodeNativeManifest(found[nativeManifestFile])
	if err == nil {
		err = manifest.validate(version, goos, arch, profile)
	}
	return manifest, append([]*zip.File{found[nativeManifestFile], found[names[0]], found[names[1]]}, fullEntries...), err
}

func nativeEntryLimit(name string) int64 {
	if name == nativeManifestFile {
		return offlineSmallFile
	}
	return nativeBinaryLimit
}

func decodeNativeManifest(entry *zip.File) (NativeManifest, error) {
	reader, err := entry.Open()
	if err != nil {
		return NativeManifest{}, err
	}
	defer reader.Close()
	var manifest NativeManifest
	decoder := json.NewDecoder(io.LimitReader(reader, offlineSmallFile+1))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&manifest); err != nil {
		return NativeManifest{}, err
	}
	if decoder.Decode(new(json.RawMessage)) != io.EOF {
		return NativeManifest{}, errors.New("原生发布清单包含多余内容")
	}
	return manifest, nil
}

func handleNativeEntry(ctx context.Context, stage *os.Root, entry *zip.File, create bool) error {
	archiveReader, err := entry.Open()
	if err != nil {
		return err
	}
	defer archiveReader.Close()
	limit := nativeEntryLimit(entry.Name)
	if create {
		mode := os.FileMode(0500)
		if entry.Name == nativeManifestFile {
			mode = 0400
		}
		return writeNativeFile(stage, entry.Name, &contextReader{ctx: ctx, Reader: archiveReader}, limit, mode)
	}
	localFile, err := openOfflineFile(stage, entry.Name, limit)
	if err != nil {
		return err
	}
	defer localFile.Close()
	archiveHash, localHash := sha256.New(), sha256.New()
	for _, input := range []struct {
		writer io.Writer
		reader io.Reader
	}{{archiveHash, archiveReader}, {localHash, localFile}} {
		copied, err := io.Copy(input.writer, &contextReader{ctx: ctx, Reader: io.LimitReader(input.reader, limit+1)})
		if err != nil || copied < 0 || uint64(copied) != entry.UncompressedSize64 {
			return errors.Join(err, fmt.Errorf("原生版本文件长度不匹配：%s", entry.Name))
		}
	}
	if !bytes.Equal(archiveHash.Sum(nil), localHash.Sum(nil)) {
		return fmt.Errorf("原生版本文件已变化：%s", entry.Name)
	}
	return nil
}

func writeNativeFile(root *os.Root, name string, input io.Reader, limit int64, mode os.FileMode) error {
	file, err := root.OpenFile(name, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode)
	if err != nil {
		return err
	}
	written, err := io.Copy(file, io.LimitReader(input, limit+1))
	if err == nil && (written == 0 || written > limit) {
		err = fmt.Errorf("原生发布文件大小无效：%s", name)
	}
	if err == nil {
		err = file.Sync()
	}
	return errors.Join(err, file.Close())
}
