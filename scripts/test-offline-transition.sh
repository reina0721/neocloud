#!/usr/bin/env bash
# 在原生 Linux CI 的本机 Docker 中演练旧稳定版到离线维护的切换。
set -euo pipefail
umask 077

fail() { printf '%s\n' "$*" >&2; exit 1; }
[[ $# == 3 ]] || fail '用法：bash scripts/test-offline-transition.sh 旧版资产目录 候选资产目录 信任目录'
legacy=$(realpath -e -- "$1")
candidate=$(realpath -e -- "$2")
trust=$(realpath -e -- "$3")
old=$(cat -- "$legacy/version.txt")
new=$(cat -- "$candidate/version.txt")
[[ $old == v0.2.2 && $new =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ && $new != "$old" ]] || fail '离线切换验收需要 v0.2.2 和不同的正式候选版本'
cosign=$(command -v "${CLOUDDRIVE_COSIGN:-cosign}")
node=$(command -v node)
docker=$(command -v docker)
sock=unix:///var/run/docker.sock
docker_host() { sudo -n -- "$docker" --host "$sock" "$@"; }
case $(docker_host info --format '{{.Architecture}}') in
  x86_64|amd64) arch=amd64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) fail '需要原生 amd64 或 arm64 Docker' ;;
esac

old_images=("clouddrive-api:$old-$arch" "clouddrive-web:$old-$arch")
declare -A old_image_ids=()
for image in "${old_images[@]}"; do
  if docker_host image inspect "$image" >/dev/null 2>&1; then
    fail "旧镜像 $image 已存在。请在独立的 CI runner 上执行镜像回收验收"
  fi
done

fixture=$(realpath -e -- "$(mktemp -d "${TMPDIR:-/tmp}/clouddrive-offline-transition-XXXXXXXX")")
instance="$fixture/instance"
manager="$instance/install.sh"
project_digest=$(printf '%s' "$instance" | sha256sum)
project="clouddrive-${project_digest:0:12}"

remove_test_image() {
  local image=$1 actual
  actual=$(docker_host image inspect --format '{{.Id}}' "$image") || return 1
  [[ $actual == "${old_image_ids[$image]}" ]] || { printf '旧镜像标记已变化，保留 %s\n' "$image" >&2; return 1; }
  [[ -z $(docker_host ps --all --quiet --filter "ancestor=$image") ]] || { printf '旧镜像仍被使用，保留 %s\n' "$image" >&2; return 1; }
  docker_host image rm "$image"
}

cleanup() {
  local status=$? version image
  trap - EXIT
  if sudo -n test -f "$instance/.control/project"; then
    if [[ $(sudo -n cat "$instance/.control/project") != "$project" ]]; then
      printf '验收项目标记异常，保留现场：%s\n' "$fixture" >&2
      exit 1
    fi
    for version in "$new" "$old"; do
      if sudo -n test -f "$instance/releases/$version/compose.yaml"; then
        if ! docker_host compose --project-directory "$instance" --project-name "$project" \
          --env-file "$instance/runtime.env" --env-file "$instance/releases/$version/images.env" \
          --file "$instance/releases/$version/compose.yaml" down --remove-orphans; then status=1; fi
        break
      fi
    done
  fi
  if [[ $status == 0 ]]; then
    for image in "${old_images[@]}"; do remove_test_image "$image" || status=1; done
  fi
  if [[ $status == 0 ]]; then sudo -n rm -rf -- "$fixture"
  else printf '离线切换验收现场：%s\n' "$fixture" >&2; fi
  exit "$status"
}
trap cleanup EXIT

# Docker 守护进程仍通过本机 Unix socket 提供服务。阻止验收中的隐式镜像源切换。
mkdir "$fixture/bin"
cat > "$fixture/bin/docker" <<'BASH'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}:${2:-}" in
  pull:*|push:*|build:*|image:pull|image:push|buildx:build)
    printf '离线验收禁止 Docker %s %s\n' "${1:-}" "${2:-}" >&2; exit 91 ;;
esac
if [[ ${1:-} == run && " $* " != *' --pull never '* ]]; then
  printf '离线验收的 docker run 要求 --pull never\n' >&2; exit 92
fi
if [[ ${1:-} == compose && ( " $* " == *' pull '* || " $* " == *' build '* ) ]]; then
  printf '离线验收禁止 Compose 拉取或构建镜像\n' >&2; exit 93
