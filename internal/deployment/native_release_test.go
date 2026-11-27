package deployment

import (
	"archive/zip"
	"context"
	"encoding/json"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

type nativeReleaseRoundTrip func(*http.Request) (*http.Response, error)

func (f nativeReleaseRoundTrip) RoundTrip(request *http.Request) (*http.Response, error) {
	return f(request)
}

func TestNativeCandidatesFiltersPublishedPlatformAssetsAndSorts(t *testing.T) {
	const current = "v0.2.0"
	if _, err := nativeAssetName(current, runtime.GOOS, runtime.GOARCH); err != nil {
		t.Skip("原生平台不受支持")
	}
	release := func(version, state string) nativeReleaseSummary {
		asset, err := nativeAssetName(version, runtime.GOOS, runtime.GOARCH)
		if err != nil {
			t.Fatal(err)
		}
		return nativeReleaseSummary{Tag: version, Assets: []struct {
			Name  string `json:"name"`
			State string `json:"state"`
		}{{Name: asset, State: state}}}
	}
	page := make([]nativeReleaseSummary, 30)
	page[0] = release("v0.9.0", "uploaded")
	page[0].Assets[0].Name = strings.Replace(page[0].Assets[0].Name, "clouddrive_", "neocloud_", 1)
	page[1] = release("v0.12.0", "uploaded")
	page[1].Draft = true
	page[2] = release("v0.13.0", "uploaded")
	page[2].Prerelease = true
	page[3] = release("v0.14.0", "starter")
	page[4] = release("v0.1.9", "uploaded")
	page[5] = release("v0.15.0", "uploaded")
	page[5].Assets[0].Name = "install.sh"
	page[6] = release("v0.8.0", "uploaded")
	page[6].Assets[0].Name = strings.Replace(page[6].Assets[0].Name, "_managed-go.zip", "_managed-full.zip", 1)
	var calls int
	client := &Releases{http: &http.Client{Transport: nativeReleaseRoundTrip(func(request *http.Request) (*http.Response, error) {
		calls++
		if request.URL.Host != "api.github.com" || request.URL.Path != "/repos/"+repository+"/releases" {
			t.Fatalf("意外的发布来源：%s", request.URL)
		}
		var rows []nativeReleaseSummary
		switch request.URL.Query().Get("page") {
		case "1":
			rows = page
		case "2":
			rows = []nativeReleaseSummary{release("v0.9.0", "uploaded"), release("v0.10.0", "uploaded")}
		default:
			t.Fatal("意外的额外分页")
		}
		data, err := json.Marshal(rows)
		if err != nil {
			t.Fatal(err)
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(string(data)))}, nil
	})}}
	got, err := client.NativeCandidates(t.Context(), current)
	if err != nil || !reflect.DeepEqual(got, []string{"v0.10.0", "v0.9.0"}) || calls != 2 {
		t.Fatalf("候选：%v 请求数：%d 错误：%v", got, calls, err)
	}
	got, err = client.NativeCandidatesFor(t.Context(), current, NativeFull)
	if err != nil || !reflect.DeepEqual(got, []string{"v0.8.0"}) {
		t.Fatalf("整包候选混入其他发布类型：%v，%v", got, err)
	}
}

type nativeZipTestEntry struct {
	name string
	body string
	mode fs.FileMode
}

func writeNativeFixture(t *testing.T, entries []nativeZipTestEntry) *os.File {
	t.Helper()
	file, err := os.CreateTemp(t.TempDir(), "*.zip")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = file.Close() })
	archive := zip.NewWriter(file)
	for _, entry := range entries {
		header := &zip.FileHeader{Name: entry.name}
		header.SetMode(entry.mode)
		writer, err := archive.CreateHeader(header)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = writer.Write([]byte(entry.body)); err != nil {
			t.Fatal(err)
		}
	}
	if err = archive.Close(); err != nil {
		t.Fatal(err)
	}
	return file
}

