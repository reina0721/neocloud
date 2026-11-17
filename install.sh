#!/usr/bin/env bash
# CloudDrive Release 安装管理入口；目标机只使用 Docker 和标准 Linux 工具。
set -Eeuo pipefail
umask 077
REPOSITORY=reina0721/neocloud
command_name=${1:-help}
[[ $# == 0 ]] || shift
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
version=latest
release_source=
port=4173
wait_timeout=120
explicit_dir=false
work=
stop_recovery=false
old_version=
fail() { printf '错误：%s\n' "$*" >&2; exit 1; }
usage() {
  cat <<'HELP'
bash install.sh install [--dir ./clouddrive] [--port 4173] [--version vX.Y.Z]
./clouddrive/install.sh status | check-update | upgrade | backup | start | stop
upgrade 支持 --version；install/upgrade/check-update 支持 --release-dir 离线产物目录。
需要 Linux、本机 Docker Engine、Docker Compose >=2.20、curl、tar、gzip、sha256sum、flock。
仅开放 http://127.0.0.1:端口；API 与 management 不映射宿主机端口。
HELP
}
[[ $command_name != help && $command_name != --help ]] || { usage; exit 0; }
while [[ $# -gt 0 ]]; do
  case $1 in
    --dir) [[ $# -ge 2 ]] || fail '--dir 缺少路径'; root=$2; explicit_dir=true; shift 2 ;;
    --port) [[ $# -ge 2 ]] || fail '--port 缺少数值'; port=$2; shift 2 ;;
    --wait-timeout) [[ $# -ge 2 ]] || fail '--wait-timeout 缺少秒数'; wait_timeout=$2; shift 2 ;;
    --version) [[ $# -ge 2 ]] || fail '--version 缺少版本'; version=$2; shift 2 ;;
    --release-dir) [[ $# -ge 2 ]] || fail '--release-dir 缺少路径'; release_source=$(realpath -e -- "$2"); shift 2 ;;
    *) fail "未知参数：$1" ;;
  esac
done
case $command_name in install|upgrade|check-update|status|backup|start|stop) ;; *) fail "未知命令：$command_name" ;; esac
[[ $(uname -s) == Linux ]] || fail '当前安装包只支持 Linux'
for dependency in docker curl tar gzip sha256sum flock realpath awk sed cmp od tr; do
  command -v "$dependency" >/dev/null || fail "缺少 $dependency，请先安装；脚本不会自动修改系统软件"
done
[[ $(tar --help) == *--no-same-permissions* ]] || fail '需要 GNU tar；请先安装 GNU tar/coreutils'
docker info >/dev/null 2>&1 || fail '无法访问 Docker，请先启动 Docker 并配置当前用户权限'
compose_version=$(docker compose version --short 2>/dev/null) || fail '请先安装 Docker Compose 插件（>=2.20）'
compose_version=${compose_version#v}
[[ $compose_version =~ ^([0-9]+)\.([0-9]+) ]] || fail '无法识别 Compose 版本'
(( BASH_REMATCH[1] > 2 || (BASH_REMATCH[1] == 2 && BASH_REMATCH[2] >= 20) )) || fail '需要 Docker Compose >=2.20'
endpoint=${DOCKER_HOST:-$(docker context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null)}
[[ $endpoint == unix://* ]] || fail '仅支持本机 Unix socket Docker，远程 daemon 无法使用本机持久目录'
[[ $(docker info --format '{{.OSType}}') == linux ]] || fail 'Docker 必须使用 Linux 容器'
case $(docker info --format '{{.Architecture}}') in x86_64|amd64) arch=amd64 ;; aarch64|arm64) arch=arm64 ;; *) fail '仅支持 amd64/arm64' ;; esac
if [[ $command_name == install && $explicit_dir == false && ! -f $root/.control/project ]]; then root="$PWD/clouddrive"; fi
root=$(realpath -m -- "$root")
[[ $root != *$'\n'* && $root != *,* && $root != / ]] || fail '安装路径不能为根目录或包含换行、逗号'
[[ $port =~ ^[0-9]+$ && ${#port} -le 5 ]] || fail '端口必须为数字'
port=$((10#$port))
((port >= 1024 && port <= 65535)) || fail '端口范围为 1024–65535'
[[ $wait_timeout =~ ^[1-9][0-9]{0,2}$ ]] || fail '等待时间不合法'
((wait_timeout >= 5 && wait_timeout <= 600)) || fail '等待时间范围为 5–600 秒'
valid_version() { [[ $1 =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; }
resolve_version() {
  if [[ $version == latest ]]; then
    if [[ -n $release_source ]]; then
      [[ -f $release_source/version.txt ]] || fail '离线目录缺少 version.txt，或显式指定 --version'
      version=$(cat "$release_source/version.txt")
    else
      local location
      location=$(curl --fail --location --silent --show-error --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 120 --output /dev/null --write-out '%{url_effective}' "https://github.com/$REPOSITORY/releases/latest") || fail '无法取得最新正式 Release；请确认项目已发布稳定版，或指定 --version'
      [[ $location == "https://github.com/$REPOSITORY/releases/tag/"* ]] || fail 'Release 重定向地址不符合预期'
      version=${location##*/}
    fi
  fi
  valid_version "$version" || fail '版本必须为 v主版本.次版本.修订号，可带预发布后缀'
}
managed() { [[ -f $root/.control/project && -f $root/.control/current ]] || fail '此目录不是安装器管理的实例；不会接管既有数据'; }
compose_at() {
  local release=$1; shift
  docker compose --project-directory "$root" --env-file "$root/runtime.env" --env-file "$root/releases/$release/images.env" --project-name "$project" --file "$root/releases/$release/compose.yaml" "$@"
}
current() { cat "$root/.control/current"; }
atomic_current() { printf '%s\n' "$1" > "$root/.control/current.new"; mv -- "$root/.control/current.new" "$root/.control/current"; }
probe() {
  local release=$1 deadline=$((SECONDS + wait_timeout))
  while (( SECONDS < deadline )); do
    if compose_at "$release" exec -T web node -e '
      const signal=AbortSignal.timeout(5000);
      Promise.all([fetch("http://127.0.0.1:4173/login",{signal}),fetch("http://backend:9090/readyz",{signal}),fetch("http://backend:9090/build",{signal})]).then(async ([web,ready,build])=>{
        if(!web.ok||!ready.ok||!build.ok)process.exit(1);
        const info=await build.json(); if(info.version!==process.argv[1])process.exit(1);
      }).catch(()=>process.exit(1))' "$release" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}
migration_status() {
  local release=$1 web_ref
  web_ref=$(sed -n 's/^WEB_IMAGE=//p' "$root/releases/$release/images.env")
  compose_at "$release" run --rm --no-deps migrate db migrate status |
    docker run --rm --pull never --interactive "$web_ref" node -e '
      let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
        try {const s=JSON.parse(b); if(s.compatible!==true||!s.sets.length||!s.sets.every(x=>x.compatible===true&&x.dirty===false&&x.current===x.target))process.exit(1)}catch{process.exit(1)}
      })'
}
compatible_old() { migration_status "$old_version" >/dev/null 2>&1; }
cleanup() {
  local status=$?
  trap - EXIT
  if [[ $status != 0 && $stop_recovery == true ]]; then
    printf '操作未完成。已保留数据、备份及候选版本；正在停止候选服务。\n' >&2
    compose_at "$version" stop >/dev/null 2>&1 || true
    if [[ -n $old_version ]] && compatible_old; then
      if compose_at "$old_version" up --detach --pull never backend web >/dev/null 2>&1 && probe "$old_version"; then
        printf '旧版本 %s 与当前数据库兼容，已恢复旧服务。\n' "$old_version" >&2
      else printf '旧服务恢复未通过，请检查容器日志。\n' >&2; fi
    else printf '未自动回退数据库。请保留现场，参照备份进行人工恢复或修复升级。\n' >&2; fi
  fi
  [[ -z $work ]] || rm -rf -- "$work"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
fetch_asset() {
  local name=$1 destination=$2
  if [[ -n $release_source ]]; then cp -- "$release_source/$name" "$destination" || fail "离线目录缺少 $name";
  else curl --fail --location --silent --show-error --proto '=https' --proto-redir '=https' --retry 2 --connect-timeout 15 --max-time 1800 "https://github.com/$REPOSITORY/releases/download/$version/$name" --output "$destination" || fail "下载 $name 失败"; fi
}
read_manifest() { sed -n "s/^$1=//p" "$work/bundle/manifest.txt"; }
verify_config_identity() {
  local ref=$1 expected=$2 saved="$work/$3-runtime.tar" digest
  local -a platform_args=()
  # containerd 的显示 ID 是 manifest/index；读取本地导出的原始配置摘要。
  if [[ $(docker image save --help) == *--platform* ]]; then platform_args=(--platform "linux/$arch"); fi
  docker image save "${platform_args[@]}" "$ref" > "$saved" || fail '无法核对已导入镜像配置'
  if ! digest=$(tar -xOf "$saved" "blobs/sha256/${expected#sha256:}" 2>/dev/null | sha256sum); then
    digest=$(tar -xOf "$saved" "${expected#sha256:}.json" 2>/dev/null | sha256sum) || fail '镜像配置摘要不存在'
  fi
  [[ "sha256:${digest%% *}" == "$expected" ]] || fail '镜像配置内容摘要不匹配'
  rm -- "$saved"
}
prepare_release() {
  local name="clouddrive_${version}_linux_${arch}_docker.tar.gz" digest listing
  work=$(mktemp -d)
  fetch_asset checksums.txt "$work/checksums.txt"
  fetch_asset "$name" "$work/$name"
  digest=$(awk -v asset="$name" '$2 == asset {print $1}' "$work/checksums.txt")
  [[ $digest =~ ^[a-f0-9]{64}$ ]] || fail '校验清单缺少唯一有效的目标产物摘要'
  printf '%s  %s\n' "$digest" "$work/$name" | sha256sum --check --status || fail '安装包摘要不匹配；现有服务保持不动'
  listing=$(tar -tzf "$work/$name" | LC_ALL=C sort)
  [[ $listing == $'compose.yaml\nimages.env\nimages.tar\ninstall.sh\nmanifest.txt' ]] || fail '安装包文件列表不符合规范'
  tar -tvzf "$work/$name" | awk 'substr($1,1,1) != "-" {exit 1}' || fail '安装包只能包含普通文件'
  mkdir "$work/bundle"
  tar --extract --gzip --file "$work/$name" --directory "$work/bundle" --no-same-owner --no-same-permissions
  [[ $(read_manifest FORMAT) == 1 && $(read_manifest VERSION) == "$version" && $(read_manifest ARCH) == "$arch" ]] || fail '安装包版本或架构不匹配'
  [[ $(read_manifest COMMIT) =~ ^[a-f0-9]{40}$ ]] || fail '源码版本标识无效'
  api_image="clouddrive-api:$version-$arch"; web_image="clouddrive-web:$version-$arch"
  [[ $(cat "$work/bundle/images.env") == "API_IMAGE=$api_image"$'\n'"WEB_IMAGE=$web_image" ]] || fail '镜像引用不符合配套版本'
  docker image load --input "$work/bundle/images.tar" >/dev/null
  for kind in API WEB; do
    local ref expected actual
    if [[ $kind == API ]]; then ref=$api_image; else ref=$web_image; fi
    expected=$(read_manifest "${kind}_ID")
    [[ $expected =~ ^sha256:[a-f0-9]{64}$ ]] || fail '镜像 ID 无效'
    actual=$(docker image inspect --format '{{.Id}}|{{.Os}}|{{.Architecture}}|{{index .Config.Labels "org.opencontainers.image.version"}}|{{index .Config.Labels "org.opencontainers.image.revision"}}' "$ref")
    [[ ${actual#*|} == "linux|$arch|$version|$(read_manifest COMMIT)" ]] || fail '镜像架构或源码版本不匹配'
    if [[ ${actual%%|*} != "$expected" ]]; then verify_config_identity "$ref" "$expected" "$kind"; fi
  done
}
store_release() {
  local destination="$root/releases/$version"
  if [[ -d $destination ]]; then
    for file in manifest.txt compose.yaml images.env install.sh; do
      cmp -- "$destination/$file" "$work/bundle/$file" >/dev/null || fail '同一版本的产物已发生变化；拒绝覆盖'
    done
  else
    mkdir -- "$destination"
    cp -- "$work/bundle/compose.yaml" "$work/bundle/images.env" "$work/bundle/manifest.txt" "$work/bundle/install.sh" "$destination/"
  fi
  compose_at "$version" config --quiet
}
backup_data() {
  local release=$1 stamp directory
  stamp="$(date -u +%Y%m%dT%H%M%SZ)-$$"; directory="$root/backups/$stamp"
  mkdir -m 700 -- "$directory"
  # 服务已停止；镜像内工具读取受保护的 SQLite，宿主机重定向创建当前用户拥有的备份。
  local web_ref
  web_ref=$(sed -n 's/^WEB_IMAGE=//p' "$root/releases/$release/images.env")
  if ! docker run --rm --pull never --user 0:0 --mount "type=bind,source=$root/data,target=/data,readonly" "$web_ref" sh -ec 'cd /data; set -- app.db; for f in app.db-wal app.db-shm; do [ ! -f "$f" ] || set -- "$@" "$f"; done; tar -cf - "$@"' > "$directory/database.tar"; then fail "备份失败：$directory；没有执行迁移"; fi
  tar -tf "$directory/database.tar" >/dev/null || fail '数据库备份不可读取'
  cp -- "$root/runtime.env" "$root/.control/current" "$root/.control/project" "$directory/"
  (cd "$directory" && sha256sum database.tar runtime.env current project > checksums.txt && sha256sum --check --status checksums.txt)
  printf '数据库与配置备份：%s（文件内容仍保存在原 data/storage，不复制大文件）\n' "$directory"
}
install_manager() {
  cp -- "$work/bundle/install.sh" "$root/install.sh.new"
  chmod 700 "$root/install.sh.new"
  mv -- "$root/install.sh.new" "$root/install.sh"
}
if [[ $command_name == install ]]; then
  if [[ -f $root/.control/current ]]; then
    project=$(cat "$root/.control/project")
    printf '此实例已安装 %s；更新请使用 upgrade。\n' "$(current)"; exit 0
  fi
  resume=false
  if [[ -f $root/.control/project && -f $root/.control/candidate ]]; then
    resume=true
    project=$(cat "$root/.control/project")
    [[ $project =~ ^clouddrive-[a-f0-9]{12}$ ]] || fail '实例标记无效'
  else
    [[ ! -e $root || ( -d $root && -z $(ls -A -- "$root") ) ]] || fail '目标目录非空；不会覆盖既有文件或接管数据库'
  fi
  resolve_version
  prepare_release
  if [[ $resume == true ]]; then port=$(sed -n 's/^WEB_PORT=//p' "$root/runtime.env"); fi
  docker run --rm --pull never --network host "$web_image" node -e 'const s=require("node:net").createServer();s.once("error",()=>process.exit(1));s.listen(Number(process.argv[1]),"127.0.0.1",()=>s.close())' "$port" || fail '端口已占用；尚未执行迁移'
  mkdir -p -- "$root/.control" "$root/releases" "$root/backups" "$root/data"
  exec 9>"$root/.control/lock"; flock -n 9 || fail '另一个安装/升级操作正在执行'
  if [[ -f $root/.control/current ]]; then printf '另一个安装操作已完成，此实例无需重复初始化。\n'; exit 0; fi
  if [[ $resume == false ]]; then
  project="clouddrive-$(printf '%s' "$root" | sha256sum | cut -c1-12)"
  printf '%s\n' "$project" > "$root/.control/project"
  token=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
  printf 'WEB_PORT=%s\nSETUP_TOKEN=%s\n' "$port" "$token" > "$root/runtime.env"
  printf '%s\n' "$token" > "$root/.control/setup-token"
  fi
  printf '%s\n' "$version" > "$root/.control/candidate"
  install_manager
  store_release
  if [[ $resume == false ]]; then docker run --rm --pull never --user 0:0 --mount "type=bind,source=$root/data,target=/data" "$web_image" node -e 'const f=require("node:fs");f.chmodSync("/data",0o700);f.chownSync("/data",65532,65532)'; fi
  stop_recovery=true
  compose_at "$version" run --rm --no-deps migrate
  migration_status "$version"
  compose_at "$version" up --detach --pull never backend web
  probe "$version" || fail '安装后就绪/版本检查未通过'
  atomic_current "$version"; rm -f -- "$root/.control/candidate"; stop_recovery=false
  install_manager
  printf '安装完成：http://127.0.0.1:%s/setup\n请自行创建管理员；设置令牌保存在 %s/.control/setup-token（不输出令牌）。\n' "$port" "$root"
  exit 0
fi
managed
project=$(cat "$root/.control/project")
[[ $project =~ ^clouddrive-[a-f0-9]{12}$ ]] || fail '实例标记无效'
old_version=$(current); valid_version "$old_version" || fail '当前版本标记无效'
case $command_name in
  status) printf '当前版本：%s\n安装目录：%s\n' "$old_version" "$root"; compose_at "$old_version" ps; exit 0 ;;
  check-update) resolve_version; printf '当前版本：%s\n最新目标：%s\n' "$old_version" "$version"; exit 0 ;;
esac
exec 9>"$root/.control/lock"; flock -n 9 || fail '另一个管理操作正在执行'
case $command_name in
  stop) compose_at "$old_version" stop; exit 0 ;;
  start) migration_status "$old_version"; compose_at "$old_version" up --detach --pull never backend web; probe "$old_version" || fail '启动检查未通过'; exit 0 ;;
  backup)
    version=$old_version; stop_recovery=true
    compose_at "$old_version" stop
    backup_data "$old_version"
    compose_at "$old_version" up --detach --pull never backend web
    probe "$old_version" || fail '备份后服务恢复未通过'
    stop_recovery=false; exit 0 ;;
  upgrade)
    resolve_version
    [[ $version != "$old_version" ]] || { printf '已是目标版本 %s，无需重复迁移。\n' "$version"; exit 0; }
    prepare_release
    store_release
    # 所有下载、校验和 Compose 检查成功后才停止服务。
    stop_recovery=true
    compose_at "$old_version" stop
    backup_data "$old_version"
    compose_at "$version" run --rm --no-deps migrate
    migration_status "$version"
    compose_at "$version" up --detach --pull never backend web
    probe "$version" || fail '升级后就绪/版本检查未通过'
    atomic_current "$version"; stop_recovery=false
    install_manager
    printf '升级完成：%s → %s。数据与挂载路径保持不变。\n' "$old_version" "$version"
    ;;
esac
