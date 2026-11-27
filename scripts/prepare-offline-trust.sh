#!/usr/bin/env bash
# 在联网主机从 Sigstore 的 TUF 仓库准备独立的离线信任材料。
set -euo pipefail
umask 077

fail() { printf '%s\n' "$*" >&2; exit 1; }
[[ $# == 1 || ( $# == 2 && $2 == --legacy ) ]] ||
  fail '用法：bash scripts/prepare-offline-trust.sh 输出目录 [--legacy]'
destination=$1
cosign=${CLOUDDRIVE_COSIGN:-cosign}
command -v "$cosign" >/dev/null || fail '请先安装 cosign 2.6.5 或更新的已修复版本'

work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
env -u TUF_ROOT_JSON -u TUF_MIRROR TUF_ROOT="$work/tuf" "$cosign" initialize --mirror https://tuf-repo-cdn.sigstore.dev
trusted_root="$work/tuf/tuf-repo-cdn.sigstore.dev/targets/trusted_root.json"
[[ -s $trusted_root ]] || fail 'Sigstore TUF 未返回可信的 trusted_root.json'

materials=(trusted_root.json)
cp -- "$trusted_root" "$work/trusted_root.json"
if [[ ${2:-} == --legacy ]]; then
  command -v node >/dev/null || fail '导出旧格式信任材料需要 Node.js'
  node --input-type=module - "$work" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const directory = process.argv[2];
const root = JSON.parse(readFileSync(join(directory, "trusted_root.json"), "utf8"));
const pem = (type, raw) => {
  const lines = raw?.match(/.{1,64}/g);
  if (!lines?.length) throw new Error(`缺少信任材料：${type}`);
  return `-----BEGIN ${type}-----\n${lines.join("\n")}\n-----END ${type}-----\n`;
};
const logKey = (entries, url) => {
  const matches = entries.filter((entry) => entry.baseUrl === url);
  if (matches.length !== 1) throw new Error(`无法唯一选择旧版日志密钥：${url}`);
  return pem("PUBLIC KEY", matches[0].publicKey.rawBytes);
};
const certificates = new Set(root.certificateAuthorities.flatMap(
  (authority) => authority.certChain.certificates.map((certificate) => certificate.rawBytes),
));
if (!certificates.size) throw new Error("未找到 Fulcio 证书链");
const write = (name, content) => writeFileSync(join(directory, name), content, { mode: 0o600, flag: "wx" });
write("fulcio.pem", [...certificates].map((certificate) => pem("CERTIFICATE", certificate)).join(""));
write("rekor.pub", logKey(root.tlogs, "https://rekor.sigstore.dev"));
write("ctfe.pub", logKey(root.ctlogs, "https://ctfe.sigstore.dev/2022"));
NODE
  materials+=(fulcio.pem rekor.pub ctfe.pub)
fi

[[ ! -L $destination ]] || fail "信任输出目录须为实际目录：$destination"
mkdir -p -- "$destination"
for name in "${materials[@]}"; do
  target="$destination/$name"
  if [[ -e $target || -L $target ]]; then
    [[ -f $target && ! -L $target ]] && cmp -s -- "$work/$name" "$target" ||
      fail "信任材料已存在且内容不同：$target。请选择新的输出目录。"
  else
    (set -o noclobber; cat -- "$work/$name" > "$target")
  fi
done
printf '离线信任材料：%s\n' "$destination"
