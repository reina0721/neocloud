#!/usr/bin/env bash
# CloudDrive Release 安装管理入口；目标机只使用 Docker 和标准 Linux 工具。
set -Eeuo pipefail
umask 077
main() {
REPOSITORY=reina0721/neocloud
command_name=
if [[ $# -gt 0 && $1 != -* ]]; then command_name=$1; shift; fi
script_directory=
if [[ -n ${BASH_SOURCE[0]:-} ]]; then script_directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd); fi
root=${HOME:?}/clouddrive
if [[ -n $script_directory && -f $script_directory/.control/project ]]; then root=$script_directory; fi
version=latest
release_source=
port=4173
bind=0.0.0.0
public_origin=
allow_http=true
explicit_http=false
additional_origins=()
network_options=false
wait_timeout=120
explicit_dir=false
explicit_bind=false
explicit_port=false
requested_name=
requested_data=
check_plan=false
layout=false
layout_owner=
claim_created=false
yes=false
follow=false
tail_lines=100
work=
stop_recovery=false
old_version=
enable_web=false
trusted_proxy=
backup_id=
restore_confirmation=
fail() { printf '错误：%s\n' "$*" >&2; exit 1; }
usage() {
  cat <<'HELP'
bash install.sh                         首次安装向导；已安装实例显示管理菜单
bash install.sh install [--dir ~/clouddrive] [--bind 0.0.0.0] [--port 4173]
  [--name 实例名] [--data-dir ./data] [--version vX.Y.Z] [--yes]
bash install.sh plan [--check] [与 install 相同的参数]   --check 检查本机名称、挂载和端口占用
~/clouddrive/install.sh status | check-update | upgrade | update | backup | start | stop | restart
~/clouddrive/install.sh logs [-f|--follow] [--tail 100]
~/clouddrive/install.sh enable-web-management [--trusted-proxy IP]
启用后支持 rollback、restore --backup-id ID --confirm-restore ID。
首次安装可用 --enable-web-management 启用同址网页运维。
upgrade 支持 --version；install/upgrade/check-update 支持 --release-dir 离线产物目录。
高级选项：--public-url HTTP(S)根地址、--allow-origin 精确Origin（可重复）、--allow-http。
首次安装需要 Linux、本机 Docker Engine、Docker Compose >=2.20、iproute2 (ss) 与标准 Linux 工具。
新安装默认 ~/clouddrive、0.0.0.0:4173、HTTP；API 与 management 不映射宿主机端口。
HELP
}
progress() { printf '[CloudDrive] %s\n' "$*" >&2; }
open_terminal() { { exec 3<>/dev/tty; } 2>/dev/null; }
prompt() {
  local label=$1 default=$2 result=$3 answer
  printf '%s [%s]：' "$label" "$default" >&3
  IFS= read -r answer <&3 || fail '终端输入结束，操作已取消'
  printf -v "$result" '%s' "${answer:-$default}"
}
management_menu() {
  local choice operation
  while true; do
    printf '\nCloudDrive 管理 — %s\n1 状态  2 检查更新  3 更新  4 启动  5 停止  6 重启  7 日志  8 备份  0 退出\n' "$root" >&3
    prompt '选择操作' 0 choice
    case $choice in
      0) return ;;
      1) operation=status ;; 2) operation=check-update ;; 3) operation=upgrade ;;
      4) operation=start ;; 5) operation=stop ;; 6) operation=restart ;;
      7) operation=logs ;; 8) operation=backup ;;
      *) printf '请输入 0–8。\n' >&3; continue ;;
    esac
    if ! "$root/install.sh" "$operation"; then printf '操作失败，请查看上方原因。\n' >&3; fi
  done
}
[[ $command_name != help ]] || { usage; exit 0; }
while [[ $# -gt 0 ]]; do
  case $1 in
    -h|--help) usage; exit 0 ;;
    -y|--yes) yes=true; shift ;;
    --enable-web-management) enable_web=true; shift ;;
    --trusted-proxy) [[ $# -ge 2 ]] || fail '--trusted-proxy 缺少 IP'; trusted_proxy=$2; shift 2 ;;
    --backup-id) [[ $# -ge 2 ]] || fail '--backup-id 缺少 ID'; backup_id=$2; shift 2 ;;
    --confirm-restore) [[ $# -ge 2 ]] || fail '--confirm-restore 缺少 ID'; restore_confirmation=$2; shift 2 ;;
    --dir) [[ $# -ge 2 ]] || fail '--dir 缺少路径'; root=$2; explicit_dir=true; shift 2 ;;
    --name) [[ -n ${2:-} && $2 != -* ]] || fail '--name 缺少实例名'; requested_name=$2; shift 2 ;;
    --data-dir) [[ -n ${2:-} && $2 != --* ]] || fail '--data-dir 缺少路径'; requested_data=$2; shift 2 ;;
    --check) check_plan=true; shift ;;
    --port) [[ $# -ge 2 ]] || fail '--port 缺少数值'; port=$2; explicit_port=true; shift 2 ;;
    --bind) [[ $# -ge 2 ]] || fail '--bind 缺少监听 IP'; network_options=true; explicit_bind=true; bind=$2; shift 2 ;;
    --public-url) [[ $# -ge 2 ]] || fail '--public-url 缺少外部 Origin'; network_options=true; public_origin=$2; shift 2 ;;
    --allow-origin) [[ $# -ge 2 ]] || fail '--allow-origin 缺少 Origin'; network_options=true; additional_origins+=("$2"); shift 2 ;;
    --allow-http) network_options=true; explicit_http=true; allow_http=true; shift ;;
    -f|--follow) follow=true; shift ;;
    --tail) [[ $# -ge 2 && $2 =~ ^[0-9]+$ && ${#2} -le 5 ]] || fail '--tail 需要 0–10000'; tail_lines=$((10#$2)); ((tail_lines <= 10000)) || fail '--tail 需要 0–10000'; shift 2 ;;
    --wait-timeout) [[ $# -ge 2 ]] || fail '--wait-timeout 缺少秒数'; wait_timeout=$2; shift 2 ;;
    --version) [[ $# -ge 2 ]] || fail '--version 缺少版本'; version=$2; shift 2 ;;
    --release-dir) [[ $# -ge 2 ]] || fail '--release-dir 缺少路径'; release_source=$(realpath -e -- "$2"); shift 2 ;;
    *) fail "未知参数：$1" ;;
  esac
done
if [[ -z $command_name ]]; then
  if [[ $yes == true ]]; then command_name=install
  elif open_terminal; then
    if [[ -f $root/.control/current ]]; then management_menu; exit 0; fi
    [[ $explicit_dir == true ]] || prompt '安装目录' "$root" root
    [[ $explicit_bind == true ]] || prompt '监听地址' "$bind" bind
    [[ $explicit_port == true ]] || prompt 'Web 端口' "$port" port
    printf '\n安装目录：%s\n监听地址：%s:%s\n版本：%s\n' "$root" "$bind" "$port" "$version" >&3
    prompt '开始安装？输入 y 继续' y confirmation
    [[ $confirmation == y || $confirmation == Y ]] || { printf '已取消。\n' >&3; exit 0; }
    if [[ $enable_web == false ]]; then
      prompt '启用网页运维？需要 systemd、cosign 和宿主机管理权限（输入 y 启用）' n confirmation
      [[ $confirmation != y && $confirmation != Y ]] || enable_web=true
    fi
    command_name=install
  else usage >&2; printf '没有交互终端；请使用 install 命令或 --yes。\n' >&2; exit 2; fi
fi
[[ $command_name != update ]] || command_name=upgrade
case $command_name in
  install|plan|upgrade|check-update|status|backup|start|stop|restart|logs|rollback|restore|enable-web-management) ;;
  _prepare|_config|_probe|_compat|_migrate|_start|_stop|_idle|_capture|_extract)
    [[ ${CLOUDDRIVE_MAINTENANCE_ENGINE:-} == 1 ]] || fail '此命令由宿主维护进程调用' ;;
  *) fail "未知命令：$command_name" ;;
esac
if [[ $explicit_http == false && $public_origin == https://* ]]; then allow_http=false; fi
[[ $network_options == false || $command_name == install || $command_name == plan ]] || fail '已有实例请编辑 runtime.env，再执行 stop/start；网络选项只用于 install 和 plan'
[[ ( -z $requested_name && -z $requested_data ) || $command_name == install || $command_name == plan ]] || fail '--name 和 --data-dir 只用于首次 install 和 plan'
[[ $check_plan == false || $command_name == plan ]] || fail '--check 只用于 plan'
[[ $(uname -s) == Linux ]] || fail '当前安装包只支持 Linux'
for dependency in curl realpath sha256sum; do
  command -v "$dependency" >/dev/null || fail "缺少 $dependency，请先安装"
done
root=$(realpath -m -- "$root")
[[ $root != *$'\n'* && $root != *$'\r'* && $root != *,* && $root != / ]] || fail '安装路径不能为根目录或包含换行、逗号'
[[ $port =~ ^[0-9]+$ && ${#port} -le 5 ]] || fail '端口必须为数字'
port=$((10#$port))
((port >= 1024 && port <= 65535)) || fail '端口范围为 1024–65535'
[[ $wait_timeout =~ ^[1-9][0-9]{0,2}$ ]] || fail '等待时间不合法'
((wait_timeout >= 5 && wait_timeout <= 600)) || fail '等待时间范围为 5–600 秒'
valid_version() { [[ $1 =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; }
normalize_arch() {
  case $1 in x86_64|amd64) printf amd64 ;; aarch64|arm64) printf arm64 ;; *) fail '仅支持 amd64/arm64' ;; esac
}
project_for_root() {
  local digest
  digest=$(printf '%s' "$root" | sha256sum)
  printf 'clouddrive-%s\n' "${digest:0:12}"
}
valid_project() { [[ $1 =~ ^[a-z0-9][a-z0-9_-]{0,39}$ ]]; }
resolve_data_directory() {
  local dir=${1:-./data} branch
  [[ $dir != *$'\n'* && $dir != *$'\r'* ]] || fail '数据目录不能包含换行'
  if [[ $dir != /* ]]; then dir="$root/$dir"; fi
  dir=$(realpath -m -- "$dir")
  [[ $dir != / && $dir != *,* && $dir != *:* && $dir != *$'\n'* && $dir != *$'\r'* ]] || fail '数据目录不能为根目录或包含换行、逗号、冒号'
  [[ $dir != "$root" && $root != "$dir/"* ]] || fail '请将 --data-dir 指向安装目录内的子目录（例如 ./data）或独立目录'
  if [[ $dir == "$root/"* ]]; then
    branch=${dir#"$root/"}
    case ${branch%%/*} in .control|releases|backups|runtime.env|install.sh) fail "数据目录与安装文件重叠：$dir" ;; esac
  fi
  printf '%s\n' "$dir"
}
layout_fingerprint() {
  local digest
  digest=$(printf '%s\0%s\0%s' "$root" "$project" "$data_dir" | sha256sum)
  printf '%s\n' "${digest%% *}"
}
read_install_layout() {
  project=$(cat -- "$root/.control/project")
  valid_project "$project" || fail '实例标记无效'
  data_dir="$root/data"
  if [[ -f $root/.control/data-dir ]]; then
    [[ -f $root/.control/maintenance-project ]] || fail '实例的维护身份记录缺失'
    layout=true
    local recorded
    recorded=$(cat -- "$root/.control/data-dir")
    [[ $recorded == /* ]] || fail '已安装实例的数据目录记录无效'
    data_dir=$(resolve_data_directory "$recorded")
    [[ $data_dir == "$recorded" ]] || fail "已安装实例的数据路径已变化：$recorded"
    layout_owner=$(layout_fingerprint)
  elif [[ -f $root/.control/maintenance-project || ! $project =~ ^clouddrive-[a-f0-9]{12}$ ]]; then
    fail '实例布局记录缺失，请恢复安装目录中的 .control/data-dir'
  fi
  [[ -z $requested_name || $requested_name == "$project" ]] || fail "此安装目录已使用实例名 $project；请保留该名称或为新实例指定不同的 --dir"
  [[ -z $requested_data || $requested_data_dir == "$data_dir" ]] || fail "此实例使用的数据目录为 $data_dir；已有数据位置不可通过安装参数更改"
}
project=${requested_name:-$(project_for_root)}
valid_project "$project" || fail '--name 须以小写字母或数字开头，最多 40 个字符，可包含 - 和 _'
requested_data_dir="$root/data"
if [[ -n $requested_name || -n $requested_data ]]; then requested_data_dir=$(resolve_data_directory "$requested_data"); fi
data_dir=$requested_data_dir
if [[ -n $requested_name || -n $requested_data ]]; then
  layout=true
  layout_owner=$(layout_fingerprint)
fi
access_origin() {
  if [[ -n $public_origin ]]; then
    printf '%s' "$public_origin"
    return
  fi
  local host=$bind
  case $host in
    0.0.0.0|::|'[::]') host='<服务器地址>' ;;
    \[*\]) ;;
    *:*) host="[$host]" ;;
  esac
  printf 'http://%s:%s' "$host" "$port"
}
show_deployment() {
  local listen=$bind
  if [[ $listen == *:* && $listen != \[*\] ]]; then listen="[$listen]"; fi
  printf '安装目录：%s\n数据目录：%s → /app/.data（app.db、storage/、transfers/）\n配置：%s/runtime.env\n数据库备份：%s/backups\n' "$root" "$data_dir" "$root" "$root"
  printf 'Compose 项目：%s\n容器：%s-backend-1、%s-web-1\n网络：%s_default\n镜像：clouddrive-api:%s-%s、clouddrive-web:%s-%s\n' \
    "$project" "$project" "$project" "$project" "$version" "$arch" "$version" "$arch"
  if [[ $layout == true ]]; then printf '实例归属卷：%s-instance\n' "$project"; fi
  printf '端口：%s:%s → Web 4173/tcp；Go 8080/9090 留在容器网络\n访问地址：%s\n允许 HTTP Cookie：%s\n' \
    "$listen" "$port" "$(access_origin)" "$allow_http"
}
check_fresh_project() {
  local containers networks volumes
  containers=$(docker ps --all --filter "label=com.docker.compose.project=$project" --format '{{.Names}}')
  [[ -z $containers ]] || fail "Docker 项目 $project 已有容器：$containers；请用 --name 指定新实例名再重试"
  containers=$(docker ps --all --filter "name=^/${project}-backend-1$" --filter "name=^/${project}-web-1$" --format '{{.Names}}')
  [[ -z $containers ]] || fail "Docker 容器名称已被占用：$containers；请用 --name 指定新实例名再重试"
  networks=$(docker network ls --filter "name=^${project}_default$" --format '{{.Name}}')
  [[ -z $networks ]] || fail "Docker 网络已被占用：$networks；请用 --name 指定新实例名再重试"
  volumes=$(docker volume ls --quiet --filter "name=^${project}-instance$")
  if grep -Fxq -- "$project-instance" <<< "$volumes"; then
    [[ $layout == true ]] && check_layout_owner || fail "实例名 $project 已被归属卷 $project-instance 占用；请用 --name 指定新实例名再重试"
  fi
}
check_layout_owner() {
  local owner
  owner=$(docker volume inspect --format '{{with .Labels}}{{index . "io.clouddrive.release.owner"}}{{end}}' "$project-instance" 2>/dev/null) || return 1
  [[ $owner == "$layout_owner" ]]
}
require_layout_owner() {
  if [[ $layout == true ]] && ! check_layout_owner; then
    fail "实例归属卷 $project-instance 缺失或属于其他实例；请先恢复原实例归属"
  fi
}
first_other_entry() (
  local dir=$1 entry
  shift
  shopt -s nullglob dotglob
  for entry in "$dir"/*; do
    if [[ $# -gt 0 && $entry == "$1" || $# -gt 1 && $entry == "$2" ]]; then continue; fi
    printf '%s\n' "$entry"
    break
  done
)
check_fresh_paths() {
  local dir=$root child next other parent ignored=
  [[ ! -L $root/.control ]] || fail "实例控制目录是符号链接：$root/.control；请修改 --dir"
  if [[ -d $root/.control && -f $root/.control/lock ]]; then
    other=$(first_other_entry "$root/.control" "$root/.control/lock")
    if [[ -z $other ]]; then ignored="$root/.control"; fi
  fi
  while [[ $dir != "$data_dir" && -e $dir ]]; do
    [[ -d $dir && -r $dir && -x $dir ]] || fail "无法使用安装目录：$dir；请修改 --dir"
    child=
    if [[ $data_dir == "$dir/"* ]]; then next=${data_dir#"$dir/"}; child="$dir/${next%%/*}"; fi
    other=$(first_other_entry "$dir" "$child" "$ignored")
    [[ -z $other ]] || fail "安装目录非空，已存在：$other；请修改 --dir"
    [[ -n $child ]] || break
    dir=$child
  done
  if [[ -L $data_dir ]]; then fail "数据目录是符号链接：$data_dir；请通过 --data-dir 指定实际位置"; fi
  if [[ -e $data_dir ]]; then
    [[ -d $data_dir ]] || fail "数据路径已被文件占用：$data_dir；请修改 --data-dir"
    if [[ $layout != true ]] || ! check_layout_owner; then
      [[ -r $data_dir && -x $data_dir ]] || fail "数据目录不可访问或已被占用：$data_dir；请修改 --data-dir"
      other=$(first_other_entry "$data_dir")
      [[ -z $other ]] || fail "数据目录 $data_dir 非空，已存在：$other；请选择空的 --data-dir"
    fi
    if [[ $layout == true ]] && mountpoint -q -- "$data_dir"; then
      fail "数据目录 $data_dir 本身是挂载点；请把 --data-dir 指向该磁盘内的子目录"
    fi
  fi
  if [[ $layout == true ]]; then
    parent=${data_dir%/*}
    while [[ ! -e ${parent:-/} ]]; do parent=${parent%/*}; done
    [[ -d ${parent:-/} && -w ${parent:-/} && -x ${parent:-/} ]] || fail "数据目录的上级无法写入：${parent:-/}；请修改 --data-dir 或目录权限"
  fi
}
check_docker_data() {
  local containers mounts name source access
  local ids=()
  containers=$(docker ps --all --quiet)
  [[ -n $containers ]] || return 0
  mapfile -t ids <<< "$containers"
  mounts=$(docker container inspect --format '{{ $name := .Name }}{{ range .Mounts }}{{ if eq .Type "bind" }}{{ printf "%s\t%s\t%t\n" $name .Source .RW }}{{ end }}{{ end }}' "${ids[@]}")
  while IFS=$'\t' read -r name source access; do
    [[ -n $source ]] || continue
    if [[ $data_dir == "$source" || $source == "$data_dir/"* || ( $access == true && $data_dir == "${source%/}/"* ) ]]; then
      fail "数据目录 $data_dir 与容器 ${name#/} 的挂载 $source 重叠；请修改 --data-dir"
    fi
  done <<< "$mounts"
}
check_host_port() {
  local requested=${bind#[} running mappings= container ip published target listeners endpoint
  requested=${requested%]}
  local ids=()
  running=$(docker ps --quiet)
  if [[ -n $running ]]; then
    mapfile -t ids <<< "$running"
    mappings=$(docker container inspect --format '{{ $name := .Name }}{{ range $target, $bindings := .NetworkSettings.Ports }}{{ range $bindings }}{{ printf "%s\t%s\t%s\t%s\n" $name .HostIp .HostPort $target }}{{ end }}{{ end }}' "${ids[@]}")
  fi
  while IFS=$'\t' read -r container ip published target; do
    [[ $published == "$port" && $target == */tcp ]] || continue
    if addresses_overlap "$requested" "$ip"; then
      fail "端口 $bind:$port 已被容器 ${container#/} 发布（$ip:$published）；请修改 --port 或 --bind"
    fi
  done <<< "$mappings"
  listeners=$(ss -H -ltn "sport = :$port" | awk '{print $4}')
  while IFS= read -r endpoint; do
    [[ -n $endpoint ]] || continue
    ip=${endpoint%:*}; ip=${ip#[}; ip=${ip%]}
    if addresses_overlap "$requested" "$ip"; then
      fail "宿主机端口已占用：$endpoint（请求 $bind:$port）；请修改 --port 或 --bind"
    fi
  done <<< "$listeners"
}
addresses_overlap() {
  [[ $1 == "$2" || $2 == '*' || $1 == '::' || $2 == '::' ||
    ( $1 == 0.0.0.0 && $2 == *.* ) || ( $2 == 0.0.0.0 && $1 == *.* ) ]]
}
preflight() {
  command -v ss >/dev/null || fail '缺少 iproute2 的 ss，无法检查宿主机端口'
  if [[ $layout == true ]]; then command -v mountpoint >/dev/null || fail '缺少 util-linux 的 mountpoint'; fi
  check_fresh_project
  check_docker_data
  check_fresh_paths
  check_host_port
}
network_configuration() {
  # 使用已校验镜像中的 Node 标准库；目标机不需要安装 Node。
  docker run --rm --pull never "$web_image" node -e '
    const [bind,port,primary,http,...extra]=process.argv.slice(1), net=require("node:net");
    const ip=bind.replace(/^\[|\]$/g, "");
    if(!net.isIP(ip))throw Error("监听地址必须是 IPv4/IPv6，不能使用主机名或通配符");
    function origin(value){
      const u=new URL(value);
      if(!["http:","https:"].includes(u.protocol)||u.username||u.password||u.pathname!=="/"||u.search||u.hash||value!==u.origin)throw Error("入口必须是规范 HTTP(S) Origin，不带路径、凭据或末尾斜杠");
      if(!net.isIP(u.hostname.replace(/^\[|\]$/g,""))&&(u.hostname.length>253||!u.hostname.split(".").every(label=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))))throw Error("入口主机必须是规范 IP 或 DNS 名称");
      if(["0.0.0.0","[::]"].includes(u.hostname))throw Error("外部访问地址不能是 0.0.0.0 或 [::]");
      if(u.protocol==="http:"&&!["localhost","127.0.0.1","[::1]"].includes(u.hostname)&&http!=="true")throw Error("非本机 HTTP 入口需要显式 --allow-http");
      return u.origin;
    }
    const origins=[...new Set([...(primary?[origin(primary)]:[]),...extra.map(origin)])];
    if(origins.length>32)throw Error("最多允许 32 个 Origin");
    console.log(`WEB_BIND=${net.isIP(ip)===6?`[${ip}]`:ip}\nPUBLIC_ORIGIN=${primary?origin(primary):""}\nALLOW_INSECURE_HTTP=${http}\nALLOWED_ORIGINS=\x27${JSON.stringify(origins)}\x27`);
  ' "$bind" "$port" "$public_origin" "$allow_http" "${additional_origins[@]}" > "$work/network.env" || fail '网络配置无效；尚未执行迁移'
}
resolve_version() {
  progress '解析目标版本'
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
  progress "目标版本：$version（$arch）"
}
if [[ $command_name == plan ]]; then
  [[ ! -e $root/.control/project ]] || fail '已有实例，请使用安装目录中的 install.sh status 查看实际配置'
  origin_pattern='^https?://([a-zA-Z0-9.-]+|\[[a-fA-F0-9:]+\])(:[0-9]{1,5})?$'
  [[ -z $public_origin || $public_origin =~ $origin_pattern ]] || fail '--public-url 须为不带路径或凭据的 HTTP(S) Origin'
  [[ $bind =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ || ( $bind == *:* && $bind =~ ^(\[[0-9a-fA-F:.]+\]|[0-9a-fA-F:.]+)$ ) ]] || fail '--bind 须为 IP 地址'
  if [[ $check_plan == false ]]; then
    arch=$(normalize_arch "$(uname -m)")
    resolve_version
    show_deployment
    exit 0
  fi
fi
for dependency in docker tar gzip flock awk sed cmp od tr; do
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
arch=$(normalize_arch "$(docker info --format '{{.Architecture}}')")
if [[ $command_name == plan ]]; then
  preflight
  resolve_version
  show_deployment
  printf '本机部署预检通过。\n'
  exit 0
fi
managed() { [[ -f $root/.control/project && -f $root/.control/current ]] || fail '此目录不是安装器管理的实例；不会接管既有数据'; }
verify_instance_storage() {
  local release=$1 mode=${2:-verify} web_ref
  [[ -d $data_dir ]] || fail "实例数据目录缺失：$data_dir"
  [[ $layout == true ]] || return 0
  web_ref=$(sed -n 's/^WEB_IMAGE=//p' "$root/releases/$release/images.env")
  docker run --rm --pull never --network none --user 0:0 \
    --mount "type=bind,source=$data_dir,target=/data" "$web_ref" node -e '
      const fs = require("node:fs");
      const [owner, mode] = process.argv.slice(1);
      const marker = "/data/.clouddrive-installation";
      if (fs.existsSync(marker)) {
        if (!fs.lstatSync(marker).isFile() || fs.readFileSync(marker, "utf8") !== owner) {
          throw Error("数据目录属于其他实例");
        }
      } else {
        if (mode !== "initialize" || fs.readdirSync("/data").length !== 0) {
          throw Error("目录非空或缺少实例归属标记");
        }
        fs.writeFileSync(marker, owner, { flag: "wx", mode: 0o600 });
      }
      if (mode === "initialize") {
        fs.chmodSync("/data", 0o700);
        fs.chownSync("/data", 65532, 65532);
      }
    ' "$layout_owner" "$mode" || fail "无法确认数据目录 $data_dir 的归属或权限；请核对 --data-dir"
}
compose_at() {
  local release=$1; shift
  local -a maintenance=()
  require_layout_owner
  if [[ $layout == true ]]; then local -x COMPOSE_COMPATIBILITY=false; fi
  if [[ $1 == up || $1 == run && -z ${CLOUDDRIVE_MAINTENANCE_STAGE:-} ]]; then verify_instance_storage "$release"; fi
  if [[ ${CLOUDDRIVE_MAINTENANCE_ENGINE:-} == 1 && -n ${CLOUDDRIVE_MAINTENANCE_COMPOSE:-} ]]; then
    maintenance=(--file "$CLOUDDRIVE_MAINTENANCE_COMPOSE")
  fi
  CLOUDDRIVE_RELEASE_DATA_DIR="$data_dir" \
    docker compose --project-directory "$root" --env-file "${CLOUDDRIVE_MAINTENANCE_CONFIG:-$root/runtime.env}" --env-file "$root/releases/$release/images.env" --project-name "$project" --file "$root/releases/$release/compose.yaml" "${maintenance[@]}" "$@"
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
  local -a mounts=()
  if [[ -n ${CLOUDDRIVE_MAINTENANCE_STAGE:-} ]]; then
    mounts=(--volume "$CLOUDDRIVE_MAINTENANCE_STAGE:/app/.data")
  fi
  web_ref=$(sed -n 's/^WEB_IMAGE=//p' "$root/releases/$release/images.env")
  compose_at "$release" run --rm --no-deps "${mounts[@]}" migrate db migrate status |
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
  if [[ $claim_created == true ]] && check_layout_owner; then docker volume rm "$project-instance" >/dev/null || true; fi
  [[ -z $work ]] || rm -rf -- "$work"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
fetch_asset() {
  local name=$1 destination=$2
  local -a display=(--silent)
  [[ ! -t 2 ]] || display=(--progress-bar)
  progress "下载 $name"
  if [[ -n $release_source ]]; then cp -- "$release_source/$name" "$destination" || fail "离线目录缺少 $name";
  else curl --fail --location "${display[@]}" --show-error --proto '=https' --proto-redir '=https' --retry 2 --connect-timeout 15 --speed-limit 1024 --speed-time 30 --max-time 1800 "https://github.com/$REPOSITORY/releases/download/$version/$name" --output "$destination" || fail "下载 $name 失败"; fi
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
  progress '校验安装包与版本清单'
  [[ $digest =~ ^[a-f0-9]{64}$ ]] || fail '校验清单缺少唯一有效的目标产物摘要'
  printf '%s  %s\n' "$digest" "$work/$name" | sha256sum --check --status || fail '安装包摘要不匹配；现有服务保持不动'
  listing=$(tar -tzf "$work/$name" | LC_ALL=C sort)
  [[ $listing == $'compose.yaml\nimages.env\nimages.tar\ninstall.sh\nmanifest.txt' ]] || fail '安装包文件列表不符合规范'
  tar -tvzf "$work/$name" | awk 'substr($1,1,1) != "-" {exit 1}' || fail '安装包只能包含普通文件'
  mkdir "$work/bundle"
  tar --extract --gzip --file "$work/$name" --directory "$work/bundle" --no-same-owner --no-same-permissions
  [[ $(read_manifest FORMAT) == 1 && $(read_manifest VERSION) == "$version" && $(read_manifest ARCH) == "$arch" ]] || fail '安装包版本或架构不匹配'
  local needs_network=$network_options
  if [[ -f $root/runtime.env && -n $(sed -n 's/^WEB_BIND=//p' "$root/runtime.env") ]]; then needs_network=true; fi
  [[ $needs_network == false || $(read_manifest NETWORK) == 1 ]] || fail '目标 Release 不支持网络配置，请使用包含此功能的新版本；v0.1.2 仅支持本机入口'
  local needs_entrypoint=false
  if [[ $command_name == install && -z $public_origin ]]; then needs_entrypoint=true; fi
  if [[ -f $root/runtime.env && -n $(sed -n 's/^WEB_BIND=//p' "$root/runtime.env") && -z $(sed -n 's/^PUBLIC_ORIGIN=//p' "$root/runtime.env") ]]; then needs_entrypoint=true; fi
  [[ $needs_entrypoint == false || $(read_manifest ENTRYPOINT) == 1 ]] || fail '目标 Release 不支持自动同源入口；已有配置未修改，请选择支持此入口的新版本'
  [[ $layout == false || $(read_manifest INSTANCE_LAYOUT) == 1 ]] || fail "目标 Release $version 不支持自定义实例名或数据目录（需要 INSTANCE_LAYOUT=1），请选择支持的版本"
  [[ $(read_manifest COMMIT) =~ ^[a-f0-9]{40}$ ]] || fail '源码版本标识无效'
  api_image="clouddrive-api:$version-$arch"; web_image="clouddrive-web:$version-$arch"
  [[ $(cat "$work/bundle/images.env") == "API_IMAGE=$api_image"$'\n'"WEB_IMAGE=$web_image" ]] || fail '镜像引用不符合配套版本'
  progress '导入配套 Docker 镜像'
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
  local destination="$root/releases/$version" staging
  if [[ -d $destination ]]; then
    for file in manifest.txt compose.yaml images.env install.sh; do
      cmp -- "$destination/$file" "$work/bundle/$file" >/dev/null || fail '同一版本的产物已发生变化；拒绝覆盖'
    done
  else
    staging=$(mktemp -d "$root/releases/.candidate.XXXXXXXX")
    cp -- "$work/bundle/compose.yaml" "$work/bundle/images.env" "$work/bundle/manifest.txt" "$work/bundle/install.sh" "$staging/"
    mv -T -- "$staging" "$destination"
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
  verify_instance_storage "$release"
  if ! docker run --rm --pull never --user 0:0 --mount "type=bind,source=$data_dir,target=/data,readonly" "$web_ref" sh -ec 'cd /data; set -- app.db; for f in app.db-wal app.db-shm; do [ ! -f "$f" ] || set -- "$@" "$f"; done; tar -cf - "$@"' > "$directory/database.tar"; then fail "备份失败：$directory；没有执行迁移"; fi
  tar -tf "$directory/database.tar" >/dev/null || fail '数据库备份不可读取'
  cp -- "$root/runtime.env" "$root/.control/current" "$root/.control/project" "$directory/"
  (cd "$directory" && sha256sum database.tar runtime.env current project > checksums.txt && sha256sum --check --status checksums.txt)
  if [[ $layout == true ]]; then
    cp -- "$root/.control/data-dir" "$root/.control/maintenance-project" "$directory/"
    (cd "$directory" && sha256sum data-dir maintenance-project >> checksums.txt)
  fi
  printf '数据库与配置备份：%s（文件内容仍保存在 %s/storage）\n' "$directory" "$data_dir"
}
install_manager() {
  cp -- "$work/bundle/install.sh" "$root/install.sh.new"
  chmod 700 "$root/install.sh.new"
  mv -- "$root/install.sh.new" "$root/install.sh"
}
enable_maintenance() {
  local name identity
  version=$(current)
  [[ $version =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail '网页运维要求正式版本'
  name="clouddrive-maintenance_${version}_linux_${arch}"
  command -v cosign >/dev/null || fail '启用网页运维前请按部署手册安装 cosign'
  command -v systemctl >/dev/null || fail '网页运维要求 systemd'
  [[ $EUID == 0 ]] || command -v sudo >/dev/null || fail '启用网页运维需要 sudo'
  [[ -z $work ]] || rm -rf -- "$work"
  work=$(mktemp -d)
  fetch_asset checksums.txt "$work/checksums.txt"
  fetch_asset checksums.txt.sigstore.json "$work/checksums.txt.sigstore.json"
  identity="https://github.com/$REPOSITORY/.github/workflows/release.yml@refs/tags/$version"
  local -a verification=(
    --bundle "$work/checksums.txt.sigstore.json"
    --certificate-identity "$identity"
    --certificate-oidc-issuer https://token.actions.githubusercontent.com
  )
  cosign verify-blob "${verification[@]}" "$work/checksums.txt"
  fetch_asset "$name" "$work/$name"
  local digest
  digest=$(awk -v asset="$name" '$2 == asset {print $1}' "$work/checksums.txt")
  [[ $digest =~ ^[a-f0-9]{64}$ ]] || fail '清单缺少唯一维护工具条目'
  printf '%s  %s\n' "$digest" "$work/$name" | sha256sum --check --status || fail '维护工具摘要不匹配'
  chmod 700 "$work/$name"
  "$work/$name" enable --root "$root" --trusted-proxy "$trusted_proxy" --cosign "$(command -v cosign)" --docker-host "$endpoint"
}
if [[ $command_name == install ]]; then
  if [[ -f $root/.control/current ]]; then
    read_install_layout
    require_layout_owner
    configured_bind=$(sed -n 's/^WEB_BIND=//p' "$root/runtime.env"); configured_bind=${configured_bind:-127.0.0.1}
    configured_port=$(sed -n 's/^WEB_PORT=//p' "$root/runtime.env")
    configured_origin=$(sed -n 's/^PUBLIC_ORIGIN=//p' "$root/runtime.env")
    configured_http=$(sed -n 's/^ALLOW_INSECURE_HTTP=//p' "$root/runtime.env")
    [[ ( $explicit_bind == false || $bind == "$configured_bind" ) && ( $explicit_port == false || $port == "$configured_port" ) &&
      ( -z $public_origin || $public_origin == "$configured_origin" ) && ( $explicit_http == false || $configured_http == true ) && ${#additional_origins[@]} -eq 0 ]] ||
      fail "安装目录 $root 已有实例 $project，使用 $configured_bind:$configured_port；新实例请指定独立的 --dir、--name 和 --port"
    printf '此实例已安装 %s；更新请使用 upgrade。\n' "$(current)"; exit 0
  fi
  resume=false
  if [[ -f $root/.control/project && -f $root/.control/candidate ]]; then
    resume=true
    read_install_layout
    require_layout_owner
    port=$(sed -n 's/^WEB_PORT=//p' "$root/runtime.env")
    bind=$(sed -n 's/^WEB_BIND=//p' "$root/runtime.env"); bind=${bind:-127.0.0.1}
    public_origin=$(sed -n 's/^PUBLIC_ORIGIN=//p' "$root/runtime.env")
    allow_http=$(sed -n 's/^ALLOW_INSECURE_HTTP=//p' "$root/runtime.env"); allow_http=${allow_http:-false}
  else
    preflight
  fi
  resolve_version
  prepare_release
  network_configuration
  if [[ $resume == true ]]; then port=$(sed -n 's/^WEB_PORT=//p' "$root/runtime.env"); fi
  show_deployment
  docker run --rm --pull never --network host "$web_image" node -e 'const s=require("node:net").createServer();s.once("error",e=>{console.error(e.code);process.exit(1)});s.listen(Number(process.argv[1]),process.argv[2].replace(/^\[|\]$/g,""),()=>s.close())' "$port" "$bind" || fail "监听地址 $bind:$port 不可用或端口已占用；请修改 --bind 或 --port"
  mkdir -p -- "$root/.control"
  exec 9>"$root/.control/lock"; flock -n 9 || fail '另一个安装/升级操作正在执行'
  if [[ -f $root/.control/current ]]; then printf '另一个安装操作已完成，此实例无需重复初始化。\n'; exit 0; fi
  if [[ $resume == false ]]; then
    [[ ! -f $root/.control/project ]] || fail '另一个安装已预留此目录，请使用原命令重试'
    preflight
    if [[ $layout == true ]] && ! check_layout_owner; then
      # Docker 按卷名创建。即使两次预检同时通过，也只有原归属能继续。
      docker volume create --label "io.clouddrive.release.owner=$layout_owner" "$project-instance" >/dev/null || fail "无法预留实例名 $project；请检查同名卷 $project-instance 或修改 --name"
      check_layout_owner || fail "实例名 $project 已被其他安装抢先占用；请修改 --name"
      claim_created=true
    fi
    mkdir -p -- "$root/releases" "$root/backups" "$data_dir"
    if [[ $layout == true ]]; then
      printf '%s\n' "$data_dir" > "$root/.control/data-dir"
      project_for_root > "$root/.control/maintenance-project"
    fi
    token=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
    printf 'WEB_PORT=%s\nSETUP_TOKEN=%s\n' "$port" "$token" > "$root/runtime.env"
    cat "$work/network.env" >> "$root/runtime.env"
    printf '%s\n' "$token" > "$root/.control/setup-token"
    printf '%s\n' "$project" > "$root/.control/project"
  fi
  printf '%s\n' "$version" > "$root/.control/candidate"
  claim_created=false
  install_manager
  store_release
  if [[ $layout == true && ! -f $root/.control/data-initialized ]]; then
    verify_instance_storage "$version" initialize
    touch -- "$root/.control/data-initialized"
  elif [[ $layout == false && $resume == false ]]; then
    docker run --rm --pull never --user 0:0 --mount "type=bind,source=$data_dir,target=/data" "$web_image" node -e 'const f=require("node:fs");f.chmodSync("/data",0o700);f.chownSync("/data",65532,65532)'
  fi
  stop_recovery=true
  progress '执行数据库迁移与兼容性检查'
  compose_at "$version" run --rm --no-deps migrate
  migration_status "$version"
  progress '启动服务并检查就绪状态'
  compose_at "$version" up --detach --pull never backend web
  probe "$version" || fail '安装后就绪/版本检查未通过'
  atomic_current "$version"; rm -f -- "$root/.control/candidate"; stop_recovery=false
  install_manager
  local setup_origin
  setup_origin=$(access_origin)
  printf '安装完成：%s\nWeb 端口：%s:%s；访问 %s/setup 创建管理员。\n设置令牌保存在 %s/.control/setup-token（不输出令牌）。\n管理入口：%s/install.sh\n' "$root" "$bind" "$port" "$setup_origin" "$root" "$root"
  exec 9>&-
  if [[ $enable_web == true ]]; then enable_maintenance; fi
  exit 0
fi
managed
read_install_layout
require_layout_owner
old_version=$(current); valid_version "$old_version" || fail '当前版本标记无效'
maintenance_config="$root/.control/maintenance/gateway.json"
if [[ $command_name == enable-web-management ]]; then enable_maintenance; exit 0; fi
if [[ $command_name == _* ]]; then
  valid_version "$version" || fail '宿主执行器需要明确版本'
  case $command_name in
    _prepare) prepare_release; store_release ;;
    _config) compose_at "$version" config --quiet ;;
    _probe) probe "$version" ;;
    _compat) migration_status "$version" ;;
    _migrate) compose_at "$version" run --rm --no-deps migrate ;;
    _start) compose_at "$version" up --detach --pull never --force-recreate backend web ;;
    _stop) compose_at "$version" stop ;;
    _idle)
      active_migrations=$(docker ps -q --filter "label=com.docker.compose.project=$project" \
        --filter "label=com.docker.compose.service=migrate")
      [[ -z $active_migrations ]] || fail '仍有迁移容器运行，请等待或由宿主机管理员检查' ;;
    _capture|_extract)
      web_ref=$(sed -n 's/^WEB_IMAGE=//p' "$root/releases/$version/images.env")
      if [[ $command_name == _capture ]]; then
        verify_instance_storage "$version"
        docker run --rm --pull never --network none --user 0:0 --mount "type=bind,source=$data_dir,target=/data,readonly" "$web_ref" tar --numeric-owner -C /data -czf - .
      else
        [[ -n ${CLOUDDRIVE_MAINTENANCE_STAGE:-} ]] || fail '缺少恢复暂存目录'
        docker run --rm --pull never --network none --user 0:0 --interactive --mount "type=bind,source=$CLOUDDRIVE_MAINTENANCE_STAGE,target=/data" "$web_ref" tar --numeric-owner --same-owner -C /data -xzf -
      fi ;;
  esac
  exit 0
fi
if [[ -f $maintenance_config && $command_name != logs ]]; then
  [[ -z $release_source ]] || fail '网页运维模式仅使用已验证的官方在线产物'
  if [[ $command_name == restore ]]; then version=$backup_id; fi
  exec "$root/.control/maintenance/client" client --root "$root" --action "$command_name" --target "$version" --confirm "$restore_confirmation"
fi
[[ $command_name != rollback && $command_name != restore ]] || fail '请先启用网页运维'
case $command_name in
  status) printf '当前版本：%s\n实例名：%s\n安装目录：%s\n数据目录：%s\n' "$old_version" "$project" "$root" "$data_dir"; compose_at "$old_version" ps; exit 0 ;;
  logs) log_args=(logs --tail "$tail_lines"); [[ $follow == false ]] || log_args+=(--follow); compose_at "$old_version" "${log_args[@]}" backend web; exit 0 ;;
  check-update) resolve_version; printf '当前版本：%s\n最新目标：%s\n' "$old_version" "$version"; exit 0 ;;
esac
exec 9>"$root/.control/lock"; flock -n 9 || fail '另一个管理操作正在执行'
case $command_name in
  stop) compose_at "$old_version" stop; exit 0 ;;
  start) migration_status "$old_version"; compose_at "$old_version" up --detach --pull never backend web; probe "$old_version" || fail '启动检查未通过'; exit 0 ;;
  restart) migration_status "$old_version"; compose_at "$old_version" stop; compose_at "$old_version" up --detach --pull never backend web; probe "$old_version" || fail '重启检查未通过'; exit 0 ;;
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
    progress '执行数据库迁移与兼容性检查'
    compose_at "$version" run --rm --no-deps migrate
    migration_status "$version"
    progress '启动目标版本并检查就绪状态'
    compose_at "$version" up --detach --pull never backend web
    probe "$version" || fail '升级后就绪/版本检查未通过'
    atomic_current "$version"; stop_recovery=false
    install_manager
    printf '升级完成：%s → %s。数据与挂载路径保持不变。\n' "$old_version" "$version"
    ;;
esac
}
main "$@"
