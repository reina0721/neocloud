#!/usr/bin/env bash
set -euo pipefail
umask 077

fail() { printf '%s\n' "$*" >&2; exit 1; }

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
action=up
state=
input_config=
if [[ ${1:-} != -* && $# -gt 0 ]]; then action=$1; shift; fi
case $action in
  up|plan|status|logs|stop|token) ;;
  *) fail "未知命令：$action，请使用 --help 查看用法" ;;
esac
while [[ $# -gt 0 ]]; do
  case $1 in
    --dir) [[ -n ${2:-} ]] || fail '--dir 需要安装目录'; state=$2; shift 2 ;;
    --config) [[ -n ${2:-} ]] || fail '--config 需要配置文件'; input_config=$2; shift 2 ;;
    -h|--help)
      printf '用法：bash scripts/deploy-docker.sh [up|plan|status|logs|stop|token] [--dir DIR] [--config FILE]\n'
      exit 0 ;;
    *) [[ $action == logs ]] || fail "未知参数：$1"; break ;;
  esac
done

legacy=false
legacy_state="$root/.data/docker"
if [[ -z $state && -f $legacy_state/runtime.env ]]; then state=$legacy_state; fi
state=$(realpath -m -- "${state:-${HOME:?}/clouddrive-deploy}")
[[ $state != / && $state != *$'\n'* ]] || fail '安装目录无效'
if [[ $state == "$legacy_state" && -f $state/runtime.env ]]; then legacy=true; fi
if [[ $legacy == false && ( $state == "$root" || $state == "$root/"* ) ]]; then
  fail '请指定源码目录之外的安装目录，避免部署配置进入镜像构建上下文'
fi
control="$state/.control"
config="$state/deploy.env"
token_file="$control/setup-token"
new=false
if [[ $legacy == true ]]; then
  config="$state/runtime.env"
elif [[ ! -f $control/instance ]]; then
  new=true
  [[ ! -e $state || ( -d $state && -z $(ls -A -- "$state") ) ]] || fail "安装目录已存在且非空：$state"
fi
if [[ -n $input_config ]]; then
  [[ $new == true && ( $action == up || $action == plan ) ]] || fail "已有实例请编辑 $config"
  [[ -f $input_config ]] || fail "未找到配置文件：$input_config"
fi

load_config() {
  local line key value
  while IFS= read -r line || [[ -n $line ]]; do
    line=${line%$'\r'}
    [[ -z $line || $line == '#'* ]] && continue
    [[ $line == *=* ]] || fail "配置行缺少等号：$1"
    key=${line%%=*}; value=${line#*=}
    case $key in
      INSTANCE_NAME|WEB_BIND|WEB_PORT|PUBLIC_ORIGIN|ALLOW_INSECURE_HTTP) printf -v "$key" '%s' "$value" ;;
      ALLOWED_ORIGINS) ALLOWED_ORIGINS=${value#\'}; ALLOWED_ORIGINS=${ALLOWED_ORIGINS%\'} ;;
      SETUP_TOKEN|CLOUDDRIVE_SOURCE_PROJECT) [[ $legacy == true ]] || fail "配置不应包含 $key" ;;
      *) fail "未知配置键：$key" ;;
    esac
  done < "$1"
}

unset ALLOWED_ORIGINS
load_config "$root/deploy-docker.env.example"
if [[ $new == false ]]; then load_config "$config"; fi
if [[ -n $input_config ]]; then load_config "$input_config"; fi
project=$INSTANCE_NAME
owner=
if [[ $legacy == true ]]; then
  project=$(sed -n 's/^CLOUDDRIVE_SOURCE_PROJECT=//p' "$config")
  [[ $project =~ ^clouddrive-source-[0-9a-f]{12}$ ]] || fail '旧实例项目标记无效'
  owner="legacy-$project"
elif [[ $new == false ]]; then
  read -r saved_project owner < "$control/instance" || fail '无法读取实例身份'
  [[ $saved_project == "$project" && $owner =~ ^[a-f0-9]{32}$ ]] || fail '实例名称和现有身份不一致，请为新名称使用独立安装目录'