fi
exec "$TRANSITION_DOCKER" "$@"
BASH
chmod 700 "$fixture/bin/docker"

airgap() {
  sudo -n unshare --net -- env "PATH=$fixture/bin:$PATH" "DOCKER_HOST=$sock" DOCKER_CONTEXT= \
    "CLOUDDRIVE_COSIGN=$cosign" "TRANSITION_DOCKER=$docker" bash -ec '
      [[ -z $(ip route show default) && -z $(ip -6 route show default) ]]
      [[ $(ip -o link show | wc -l) == 1 ]]
      exec "$@"
    ' bash "$@"
}

verify_assets() (
  local directory=$1 version=$2 file
  shift 2
  local -a verify=(verify-blob --offline --bundle "$directory/checksums.txt.sigstore.json"
    --certificate-identity "https://github.com/reina0721/neocloud/.github/workflows/release.yml@refs/tags/$version"
    --certificate-oidc-issuer https://token.actions.githubusercontent.com)
  if [[ $version == "$old" ]]; then
    airgap env "SIGSTORE_ROOT_FILE=$trust/fulcio.pem" "SIGSTORE_REKOR_PUBLIC_KEY=$trust/rekor.pub" \
      "SIGSTORE_CT_LOG_PUBLIC_KEY_FILE=$trust/ctfe.pub" "$cosign" "${verify[@]}" "$directory/checksums.txt"
  else
    airgap "$cosign" "${verify[@]}" --new-bundle-format --trusted-root "$trust/trusted_root.json" "$directory/checksums.txt"
  fi
  cd -- "$directory"
  for file in install.sh version.txt "clouddrive_${version}_linux_${arch}_docker.tar.gz" "$@"; do
    awk -v asset="$file" '$2 == asset {print}' checksums.txt | sha256sum --check --strict -
  done
)

verify_assets "$legacy" "$old"
verify_assets "$candidate" "$new" "clouddrive-maintenance_${new}_linux_${arch}"

port=$("$node" -e 'const net=require("node:net");const s=net.createServer();s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close()})')
origin="http://127.0.0.1:$port"
cat > "$fixture/readback.mjs" <<'NODE'
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';

const [mode, root, origin] = process.argv.slice(2);
const statePath = join(dirname(root), 'readback.json');
const jar = new Map();
let csrf;

async function request(path, { method = 'GET', body, status = 200, binary = false } = {}) {
  const response = await fetch(origin + '/api/console/v1' + path, {
    method,
    headers: {
      Origin: origin,
      Cookie: [...jar.values()].join('; '),
      ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  for (const cookie of response.headers.getSetCookie()) {
    const value = cookie.split(';')[0];
    jar.set(value.split('=')[0], value);
  }
  if (status === 200) {
    assert.ok(response.ok, `${method} ${path} HTTP ${response.status}`);
    return binary ? response.text() : response.json();
  }
  assert.equal(response.status, status, `${method} ${path}`);
  await response.arrayBuffer();
}

async function create(name, text) {
  const entry = await request('/native/files/text', {
    method: 'POST',
    body: { parentId: '', name, text, key: randomUUID() },
  });
  return { id: entry.id, text };
}

async function read(entry) {
  assert.equal(await request(`/native/files/${entry.id}/content`, { binary: true }), entry.text);
}

const state = mode === 'initialize'
  ? { account: { email: 'airgap-owner@clouddrive.test', password: randomBytes(24).toString('base64url') } }
  : JSON.parse(await readFile(statePath, 'utf8'));
csrf = (await request('/auth/csrf')).token;
if (mode === 'initialize') {
  const setupToken = (await readFile(join(root, '.control/setup-token'), 'utf8')).trim();
  await request('/auth/setup', { method: 'POST', body: { ...state.account, name: '离线验收', setupToken } });
}
const session = await request('/auth/login', { method: 'POST', body: state.account });
csrf = (await request('/auth/csrf')).token;
if (mode === 'initialize') {
  state.owner = session.user.id;
  state.anchor = await create('offline-anchor.txt', `离线恢复保留的数据\n${randomUUID()}`);
}
assert.equal(session.user.id, state.owner);
await read(state.anchor);
if (mode === 'write-after-backup') {
  state.later = await create('after-backup.txt', `备份后写入的数据\n${randomUUID()}`);
}
if (mode === 'read-restored') {
  await request(`/native/files/${state.later.id}/content`, { status: 404 });
} else if (state.later) {
  await read(state.later);
}
if (mode === 'initialize' || mode === 'write-after-backup') {
  await writeFile(statePath, JSON.stringify(state), { mode: 0o600 });
}
NODE

readback() { sudo -n -- "$node" "$fixture/readback.mjs" "$1" "$instance" "$origin"; }
expect_version() {
  local actual
  actual=$(sudo -n cat "$instance/.control/current")
  [[ $actual == "$1" ]] || fail "预期服务版本 $1，实际为 $actual"
  docker_host compose --project-directory "$instance" --project-name "$project" \
    --env-file "$instance/runtime.env" --env-file "$instance/releases/$1/images.env" \
    --file "$instance/releases/$1/compose.yaml" --profile tools config --format json |
    "$node" -e 'const c=JSON.parse(require("node:fs").readFileSync(0,"utf8"));for(const s of ["backend","web","migrate"])if(c.services[s]?.pull_policy!=="never")throw Error(`离线服务 ${s} 应禁用隐式拉取`);'
}
expect_standalone() { ! sudo -n test -e "$instance/.control/maintenance/gateway.json"; }

airgap bash "$legacy/install.sh" install --dir "$instance" --bind 127.0.0.1 --port "$port" \
  --release-dir "$legacy" --version "$old"
expect_version "$old"
expect_standalone
readback initialize
runtime_digest=$(sudo -n sha256sum "$instance/runtime.env")
for image in "${old_images[@]}"; do old_image_ids[$image]=$(docker_host image inspect --format '{{.Id}}' "$image"); done

airgap bash "$candidate/install.sh" update-maintenance --dir "$instance" --release-dir "$candidate" --trust-dir "$trust"
expect_version "$old"
expect_standalone
[[ $(sudo -n cat "$instance/.control/maintenance/offline-tool") == "$new" ]]
backup=$(
  airgap "$manager" backup --full |
    "$node" -e 'const j=JSON.parse(require("node:fs").readFileSync(0,"utf8"));if(j.phase!=="succeeded"||!/^[a-f0-9]{32}$/.test(j.backup))throw Error("完整恢复点未创建");process.stdout.write(j.backup)'
)
sudo -n test -s "$instance/backups/full-$backup/data.tar.gz"

airgap "$manager" upgrade --offline --version "$new"
expect_version "$new"
[[ $(sudo -n sha256sum "$instance/runtime.env") == "$runtime_digest" ]]
readback write-after-backup

# 事先确认旧镜像原本不存在，仅无强制标志地移除本测试导入的两个版本标签。
for image in "${old_images[@]}"; do
  remove_test_image "$image"
  if docker_host image inspect "$image" >/dev/null 2>&1; then fail "旧镜像没有移除：$image"; fi
done

airgap "$manager" import-release --release-dir "$legacy"
airgap "$manager" check-update --offline | "$node" -e '
  const releases=JSON.parse(require("node:fs").readFileSync(0,"utf8"));
  for (const version of process.argv.slice(1)) if(!releases.some(x=>x.version===version))throw Error(`缺少已验证的本地版本 ${version}`);
' "$old" "$new"

if airgap "$manager" rollback --offline; then
  expect_version "$old"
else
  # 未来新增迁移时，旧程序应明确拒绝当前结构并恢复仍可用的新版本。
  expect_version "$new"
  airgap "$manager" status | "$node" -e '
    const state=JSON.parse(require("node:fs").readFileSync(0,"utf8")), job=state.jobs.at(-1);
    if(!state.serving||job.action!=="rollback"||job.phase!=="failed"||!job.result.includes("数据库不兼容"))throw Error("离线回退失败原因不是预期的迁移不兼容");
  '
fi
for image in "${old_images[@]}"; do
  [[ $(docker_host image inspect --format '{{.Id}}' "$image") == "${old_image_ids[$image]}" ]] || fail "未恢复原始镜像：$image"
done
readback read-current

airgap "$manager" restore --offline --backup-id "$backup" --confirm-restore "$backup"
expect_version "$old"
expect_standalone
[[ $(sudo -n sha256sum "$instance/runtime.env") == "$runtime_digest" ]]
[[ $(sudo -n cat "$instance/.control/project") == "$project" ]]
readback read-restored
printf '真实断网旧版切换通过：%s → %s，完整备份、旧镜像重新导入、回退判断和恢复后文件回读\n' "$old" "$new"
