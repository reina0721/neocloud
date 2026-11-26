#!/usr/bin/env bash
# 构建单一平台的离线 Docker Release 包；CI 在两种原生 runner 分别执行。
set -Eeuo pipefail
umask 022
# 一次解析主流程，长时间构建期间不重新读取可能被编辑的脚本尾部。
main() {
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
version='' arch='' out='' api_source='' web_source=''
while [[ $# -gt 0 ]]; do
  case $1 in
    --version) version=$2; shift 2 ;;
    --arch) arch=$2; shift 2 ;;
    --out) out=$2; shift 2 ;;
    --api-image) api_source=$2; shift 2 ;;
    --web-image) web_source=$2; shift 2 ;;
    *) printf '未知参数：%s\n' "$1" >&2; exit 1 ;;
  esac
done
[[ $version =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ && $arch =~ ^(amd64|arm64)$ ]] || { echo '需要 --version vX.Y.Z --arch amd64|arm64' >&2; exit 1; }
out=$(realpath -m "${out:-$root/dist/docker}")
mkdir -p "$out"
d() { if [[ ${CLOUDDRIVE_DOCKER_SUDO:-0} == 1 ]]; then sudo -n docker "$@"; else docker "$@"; fi; }
commit=$(git -C "$root" rev-parse HEAD)
api="clouddrive-api:$version-$arch"; web="clouddrive-web:$version-$arch"
if [[ -z $api_source && -z $web_source ]]; then
  dirty=false; [[ -z $(git -C "$root" status --porcelain) ]] || dirty=true
  d buildx build --platform "linux/$arch" --load --build-arg VERSION="$version" --build-arg COMMIT="$commit" --build-arg DIRTY="$dirty" --build-arg BUILD_TIME="$(date -u +%FT%TZ)" --tag "$api" "$root"
  d buildx build --platform "linux/$arch" --load --file "$root/frontend/Dockerfile" --build-arg VERSION="$version" --build-arg COMMIT="$commit" --tag "$web" "$root"
elif [[ -n $api_source && -n $web_source ]]; then
  # 已构建的配套镜像用于重复打包；仍校验版本/平台/源码，不能伪造发布标签。
  d image tag "$api_source" "$api"; d image tag "$web_source" "$web"
else echo '两个源镜像必须一起提供' >&2; exit 1; fi
stage=$(mktemp -d); probe=''
cleanup() {
  status=$?
  if [[ -n $probe ]]; then d container rm "$probe" >/dev/null 2>&1 || true; fi
  rm -rf "$stage"
  return "$status"
}
trap cleanup EXIT
cp "$root/compose.release.yaml" "$stage/compose.yaml"
cp "$root/install.sh" "$stage/install.sh"
printf 'API_IMAGE=%s\nWEB_IMAGE=%s\n' "$api" "$web" > "$stage/images.env"
printf 'FORMAT=1\nNETWORK=1\nENTRYPOINT=1\nINSTANCE_LAYOUT=1\nOFFLINE_MAINTENANCE=1\nVERSION=%s\nARCH=%s\nCOMMIT=%s\n' "$version" "$arch" "$commit" > "$stage/manifest.txt"
for pair in "API:$api" "WEB:$web"; do
  kind=${pair%%:*}; ref=${pair#*:}
  identity=$(d image inspect --format '{{.Os}}|{{.Architecture}}|{{index .Config.Labels "org.opencontainers.image.version"}}|{{index .Config.Labels "org.opencontainers.image.revision"}}' "$ref")
  [[ $identity == "linux|$arch|$version|$commit" ]] || { echo "镜像 $ref 的平台、版本或源码不匹配" >&2; exit 1; }
done
# 只创建容器并读取文件，不执行目标程序；模拟执行也不能掩盖错装的架构。
probe=$(d container create --platform "linux/$arch" "$api")
d container cp "$probe:/app/clouddrive" "$stage/api-binary"
node "$root/scripts/verify-elf-platform.mjs" "$stage/api-binary" "$arch"
d container rm "$probe" >/dev/null; probe=''
rm "$stage/api-binary"
d image save "$api" "$web" > "$stage/images.tar"
for pair in "API:$api" "WEB:$web"; do
  kind=${pair%%:*}; ref=${pair#*:}
  config_id=$(node "$root/scripts/docker-image-config-id.mjs" "$stage/images.tar" "$ref" "$arch")
  printf '%s_ID=%s\n' "$kind" "$config_id" >> "$stage/manifest.txt"
done
# 由调用者重定向创建归档，避免 sudo Docker 创建仅 root 可读的文件。
archive="clouddrive_${version}_linux_${arch}_docker.tar.gz"
tar --create --gzip --file "$out/$archive" --directory "$stage" compose.yaml images.env images.tar install.sh manifest.txt
cp "$root/install.sh" "$out/install.sh"
printf '%s\n' "$version" > "$out/version.txt"
(cd "$out" && sha256sum "$archive" install.sh version.txt > "checksums-$arch.txt")
cp "$out/checksums-$arch.txt" "$out/checksums.txt"
printf '已生成 %s\n' "$out/$archive"

}
main "$@"