fi
[[ $project =~ ^[a-z0-9][a-z0-9_-]{0,39}$ ]] || fail '实例名须以小写字母或数字开头，最多 40 个字符，可包含 - 和 _'
[[ $WEB_PORT =~ ^[0-9]{1,5}$ ]] && (( 10#$WEB_PORT >= 1024 && 10#$WEB_PORT <= 65535 )) || fail 'WEB_PORT 必须在 1024–65535 之间'
WEB_PORT=$((10#$WEB_PORT))
[[ $WEB_BIND =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ || $WEB_BIND =~ ^\[[0-9a-fA-F:]+\]$ ]] || fail 'WEB_BIND 必须是 IP 地址，IPv6 使用方括号'
[[ $ALLOW_INSECURE_HTTP == true || $ALLOW_INSECURE_HTTP == false ]] || fail 'ALLOW_INSECURE_HTTP 只接受 true 或 false'
[[ -z $PUBLIC_ORIGIN || $PUBLIC_ORIGIN =~ ^https?://([a-zA-Z0-9.-]+|\[[a-fA-F0-9:]+\])(:[0-9]+)?$ ]] || fail 'PUBLIC_ORIGIN 须为不带路径的 HTTP(S) Origin'

unset COMPOSE_COMPATIBILITY
export SETUP_TOKEN=
export API_IMAGE="$project-api:local" WEB_IMAGE="$project-web:local"
export CLOUDDRIVE_SOURCE_PROJECT="$project" WEB_BIND WEB_PORT PUBLIC_ORIGIN ALLOW_INSECURE_HTTP
export ALLOWED_ORIGINS
volume="$project-data"
access=$PUBLIC_ORIGIN
if [[ -z $access ]]; then
  host=$WEB_BIND
  if [[ $host == 0.0.0.0 || $host == '[::]' ]]; then
    host=$(hostname -I 2>/dev/null | awk '{for (i=1; i<=NF; i++) if ($i ~ /^[0-9.]+$/) {print $i; exit}}') || host=
    host=${host:-'<服务器IP>'}
  fi
  access="http://$host:$WEB_PORT"
fi

show_plan() {
  printf '源码目录：%s\n安装目录：%s\n部署配置：%s\n数据库备份：%s/backups\n' "$root" "$state" "$config" "$state"
  if [[ $legacy == true ]]; then printf '首次设置令牌：%s\n' "$config"; else printf '首次设置令牌：%s\n' "$token_file"; fi
  printf 'Compose 项目：%s\n容器：%s-backend-1、%s-web-1；临时迁移容器 %s-migrate\n' "$project" "$project" "$project" "$project"
  printf '镜像：%s、%s\n网络：%s_default\n数据卷：%s → /app/.data（app.db、storage/、transfers/）\n' "$API_IMAGE" "$WEB_IMAGE" "$project" "$volume"
  printf '端口：%s:%s → Web 4173/tcp；Go 8080/9090 仅在容器网络\n访问地址：%s\n' "$WEB_BIND" "$WEB_PORT" "$access"
}
if [[ $action == plan ]]; then show_plan; exit 0; fi

read_token() {
  [[ $new == false ]] || fail '请先运行 bash scripts/deploy-docker.sh'
  if [[ $legacy == true ]]; then sed -n 's/^SETUP_TOKEN=//p' "$config"; else cat -- "$token_file"; fi
}
if [[ $action == token ]]; then read_token; exit 0; fi
[[ $action == up || $new == false ]] || fail '请先运行 bash scripts/deploy-docker.sh'

command -v docker >/dev/null || fail '请先安装 Docker Engine 和 Compose 插件（>=2.20）'
compose_version=$(docker compose version --short) || fail '请先安装 Docker Compose 插件（>=2.20）'
[[ $compose_version =~ ^v?([0-9]+)\.([0-9]+) ]] || fail '无法识别 Docker Compose 版本'
(( BASH_REMATCH[1] > 2 || (BASH_REMATCH[1] == 2 && BASH_REMATCH[2] >= 20) )) || fail '需要 Docker Compose >=2.20'

daemon=${DOCKER_HOST:-}
if [[ -z $daemon || -n ${DOCKER_CONTEXT:-} ]]; then daemon=$(docker context inspect --format '{{.Endpoints.docker.Host}}'); fi
[[ $daemon == unix://* ]] || fail '需要本机 Docker Unix socket，才能核对宿主机端口和数据路径'
[[ $(docker info --format '{{.OSType}}') == linux ]] || fail '需要正在运行的 Linux Docker Engine'
if [[ $new == true ]]; then owner=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n'); fi
export CLOUDDRIVE_SOURCE_OWNER="$owner"

compose() {
  docker compose --project-name "$project" --env-file /dev/null \
    --file "$root/compose.release.yaml" --file "$root/compose.source.yaml" "$@"
}

assert_owner() {
  local kind=$1 name=$2 labels='.Labels' actual
  if [[ $kind == container || $kind == image ]]; then labels='.Config.Labels'; fi
  actual=$(docker "$kind" inspect --format "{{with $labels}}{{index . \"io.clouddrive.source.instance\"}}|{{index . \"com.docker.compose.project\"}}{{end}}" "$name")
  if [[ ${actual%%|*} == "$owner" ]]; then return; fi
  if [[ $legacy == true && $actual == "|$project" ]]; then return; fi
  fail "同名 Docker $kind 已被其他实例使用：$name。请使用独立目录并修改 INSTANCE_NAME。"
}

check_names() {
  local names name project_containers
  project_containers=$(docker ps --all --filter "label=com.docker.compose.project=$project" --format '{{.Names}}')
  while IFS= read -r name; do if [[ -n $name ]]; then assert_owner container "$name"; fi; done <<< "$project_containers"
  names=$(docker ps --all --format '{{.Names}}')
  for name in "$project-backend-1" "$project-web-1" "$project-migrate"; do
    if grep -Fxq "$name" <<< "$names"; then assert_owner container "$name"; fi
  done
  for name in "$API_IMAGE" "$WEB_IMAGE"; do
    names=$(docker image ls --format '{{.Repository}}:{{.Tag}}' "$name")
    if grep -Fxq "$name" <<< "$names"; then assert_owner image "$name"; fi
  done
  names=$(docker network ls --format '{{.Name}}' --filter "name=${project}_default")
  if grep -Fxq "${project}_default" <<< "$names"; then assert_owner network "${project}_default"; fi
  names=$(docker volume ls --quiet --filter "name=$volume")
  volume_exists=false
  if grep -Fxq "$volume" <<< "$names"; then
    assert_owner volume "$volume"
    volume_exists=true
  elif [[ -f $control/data-ready || -n $project_containers ]]; then
    fail "原数据卷缺失：$volume。请恢复原卷后再部署。"
  fi
}

binds_overlap() {
  local existing=$1 requested=${WEB_BIND#[}
  requested=${requested%]}
  [[ $existing == "$requested" || $existing == '*' || $existing == '::' || $requested == '::' ||
    ( $existing == 0.0.0.0 && $requested == *.* ) || ( $requested == 0.0.0.0 && $existing == *.* ) ]]
}

check_port() {
  local running mappings='' name host port mapping listeners endpoint
  local own=()
  command -v ss >/dev/null || fail '需要 iproute2 的 ss 来核对端口占用'
  running=$(docker ps --quiet)
  if [[ -n $running ]]; then
    local ids=()
    mapfile -t ids <<< "$running"
    mappings=$(docker container inspect --format '{{ $name := .Name }}{{ range $target, $bindings := .NetworkSettings.Ports }}{{ range $bindings }}{{ printf "%s\t%s\t%s\t%s\n" $name .HostIp .HostPort $target }}{{ end }}{{ end }}' "${ids[@]}")
  fi
  while IFS=$'\t' read -r name host port mapping; do
    [[ $port == "$WEB_PORT" && $mapping == */tcp ]] || continue
    binds_overlap "$host" || continue
    if [[ $name != "/$project-web-1" ]]; then fail "端口 $WEB_PORT 已被容器 ${name#/} 发布。请修改 WEB_PORT。"; fi
    own+=("$host")
  done <<< "$mappings"
  listeners=$(ss -H -ltn "sport = :$WEB_PORT" | awk '{print $4}')
  while IFS= read -r endpoint; do
    [[ -n $endpoint ]] || continue
    host=${endpoint%:*}; host=${host#[}; host=${host%]}
    binds_overlap "$host" || continue
    if printf '%s\n' "${own[@]}" | grep -Fxq "$host"; then continue; fi
    if [[ $host == '*' ]] && printf '%s\n' "${own[@]}" | grep -Exq '0\.0\.0\.0|::'; then continue; fi
    fail "宿主机端口已监听：$endpoint。请修改 WEB_PORT。"
  done <<< "$listeners"
}

lock_instance() {
  local lock="$control/deploy.lock"
  if [[ $legacy == true ]]; then lock="$state/deploy.lock"; fi
  mkdir -p -- "$control"
  exec 9>"$lock"
  flock -n 9 || fail "实例正执行部署或停止：$state"
}

prepare_instance() {
  if [[ $new == true ]]; then
    [[ ! -f $control/instance && ! -e $config ]] || fail '实例已被另一部署创建，请重试'
    printf 'INSTANCE_NAME=%s\nWEB_BIND=%s\nWEB_PORT=%s\nPUBLIC_ORIGIN=%s\nALLOW_INSECURE_HTTP=%s\n' \
      "$project" "$WEB_BIND" "$WEB_PORT" "$PUBLIC_ORIGIN" "$ALLOW_INSECURE_HTTP" > "$config"
    if [[ -n ${ALLOWED_ORIGINS:-} ]]; then printf 'ALLOWED_ORIGINS=%s\n' "$ALLOWED_ORIGINS" >> "$config"; fi
    od -An -N32 -tx1 /dev/urandom | tr -d ' \n' > "$token_file"
    printf '\n' >> "$token_file"
    printf '%s %s\n' "$project" "$owner" > "$control/instance"
    new=false
  fi
  if [[ $volume_exists == false ]]; then
    docker volume create --label "io.clouddrive.source.instance=$owner" "$volume" >/dev/null
    assert_owner volume "$volume"
  fi
  touch -- "$control/data-ready"
}

show_data_path() {
  printf '数据卷宿主机路径：%s\n' "$(docker volume inspect --format '{{.Mountpoint}}' "$volume")"
}

backup_database() {
  local volumes
  volumes=$(docker volume ls --quiet --filter "name=$volume") || return 1
  if ! grep -Fxq "$volume" <<< "$volumes"; then return 1; fi
  local archive="$state/backups/$(date -u +%Y%m%dT%H%M%SZ)-$$.tar.gz"
  mkdir -p -- "$state/backups" || return 1
  if ! docker run --rm --pull never --network none --user 0:0 \
    --mount "type=volume,source=$volume,target=/data,readonly" "$WEB_IMAGE" sh -ec '
      cd /data
      if [ ! -f app.db ]; then exit 0; fi
      set -- app.db
      for sidecar in app.db-wal app.db-shm; do
        if [ -f "$sidecar" ]; then set -- "$@" "$sidecar"; fi
      done
      exec tar -czf - "$@"
    ' > "$archive.tmp"; then
    rm -f -- "$archive.tmp"
    return 1
  fi
  if [[ -s $archive.tmp ]]; then
    mv -- "$archive.tmp" "$archive" || return 1
    printf '数据库备份：%s\n' "$archive"
  else
    rm -f -- "$archive.tmp"
  fi
}

case $action in
  status|logs|stop)
    if [[ $action == stop ]]; then lock_instance; fi
    check_names
    case $action in
      status) show_plan; if [[ $volume_exists == true ]]; then show_data_path; fi; compose ps --all ;;
      logs) compose logs "$@" backend web ;;
      stop) compose stop web backend ;;
    esac ;;
  up)
    show_plan
    check_names
    check_port
    compose config --quiet
    lock_instance
    check_names
    prepare_instance
    SETUP_TOKEN=$(read_token)
    [[ $SETUP_TOKEN =~ ^[a-f0-9]{64}$ ]] || fail '初始化令牌文件损坏'
    CLOUDDRIVE_SOURCE_COMMIT=$(git -C "$root" rev-parse HEAD 2>/dev/null || printf unknown)
    export SETUP_TOKEN CLOUDDRIVE_SOURCE_COMMIT
    compose build backend web
    check_port
    containers=$(compose ps --all --quiet backend web)
    if [[ -n $containers ]]; then compose stop web backend; fi
    if ! backup_database; then
      if [[ -n $containers ]]; then compose start backend web || true; fi
      fail '数据库备份失败，尚未运行迁移。'
    fi
    compose run --rm --no-deps --name "$project-migrate" migrate || fail '数据库迁移失败。请检查迁移输出和原数据库备份。'
    compose up --no-build --wait --wait-timeout 120 backend web
    compose ps
    show_data_path
    printf '\n首次使用：%s/setup\n查看初始化令牌：bash scripts/deploy-docker.sh token --dir %q\n' "$access" "$state"
    ;;
esac
