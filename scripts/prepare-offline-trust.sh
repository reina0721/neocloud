#!/usr/bin/env bash
# 在联网主机从 Sigstore 的 TUF 仓库准备独立的离线信任材料。
set -euo pipefail
umask 077

fail() { printf '%s\n' "$*" >&2; exit 1; }
[[ $# == 1 ]] || fail '用法：bash scripts/prepare-offline-trust.sh 输出目录'
destination=$1
cosign=${NEOCLOUD_COSIGN:-cosign}
command -v "$cosign" >/dev/null || fail '请先安装 cosign 2.6.5 或更新的已修复版本'

work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
env -u TUF_ROOT_JSON -u TUF_MIRROR TUF_ROOT="$work/tuf" "$cosign" initialize --mirror https://tuf-repo-cdn.sigstore.dev
trusted_root="$work/tuf/tuf-repo-cdn.sigstore.dev/targets/trusted_root.json"
[[ -s $trusted_root ]] || fail 'Sigstore TUF 未返回可信的 trusted_root.json'

[[ ! -L $destination ]] || fail "信任输出目录须为实际目录：$destination"
mkdir -p -- "$destination"
target="$destination/trusted_root.json"
if [[ -e $target || -L $target ]]; then
  [[ -f $target && ! -L $target ]] && cmp -s -- "$trusted_root" "$target" ||
    fail "信任材料已存在且内容不同：$target。请选择新的输出目录。"
else
  (set -o noclobber; cat -- "$trusted_root" > "$target")
fi
printf '离线信任材料：%s\n' "$destination"