func baselineNativeFixture(t *testing.T) []nativeZipTestEntry {
	t.Helper()
	manifest, err := json.Marshal(NativeManifest{
		Version: "v0.2.3", Commit: strings.Repeat("a", 40), OS: "windows", Arch: "amd64", HostProtocol: NativeHostProtocol,
	})
	if err != nil {
		t.Fatal(err)
	}
	return []nativeZipTestEntry{
		{name: nativeManifestFile, body: string(manifest), mode: 0400},
		{name: "clouddrive.exe", body: "candidate", mode: 0500},
		{name: "clouddrive-host.exe", body: "host", mode: 0500},
	}
}

func TestNativeArchiveIdentityAndUnsafeEntries(t *testing.T) {
	base := baselineNativeFixture(t)
	file := writeNativeFixture(t, base)
	manifest, _, err := inspectNativeFile(file, "v0.2.3", "windows", "amd64")
	if err != nil || manifest.Version != "v0.2.3" {
		t.Fatalf("inspect archive: %+v %v", manifest, err)
	}
	if _, _, err := inspectNativeFile(file, "v0.2.4", "windows", "amd64"); err == nil {
		t.Fatal("不同正式版本通过了校验")
	}
	for _, entry := range []nativeZipTestEntry{
		{name: "../evil.exe", body: "escape", mode: 0500},
		{name: `folder\evil.exe`, body: "escape", mode: 0500},
		{name: "CLOuddrive.exe", body: "duplicate", mode: 0500},
		{name: "link", body: "clouddrive.exe", mode: fs.ModeSymlink},
	} {
		t.Run(entry.name, func(t *testing.T) {
			archive := writeNativeFixture(t, append(base, entry))
			if _, _, err := inspectNativeFile(archive, "v0.2.3", "windows", "amd64"); err == nil {
				t.Fatal("接收了不安全的归档条目")
			}
		})
	}
}

func TestNativeArchiveRequiresMatchingExecutableFamily(t *testing.T) {
	entries := baselineNativeFixture(t)
	entries[1].name, entries[2].name = "neocloud.exe", "neocloud-host.exe"
	manifest, _, err := inspectNativeFile(writeNativeFixture(t, entries), "v0.2.3", "windows", "amd64")
	if err != nil || manifest.family != neoRelease {
		t.Fatalf("无法读取 NeoCloud 原生程序：%v %v", manifest.family, err)
	}
	entries[2].name = "clouddrive-host.exe"
	if _, _, err := inspectNativeFile(writeNativeFixture(t, entries), "v0.2.3", "windows", "amd64"); err == nil {
		t.Fatal("接受了不同命名系列的业务程序和宿主")
	}
}

func TestNativeStageEntryDetectsTampering(t *testing.T) {
	base := baselineNativeFixture(t)
	file := writeNativeFixture(t, base)
	_, entries, err := inspectNativeFile(file, "v0.2.3", "windows", "amd64")
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	root, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	ctx := context.Background()
	entry := entries[1]
	if err := handleNativeEntry(ctx, root, entry, true); err != nil {
		t.Fatal(err)
	}
	if err := handleNativeEntry(ctx, root, entry, false); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, entry.Name)
	if err := os.Chmod(path, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("tampering"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := handleNativeEntry(ctx, root, entry, false); err == nil {
		t.Fatal("已篡改的暂存程序通过了重新验证")
	}
}

func TestNativeVersionMovesIntoSameStore(t *testing.T) {
	root, err := os.OpenRoot(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	if err := root.Mkdir("candidate", 0700); err != nil {
		t.Fatal(err)
	}
	if err := root.WriteFile("candidate/payload", []byte("ready"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := publishNativeDirectory(root, "candidate", "v0.2.3"); err != nil {
		t.Fatal(err)
	}
	data, err := root.ReadFile("v0.2.3/payload")
	if err != nil || string(data) != "ready" {
		t.Fatalf("发布目录内容不正确：%q %v", data, err)
	}
}
