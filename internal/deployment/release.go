package deployment

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const repository = "reina0721/neocloud"
const releaseOrigin = "https://github.com/" + repository

type Releases struct {
	http *http.Client
}

func NewReleases() *Releases {
	return &Releases{http: &http.Client{
		Timeout: 30 * time.Minute,
		CheckRedirect: func(r *http.Request, via []*http.Request) error {
			switch r.URL.Host {
			case "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com":
				if r.URL.Scheme == "https" && len(via) < 5 {
					return nil
				}
			}
			return errors.New("Release 重定向不受信")
		},
	}}
}

func (s *Releases) Latest(ctx context.Context) (Release, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	var value struct {
		Tag        string `json:"tag_name"`
		Body       string `json:"body"`
		Draft      bool   `json:"draft"`
		Prerelease bool   `json:"prerelease"`
	}
	resp, err := s.get(ctx, "https://api.github.com/repos/"+repository+"/releases/latest")
	if err != nil {
		return Release{}, err
	}
	defer resp.Close()
	if err = json.NewDecoder(io.LimitReader(resp, 1<<20)).Decode(&value); err != nil ||
		value.Draft || value.Prerelease || !versionPattern.MatchString(value.Tag) {
		return Release{}, errors.New("最新正式版响应无效")
	}
	return Release{Version: value.Tag, Notes: value.Body, URL: releaseOrigin + "/releases/tag/" + value.Tag}, nil
}

func (s *Releases) get(ctx context.Context, address string) (io.ReadCloser, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, address, nil)
	if err != nil {
		return nil, err
	}
	response, err := s.http.Do(req)
	if err != nil {
		return nil, err
	}
	if response.StatusCode != http.StatusOK {
		return nil, errors.Join(fmt.Errorf("正式产物请求失败，HTTP %d", response.StatusCode), response.Body.Close())
	}
	return response.Body, nil
}

func fileDigest(path string) (string, error) {
	// #nosec G304 -- 调用方仅传入管理目录的固定文件名或已限定格式的发布附件。
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	hash := sha256.New()
	_, err = io.Copy(hash, f)
	return hex.EncodeToString(hash.Sum(nil)), err
}

func VerifyRelease(ctx context.Context, dir, version string) error {
	if !versionPattern.MatchString(version) {
		return errors.New("维护只接受正式版本")
	}
	cosign := os.Getenv("CLOUDDRIVE_COSIGN")
	if cosign == "" {
		cosign = "cosign"
	}
	// #nosec G204 G702 -- cosign 由安装者配置，证书身份的 tag 已限定格式，参数独立传递。
	command := exec.CommandContext(ctx, cosign, "verify-blob",
		"--bundle", filepath.Join(dir, "checksums.txt.sigstore.json"),
		"--certificate-identity", releaseOrigin+"/.github/workflows/release.yml@refs/tags/"+version,
		"--certificate-oidc-issuer", "https://token.actions.githubusercontent.com",
		filepath.Join(dir, "checksums.txt"))
	if err := command.Run(); err != nil {
		return fmt.Errorf("正式发布签名验证失败: %w", err)
	}
	return nil
}

func VerifyAsset(dir, name string) error {
	root, err := os.OpenRoot(dir)
	if err != nil {
		return err
	}
	defer root.Close()
	f, err := root.Open("checksums.txt")
	if err != nil {
		return err
	}
	defer f.Close()
	asset, err := root.Open(name)
	if err != nil {
		return err
	}
	defer asset.Close()
	return verifyAsset(f, asset, name)
}

func verifyAsset(reader, asset io.Reader, name string) error {
	var want string
	scanner := bufio.NewScanner(reader)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) == 2 && strings.TrimPrefix(fields[1], "*") == name {
			if want != "" {
				return errors.New("产物校验条目重复")
			}
			want = fields[0]
		}
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	hash := sha256.New()
	if _, err := io.Copy(hash, asset); err != nil {
		return err
	}
	if want != hex.EncodeToString(hash.Sum(nil)) {
		return errors.New("正式产物摘要不匹配")
	}
	return nil
}

func (s *Releases) Package(ctx context.Context, dir, version string) error {
	if !versionPattern.MatchString(version) {
		return errors.New("目标需要正式版本号")
	}
	const MB = 1 << 20
	for _, asset := range []string{"checksums.txt", "checksums.txt.sigstore.json"} {
		if err := s.download(ctx, dir, version, asset, MB); err != nil {
			return err
		}
	}
	if err := VerifyRelease(ctx, dir, version); err != nil {
		return err
	}
	asset := fmt.Sprintf("clouddrive_%s_linux_%s_docker.tar.gz", version, runtime.GOARCH)
	if err := s.download(ctx, dir, version, asset, 6<<30); err != nil {
		return err
	}
	return VerifyAsset(dir, asset)
}

func (s *Releases) download(ctx context.Context, dir, version, asset string, limit int64) error {
	remote := releaseOrigin + "/releases/download/" + url.PathEscape(version) + "/" + url.PathEscape(asset)
	body, err := s.get(ctx, remote)
	if err != nil {
		return err
	}
	defer body.Close()
	root, err := os.OpenRoot(dir)
	if err != nil {
		return err
	}
	defer root.Close()
	file, err := root.OpenFile(asset, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	written, err := io.Copy(file, io.LimitReader(body, limit+1))
	err = errors.Join(err, file.Close())
	if err == nil && written > limit {
		return errors.New("正式产物超过长度上限")
	}
	return err
}
