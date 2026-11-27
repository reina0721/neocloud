package deployment

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func offlineTestArchive(t *testing.T, version, arch, installer string) []byte {
	t.Helper()
	var output bytes.Buffer
	compressed := gzip.NewWriter(&output)
	archive := tar.NewWriter(compressed)
	tag := version + "-" + arch
	manifest := fmt.Sprintf("FORMAT=1\nVERSION=%s\nARCH=%s\nCOMMIT=%s\nAPI_ID=sha256:%s\nWEB_ID=sha256:%s\n",
		version, arch, strings.Repeat("a", 40), strings.Repeat("b", 64), strings.Repeat("c", 64))
	for name, data := range map[string]string{
		"compose.yaml": "services: {}", "images.tar": "fake-docker-image",
		"images.env": "API_IMAGE=clouddrive-api:" + tag + "\nWEB_IMAGE=clouddrive-web:" + tag + "\n",
		"install.sh": installer, "manifest.txt": manifest,
	} {
		if err := archive.WriteHeader(&tar.Header{Name: name, Mode: 0600, Size: int64(len(data)), Typeflag: tar.TypeReg}); err != nil {
			t.Fatal(err)
		}
		if _, err := archive.Write([]byte(data)); err != nil {
			t.Fatal(err)
		}
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	if err := compressed.Close(); err != nil {
		t.Fatal(err)
	}
	return output.Bytes()
}

func writeOfflineTestAsset(t *testing.T, path string, data []byte) {
	t.Helper()
	if err := os.WriteFile(path, data, 0700); err != nil {
		t.Fatal(err)
	}
}

func TestOfflineArchiveVerifiesIdentityAndInstaller(t *testing.T) {
	version := "v1.2.3"
	installer := "test-installer"
	data := offlineTestArchive(t, version, "amd64", installer)
	release := signedOfflineRelease{
		version: version,
		digests: map[string]string{"install.sh": fmt.Sprintf("%x", sha256.Sum256([]byte(installer)))},
	}
	if err := verifyOfflineArchive(t.Context(), bytes.NewReader(data), release, "amd64", legacyRelease); err != nil {
		t.Fatal(err)
	}
	if err := verifyOfflineArchive(t.Context(), bytes.NewReader(data), release, "arm64", legacyRelease); err == nil {
		t.Fatal("接受了不同平台的离线包")
	}
	release.digests["install.sh"] = strings.Repeat("0", 64)
	if err := verifyOfflineArchive(t.Context(), bytes.NewReader(data), release, "amd64", legacyRelease); err == nil {
		t.Fatal("接受了包内与签名安装器不一致的离线包")
	}
}

func TestOfflineImportKeepsVersionAndTrustImmutable(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("离线导入夹具需要 Linux shell")
	}
	verifier := filepath.Join(t.TempDir(), "cosign")
	writeOfflineTestAsset(t, verifier, []byte(`#!/bin/sh
set -eu
[ "$1" = verify-blob ] && [ "$2" = --offline ] || exit 1
case "$*" in *"--new-bundle-format --trusted-root"*) ;; *) exit 2 ;; esac
case "$*" in *"https://github.com/reina0721/neocloud/.github/workflows/release.yml@refs/tags/v1.2.3"*) ;; *) exit 3 ;; esac
cat >/dev/null
`))
	t.Setenv("CLOUDDRIVE_COSIGN", verifier)
	source, trust, instance := t.TempDir(), t.TempDir(), t.TempDir()
	material := filepath.Join(trust, "trusted_root.json")
	writeOfflineTestAsset(t, material, []byte("trusted snapshot"))
	version := "v1.2.3"
	name := dockerAssetName(version, runtime.GOARCH)
	bundle := []byte(`{"mediaType":"application/vnd.dev.sigstore.bundle.v0.3+json"}`)
	writeOfflineTestAsset(t, filepath.Join(source, offlineBundle), bundle)
	putPackage := func(installer string) {
		data := offlineTestArchive(t, version, runtime.GOARCH, installer)
		checksum := fmt.Sprintf("%x  %s\n", sha256.Sum256(data), name)
		writeOfflineTestAsset(t, filepath.Join(source, name), data)
		writeOfflineTestAsset(t, filepath.Join(source, offlineChecksums), []byte(checksum))
	}
	putPackage("initial fixture")
	release, err := ImportOfflineRelease(t.Context(), instance, source, version, trust)
	if err != nil || release.Version != version {
		t.Fatalf("导入失败: %+v %v", release, err)
	}
	control := filepath.Join(instance, ".control", "maintenance")
	localTrust := filepath.Join(control, "trust")
	store := filepath.Join(control, "assets")
	if versions, err := OfflineVersions(t.Context(), store, localTrust); err != nil || len(versions) != 1 || versions[0].Version != version {
		t.Fatalf("无法读取本地版本: %+v %v", versions, err)
	}
	if _, err = ImportOfflineRelease(t.Context(), instance, source, version, ""); err != nil {
		t.Fatalf("重复导入未保持幂等: %v", err)
	}
	legacy := t.TempDir()
	for _, name := range []string{"fulcio.pem", "rekor.pub", "ctfe.pub"} {
		writeOfflineTestAsset(t, filepath.Join(legacy, name), []byte(name))
	}
	if _, err = ImportOfflineRelease(t.Context(), instance, source, version, legacy); err != nil {
		t.Fatalf("不能追加独立提供的旧格式信任材料: %v", err)
	}
	for _, name := range []string{"fulcio.pem", "rekor.pub", "ctfe.pub", "trusted_root.json"} {
		if _, err = os.Stat(filepath.Join(localTrust, name)); err != nil {
			t.Fatal(err)
		}
	}
	putPackage("same tag different contents")
	if _, err = ImportOfflineRelease(t.Context(), instance, source, version, ""); err == nil {
		t.Fatal("允许覆盖同一个已存储版本")
	}
	if err = VerifyOfflineRelease(t.Context(), filepath.Join(store, version), version, localTrust); err != nil {
		t.Fatalf("同名导入破坏了原版本: %v", err)
	}
	writeOfflineTestAsset(t, material, []byte("unapproved replacement"))
	if _, err = ImportOfflineRelease(t.Context(), instance, source, version, trust); err == nil {
		t.Fatal("允许更换现有信任材料")
	}
	nestedTrust := filepath.Join(source, "untrusted")
	if err = os.Mkdir(nestedTrust, 0700); err != nil {
		t.Fatal(err)
	}
	if err = VerifyOfflineRelease(t.Context(), source, version, nestedTrust); err == nil {
		t.Fatal("使用了发布介质中的信任材料")
	}
	target := filepath.Join(source, name)
	if err = os.Remove(target); err != nil {
		t.Fatal(err)
	}
	if err = os.Symlink(filepath.Join(store, version, name), target); err != nil {
		t.Fatal(err)
	}
	if err = VerifyOfflineRelease(t.Context(), source, version, localTrust); err == nil {
		t.Fatal("跟随了发布介质中的符号链接")
	}
}
