package deployment

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func fullNativeFixture(t *testing.T, add map[string]string) []nativeZipTestEntry {
	t.Helper()
	buildID := strings.Repeat("a", 40)
	page := "<!doctype html><title>CloudDrive fixture</title>"
	files := map[string]string{
		"index.html": page, "404.html": page, "home.html": page, "login.html": page, "workspace.html": page,
		"_next/static/fixture.js": "console.log('fixture')",
		"empty.txt":               "",
		"web-build.json":          fmt.Sprintf("{\"buildId\":%q}", buildID),
	}
	for path, data := range add {
		files[path] = data
	}
	var index []nativeWebFile
	entries := baselineNativeFixture(t)
	for path, data := range files {
		index = append(index, nativeWebFile{Path: path, Size: int64(len(data)), SHA256: fmt.Sprintf("%x", sha256.Sum256([]byte(data)))})
		entries = append(entries, nativeZipTestEntry{name: "web/" + path, body: data, mode: 0400})
	}
	data, err := json.Marshal(index)
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := json.Marshal(NativeManifest{
		Version: "v0.2.3", Commit: buildID, OS: "windows", Arch: "amd64", HostProtocol: NativeFullHostProtocol,
		Profile: NativeFull, WebID: buildID, WebInventorySHA256: fmt.Sprintf("%x", sha256.Sum256(data)),
	})
	if err != nil {
		t.Fatal(err)
	}
	entries[0].body = string(manifest)
	return append(entries, nativeZipTestEntry{name: nativeWebInventory, body: string(data), mode: 0400})
}

func TestNativeFullWebInventoryAndCache(t *testing.T) {
	file := writeNativeFixture(t, fullNativeFixture(t, nil))
	if _, _, err := inspectNativeFile(file, "v0.2.3", "windows", "amd64"); err == nil {
		t.Fatal("Go-only profile accepted a full package")
	}
	manifest, entries, err := inspectNativeFileFor(file, "v0.2.3", "windows", "amd64", NativeFull)
	if err != nil {
		t.Fatal(err)
	}
	web, err := inspectNativeWeb(manifest, entries[3:])
	if err != nil {
		t.Fatal(err)
	}
	root, err := os.OpenRoot(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	if err := web.prepare(t.Context(), root, true); err != nil {
		t.Fatal(err)
	}
	if err := web.prepare(t.Context(), root, false); err != nil {
		t.Fatal(err)
	}
	if data, err := root.ReadFile("web/empty.txt"); err != nil || len(data) != 0 {
		t.Fatalf("empty static resource: %q, %v", data, err)
	}
	if err := root.WriteFile("web/unlisted.html", []byte("not signed"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := web.prepare(t.Context(), root, false); err == nil {
		t.Fatal("cached deployment accepted a file outside the signed inventory")
	}
	if err := root.Remove("web/unlisted.html"); err != nil {
		t.Fatal(err)
	}
	if err := root.Chmod("web/home.html", 0600); err != nil {
		t.Fatal(err)
	}
	if err := root.WriteFile("web/home.html", []byte("tampered cached file"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := web.prepare(t.Context(), root, false); err == nil {
		t.Fatal("cached deployment accepted a modified static asset")
	}
}

func TestNativeFullRejectsWrongTree(t *testing.T) {
	for _, test := range []struct {
		name  string
		extra map[string]string
	}{
		{"different Web commit", map[string]string{"web-build.json": "{}"}},
		{"Windows device", map[string]string{"docs/aux.html": "collision"}},
		{"case conflict in implied directories", map[string]string{"Tree/a.txt": "first", "tree/b.txt": "second"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			file := writeNativeFixture(t, fullNativeFixture(t, test.extra))
			manifest, entries, err := inspectNativeFileFor(file, "v0.2.3", "windows", "amd64", NativeFull)
			if err == nil {
				_, err = inspectNativeWeb(manifest, entries[3:])
			}
			if err == nil {
				t.Fatal("full package accepted an invalid Web tree")
			}
		})
	}
	entries := fullNativeFixture(t, nil)
	for i := range entries {
		if entries[i].name == "web/home.html" {
			entries[i].body = strings.Repeat("x", len(entries[i].body))
		}
	}
	file := writeNativeFixture(t, entries)
	manifest, related, err := inspectNativeFileFor(file, "v0.2.3", "windows", "amd64", NativeFull)
	if err != nil {
		t.Fatal(err)
	}
	web, err := inspectNativeWeb(manifest, related[3:])
	if err != nil {
		t.Fatal(err)
	}
	if err := web.verifyArchive(); err == nil {
		t.Fatal("full package accepted corrupted bytes of the right length")
	}
	base := t.TempDir()
	goStore, err := NativeCacheDirectory(base, NativeGo)
	if err != nil || goStore != base {
		t.Fatalf("legacy Go store moved: %s %v", goStore, err)
	}
	fullStore, err := NativeCacheDirectory(base, NativeFull)
	if err != nil || fullStore != filepath.Join(base, "managed-full") {
		t.Fatalf("full store lacks a separate namespace: %s %v", fullStore, err)
	}
}
