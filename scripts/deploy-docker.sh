#!/usr/bin/env bash
set -euo pipefail
umask 077

fail() { printf '%s\n' "$*" >&2; exit 1; }

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
state="$root/.data/docker"
runtime="$state/runtime.env"
action=${1:-up}
if [[ $# -gt 0 ]]; then shift; fi
case $action in
  --help|-h)
    printf '用法：bash scripts/deploy-docker.sh [up | status | logs [参数] | stop | token]\n'
    exit 0 ;;
  up|status|logs|stop|token) ;;
  *) fail "未知命令：$action，请使用 --help 查看用法" ;;
esac
[[ $action == logs || $# == 0 ]] || fail "$action 不接受额外参数"

if [[ $action == token ]]; then
  [[ -f $runtime ]] || fail '请先运行 bash scripts/deploy-docker.sh'
  sed -n 's/^SETUP_TOKEN=//p' "$runtime"
  exit 0
fi

command -v docker >/dev/null || fail '请先安装 Docker Engine 和 Compose 插件（>=2.20）'
compose_version=$(docker compose version --short) || fail '请先安装 Docker Compose 插件（>=2.20）'
[[ $compose_version =~ ^v?([0-9]+)\.([0-9]+) ]] || fail '无法识别 Docker Compose 版本'
(( BASH_REMATCH[1] > 2 || (BASH_REMATCH[1] == 2 && BASH_REMATCH[2] >= 20) )) || fail '需要 Docker Compose >=2.20'

if [[ $action == up || $action == stop ]]; then
  mkdir -p -- "$state"
  exec 9>"$state/deploy.lock"
  flock -n 9 || fail '当前源码实例已有部署或停止操作在执行'
fi
if [[ ! -f $runtime ]]; then
  [[ $action == up ]] || fail '请先运行 bash scripts/deploy-docker.sh'
  project_suffix=$(printf '%s' "$root" | sha256sum | cut -c1-12)
  setup_token=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
  printf 'CLOUDDRIVE_SOURCE_PROJECT=clouddrive-source-%s\nWEB_BIND=0.0.0.0\nWEB_PORT=4180\nPUBLIC_ORIGIN=\nALLOW_INSECURE_HTTP=true\nSETUP_TOKEN=%s\n' \
    "$project_suffix" "$setup_token" > "$runtime.tmp"
  chmod 600 "$runtime.tmp"
  mv -- "$runtime.tmp" "$runtime"
fi
project=$(sed -n 's/^CLOUDDRIVE_SOURCE_PROJECT=//p' "$runtime")
[[ $project =~ ^clouddrive-source-[0-9a-f]{12}$ ]] || fail '源码实例标记无效'
unset SETUP_TOKEN
export CLOUDDRIVE_SOURCE_PROJECT="$project"
export API_IMAGE="$project-api:local" WEB_IMAGE="$project-web:local"
export CLOUDDRIVE_SOURCE_COMMIT
CLOUDDRIVE_SOURCE_COMMIT=$(git -C "$root" rev-parse HEAD 2>/dev/null || printf unknown)

compose() {
  docker compose --project-name "$project" --env-file "$runtime" \
    --file "$root/compose.release.yaml" --file "$root/compose.source.yaml" "$@"
}

backup_database() {
  local volumes
  volumes=$(docker volume ls --quiet --filter "name=$project-data") || return 1
  if ! grep -Fxq "$project-data" <<< "$volumes"; then return 0; fi
  local archive="$state/backups/$(date -u +%Y%m%dT%H%M%SZ)-$$.tar.gz"
  mkdir -p -- "$state/backups" || return 1
  if ! docker run --rm --pull never --network none --user 0:0 \
    --mount "type=volume,source=$project-data,target=/data,readonly" "$WEB_IMAGE" sh -ec '
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
  status) compose ps --all ;;
  logs) compose logs "$@" backend web ;;
  stop) compose stop web backend ;;
  up)
    compose config --quiet
    compose build backend web
    containers=$(compose ps --all --quiet backend web)
    if [[ -n $containers ]]; then compose stop web backend; fi
    if ! backup_database; then
      if [[ -n $containers ]]; then compose start backend web || true; fi
      fail '数据库备份失败，尚未运行迁移。'
    fi
    compose run --rm --no-deps migrate || fail '数据库迁移失败。请检查迁移输出和原数据库备份。'
    compose up --no-build --wait --wait-timeout 120 backend web
    compose ps
    printf '\n首次使用请打开网页的 /setup。默认地址为 http://服务器IP:4180/setup。\n'
    printf '查看初始化令牌：bash scripts/deploy-docker.sh token\n'
    ;;
esac
