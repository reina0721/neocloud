# NeoCloud 安装与部署

本手册适用于 NeoCloud v0.4.0 及后续版本。更早发行版的数据和配置应保留在原实例。安装 NeoCloud 时选择独立目录、数据位置和空闲端口。

选择与目标机匹配的入口。Windows 和 Linux 可运行[原生整包](backend-archive.md#运行原生-go-与-web-整包)，也可[从源码构建 Go 与 Node 本机包](#构建与进程)。Linux 服务器可用 [Docker Release 安装脚本](#release-下载版安装与升级)下载配套包、将附件复制到[离线目标机](#自动化与离线安装)，或在本机[构建 Docker 镜像](#从源码部署)。

## 安装 Docker 与系统依赖

Linux amd64 和 arm64 需要本机 Docker Engine 与 Docker Compose 2.20 或更新版本。源码构建还用到 Buildx 和 Git。以下在尚未安装 Docker 的 Ubuntu 24.04 上执行。已有 Docker 的主机先运行结尾的检查命令，升级或更换现有安装时按发行版的说明处理冲突包。[Ubuntu 安装说明](https://docs.docker.com/engine/install/ubuntu/) · [其他 Linux 发行版](https://docs.docker.com/engine/install/)

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git bash tar gzip coreutils util-linux iproute2
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF

sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
```

最后一条给当前用户 Docker 权限，权限等同于宿主机 root。结束 SSH 会话并重新登录，使新组成员身份生效。使用预先具备 Docker 权限的账户时可跳过添加用户组。[Docker 用户组说明](https://docs.docker.com/engine/install/linux-postinstall/)

```bash
docker info --format '{{.OSType}}/{{.Architecture}}'
docker compose version --short
docker buildx version
```

`linux/x86_64` 或 `linux/amd64` 对应 `amd64` 附件，`linux/aarch64` 或 `linux/arm64` 对应 `arm64` 附件。上述检查只访问本机 Docker。离线目标机可在准备期安装系统依赖，或提前转移适合目标系统和架构的 `.deb` 与依赖。[Docker 软件包安装](https://docs.docker.com/engine/install/ubuntu/#install-from-a-package)

## 从源码部署

在准备好[系统依赖](#安装-docker-与系统依赖)的 Linux 服务器上构建。首次构建需要访问 Docker Hub、Google Container Registry、Go 模块源和 npm 源，以获取基础镜像和依赖。Go、Node.js 与 pnpm 在构建容器中运行。

```bash
git clone --branch v0.4.0 https://github.com/reina0721/neocloud.git
cd neocloud
bash scripts/deploy-docker.sh plan
bash scripts/deploy-docker.sh up
```

执行 `plan` 可在部署前核对计算出的路径、名称和端口。`up` 会检查实际资源冲突，再构建镜像。使用默认配置时，资源如下。

| 项目 | 默认值与用途 |
| --- | --- |
| 源码目录 | 当前源码所在的目录，也是构建输入 |
| 安装目录 | `~/neocloud-deploy`，保存部署配置和记录 |
| 配置和令牌 | 安装目录下的 `deploy.env` 保存用户编辑的配置，`.control/` 存放实例记录与首次设置令牌 `setup-token` |
| Compose 项目与网络 | `neocloud`、`neocloud_default` |
| 容器 | `neocloud-backend-1`、`neocloud-web-1`、一次性迁移容器 `neocloud-migrate` |
| 镜像 | `neocloud-api:local`、`neocloud-web:local` |
| 数据 | 新实例通过本地 Docker 卷 `neocloud-data`，将宿主机的 `~/neocloud-deploy/data/` 挂载到 Go 与迁移容器的 `/app/.data`，包含 SQLite `app.db`、用户文件 `storage/`、传输暂存 `transfers/` |
| 数据库备份 | 实例目录下的 `backups/` |
| 端口和访问地址 | 宿主 `0.0.0.0:4180` 转发至 Web 容器 `4173/tcp`，浏览器打开 `http://服务器IP:4180`。Go API 的 `8080` 与运维的 `9090` 通过容器网络访问 |

### 配置实例

复制[配置模板](../../deploy-docker.env.example)后，可在同一份文件里指定安装位置、数据位置、资源名称及访问方式。

```bash
cp deploy-docker.env.example deploy.env
# 编辑 deploy.env 后，先核对计划，再执行部署。
bash scripts/deploy-docker.sh plan --config ./deploy.env
bash scripts/deploy-docker.sh --config ./deploy.env
```

例如，要将安装文件和数据分别放到系统盘与数据盘，可以在 `deploy.env` 设置以下值。

```dotenv
INSTALL_DIR=/opt/neocloud
DATA_DIR=/mnt/cloud-data/neocloud
COMPOSE_PROJECT_NAME=neocloud
WEB_PORT=4180
```

| 参数 | 新实例默认值 | 用途 |
| --- | --- | --- |
| `INSTALL_DIR` | 空，使用 `~/neocloud-deploy` | 保存配置、备份和部署记录的宿主机目录。相对路径以提供的配置文件所在目录为基准。显式 `--dir` 优先 |
| `DATA_DIR` | `./data` | 数据的宿主机目录。相对路径以安装目录为基准，可填绝对路径，例如 `/mnt/cloud-data/drive`。实例独占该目录 |
| `COMPOSE_PROJECT_NAME` | `neocloud` | 决定容器、镜像、网络等资源名称。已有配置可继续使用旧键 `INSTANCE_NAME` |
| `WEB_BIND` | `0.0.0.0` | 宿主机监听 IP，IPv6 地址使用方括号 |
| `WEB_PORT` | `4180` | 浏览器访问的宿主机端口，范围为 1024–65535 |
| `PUBLIC_ORIGIN` | 空 | 可选的公开入口，例如 `https://drive.example.com`。填写完整 HTTP(S) Origin，无路径或尾斜杠 |
| `ALLOW_INSECURE_HTTP` | 空，随公开入口推断 | `PUBLIC_ORIGIN` 为 HTTPS 时使用 HTTPS Cookie。公开入口为空或为 HTTP 时允许 HTTP Cookie。可显式填 `true` 或 `false` |
| `ALLOWED_ORIGINS` | 空 | 可选的额外跨域访问白名单，填精确 Origin 的 JSON 数组，例如 `["https://reader.example.com"]` |
| `--config FILE` | 使用模板默认配置 | 从指定文件读取新实例的设置，也可用来查找已安装实例 |
| `--dir DIR` | 由 `INSTALL_DIR` 或默认目录决定 | 直接选择安装目录。相对路径从执行脚本的当前目录解析 |

路径支持 `~/`，含空格时可用引号包裹。运行账户需能创建安装目录和数据目录。首次部署需使用尚未创建或为空的数据目录，部署时会按 Go 容器的 `65532:65532` 设置权限。计划列出的实际目录可在运行 `up` 前检查。

也可提前将编辑好的 `deploy.env` 放入目标安装目录，再用 `--dir` 选择该目录。已有实例以安装目录中保存的 `deploy.env` 为准。重新运行同一部署命令即可应用这份文件中的网络设置。最初的配置文件仍可通过 `--config` 定位实例。

新建第二个实例时，为它指定独立的安装目录、数据目录、项目名和空闲端口。安装计划会显示配置解析后的宿主机数据目录，部署和状态会显示实际数据位置。安装目录有无关文件、数据目录已被其他实例使用、Docker 资源重名或端口已占用时，脚本会报出冲突。调整配置后重试，端口始终以 `WEB_PORT` 为准。实例初始化后，项目名和数据位置随实例身份固定。

若使用 SSH 隧道或同机 HTTPS 反向代理，先设 `WEB_BIND=127.0.0.1`。端口、反向代理和 WebDAV 配置见[远程访问与 HTTPS](#远程访问与-https)。

### 首次设置和日常管理

部署完成后打开部署输出中的 `/setup` 地址，用下列命令读取初始化令牌并创建管理员。自定义安装目录时，给管理命令传入同一个 `--config` 或 `--dir`。

```bash
bash scripts/deploy-docker.sh token
bash scripts/deploy-docker.sh status
bash scripts/deploy-docker.sh logs -f
bash scripts/deploy-docker.sh logs --tail 100
bash scripts/deploy-docker.sh stop
```

例如，用自定义配置查看日志时执行 `bash scripts/deploy-docker.sh logs --config ./deploy.env --tail 100`。停止后使用同一个实例的 `up` 重新启动。默认端口可用 `curl -fsS http://127.0.0.1:4180/api/console/v1/auth/registration-policy` 检查 Web 到 Go 的连接，`status` 会显示端口和数据路径。首次登录后上传一个小文件，按上述命令停止并重新启动同一实例，再确认可下载原文件。

使用固定标签安装时，先阅读目标版本说明，再从原源码目录运行下列命令。将 `vX.Y.Z` 换成目标正式标签，`--config` 使用首次部署的配置路径，默认实例可省略该参数。

```bash
git fetch --tags origin
git switch --detach vX.Y.Z
bash scripts/deploy-docker.sh up --config ./deploy.env
```

镜像构建成功后，脚本会停止本实例，备份 SQLite，再执行迁移并等待 Web 和 Go 就绪。迁移失败时按[迁移与回滚](migration-and-rollback.md)处理。完整备份包括安装目录和实际数据路径。使用单独的数据目录时须单独备份该目录。

已有 NeoCloud 源码部署继续使用原来的 Docker 数据卷。保留 `DATA_DIR` 空白或省略该键，部署及 `status` 会列出原卷名称和宿主机挂载路径，备份时需保留该卷。

## Release 下载版安装与升级

下载版支持 Linux amd64、arm64，使用 SQLite 和本地文件存储。先完成[系统依赖](#安装-docker-与系统依赖)安装。安装脚本需要本机 Docker Unix socket、Compose 2.20 或更新版本、当前账户的 Docker 权限，以及可执行的 Cosign。发布验证使用 Cosign 2.6.5，可通过 `NEOCLOUD_COSIGN` 指定工具路径。在线方式从 GitHub Releases 下载并验签，离线方式使用单独准备的可信根校验同一套归档。两种方式均无需目标机安装 Go、Node.js 或 pnpm。安装前检查实例和数据盘、临时解包目录（默认 `/tmp`，可通过 `TMPDIR` 调整）以及 Docker 存储目录的可用空间。安装器会暂存下载归档和解包后的 `images.tar`，Docker 导入后还需要镜像空间。可通过 `docker info --format '{{.DockerRootDir}}'` 查看 Docker 存储目录。[Cosign 安装](https://docs.sigstore.dev/cosign/system_config/installation/)

### 安装当前正式版

在部署账号的 Linux 终端下载脚本并查看选项，再安装 v0.4.0。本例绑定回环地址并显式使用 `4180`。安装器默认目录为 `~/neocloud`，默认端口为 `4173`。

```bash
curl -fsSL --proto '=https' --proto-redir '=https' \
  https://github.com/reina0721/neocloud/releases/download/v0.4.0/install.sh -o install.sh
bash install.sh --help
bash install.sh install --version v0.4.0 --dir "$HOME/neocloud" --bind 127.0.0.1 --port 4180
"$HOME/neocloud/install.sh" status
curl -fsS http://127.0.0.1:4180/api/console/v1/auth/registration-policy
```

在服务器打开 `http://127.0.0.1:4180/setup`，或按[远程访问](#ssh-隧道与局域网访问)从自己的电脑访问。运行 `cat "$HOME/neocloud/.control/setup-token"` 读取令牌，在设置页创建管理员。令牌文件权限为 `0600`，应仅交给负责初始化的管理员。创建管理员后登录并上传一个小文件，运行 `"$HOME/neocloud/install.sh" restart`，再登录确认可以下载原文件。

| 项目 | 上例的实际位置或名称 |
| --- | --- |
| 安装目录和管理入口 | `~/neocloud/`，日常管理使用其中的 `install.sh` |
| 数据与备份 | 数据为 `~/neocloud/data/`，包括 `app.db`、`storage/` 和 `transfers/`，挂载到容器内 `/app/.data`。备份为 `~/neocloud/backups/` |
| Compose 项目 | `neocloud-<安装目录 SHA-256 的前 12 位>`，以解析后的绝对路径派生 |
| 容器和网络 | `<项目>-backend-1`、`<项目>-web-1`、`<项目>_default` |
| 镜像 | `neocloud-api:<版本>-<架构>`、`neocloud-web:<版本>-<架构>` |
| 端口 | 宿主机 `127.0.0.1:4180` 映射到 Web 容器 `4173/tcp`。Go 的 `8080` 和 `9090` 在容器网络内 |

#### 安装参数

| 参数 | 默认值 | 用途 |
| --- | --- | --- |
| `--dir DIR` | `~/neocloud` | 保存安装脚本、配置、备份与部署记录。相对路径以当前目录为基准 |
| `--name NAME` | 从安装目录派生 | 指定 Compose 项目名，影响容器、网络和名称保留卷。需要 `INSTANCE_LAYOUT=1` |
| `--data-dir DIR` | 安装目录的 `data/` | 指定持久化路径。相对路径以安装目录为基准。需要 `INSTANCE_LAYOUT=1` |
| `--bind IP` | `0.0.0.0` | 宿主机监听 IP。`127.0.0.1` 仅供本机、SSH 隧道或本机反向代理。IPv6 例如 `[::1]` |
| `--port PORT` | `4173` | 宿主机 Web 端口，范围 1024–65535。容器 Web 端口固定为 `4173` |
| `--public-url ORIGIN` | 空 | 浏览器使用的可选公开地址，例如 `https://drive.example.com`。只接受 HTTP(S) 根 Origin，省略路径、尾斜杠、查询、片段及凭据 |
| `--allow-origin ORIGIN` | 无额外 Origin | 单次允许一个精确的跨域 Origin，可重复，支持最多 32 项 Origin 配置（包含显式公开地址）。同源网页通常省略 |
| `--allow-http` | 无 HTTPS 公开地址时允许 HTTP | 显式使用 HTTP Cookie 模式。公网 HTTPS 部署填 HTTPS 地址并省略此参数 |
| `--version TAG` | 在线取最新正式版，离线读 `version.txt` | 固定版本，例如 `v0.4.0`。自动化可将下载地址和参数锁定在同一个 tag |
| `--release-dir DIR` | 在线下载 | 读取目标机已有的 Release 附件，启用本地安装或更新路径。参见[离线安装](#自动化与离线安装) |
| `--trust-dir DIR` | 实例已保存的信任目录 | 指定独立准备的 Sigstore 信任目录。首次签名离线安装需显式提供 |
| `--wait-timeout SECONDS` | `120` | 安装器等待启动就绪的秒数，范围 5–600 |
| `--yes`、`-y` | 交互式向导 | 省略子命令时可跳过向导，使用默认或显式参数安装。`install` 子命令本身即可非交互运行 |
| `--enable-web-management` | 关闭 | 完成安装后启用同址网页维护。需要 systemd、Cosign 和宿主机管理权限 |
| `--trusted-proxy IP` | 无 | 启用网页维护时，指定直接连接维护网关的反代 IP。只在使用该网关的反代部署中需要 |

### 自定义实例与安装检查

`v0.4.0` 的归档已带有 `INSTANCE_LAYOUT=1`。以下使用由部署账户拥有的路径，也可指定已授权的 `/opt/`、`/mnt/` 专用目录。

```bash
bash install.sh plan --check --version v0.4.0 --name cloud-main --dir "$HOME/neocloud-main" \
  --data-dir "$HOME/cloud-data/cloud-main" --bind 127.0.0.1 --port 44180
bash install.sh install --version v0.4.0 --name cloud-main --dir "$HOME/neocloud-main" \
  --data-dir "$HOME/cloud-data/cloud-main" --bind 127.0.0.1 --port 44180
```

本例在 `http://127.0.0.1:44180/setup` 设置第二个实例，令牌位于 `~/neocloud-main/.control/setup-token`。项目名以小写字母或数字开头，最多 40 个字符，可含小写字母、数字、下划线和短横线。上例创建 `cloud-main-backend-1`、`cloud-main-web-1`、`cloud-main_default` 和名称保留卷 `cloud-main-instance`。该卷在容器停止后仍保留实例名称。相同版本和架构的实例共用镜像。

首次安装使用可创建或为空的专用数据目录。独立数据盘使用挂载点下的子目录。若 `/mnt/data` 已挂载，可用 `sudo install -d -m 0700 -o "$USER" -g "$(id -gn)" /mnt/data/cloud-main` 创建专用空目录，并将两个命令的 `--data-dir` 都改成 `/mnt/data/cloud-main`。数据目录不能是挂载点本身、安装目录或安装目录的上级。项目名与解析后的数据位置在安装后固定，升级沿用此实例的真实路径。第二个实例需要独立的安装目录、数据路径、项目名和空闲端口。

`plan` 显示名称、路径与端口映射，无需连接 Docker 或写入安装目录。使用 `--version` 或带有 `version.txt` 的 `--release-dir` 时可离线预览，默认会在线解析最新版本。`plan --check` 额外通过本机 Docker 和 `ss` 检查项目名、数据目录和端口冲突。若曾显式传入不同的安装参数，请按状态输出中的实际实例与路径管理。

### 安装向导

下载脚本后直接运行 `bash install.sh`。向导询问安装目录、监听地址、端口和是否启用网页运维。新安装默认 `~/neocloud`、`0.0.0.0:4173`，局域网访问按[下方说明](#ssh-隧道与局域网访问)设置。安装器检查附件摘要和镜像身份，导入两张配套镜像，迁移数据库后启动并检查就绪。没有交互终端时使用 `install` 或 `--yes`。

### 自动化与离线安装

上一节的 `install --version v0.4.0` 可用于自动化。要自动取最新正式版，可从 [latest](https://github.com/reina0721/neocloud/releases/latest/download/install.sh) 下载安装脚本并省略 `--version`。断网目标机使用以下离线流程。

1. 在目标机运行 `docker info --format '{{.OSType}}/{{.Architecture}}'` 确认架构。到可信的联网工作站安装 [Cosign](https://docs.sigstore.dev/cosign/system_config/installation/)，此示例使用项目发布工具的 `v2.6.5`。在联网的 Linux 工作站运行以下命令，将 `arch` 改为目标架构。准备目录应位于实例目录之外。

   ```bash
   (
     set -euo pipefail
     tag=v0.4.0
     arch=amd64
     prepare="$PWD/neocloud-offline"
     release_base="https://github.com/reina0721/neocloud/releases/download/$tag"
     mkdir -p "$prepare/release" "$prepare/tools"
     for name in install.sh version.txt checksums.txt checksums.txt.sigstore.json \
       "neocloud_${tag}_linux_${arch}_docker.tar.gz" "neocloud-maintenance_${tag}_linux_${arch}"; do
       curl -fsSL --proto '=https' --proto-redir '=https' "$release_base/$name" -o "$prepare/release/$name"
     done
     curl -fsSL --proto '=https' --proto-redir '=https' \
       "https://raw.githubusercontent.com/reina0721/neocloud/$tag/scripts/prepare-offline-trust.sh" \
       -o "$prepare/tools/prepare-offline-trust.sh"
     bash "$prepare/tools/prepare-offline-trust.sh" "$prepare/sigstore-trust"
   )
   ```

   目标机也需要 Cosign。若其未预装，可从 [Cosign v2.6.5 附件](https://github.com/sigstore/cosign/releases/tag/v2.6.5)获取并校验目标架构的 `cosign-linux-amd64` 或 `cosign-linux-arm64`，放入 `tools/` 一起转移。目标机以 `sudo install -m 0755 <Cosign文件> /usr/local/bin/cosign` 安装，并执行 `cosign version` 检查。Sigstore bundle 使用 `trusted_root.json`。[信任准备脚本](../../scripts/prepare-offline-trust.sh) · [Cosign 离线验证](https://github.com/sigstore/cosign#air-gapped-verification)

2. 将 `release/` 与单独准备的 `sigstore-trust/` 转移到目标机。本例放在 `~/neocloud-offline/`。运行下列命令。在执行新下载的安装脚本前，先用信任根核验签名与已取得的四个附件摘要。签名身份绑定本例的正式标签，换版时同时更新 `tag`、附件和身份。

   ```bash
   (
     set -euo pipefail
     tag=v0.4.0
     arch=amd64
     assets="$HOME/neocloud-offline/release"
     trust="$HOME/neocloud-offline/sigstore-trust"
     cd "$assets"
     cosign verify-blob --bundle checksums.txt.sigstore.json \
       --offline --new-bundle-format --trusted-root "$trust/trusted_root.json" \
       --certificate-identity "https://github.com/reina0721/neocloud/.github/workflows/release.yml@refs/tags/$tag" \
       --certificate-oidc-issuer https://token.actions.githubusercontent.com checksums.txt
     for name in install.sh version.txt \
       "neocloud_${tag}_linux_${arch}_docker.tar.gz" "neocloud-maintenance_${tag}_linux_${arch}"; do
       digest=$(awk -v name="$name" '$2 == name {print $1}' checksums.txt)
       [[ $digest =~ ^[0-9a-f]{64}$ ]]
       printf '%s  %s\n' "$digest" "$name" | sha256sum --check --strict
     done
     bash "$assets/install.sh" install --dir "$HOME/neocloud" --bind 127.0.0.1 --port 4180 \
       --version "$tag" --release-dir "$assets" --trust-dir "$trust"
   )
   "$HOME/neocloud/install.sh" status
   ```

安装器再次校验签名、文件摘要、架构与归档，导入镜像并迁移数据库。带 `OFFLINE_MAINTENANCE=1` 的正式版会把信任材料和验证后的发布包保存到实例，供[离线检查与升级](#离线检查与升级)使用。首次设置地址、令牌位置与在线安装相同。

### 管理和更新

以下示例使用默认目录，自定义目录时替换路径。脚本根据自身位置定位实例，无须先 `cd`：

```bash
~/neocloud/install.sh                 # 管理菜单
~/neocloud/install.sh status
~/neocloud/install.sh logs --tail 100
~/neocloud/install.sh logs -f
~/neocloud/install.sh check-update
~/neocloud/install.sh upgrade         # update 是同义命令
# 当前版本更旧时，也可指定正式升级目标。
~/neocloud/install.sh upgrade --version v0.4.0
~/neocloud/install.sh backup
~/neocloud/install.sh stop
~/neocloud/install.sh start
~/neocloud/install.sh restart
```

`restart` 会应用修改后的配置并检查就绪状态。启用新版维护工具后，应用升级和宿主维护工具更新分别执行。相同版本不会重复迁移。重复安装不重建已有实例，目标目录非空且无实例标记时拒绝接管。不同实例使用独立 Compose project、配置和数据目录。

#### 离线检查与升级

每个 NeoCloud 正式版本单独存放一个资产目录。需要更新已启用的宿主维护工具时，使用实际安装目录，并核对目标版本的签名资产与信任目录。

```bash
assets="$HOME/neocloud-offline/release"
trust="$HOME/neocloud-offline/sigstore-trust"
bash "$assets/install.sh" update-maintenance --dir "$HOME/neocloud" \
  --release-dir "$assets" --trust-dir "$trust"
```

之后可以直接检查、导入和升级。`check-update --release-dir` 检查指定目录的签名与归档，报告目标版本能否用于升级。导入会把验证过的发布包保存到实例，便于重复使用。

```bash
manager="$HOME/neocloud/install.sh"
next=/mnt/cloud-install/next-release
"$manager" check-update --release-dir "$next"
"$manager" import-release --release-dir "$next"
"$manager" check-update --offline
"$manager" upgrade --offline --version "$(cat "$next/version.txt")"
```

`check-update --offline` 列出已验证的本地正式版本。省略升级版本时，`upgrade --offline` 选择高于当前版本的最新本地正式包。没有较新的本地包时，命令检查当前版本镜像，必要时从已导入的同版本包恢复镜像，无须迁移。保留当前版本和上一版本的已校验附件。回退或恢复需要对应版本的本地镜像或已导入的签名发布包。

主目录结构：

```text
neocloud/
├── install.sh          # 本实例管理入口
├── runtime.env         # 用户配置，升级保留
├── data/               # 数据库、文件与传输暂存
├── releases/           # 已校验的版本编排和清单
├── backups/            # 数据库及配置备份
└── .control/           # 实例、当前版本、锁及设置令牌
```

### 高级应用配置

编辑本实例的 `runtime.env`，随后执行 `restart`。升级逐字保留已有配置；原有实例不会被改成新安装默认值。

| 变量 | 新安装默认值 | 用途 |
| --- | --- | --- |
| `WEB_BIND` | `0.0.0.0` | 宿主机监听 IP，IPv6 写作 `[::]` |
| `WEB_PORT` | `4173` | 宿主机 Web 端口，1024–65535 |
| `PUBLIC_ORIGIN` | 空 | 可选的绝对链接地址覆写；未设置时采用当前 Web 入口 |
| `ALLOW_INSECURE_HTTP` | `true` | HTTP Cookie 模式；HTTPS Cookie 策略设为 `false` |
| `ALLOWED_ORIGINS` | `'[]'` | 可选额外跨域白名单，JSON 精确 Origin 数组，不接受 `*` |
| `SETUP_TOKEN` | 随机生成 | 首次管理员创建令牌 |

首次安装仍兼容 `--public-url`、`--allow-origin`、`--allow-http` 高级参数；显式 HTTPS 地址且未提供 `--allow-http` 时使用 HTTPS Cookie。切换 Cookie 模式需重新登录，账号、文件与权限保留。

Web Host 校验外部 Host/Origin，并向 Go 转发内部同源请求；额外跨域 Origin 仍由显式白名单约束。Go 继续独立执行会话、权限和 CSRF 校验。WOPI 保留协议自身的票据验证。Web Host 覆盖客户端转发头；用于连接 URL 展示的元数据不参与鉴权、Cookie 策略或 DAV 目标授权。

安装包保持 `FORMAT=1`、`NETWORK=1` 和原五项文件集合。`ENTRYPOINT=1` 表示支持无固定外部地址的 Web 入口，`INSTANCE_LAYOUT=1` 表示支持自定义项目名或数据目录，`OFFLINE_MAINTENANCE=1` 表示有配套的离线维护工具。升级沿用已有实例的布局，并在停服前校验目标版本是否支持已用能力。签名、SBOM 与维护者发布验收见[发布说明](release.md)。

### 数据与升级失败

宿主机数据目录持久化数据库、文件和传输暂存，默认是安装目录中的 `data/`。容器内统一挂载到 `/app/.data`。`runtime.env` 保留应用配置与设置令牌，`.control/` 记录实例身份和当前版本，`releases/` 保留已校验的 Compose 与镜像清单。

升级先核对产物和配套镜像，再停服备份、执行迁移和兼容检查，最后启动并核对 `/readyz` 与 `/build` 版本。旧安装器执行 SQLite 备份。新版宿主维护工具在升级前创建完整恢复点。启动检查默认等待 120 秒。直接使用安装器升级可用 `--wait-timeout 180` 调整（5–600 秒）。

备份位于安装目录的 `backups/时间戳/`，包含 `database.tar`、`runtime.env`、原版本、实例标记和校验和。文件 Blob 留在数据目录中的 `storage/`，整机恢复须同时备份安装目录和实际数据目录。

新版宿主维护工具支持不启用网页运维的完整备份、兼容回退与恢复。`backup --full` 把数据库、文件、传输暂存和应用配置写入 `backups/full-<编号>/`。查看命令返回的恢复点编号或从状态输出中选取恢复点。

```bash
"$HOME/neocloud/install.sh" backup --full
"$HOME/neocloud/install.sh" rollback --offline
# 将 ID 替换为要恢复的完整恢复点编号。
"$HOME/neocloud/install.sh" restore --offline --backup-id ID --confirm-restore ID
```

下载或校验失败不会停止服务。备份失败不会执行目标迁移。后续失败会保留数据、候选版本和备份；只有旧镜像报告各迁移集精确兼容时才恢复旧服务。否则停止自动回退，按[迁移与回滚](migration-and-rollback.md)选择 forward-fix 或经所有者确认的备份恢复，不执行自动 `down`、删除版本记录或覆盖数据库。恢复前先停止实例、另存失败现场并校验备份，不在运行中的数据库上解包。

首次初始化失败的目录保留安装器标记，可以使用相同安装命令重试；dirty migration 等数据库问题仍必须先按迁移规范解决。任意管理操作均使用实例锁，拒绝并发安装、备份或升级。

## 网页运维

发布附件包含同版本、同架构的 `neocloud-maintenance_…` 后，Linux systemd 上的安装器托管实例可以启用。网页运维需要 Docker Compose 2.24.4 或更新版本，以便单独替换 Web 发布端口。宿主机需能访问本机 Docker，安装账户需有对应权限，启用时需要 sudo 或 root。安装 [发布验证所用的 cosign](release.md#docker-下载产物)，并让安装账户可以在 PATH 找到它。

```bash
# 已有实例先用旧管理脚本升级到配套的正式版。
~/neocloud/install.sh enable-web-management
# 新实例可在向导选择启用，或给 install 子命令加 --enable-web-management。
```

具有 `management:read` 权限的账号可从「系统管理 → 系统更新」或管理概览的「任务与运行」查看当前服务版本。点击「检查 GitHub 正式版」可读取发布说明和下载附件，Windows 本地开发环境也可查询。Windows 源码开发实例的页面可查询更新。运行 Windows 正式整包时，由[原生宿主](backend-archive.md#运行原生-go-与-web-整包)执行对应的版本操作。

启用网页运维会短暂停服。宿主网关接管原 Web 地址和端口，Web Host 改在独立的宿主机回环端口监听。IAM 系统所有者可从「系统更新」打开 `/maintenance`。停服期间可直接打开同地址的 `/maintenance`。API、DAV 和 WOPI 在业务暂不可用时返回 503 和重试提示。

远程维护写操作走 HTTPS。已有 TLS 反向代理时，先让 `runtime.env` 的 `PUBLIC_ORIGIN` 等于外部 HTTPS Origin，再给启用命令加 `--trusted-proxy <代理直接连接网关的IP>`。代理应保留 Host 并覆盖 `X-Forwarded-Proto` 为 `https`。直连回环 HTTP 可用于本机运维。工作区不可用时，从宿主机读取 `.control/maintenance/recovery-token`，在同址维护页建立短期恢复会话。妥善保护这个恢复凭据。

- 「检查正式版（GitHub）」显示在线候选和发布说明。「检查本地包」重新验证宿主机已导入的包，并显示可升级的确切版本。导入在宿主机使用 `install.sh import-release --release-dir <目录>`。每个实例一次只运行一个维护任务，刷新维护页可以重新查看进度。
- 选中本地候选后用「从本地包升级到」提交。安装器在停服前检查目标及当前版本的镜像，必要时从已导入的签名包补齐。兼容回退与恢复也使用本地来源。
- `backups/full-<编号>/` 保存 SQLite、文件、传输暂存、应用配置与版本清单。创建恢复点会停服，并需要足够空间写入压缩档案。旧 CLI 生成的 SQLite 备份继续适用于人工流程。
- 兼容回退使用上一套程序及当前数据。恢复完整备份会重新启用当时的数据和应用配置。确认前核对备份时间和恢复点编号。恢复通过同一文件系统上的重命名切换数据目录。使用默认数据目录时，原数据保留在安装目录的 `.control/maintenance/restore-<任务编号>/original-data`。使用自定义数据目录时，原数据保留在该目录旁的 `.neocloud-restore-<任务编号>/original-data`。宿主网关配置、恢复凭据和任务记录仍在原处。
- CLI 的 `check-update`、`upgrade`、`backup`、`rollback` 和 `restore --backup-id <编号> --confirm-restore <编号>` 使用相同执行路径。systemd 用安装目录派生的维护标记命名 `<维护标记>-gateway.service` 和 `<维护标记>-maintenance.service`。Compose 容器名使用 `--name`。任务失败的详细阶段可在维护服务的宿主日志中查看。

## 远程访问与 HTTPS

网页、API、WebDAV 和 WOPI 通过同一个公开入口访问。采用服务器本机回环监听时，对外连接由 SSH 隧道或同机 HTTPS 代理接收。Go 的管理端口 `9090` 保持在本机或应用的私有网络内。

### SSH 隧道与局域网访问

服务器上的应用监听 `127.0.0.1:4180` 时，在自己的电脑运行以下命令。将服务器用户名和地址换成实际值。最后一个 `4180` 是服务器实际 Web 端口，原生整包默认填 `8080`，独立 Node Web Host 默认填 `4173`。第一个 `4180` 是本机访问端口，已占用时可改成 `44180`，浏览器也使用改后的本机端口。

```bash
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:4180:127.0.0.1:4180 user@server.example.com
```

保持 SSH 会话运行，打开 `http://127.0.0.1:4180/setup`，已有管理员则打开 `/login`。应用需要允许本实例的 HTTP Cookie 模式。这个方法只需服务器开放 SSH 端口。

受信局域网若要直接访问，将 Docker 安装的 `--bind` 或实例配置的 `WEB_BIND` 设置为服务器的局域网 IP，也可在需要多个网卡时使用 `0.0.0.0`。允许来自局域网的 TCP Web 端口，云服务安全组也需按实际客户端网段配置。浏览器使用实际服务器地址，例如 `http://192.168.1.20:4180/setup`。明文 HTTP 用于受信网络或 SSH 隧道，公网访问使用 HTTPS。

### 在同机启用 HTTPS 反向代理

选择一个指向服务器的域名，例如 `drive.example.com`。应用公开入口绑定服务器回环端口，本例为 `127.0.0.1:4180`。按运行方式设定以下参数。

| 方式 | 应用监听和外部入口配置 |
| --- | --- |
| Release 首次安装 | 使用 `--bind 127.0.0.1 --port 4180 --public-url https://drive.example.com` |
| 已有 Release 或源码 Docker | Release 修改实例的 `runtime.env` 后执行 `install.sh restart`。源码 Docker 修改实例的 `deploy.env` 后运行原 `deploy-docker.sh up`。设 `WEB_BIND=127.0.0.1`、`WEB_PORT=4180`、`PUBLIC_ORIGIN=https://drive.example.com`、`ALLOW_INSECURE_HTTP=false` |
| 独立 Node Web Host | 设 `HOSTNAME=127.0.0.1`、`PORT=4180`、`NEOCLOUD_PUBLIC_ORIGIN=https://drive.example.com`。Go 侧使用同值的 `files.connections.publicOrigin` 并设 `iam.local.allowInsecureHTTP: false`，同时移除首次启动示例设置的 `NEOCLOUD_APP_IAM__LOCAL__ALLOWINSECUREHTTP` 覆盖 |
| [原生 Go 与 Web 整包](backend-archive.md#运行原生-go-与-web-整包) | 首次启动可选择 `--web-addr 127.0.0.1:4180`。已初始化的实例沿用实际 Web 端口，例如默认的 `8080`，并修改下例 Nginx 的 `proxy_pass`。Go 配置 `files.connections.publicOrigin: https://drive.example.com`、`iam.local.allowInsecureHTTP: false`，将同机代理直连地址 `127.0.0.1/32` 加入 `http.trustedProxyCIDRs` |

如果启用了 Docker 网页运维，代理仍转发原 Web 端口，并按[网页运维](#网页运维)指定直连网关的受信代理地址。切换 Cookie 策略后从新的公开地址重新登录。

下面以 Ubuntu 24.04 和 Nginx 为例。先让 DNS 指向服务器，开放用于证书验证和跳转的 TCP 80 及用于访问的 TCP 443。如果使用云安全组，同步允许这些端口。

```bash
sudo apt-get update
sudo apt-get install -y nginx certbot python3-certbot-nginx
sudo systemctl enable --now nginx
```

使用 `sudoedit /etc/nginx/conf.d/neocloud.conf` 写入以下配置，并将域名、端口改为实际值。

```nginx
server {
    listen 80;
    server_name drive.example.com;

    client_max_body_size 512m;
    client_body_timeout 300s;

    location / {
        proxy_pass http://127.0.0.1:4180;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header Forwarded "";
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Host $http_host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Port $server_port;
        proxy_request_buffering off;
        proxy_buffering off;
        proxy_send_timeout 300s;
        proxy_read_timeout 300s;
    }
}
```

确认 Nginx 配置有效后加载，然后由 Certbot 为域名申请证书并启用 HTTPS 跳转。已有证书的实例可以照本机 Nginx 证书管理方式绑定证书并启用 443。[Certbot 的 Nginx 安装说明](https://certbot.eff.org/instructions?ws=nginx&os=ubuntunoble) · [Nginx 代理参数](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)

```bash
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx -d drive.example.com --redirect
sudo certbot renew --dry-run
curl --fail --silent --show-error --output /dev/null https://drive.example.com/login
```

在浏览器访问 `https://drive.example.com/setup` 或 `/login`。证书或 DNS 更新后，用实际域名验证页面和登录。应用使用根地址，代理将所有路径及原始 Host 交给同一个入口。

### WebDAV 验收与排障

在网页「连接」页创建 WebDAV 专用凭据，并使用凭据弹窗显示的 URL 和用户名。以下是只读取目录属性的检查，curl 会交互提示保存的 WebDAV 密码。替换示例用户名和 URL，期望返回 `207 Multi-Status`。

```bash
curl --fail --show-error --include --user 'WebDAV连接用户名' \
  --request PROPFIND --header 'Depth: 0' 'https://drive.example.com/dav/'
```

上传出现 `413` 时，核对 Nginx 的 `client_max_body_size`、其他网关的请求限制和应用本身的 WebDAV PUT 上限 512 MiB。大文件传输使用 HTTP/1.1 上游且关闭代理请求缓冲。代理的读写超时按实际链路预算调整，应用仍执行自己的超时和大小限制。复制或移动失败时，检查客户端的 `Destination` 是否指向同一个公开 Origin，以及代理是否保留 Host、请求方法和 WebDAV 请求头。[WebDAV 连接与挂载](file-management.md#webdav-连接与挂载)

## 构建与进程

从源码构建的本机包包含 Go 服务和 Node Web Host。适合需要部署指定提交的 Windows 或 Linux 用户。两端由同一份源码构建，浏览器从 Web Host 的 `4173` 端口访问网页与 API。

### 安装构建工具

- Windows amd64 安装 Git for Windows、Go 1.26.11 或更新版的 Windows x86-64 MSI，以及 Node.js 24 的 Windows x64 MSI。使用安装器的默认 PATH 选项，安装后打开新的 PowerShell 窗口。Node 安装器同时提供 npm。[Git 安装说明](https://git-scm.com/install/) · [Go 下载](https://go.dev/dl/) · [Node.js 24 安装包](https://nodejs.org/dist/latest-v24.x/)
- Ubuntu 安装 Git 和解包工具。用 `uname -m` 确认架构，`x86_64` 选择 Go 的 `linux-amd64` 和 Node 的 `linux-x64`，`aarch64` 选择两者的 `linux-arm64`。核对下载页的 SHA-256，将 Go 解压到独立工具目录并把 `go/bin` 加入 `PATH`，将 Node 24 的 `.tar.xz` 解压后把其中的 `bin` 加入 `PATH`。[Go 安装步骤](https://go.dev/doc/install/) · [Go 下载](https://go.dev/dl/) · [Node.js 24 安装包](https://nodejs.org/dist/latest-v24.x/)

```bash
sudo apt-get update
sudo apt-get install -y git ca-certificates curl tar gzip xz-utils openssl
# 下载并校验对应架构的 Go .tar.gz 与 Node 24 .tar.xz 后，
# 在下载目录内分别创建全新的 Go 和 Node 工具目录。
tool_dir=$(mktemp -d "$HOME/neocloud-tools.XXXXXXXX")
mkdir "$tool_dir/go" "$tool_dir/node"
tar -xzf /path/to/go1.26.11.linux-amd64.tar.gz -C "$tool_dir/go" --strip-components=1
tar -xJf /path/to/node-v24.x.y-linux-x64.tar.xz -C "$tool_dir/node" --strip-components=1
export PATH="$tool_dir/go/bin:$tool_dir/node/bin:$PATH"
```

将上述两个归档路径替换为实际下载的文件。运行 Web Host 的账号也需要能找到 Node 24。需要持续使用时，将对应的 `bin` 路径写入该账号的 shell 配置或进程管理配置。

在 Windows PowerShell 或 Linux Bash 中核对版本后构建。如果 PowerShell 执行策略拦截 `npm.ps1`，用 `npm.cmd --version` 检查。脚本通过 npx 调用固定的 pnpm 10.22.0，按锁文件安装依赖并生成契约。首次构建需要访问 Go 模块源和 npm registry。

```text
git --version
go version
node --version
npm --version
git clone --branch v0.4.0 https://github.com/reina0721/neocloud.git
cd neocloud
node scripts/build.mjs
```

| 构建选项 | 默认值与用途 |
| --- | --- |
| `--go-executable PATH` | 默认从 `PATH` 查找 `go`。有多个工具链时可填写绝对路径。 |
| `--no-web-cache` | 默认复用 Next 本机包的编译缓存。加此选项使用独立的无缓存构建目录。 |

### 解包、迁移并启动

以下命令用于全新实例。选一个未使用的运行目录，两个终端都在其中解包得到的 `neocloud` 目录运行。已有实例继续使用原 `config.yaml`、工作目录和数据。默认配置可以用 `config init` 生成，初始化只需要执行一次。

**Windows PowerShell，终端一**

```powershell
$archive = (Resolve-Path 'dist/native/windows-amd64/neocloud-windows-amd64.zip').Path
$target = Join-Path $HOME 'neocloud-source-run'
New-Item -ItemType Directory -Path $target -ErrorAction Stop | Out-Null
Expand-Archive -LiteralPath $archive -DestinationPath $target -ErrorAction Stop
Set-Location (Join-Path $target 'neocloud')
.\neocloud.exe config init
if ($LASTEXITCODE -ne 0) { throw '配置初始化失败' }
New-Item -ItemType Directory -Path .data -ErrorAction Stop | Out-Null
$tokenBytes = New-Object byte[] 32
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try { $rng.GetBytes($tokenBytes) } finally { $rng.Dispose() }
$env:NEOCLOUD_APP_IAM__LOCAL__SETUPTOKEN = [Convert]::ToBase64String($tokenBytes)
$env:NEOCLOUD_APP_IAM__LOCAL__ALLOWINSECUREHTTP = 'true'
.\neocloud.exe db migrate up
if ($LASTEXITCODE -ne 0) { throw '数据库迁移失败' }
Write-Host "首次设置令牌：$env:NEOCLOUD_APP_IAM__LOCAL__SETUPTOKEN"
.\neocloud.exe
```

**Windows PowerShell，终端二**

```powershell
Set-Location (Join-Path $HOME 'neocloud-source-run/neocloud')
$env:NEOCLOUD_BACKEND_URL = 'http://127.0.0.1:8080'
$env:HOSTNAME = '127.0.0.1'
$env:PORT = '4173'
node start-web.mjs
```

**Linux Bash，终端一**

```bash
set -e
umask 077
case $(uname -m) in
  x86_64) arch=amd64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) printf '此示例支持 Linux amd64 或 arm64\n' >&2; exit 1 ;;
esac
target="$HOME/neocloud-source-run"
mkdir "$target"
tar -xzf "dist/native/linux-$arch/neocloud-linux-$arch.tar.gz" -C "$target"
cd "$target/neocloud"
./neocloud config init
mkdir -m 700 .data
setup_token=$(openssl rand -hex 32)
export NEOCLOUD_APP_IAM__LOCAL__SETUPTOKEN="$setup_token"
export NEOCLOUD_APP_IAM__LOCAL__ALLOWINSECUREHTTP=true
./neocloud db migrate up
printf '首次设置令牌：%s\n' "$setup_token"
./neocloud
```

**Linux Bash，终端二**

```bash
cd "$HOME/neocloud-source-run/neocloud"
NEOCLOUD_BACKEND_URL=http://127.0.0.1:8080 HOSTNAME=127.0.0.1 PORT=4173 node start-web.mjs
```

运行包内的 `start-web.mjs`。它在 Windows 还负责恢复 Next 所需的依赖目录链接，因此应完整保留 `web/` 和 `.standalone-links.json`。实例目录需由当前运行账号控制。令牌只需在首次创建管理员时提供，应当作密码保管。若在完成设置前停止 Go，重启时在该进程环境中重新提供令牌。长期使用回环 HTTP 时，在 `config.yaml` 持久设置 `iam.local.allowInsecureHTTP: true`，或在每次启动 Go 的进程环境中设置上例的变量。

用 `curl -fsS http://127.0.0.1:9090/readyz` 检查 Go，再通过 `curl -fsS http://127.0.0.1:4173/api/console/v1/auth/registration-policy` 检查 Web 到 Go 的代理。PowerShell 可用 `curl.exe` 运行相同检查。打开 `http://127.0.0.1:4173/setup`，用令牌创建管理员。登录后上传一个小文件，重启两端，再登录确认可以下载原文件。远程访问时只转发 Web 端口。[远程访问与 HTTPS](#远程访问与-https)

### 运行参数

| 参数 | 默认值与用途 |
| --- | --- |
| `http.addr` / `NEOCLOUD_APP_HTTP__ADDR` | Go 业务端监听 `127.0.0.1:8080`。修改时同步调整 Web 的 `NEOCLOUD_BACKEND_URL`。 |
| `management.addr` / `NEOCLOUD_APP_MANAGEMENT__ADDR` | Go 运维监听 `127.0.0.1:9090`，用于 `/readyz`、`/build` 等本机检查。 |
| `NEOCLOUD_APP_IAM__LOCAL__SETUPTOKEN` | 默认空。新库首次设置令牌，传给 Go 进程。 |
| `iam.local.allowInsecureHTTP` / `NEOCLOUD_APP_IAM__LOCAL__ALLOWINSECUREHTTP` | 默认 `false`，使用 HTTPS Cookie。上例在 Go 进程显式设为 `true` 以允许回环 HTTP，HTTPS 部署设回 `false`。 |
| `HOSTNAME` / `PORT` | 包内 Web 启动器默认 `127.0.0.1` 和 `4173`。填写监听地址和整数端口。 |
| `NEOCLOUD_BACKEND_URL` | 默认 `http://127.0.0.1:8080`，作为 Web 服务端的 Go 上游。填 HTTP(S) Origin，省略路径、凭据、查询和片段。 |
| `NEOCLOUD_PUBLIC_ORIGIN` | 默认空。配置 HTTPS 反代时填写公开 Origin，并让 Go 的 `files.connections.publicOrigin` 使用同一值。 |

`NEOCLOUD_APP_` 环境变量覆盖 `config.yaml`。修改启动参数后重启对应进程。开发入口的 `WEB_PORT` 和构建期的 `NEXT_PUBLIC_NEOCLOUD_*` 各有自己的用途，独立 Web Host 的监听端口通过 `PORT` 设置。[应用配置](../configuration/README.md)

### 停止、备份和更新

先在 Web 终端按 `Ctrl+C`，再停止 Go。两端的前台输出可用于排障。以默认本地存储为例，停服后将 `config.yaml` 和整个 `.data/` 复制到实例目录之外的专用备份目录。SQLite 位于 `.data/app.db`，用户文件位于 `.data/storage/`，传输暂存位于 `.data/file-transfers/`。使用自定义路径时按实际配置备份。

更新时先单独构建目标版本并审阅变更，停服备份后，在同一个实例路径部署目标版本的 Go 程序。先移开旧的 `web/`，再整体安装新版 `web/`、`start-web.mjs` 及 Windows 包内的 `.standalone-links.json`，保留配置和数据。用目标 Go 程序执行 `db migrate up` 及 `db migrate status`，再启动和复查读写。迁移失败时保留现场并检查迁移状态。只有旧程序与当前数据结构兼容时才切换程序版本，按恢复点还原数据前先确认将丢失哪些后续写入。[数据库迁移与回滚](migration-and-rollback.md)

维护者可以单独构建 Go 或 Next server 产物，或运行 `pnpm --dir frontend standalone:check` 检查 Web 的运行依赖与代理传输。`node scripts/dev.mjs` 提供本地热刷新和开发实例，其数据和进程由开发入口管理。[构建与容器](build-and-container.md) · [本地开发](../getting-started/local-development.md)

## 站点信息

在「系统配置 → 站点信息」填写名称、描述、浅色和深色标志、浏览器图标、使用条款和隐私政策链接。保存后当前页面立即更新，其他浏览器下次加载时读取新值。留空可恢复默认名称、图形或浏览器标题，也可隐藏相应链接。深色标志留空时沿用浅色标志。

所有字段均对访客公开。图片和条款链接使用 HTTPS 或以单个斜杠开头的站内路径。浏览器直接请求图片，Go 服务不代理图像。

需要由公网域名生成分享、直链或文档回调时，先在 `console.siteOrigins` 登记转发到同一实例的根地址，再到「站点地址」保存主站及最多八个备选站点。分享和直链在主站或备选站点访问时沿用该地址，其他访问来源生成主站链接。外部阅读器和 WOPI 回调始终使用主站地址。清空后沿用浏览器当前地址。反向代理需要在主站转发相应的网页、公开 API 和 `/wopi/` 路径。

## 数据库与调度

将已有本地数据迁入容器时，保持存储位置标识和访问路径稳定。系统会把本地存储的绝对路径与文件元数据绑定；直接把原目录挂到另一个路径，会触发内容迁移保护并拒绝启动。本地验收沿用原绝对路径作为容器挂载目标与工作目录，使用可读写该目录的非 root UID，数据库和文件保持原样。需要改变存储位置时，应先完成明确的内容迁移。

默认 SQLite，数据保存在 `.data/`。MySQL/PostgreSQL 通过 driver/DSN 指定并执行 `db migrate up`。三种方言都使用同一组模块迁移。升级前备份数据库，迁移失败或存在 dirty 记录时，按迁移工具流程恢复。

scheduler.enabled 默认 true；任务定义与下次运行时间保存在数据库，重启后重新加载。关闭调度器会保留任务并停止派发。任务由既有 execution 生命周期执行；每次执行重新检查账号状态与权限，执行权通过版本比较领取，避免重复派发。当前本地调度适用于单个后端实例；多实例上线前配置并验证既有协调能力。

API 请求默认禁止私网、loopback、链路本地及元数据地址，重定向和 DNS 解析逐次验证。确需访问内部 API 时，管理员在 console.relay.allowedOrigins 中按协议、主机、端口显式许可，不接受来自浏览器的任意放行规则。默认最长30秒、响应体2MiB、请求体1MiB；服务端不执行任意 JavaScript。带脚本/提取器的集合不能新建服务端任务。UA/自定义允许头可用；代理和 TLS 指纹当前不支持，UI 禁用且接口返回 unsupported。
