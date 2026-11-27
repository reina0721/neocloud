#!/usr/bin/env bash
# 使用真实签名、Docker 与隔离网络命名空间；仅创建本次验收的实例。
set -euo pipefail

[[ $# == 4 ]] || { printf '用法：bash scripts/test-offline-release.sh 发布目录 信任目录 版本 架构\n' >&2; exit 1; }
assets=$(realpath -e -- "$1")
trust=$(realpath -e -- "$2")
version=$3
arch=$4
[[ $version =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ && ( $arch == amd64 || $arch == arm64 ) ]]
cosign=$(command -v "${NEOCLOUD_COSIGN:-${CLOUDDRIVE_COSIGN:-cosign}}")
family=$(awk -v suffix="-maintenance_${version}_linux_${arch}" '$2 == "neocloud" suffix { print "neocloud" } $2 == "clouddrive" suffix { print "clouddrive" }' "$assets/checksums.txt")
[[ $family == neocloud || $family == clouddrive ]] || { echo '维护程序命名系列无法确定' >&2; exit 1; }
tool="$family-maintenance_${version}_linux_${arch}"
fixture=$(mktemp -d "${TMPDIR:-/tmp}/clouddrive-airgap-XXXXXXXX")
fixture=$(realpath -e -- "$fixture")
instance="$fixture/instance"
disk="$fixture/disk"
data="$disk/data"
checksum=$(printf '%s' "$instance" | sha256sum)
project="clouddrive-airgap-${checksum:0:12}"
owner=$(printf '%s\0%s\0%s' "$instance" "$project" "$data" | sha256sum)
owner=${owner%% *}
mounted=false

cleanup() {
  local status=$? current_owner cleaned=true
  current_owner=$(sudo docker volume inspect --format '{{index .Labels "io.clouddrive.release.owner"}}' "$project-instance" 2>/dev/null) || current_owner=
  if [[ $current_owner == "$owner" ]]; then
    if sudo test -f "$instance/releases/$version/compose.yaml"; then
      sudo env "CLOUDDRIVE_RELEASE_DATA_DIR=$data" docker compose --project-directory "$instance" --project-name "$project" \
        --env-file "$instance/runtime.env" --env-file "$instance/releases/$version/images.env" \
        --file "$instance/releases/$version/compose.yaml" down --remove-orphans || cleaned=false
    fi
    if [[ $cleaned == true ]]; then sudo docker volume rm "$project-instance" >/dev/null || cleaned=false; fi
  elif sudo test -f "$instance/.control/project"; then
    printf '归属卷缺失或与验收实例不符：%s-instance\n' "$project" >&2
    cleaned=false
  fi
  if [[ $mounted == true ]]; then sudo umount -- "$disk" || cleaned=false; fi
  if [[ $cleaned == false ]]; then
    printf '验收实例清理失败：%s\n' "$instance" >&2
    if [[ $status == 0 ]]; then status=1; fi
  fi
  if [[ $status == 0 ]]; then sudo rm -rf -- "$fixture"
  else printf '离线验收现场：%s\n' "$fixture" >&2; fi
  exit "$status"
}
trap cleanup EXIT

airgap() {
  sudo unshare --net -- env "PATH=$PATH" "CLOUDDRIVE_COSIGN=$cosign" bash -ec '
    [[ -z $(ip route show default) && -z $(ip -6 route show default) ]]
    exec "$@"
  ' bash "$@"
}

# 先从独立信任目录验证附件，再执行维护二进制及安装器。
airgap "$cosign" verify-blob --offline --new-bundle-format \
  --trusted-root "$trust/trusted_root.json" --bundle "$assets/checksums.txt.sigstore.json" \
  --certificate-identity "https://github.com/reina0721/neocloud/.github/workflows/release.yml@refs/tags/$version" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com "$assets/checksums.txt"
(
  cd "$assets"
  for name in "$tool" install.sh; do
    awk -v asset="$name" '$2 == asset {print}' checksums.txt | sha256sum --check --strict -
  done
)
cp -- "$assets/$tool" "$fixture/maintenance"
chmod 700 "$fixture/maintenance"
airgap "$fixture/maintenance" verify-release --release-dir "$assets" --trust-dir "$trust" --version "$version" --arch "$arch" --asset "$tool"

mkdir -- "$disk"
sudo mount -t tmpfs -o size=128m,mode=0700 tmpfs "$disk"
mounted=true
test "$(stat -c %d "$fixture")" != "$(stat -c %d "$disk")"
port=$(node -e 'const net=require("node:net");const s=net.createServer();s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close()})')
airgap bash "$assets/install.sh" install --name "$project" --dir "$instance" --data-dir "$data" --bind 127.0.0.1 --port "$port" \
  --release-dir "$assets" --trust-dir "$trust" --version "$version"
test "$(sudo cat "$instance/.control/current")" = "$version"
test "$(sudo cat "$instance/.control/data-dir")" = "$data"
test "$(sudo cat "$instance/.control/maintenance/offline-tool")" = "$version"
airgap "$instance/install.sh" check-update --offline
airgap "$instance/install.sh" backup --full
snapshot=$(sudo find "$instance/backups" -name snapshot.json -print -quit)
snapshot_dir=${snapshot%/snapshot.json}
backup_id=${snapshot_dir##*/full-}
[[ $backup_id =~ ^[a-f0-9]{32}$ ]]
web_image=$(sudo sed -n 's/^WEB_IMAGE=//p' "$instance/releases/$version/images.env")
airgap docker run --rm --network none --pull never --user 0:0 \
  --mount "type=bind,source=$data,target=/data" "$web_image" sh -ec '
    test -f /data/app.db
    printf "test modification\n" > /data/release-airgap-probe
  '
airgap "$instance/install.sh" restore --offline --backup-id "$backup_id" --confirm-restore "$backup_id"
airgap docker run --rm --network none --pull never --user 0:0 \
  --mount "type=bind,source=$disk,target=/disk,readonly" "$web_image" sh -ec '
    test -f /disk/data/app.db
    test ! -e /disk/data/release-airgap-probe
    set -- /disk/.clouddrive-restore-*/original-data/release-airgap-probe
    test "$#" -eq 1
    test "$(cat -- "$1")" = "test modification"
  '
curl --fail --silent --show-error --max-time 15 "http://127.0.0.1:$port/login" >/dev/null
printf '真实断网 Linux 安装、离线版本检查、跨文件系统完整备份与恢复通过：%s/%s\n' "$version" "$arch"
