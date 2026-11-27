#!/usr/bin/env bash
set -euo pipefail
umask 077

fail() { printf '%s\n' "$*" >&2; exit 1; }

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
action=up
requested_dir=
input_config=
if [[ ${1:-} != -* && $# -gt 0 ]]; then action=$1; shift; fi
case $action in
  up|plan|status|logs|stop|token) ;;
  *) fail "未知命令：$action，请使用 --help 查看用法" ;;
esac
while [[ $# -gt 0 ]]; do
  case $1 in
    --dir) [[ -n ${2:-} ]] || fail '--dir 需要安装目录'; requested_dir=$2; shift 2 ;;
    --config) [[ -n ${2:-} ]] || fail '--config 需要配置文件'; input_config=$2; shift 2 ;;
    -h|--help)
      printf '用法：bash scripts/deploy-docker.sh [up|plan|status|logs|stop|token] [--dir DIR] [--config FILE]\n'
      exit 0 ;;
    *) [[ $action == logs ]] || fail "未知参数：$1"; break ;;
  esac
done

load_config() {
  local line key value declared_project=
  local assignment='^[[:blank:]]*([A-Z_]+)[[:blank:]]*=[[:blank:]]*(.*)$'
  local single_quoted="^'(.*)'([[:blank:]]+#.*)?[[:blank:]]*$"
  local double_quoted='^"(.*)"([[:blank:]]+#.*)?[[:blank:]]*$'
  while IFS= read -r line || [[ -n $line ]]; do
    line=${line%$'\r'}
    [[ $line =~ ^[[:blank:]]*(#.*)?$ ]] && continue
    [[ $line =~ $assignment ]] || fail "预期 KEY=value 配置行：$1"
    key=${BASH_REMATCH[1]}; value=${BASH_REMATCH[2]}
    if [[ $value =~ $single_quoted || $value =~ $double_quoted ]]; then
      value=${BASH_REMATCH[1]}
    else
      value=${value%%[[:blank:]]#*}
      value=${value%"${value##*[![:blank:]]}"}
    fi
    case $key in
      COMPOSE_PROJECT_NAME|INSTANCE_NAME)
        [[ -z $declared_project || $declared_project == "$value" ]] || fail "项目名称配置冲突：$1"
        declared_project=$value
        project=$value ;;
      INSTALL_DIR|DATA_DIR|WEB_BIND|WEB_PORT|PUBLIC_ORIGIN|ALLOW_INSECURE_HTTP|ALLOWED_ORIGINS) printf -v "$key" '%s' "$value" ;;
      SETUP_TOKEN|CLOUDDRIVE_SOURCE_PROJECT) [[ $legacy == true ]] || fail "配置不应包含 $key" ;;
      *) fail "未知配置键：$key" ;;
    esac
  done < "$1"
}

load_defaults() {
  unset ALLOWED_ORIGINS
  load_config "$root/deploy-docker.env.example"
  DATA_DIR=
}

