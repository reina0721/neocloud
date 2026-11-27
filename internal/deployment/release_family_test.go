package deployment

import "testing"

func TestSignedDockerAssetFamilyIsUnambiguous(t *testing.T) {
	release := signedOfflineRelease{version: "v0.4.0"}
	legacy, neo := legacyRelease.dockerAsset(release.version, "amd64"), neoRelease.dockerAsset(release.version, "amd64")
	for _, family := range releaseFamilies {
		name := family.dockerAsset(release.version, "amd64")
		release.digests = map[string]string{name: "fixture"}
		selected, asset, err := release.dockerAsset("amd64")
		if err != nil || selected != family || asset != name {
			t.Fatalf("选择了错误的签名附件族：%q %q %v", selected, asset, err)
		}
	}
	release.digests = map[string]string{legacy: "fixture", neo: "fixture"}
	if _, _, err := release.dockerAsset("amd64"); err == nil {
		t.Fatal("接受了同时声明两个附件命名族的签名清单")
	}
}
