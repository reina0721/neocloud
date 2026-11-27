package deployment

import (
	"errors"
	"fmt"
)

type releaseFamily string

const (
	legacyRelease releaseFamily = "clouddrive"
	neoRelease    releaseFamily = "neocloud"
)

var releaseFamilies = [...]releaseFamily{neoRelease, legacyRelease}

func (f releaseFamily) dockerAsset(version, arch string) string {
	return fmt.Sprintf("%s_%s_linux_%s_docker.tar.gz", f, version, arch)
}

func (f releaseFamily) maintenanceAsset(version, arch string) string {
	return fmt.Sprintf("%s-maintenance_%s_linux_%s", f, version, arch)
}

func (f releaseFamily) dockerImageEnvironment(version, arch string) string {
	tag := version + "-" + arch
	return fmt.Sprintf("API_IMAGE=%s-api:%s\nWEB_IMAGE=%s-web:%s\n", f, tag, f, tag)
}

func selectSignedAsset(digests map[string]string, name func(releaseFamily) string) (releaseFamily, string, error) {
	var selected releaseFamily
	var asset string
	for _, family := range releaseFamilies {
		candidate := name(family)
		if _, exists := digests[candidate]; !exists {
			continue
		}
		if selected != "" {
			return "", "", errors.New("校验清单包含两个命名系列的同一发行产物")
		}
		selected, asset = family, candidate
	}
	if selected == "" {
		return "", "", fmt.Errorf("校验清单缺少发行产物 %s 或 %s", name(neoRelease), name(legacyRelease))
	}
	return selected, asset, nil
}