# 文件中的相对安装目录以文件为基准，--dir 仍可直接从当前目录选择实例。
resolve_path() {
  local path=$1 base=$2
  [[ $path != *$'\n'* && $path != *$'\r'* ]] || fail '路径不能包含换行'
  if [[ $path == '~' || $path == '~/'* ]]; then path="${HOME:?}${path:1}"; fi
  if [[ $path != /* ]]; then path="$base/$path"; fi
  realpath -m -- "$path"
}

legacy=false
legacy_state="$root/.data/docker"
load_defaults
if [[ -n $input_config ]]; then
  [[ -f $input_config ]] || fail "未找到配置文件：$input_config"
  input_config=$(realpath -e -- "$input_config")
  load_config "$input_config"
fi
if [[ -n $requested_dir ]]; then
  state=$(resolve_path "$requested_dir" "$PWD")
elif [[ -n $INSTALL_DIR ]]; then
  state=$(resolve_path "$INSTALL_DIR" "${input_config%/*}")
elif [[ -f $legacy_state/runtime.env ]]; then
  state=$legacy_state
else
  state=$(resolve_path "${HOME:?}/clouddrive-deploy" "$PWD")
fi
[[ $state != / ]] || fail '安装目录不能是 /'
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
  if [[ -e $state ]]; then
    [[ -d $state ]] || fail "安装目录不是目录：$state"
    entries=$(ls -A -- "$state")
    [[ -z $entries || ( $entries == deploy.env && -f $config ) ]] || fail "安装目录已包含其他文件：$state"
  fi
fi
if [[ -f $config || $new == false ]]; then
  load_defaults
  load_config "$config"
fi

owner=
saved_data_dir=
if [[ $legacy == true ]]; then
  project=$(sed -n 's/^CLOUDDRIVE_SOURCE_PROJECT=//p' "$config")
  [[ $project =~ ^clouddrive-source-[0-9a-f]{12}$ ]] || fail '旧实例项目标记无效'
  owner="legacy-$project"
elif [[ $new == false ]]; then
  {
    read -r saved_project owner || fail '无法读取实例身份'
    IFS= read -r saved_data_dir || saved_data_dir=
  } < "$control/instance"
  [[ $saved_project == "$project" && $owner =~ ^[a-f0-9]{32}$ ]] || fail '实例名称和现有身份不一致，请为新名称使用独立安装目录'
fi

if [[ $new == true ]]; then DATA_DIR=${DATA_DIR:-./data}; else DATA_DIR=${DATA_DIR:-$saved_data_dir}; fi
data_dir=
if [[ -n $DATA_DIR ]]; then
  data_dir=$(resolve_path "$DATA_DIR" "$state")
  [[ $data_dir != / && $data_dir != "$root" && $data_dir != "$root/"* && $root != "$data_dir/"* &&
    $data_dir != "$state" && $state != "$data_dir/"* && $data_dir != "$control" && $data_dir != "$control/"* &&
    $data_dir != "$state/backups" && $data_dir != "$state/backups/"* ]] || fail "数据目录与源码或安装文件重叠：$data_dir"
fi
if [[ $new == false ]]; then
  [[ $saved_data_dir == "$data_dir" ]] || fail "不能直接更改已安装实例的数据目录。当前存储：${saved_data_dir:-$project-data}"
fi
[[ $project =~ ^[a-z0-9][a-z0-9_-]{0,39}$ ]] || fail '实例名须以小写字母或数字开头，最多 40 个字符，可包含 - 和 _'
[[ $WEB_PORT =~ ^[0-9]{1,5}$ ]] && (( 10#$WEB_PORT >= 1024 && 10#$WEB_PORT <= 65535 )) || fail 'WEB_PORT 必须在 1024–65535 之间'
WEB_PORT=$((10#$WEB_PORT))
[[ $WEB_BIND =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ || $WEB_BIND =~ ^\[[0-9a-fA-F:]+\]$ ]] || fail 'WEB_BIND 必须是 IP 地址，IPv6 使用方括号'
[[ -z $PUBLIC_ORIGIN || $PUBLIC_ORIGIN =~ ^https?://([a-zA-Z0-9.-]+|\[[a-fA-F0-9:]+\])(:[0-9]+)?$ ]] || fail 'PUBLIC_ORIGIN 须为不带路径的 HTTP(S) Origin'
http_setting=$ALLOW_INSECURE_HTTP
if [[ -z $ALLOW_INSECURE_HTTP ]]; then
  ALLOW_INSECURE_HTTP=true
  if [[ $PUBLIC_ORIGIN == https://* ]]; then ALLOW_INSECURE_HTTP=false; fi
fi
[[ $ALLOW_INSECURE_HTTP == true || $ALLOW_INSECURE_HTTP == false ]] || fail 'ALLOW_INSECURE_HTTP 只接受空值、true 或 false'

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
  printf '镜像：%s、%s\n网络：%s_default\n' "$API_IMAGE" "$WEB_IMAGE" "$project"
  if [[ -n $data_dir ]]; then
    printf '数据目录：%s → %s → /app/.data（app.db、storage/、transfers/）\n' "$data_dir" "$volume"
  else
    printf '数据卷：%s → /app/.data（app.db、storage/、transfers/）\n' "$volume"
  fi
  printf '端口：%s:%s → Web 4173/tcp；Go 8080/9090 仅在容器网络\n访问地址：%s\n允许 HTTP Cookie：%s\n' \
    "$WEB_BIND" "$WEB_PORT" "$access" "$ALLOW_INSECURE_HTTP"
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
  fail "同名 Docker $kind 已被其他实例使用：$name。请使用独立目录并修改 COMPOSE_PROJECT_NAME。"
}

check_data_volume() {
  local device
  device=$(docker volume inspect --format '{{with .Options}}{{index . "device"}}{{end}}' "$volume")
  [[ $device == "$data_dir" ]] || fail "Docker 数据卷与实例记录的位置不一致：$volume"
  if [[ -n $data_dir && ! -d $data_dir ]]; then fail "原数据目录缺失：$data_dir"; fi
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
    check_data_volume
    volume_exists=true
  elif [[ -f $control/data-ready || -n $project_containers ]]; then
    fail "原数据卷缺失：$volume。请恢复原卷后再部署。"
  fi
}

check_new_data_dir() {
  [[ -n $data_dir && $volume_exists == false ]] || return 0
  local owners entries
  owners=$(docker volume ls --quiet --filter "label=io.clouddrive.source.data-directory=$data_dir")
  [[ -z $owners ]] || fail "数据目录已被其他卷使用：$data_dir（$owners）"
  if [[ -e $data_dir ]]; then
    [[ -d $data_dir ]] || fail "数据路径不是目录：$data_dir"
    entries=$(ls -A -- "$data_dir") || fail "无法检查数据目录：$data_dir"
    [[ -z $entries ]] || fail "首次部署需要空的数据目录：$data_dir"
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
    [[ ! -f $control/instance ]] || fail '实例已被另一部署创建，请重试'
    if [[ ! -f $config ]]; then
      printf "INSTALL_DIR='%s'\nCOMPOSE_PROJECT_NAME=%s\nDATA_DIR='%s'\nWEB_BIND=%s\nWEB_PORT=%s\nPUBLIC_ORIGIN=%s\nALLOW_INSECURE_HTTP=%s\n" \
        "$state" "$project" "$data_dir" "$WEB_BIND" "$WEB_PORT" "$PUBLIC_ORIGIN" "$http_setting" > "$config"
      if [[ -n ${ALLOWED_ORIGINS:-} ]]; then printf 'ALLOWED_ORIGINS=%s\n' "$ALLOWED_ORIGINS" >> "$config"; fi
    fi
    od -An -N32 -tx1 /dev/urandom | tr -d ' \n' > "$token_file"
    printf '\n' >> "$token_file"
    printf '%s %s\n%s\n' "$project" "$owner" "$data_dir" > "$control/instance"
    new=false
  fi
  if [[ $volume_exists == false ]]; then
    local options=()
    if [[ -n $data_dir ]]; then
      mkdir -p -- "$data_dir"
      options=(--driver local --opt type=none --opt o=bind --opt "device=$data_dir"
        --label "io.clouddrive.source.data-directory=$data_dir")
    fi
    docker volume create --label "io.clouddrive.source.instance=$owner" "${options[@]}" "$volume" >/dev/null
    assert_owner volume "$volume"
    check_data_volume
  fi
  touch -- "$control/data-ready"
}

show_data_path() {
  if [[ -n $data_dir ]]; then
    printf '数据文件所在宿主机目录：%s\n' "$data_dir"
    return
  fi
  printf '数据卷宿主机路径：%s\n' "$(docker volume inspect --format '{{.Mountpoint}}' "$volume")"
}

verify_data_directory() {
  [[ -n $data_dir ]] || return 0
  local mode=initialize
  if [[ -f $control/data-initialized ]]; then mode=verify; fi
  # 在同一个挂载内独占创建标记，防止不同实例同时认领同一个空目录。
  docker run --rm --pull never --network none --user 0:0 \
    --mount "type=volume,source=$volume,target=/data,volume-nocopy" "$WEB_IMAGE" node -e '
      const fs = require("node:fs");
      const [owner, mode] = process.argv.slice(1);
      const entries = fs.readdirSync("/data");
      const marker = ".clouddrive-source-owner";
      const path = `/data/${marker}`;
      if (entries.includes(marker)) {
        if (!fs.lstatSync(path).isFile() || fs.readFileSync(path, "utf8") !== owner) {
          throw new Error("数据目录归属与当前实例不一致");
        }
      } else {
        if (mode !== "initialize" || entries.length !== 0) {
          throw new Error("数据目录非空或缺少当前实例的标记");
        }
        fs.writeFileSync(path, owner, { flag: "wx", mode: 0o600 });
      }
      if (mode === "initialize") {
        fs.chmodSync("/data", 0o700);
        fs.chownSync("/data", 65532, 65532);
      }
    ' "$owner" "$mode" || fail "无法确认数据目录归属或权限：$data_dir"
  touch -- "$control/data-initialized"
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
    check_new_data_dir
    compose config --quiet
    lock_instance
    check_names
    check_new_data_dir
    prepare_instance
    SETUP_TOKEN=$(read_token)
    [[ $SETUP_TOKEN =~ ^[a-f0-9]{64}$ ]] || fail '初始化令牌文件损坏'
    CLOUDDRIVE_SOURCE_COMMIT=$(git -C "$root" rev-parse HEAD 2>/dev/null || printf unknown)
    export SETUP_TOKEN CLOUDDRIVE_SOURCE_COMMIT
    compose build backend web
    verify_data_directory
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
