# CloudDrive Docker 安装与管理

在 Linux 服务器上安装已发布版本，直接使用 [GitHub 一键部署](#release-下载版安装与升级)。下面的源码部署适用于需要构建当前工作区的场景。两种入口各自管理独立实例和数据。

## 从源码部署

将源码放在 Linux 服务器上，进入仓库目录。需要 Docker Engine、Docker Compose ≥ 2.20、iproute2 的 `ss`，以及 Bash、flock 等常用工具。Go 和 Node 在镜像中使用。

```bash
bash scripts/deploy-docker.sh
```

执行 `bash scripts/deploy-docker.sh plan` 可在部署前核对资源。使用默认配置时，资源如下。

| 项目 | 默认值与用途 |
| --- | --- |
| 源码目录 | 当前源码所在的目录，也是构建输入 |
| 安装目录 | `~/clouddrive-deploy`，保存部署配置和记录 |
| 配置和令牌 | 安装目录下的 `deploy.env` 保存用户编辑的配置，`.control/` 存放实例记录与首次设置令牌 `setup-token` |
| Compose 项目与网络 | `clouddrive`、`clouddrive_default` |
| 容器 | `clouddrive-backend-1`、`clouddrive-web-1`、一次性迁移容器 `clouddrive-migrate` |
| 镜像 | `clouddrive-api:local`、`clouddrive-web:local` |
| 数据 | 新实例通过本地 Docker 卷 `clouddrive-data`，将宿主机的 `~/clouddrive-deploy/data/` 挂载到 Go 与迁移容器的 `/app/.data`，包含 SQLite `app.db`、用户文件 `storage/`、传输暂存 `transfers/` |
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
INSTALL_DIR=/opt/clouddrive
DATA_DIR=/mnt/cloud-data/clouddrive
COMPOSE_PROJECT_NAME=clouddrive
WEB_PORT=4180
```

| 参数 | 新实例默认值 | 用途 |
| --- | --- | --- |
| `INSTALL_DIR` | 空，使用 `~/clouddrive-deploy` | 保存配置、备份和部署记录的宿主机目录。相对路径以提供的配置文件所在目录为基准。显式 `--dir` 优先 |
| `DATA_DIR` | `./data` | 数据的宿主机目录。相对路径以安装目录为基准，可填绝对路径，例如 `/mnt/cloud-data/drive`。实例独占该目录 |
| `COMPOSE_PROJECT_NAME` | `clouddrive` | 决定容器、镜像、网络等资源名称。已有配置可继续使用旧键 `INSTANCE_NAME` |
| `WEB_BIND` | `0.0.0.0` | 宿主机监听 IP，IPv6 地址使用方括号 |
| `WEB_PORT` | `4180` | 浏览器访问的宿主机端口，范围为 1024–65535 |
| `PUBLIC_ORIGIN` | 空 | 可选的公开入口，例如 `https://drive.example.com`。填写完整 HTTP(S) Origin，无路径或尾斜杠 |
| `ALLOW_INSECURE_HTTP` | 空，随公开入口推断 | `PUBLIC_ORIGIN` 为 HTTPS 时使用 HTTPS Cookie。公开入口为空或为 HTTP 时允许 HTTP Cookie。可显式填 `true` 或 `false` |
| `ALLOWED_ORIGINS` | 空 | 可选的额外跨域访问白名单，填精确 Origin 的 JSON 数组，例如 `["https://reader.example.com"]` |

路径支持 `~/`，含空格时可用引号包裹。首次部署需使用尚未创建或为空的数据目录，部署时会按 Go 容器的 `65532:65532` 设置该目录权限。

也可提前将编辑好的 `deploy.env` 放入目标安装目录，再用 `--dir` 选择该目录。已有实例以安装目录中保存的 `deploy.env` 为准。重新运行同一部署命令即可应用这份文件中的网络设置。最初的配置文件仍可通过 `--config` 定位实例。

新建第二个实例时，为它指定独立的安装目录、数据目录、项目名和空闲端口。安装计划会显示配置解析后的宿主机数据目录，部署和状态会显示实际数据位置。安装目录有无关文件、数据目录已被其他实例使用、Docker 资源重名或端口已占用时，脚本会报出冲突。调整配置后重试，端口始终以 `WEB_PORT` 为准。实例初始化后，项目名和数据位置随实例身份固定。

公网可通过宿主机 HTTPS 反向代理接入。设置 `WEB_BIND=127.0.0.1` 和 `PUBLIC_ORIGIN=https://drive.example.com`，将反代目标指向宿主机的 Web 端口并保留原始 Host、转发 HTTPS 协议。WebDAV 与网页使用同一个入口。

### 首次设置和日常管理

部署完成后打开部署输出中的 `/setup` 地址，用下列命令读取初始化令牌并创建管理员。自定义安装目录时，给管理命令传入同一个 `--config` 或 `--dir`。

```bash
bash scripts/deploy-docker.sh token
bash scripts/deploy-docker.sh status
bash scripts/deploy-docker.sh logs --tail 100
bash scripts/deploy-docker.sh stop
```

例如，用自定义配置查看日志时执行 `bash scripts/deploy-docker.sh logs --config ./deploy.env --tail 100`。

更新源码后运行同一条部署命令。镜像构建成功后，脚本会停止本实例，备份 SQLite，再执行迁移并等待 Web 和 Go 就绪。迁移失败时按[迁移与回滚](migration-and-rollback.md)处理。完整备份包括安装目录和实际数据路径。使用单独的数据目录时须单独备份该目录。

已有实例继续使用原来的 Docker 数据卷。保留 `DATA_DIR` 空白或省略该键，部署及 `status` 会列出原卷名称和宿主机挂载路径，备份时需保留该卷。更早期的实例可在原源码目录继续部署，沿用 `.data/docker/runtime.env`，数据库备份仍写入 `.data/docker/backups/`。

## Release 下载版安装与升级

下载版支持 Linux amd64、arm64，使用 SQLite 和本地文件存储。目标机需预装本机 Docker Engine、Docker Compose >=2.20，以及 Bash、curl、GNU tar/coreutils、gzip、sha256sum、flock。当前账号应有 Docker 权限；脚本不安装系统软件、不自动提权，不需要源码、Git、Go、Node 或 pnpm。

### 安装当前正式版

在服务器上执行以下命令，GitHub 上的安装器会下载配套镜像并导入本地 Docker。安装参数直接跟在 `install` 后面，脚本自动生成实例配置。

```bash
(set -o pipefail; curl -fsSL --proto '=https' --proto-redir '=https' \
  https://github.com/reina0721/neocloud/releases/latest/download/install.sh | \
  bash -s -- install --dir "$HOME/clouddrive" --bind 0.0.0.0 --port 4180)
```

打开 `http://服务器IP:4180/setup`，使用 `~/clouddrive/.control/setup-token` 创建管理员。示例显式指定 `4180`。现有正式安装器的默认端口为 `4173`。

| 项目 | 上例的实际位置或名称 |
| --- | --- |
| 安装目录和管理入口 | `~/clouddrive/`，日常管理使用其中的 `install.sh` |
| 数据与备份 | `~/clouddrive/data/` 保存 `app.db`、`storage/`、`transfers/`，挂载到容器内 `/app/.data`。备份写入 `~/clouddrive/backups/` |
| Compose 项目 | `clouddrive-<安装目录 SHA-256 的前 12 位>`，以解析后的绝对路径派生 |
| 容器和网络 | `<项目>-backend-1`、`<项目>-web-1`、`<项目>_default` |
| 镜像 | `clouddrive-api:<版本>-<架构>`、`clouddrive-web:<版本>-<架构>` |
| 端口 | 宿主机 `0.0.0.0:4180` 映射到 Web 容器 `4173/tcp`。Go 的 `8080` 和 `9090` 在容器网络内 |

通过本机 HTTPS 反代公开时，在同一安装命令中使用 `--bind 127.0.0.1 --port 4180 --public-url https://drive.example.com`。让代理将该域名转发到 `127.0.0.1:4180`，保留原始 Host 并转发 HTTPS 协议。浏览器和 WebDAV 共用这个公开地址。

### 自定义实例与安装检查

带有 `INSTANCE_LAYOUT=1` 安装包的新版本发布后，可在同一条在线命令指定项目名、安装目录及数据目录。使用 `v0.2.2` 时，沿用上节的命令和目录规则。

```bash
(set -o pipefail; curl -fsSL --proto '=https' --proto-redir '=https' \
  https://github.com/reina0721/neocloud/releases/latest/download/install.sh | \
  bash -s -- install --name cloud-main --dir /opt/clouddrive \
    --data-dir /mnt/data/cloud-main --bind 0.0.0.0 --port 4180)
```

| 参数 | 本例结果 |
| --- | --- |
| `--name cloud-main` | Compose 项目 `cloud-main`，容器 `cloud-main-backend-1`、`cloud-main-web-1`，网络 `cloud-main_default`，用于保留实例名称的 Docker 卷 `cloud-main-instance` |
| `--dir /opt/clouddrive` | 管理脚本、配置、备份和部署记录保存在 `/opt/clouddrive`，首次设置令牌在 `/opt/clouddrive/.control/setup-token` |
| `--data-dir /mnt/data/cloud-main` | 将这个专用目录挂载到容器内的 `/app/.data`，存放 SQLite、文件和传输暂存 |
| `--bind 0.0.0.0 --port 4180` | 宿主机 `0.0.0.0:4180` 到 Web 容器 `4173/tcp`，通过 `http://服务器IP:4180/setup` 初始化 |

项目名以小写字母或数字开头，最多 40 个字符，可含小写字母、数字、下划线和短横线。省略 `--name` 时，从安装目录派生项目名。相同版本和架构的实例共用镜像 `clouddrive-api:<版本>-<架构>` 和 `clouddrive-web:<版本>-<架构>`。

自定义布局的实例通过 `<项目>-instance` 卷保留名称。即使停止或移除了容器，这个名称仍归原实例。新增另一个实例时显式指定新的 `--name`。

省略 `--data-dir` 时，数据保存在安装目录的 `data/`。相对数据路径以安装目录为基准，可以指向其中的子目录或单独的宿主机目录。首次安装可创建专用目录，或使用预先创建的空目录，运行安装的账号需要有相应写入权限。使用独立数据盘时选挂载点下的子目录，例如 `/mnt/data/cloud-main`。数据目录不能是挂载点本身、安装目录或它的上级。项目名与解析后的数据位置在安装后固定。后续升级和运维始终使用实例记录中的真实路径，不能通过替换符号链接切换存储位置。

- 把命令中的 `install` 换成 `plan`，可查看名称、路径和端口映射，无需连接 Docker 或写入安装目录。固定 `--version` 或指定 `--release-dir` 可离线预览，默认在线解析最新正式版本。
- 换成 `plan --check` 会用本机 Docker 和 iproute2 的 `ss` 检查实际冲突，检查过程不写入实例状态。正式安装也会在下载镜像前检查项目名、数据目录和监听端口。报错会指出冲突资源和对应参数。按需调整 `--name`、`--dir`、`--data-dir`、`--bind` 或 `--port` 后重试，项目名和端口以命令中的值为准。

### 安装向导

```bash
curl -fL --proto '=https' --proto-redir '=https' \
  https://github.com/reina0721/neocloud/releases/latest/download/install.sh | bash
```

向导询问安装目录、监听地址和端口，默认 `~/clouddrive`、`0.0.0.0:4173`。确认安装时也可选择启用网页运维。安装器解析最新正式 Release，固定版本下载配套产物、检查摘要和镜像身份，执行 `docker image load`、数据库迁移、启动及就绪检查。下载与导入阶段显示进度，低速停滞会有界重试；下载失败不会停止已有服务。

安装后访问 `http://服务器地址:4173/setup` 创建自己的管理员。设置令牌位于安装目录 `.control/setup-token`（0600），脚本仅提示路径，没有默认管理员或预置密码。HTTP 是该 Docker 配置的明确默认选择；Go 的通用 Cookie 策略默认值仍保留 HTTPS 保护。API 8080、management 9090 只在容器网络内，宿主机只发布 Web 端口。

网络接入由项目外部管理。应用安装不询问公网 IP、域名或外部端口。

### 自动化与离线安装

显式 `install` 使用非交互模式。要复现同一次安装，可将脚本 URL 和 `--version` 固定到同一版本。需要并行运行第二个实例时，指定独立安装目录和空闲端口。

```bash
(set -o pipefail; curl -fsSL --proto '=https' --proto-redir '=https' \
  https://github.com/reina0721/neocloud/releases/download/v0.2.2/install.sh | \
  bash -s -- install --dir "$HOME/clouddrive-two" --bind 127.0.0.1 --port 44173 --version v0.2.2)
```

离线时，从同一 Release 拷贝对应架构的 `clouddrive_vX.Y.Z_linux_amd64_docker.tar.gz` 或 `clouddrive_vX.Y.Z_linux_arm64_docker.tar.gz`、`checksums.txt`、`version.txt`，添加 `--release-dir /path/to/assets`。可以用 `--version` 替代 `version.txt`。目标机不拉取镜像仓库，也不编译源码。

### 管理和更新

以下示例使用默认目录，自定义目录时替换路径。脚本根据自身位置定位实例，无须先 `cd`：

```bash
~/clouddrive/install.sh                 # 管理菜单
~/clouddrive/install.sh status
~/clouddrive/install.sh logs --tail 100
~/clouddrive/install.sh logs -f
~/clouddrive/install.sh check-update
~/clouddrive/install.sh upgrade         # update 是同义命令
~/clouddrive/install.sh upgrade --version v0.2.2
~/clouddrive/install.sh backup
~/clouddrive/install.sh stop
~/clouddrive/install.sh start
~/clouddrive/install.sh restart
```

`restart` 会应用修改后的配置并检查就绪状态。常规 CLI 升级成功后同时更新实例管理脚本。启用网页运维的实例使用独立安装的宿主维护工具。相同版本不会重复迁移。重复安装不重建已有实例，目标目录非空且无实例标记时拒绝接管。不同实例使用独立 Compose project、配置和数据目录。

主目录结构：

```text
clouddrive/
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

安装包保持 `FORMAT=1`、`NETWORK=1` 和原五项文件集合。`ENTRYPOINT=1` 表示支持无固定外部地址的 Web 入口，`INSTANCE_LAYOUT=1` 表示支持自定义项目名或数据目录。升级沿用已有实例的布局，并在停服前校验目标版本是否支持已用能力。签名、SBOM 与维护者发布验收见[发布说明](release.md)。

### 数据与升级失败

宿主机数据目录持久化数据库、文件和传输暂存，默认是安装目录中的 `data/`。容器内统一挂载到 `/app/.data`。`runtime.env` 保留应用配置与设置令牌，`.control/` 记录实例身份和当前版本，`releases/` 保留已校验的 Compose 与镜像清单。

升级先完成下载、摘要及配套镜像校验，再停止前后端，等待退出，备份 SQLite 主文件、存在的 WAL/SHM 及配置，然后执行目标镜像的迁移和严格兼容检查，最后启动并核对 `/readyz` 和 `/build` 版本。启动检查默认等待 120 秒，可通过 `--wait-timeout 180` 调整（5–600 秒）。

备份位于安装目录的 `backups/时间戳/`，包含 `database.tar`、`runtime.env`、原版本、实例标记和校验和。文件 Blob 留在数据目录中的 `storage/`，整机恢复须同时备份安装目录和实际数据目录。

下载或校验失败不会停止服务。备份失败不会执行目标迁移。后续失败会保留数据、候选版本和备份；只有旧镜像报告各迁移集精确兼容时才恢复旧服务。否则停止自动回退，按[迁移与回滚](migration-and-rollback.md)选择 forward-fix 或经所有者确认的备份恢复，不执行自动 `down`、删除版本记录或覆盖数据库。恢复前先停止实例、另存失败现场并校验备份，不在运行中的数据库上解包。

首次初始化失败的目录保留安装器标记，可以使用相同安装命令重试；dirty migration 等数据库问题仍必须先按迁移规范解决。任意管理操作均使用实例锁，拒绝并发安装、备份或升级。

## 网页运维

发布附件包含同版本、同架构的 `clouddrive-maintenance_…` 后，Linux systemd 上的安装器托管实例可以启用。网页运维需要 Docker Compose 2.24.4 或更新版本，以便单独替换 Web 发布端口。宿主机需能访问本机 Docker，安装账户需有对应权限，启用时需要 sudo 或 root。安装 [发布验证所用的 cosign](release.md#docker-下载产物)，并让安装账户可以在 PATH 找到它。

```bash
# 已有实例先用旧管理脚本升级到配套的正式版。
~/clouddrive/install.sh enable-web-management
# 新实例可在向导选择启用，或给 install 子命令加 --enable-web-management。
```

启用会短暂停服。宿主网关接管原 Web 地址和端口，Web Host 改在独立的宿主机回环端口监听。系统工具的运行状态页通过当前 IAM 系统所有者会话打开 `/maintenance`。停服期间也可直接打开同一个地址。API、DAV 和 WOPI 在业务暂不可用时返回 503 和重试提示。

远程维护写操作走 HTTPS。已有 TLS 反向代理时，先让 `runtime.env` 的 `PUBLIC_ORIGIN` 等于外部 HTTPS Origin，再给启用命令加 `--trusted-proxy <代理直接连接网关的IP>`。代理应保留 Host 并覆盖 `X-Forwarded-Proto` 为 `https`。直连回环 HTTP 可用于本机运维。工作区不可用时，从宿主机读取 `.control/maintenance/recovery-token`，在同址维护页建立短期恢复会话。妥善保护这个恢复凭据。

- 检查正式版可查看目标版本、发布说明和更新历史。每个实例一次运行一个维护任务，刷新维护页可以重新查看任务。
- 升级先从 GitHub 校验签名并导入配套镜像，再停服复制完整恢复点。移除旧镜像前，确认所需恢复点仍有对应的本地镜像。宿主机可将经签名的正式包与校验附件放在 `.control/maintenance/assets/<版本>/` 供离线校验和导入。
- `backups/full-<编号>/` 保存 SQLite、文件、传输暂存、应用配置与版本清单。创建恢复点会停服，并需要足够空间写入压缩档案。旧 CLI 生成的 SQLite 备份继续适用于人工流程。
- 兼容回退使用上一套程序及当前数据。恢复完整备份会重新启用当时的数据和应用配置。确认前核对备份时间和恢复点编号。恢复通过同一文件系统上的重命名切换数据目录。使用默认数据目录时，原数据保留在安装目录的 `.control/maintenance/restore-<任务编号>/original-data`。使用自定义数据目录时，原数据保留在该目录旁的 `.clouddrive-restore-<任务编号>/original-data`。宿主网关配置、恢复凭据和任务记录仍在原处。
- CLI 的 `check-update`、`upgrade`、`backup`、`rollback` 和 `restore --backup-id <编号> --confirm-restore <编号>` 使用相同执行路径。systemd 用安装目录派生的维护标记命名 `<维护标记>-gateway.service` 和 `<维护标记>-maintenance.service`。Compose 容器名使用 `--name`。任务失败的详细阶段可在维护服务的宿主日志中查看。

## 构建与进程

从仓库根目录使用 Go 1.26.11 或更新版本和 Node 24 执行：

```bash
node scripts/build.mjs
```

工具使用锁定版本的 pnpm。Windows 直接生成 ZIP。Linux 使用系统 `tar` 按本机架构生成 tar.gz，分别在 amd64 和 arm64 环境运行构建以取得相应包。解包后在 `clouddrive` 目录启动各自的进程。Windows 示例：

```powershell
.\clouddrive.exe config init
.\clouddrive.exe db migrate up
.\clouddrive.exe
# 另开终端，仍在解包后的 clouddrive 目录
node start-web.mjs
```

首次设置前通过实例配置或进程环境提供设置令牌。已有实例升级时继续从原工作目录启动 Go，以便使用现有配置、数据库和文件位置。Web Host 只需 Node 24，可用 `CLOUDDRIVE_BACKEND_URL` 指向 Go 服务。Windows 的 `start-web.mjs` 在解包目录内恢复 Next 的依赖目录链接。Linux 可用相同的 Web 启动命令，Go 文件名为 `clouddrive`。

单独构建两端或为容器构建标准 Next 输出时，仍可执行：

```bash
go build -trimpath -buildvcs=false -o dist/clouddrive ./cmd/app
pnpm --dir frontend build
pnpm --dir frontend standalone:check
```

Go 二进制独立运行，数据库迁移在启动或升级前显式执行。前端默认 server 模式产出 `frontend/apps/web/dist/standalone/`，包含编译页面、依赖、静态资源和本地 PDF 组件。将完整目录部署到带 Node 24 的目标机器，由 Web Host 入口接收公开请求。HTTPS 反向代理部署可为 Web Host 设置 `CLOUDDRIVE_PUBLIC_ORIGIN`，与 Go 的 `files.connections.publicOrigin` 一致，以解析使用绝对目标地址的 DAV 复制和移动请求。Compose 从 `PUBLIC_ORIGIN` 给两个服务传入同一个值。

```bash
CLOUDDRIVE_BACKEND_URL=http://127.0.0.1:8080 HOSTNAME=127.0.0.1 PORT=4173 \
  node frontend/apps/web/dist/standalone/apps/web/runtime/start-web.mjs
```

PowerShell 对应设置 `$env:CLOUDDRIVE_BACKEND_URL`、`$env:HOSTNAME`、`$env:PORT` 后执行同一个入口。`PORT` / `HOSTNAME` 属于 standalone 进程，开发期的 `WEB_PORT` 不用于配置这个入口。

`CLOUDDRIVE_BACKEND_URL` 在服务端处理请求时读取，同一份产物可在不同环境连接不同 Go 服务。值必须是 HTTP(S) 根 Origin，不含路径、凭据、query 或 fragment；默认 `http://127.0.0.1:8080`。Host 的 Next Proxy 转发 `/api/`、`/wopi/`、`/dav/`、`/management/`；它校验浏览器 Host/Origin 并将合法同源请求规范化为内部同源。请求体、Cookie、CSRF、范围响应与取消语义保留，Go 继续执行认证授权。此变量不进入浏览器公开配置。`NEXT_PUBLIC_*` 仍属于构建期参数，不能在运行时切换认证产品形态。

根 `Dockerfile` 仅构建 Go 镜像；`frontend/Dockerfile` 的运行层只复制上述独立产物，以 node 用户运行，默认监听 `0.0.0.0:4173`。构建上下文排除 `.env`、本地数据和依赖目录。镜像内默认后端为 `http://backend:8080`，通过运行时环境变量指向同一私有网络中的 Go 服务，无需为后端地址重新构建镜像。完整容器构建入口见[构建与容器](build-and-container.md)。

`standalone:check` 把产物复制到仓库外，启动两个不同上游的传输夹具，检查依赖闭包、页面资源、Cookie/CSRF 透传、POST 请求体、范围字节及本地 PDF worker。它不代替真实 Go 会话、文件写入或线上代理验收。容器构建同样执行该检查；CI 分别构建 Go 与 Web 镜像。

静态导出模式仍生成静态站点，包含资源但不包含 Node Proxy；API 必须由部署方的同源反向代理提供。上述 standalone 启动与检查只适用于默认 server 模式。


## 站点信息

在「系统配置 → 站点信息」填写名称、描述、浅色和深色标志、浏览器图标、使用条款和隐私政策链接。保存后当前页面立即更新，其他浏览器下次加载时读取新值。留空可恢复默认名称、图形或浏览器标题，也可隐藏相应链接。深色标志留空时沿用浅色标志。

所有字段均对访客公开。图片和条款链接使用 HTTPS 或以单个斜杠开头的站内路径。浏览器直接请求图片，Go 服务不代理图像。

需要由公网域名生成分享、直链或文档回调时，先在 `console.siteOrigins` 登记转发到同一实例的根地址，再到「站点地址」保存主站及最多八个备选站点。分享和直链在主站或备选站点访问时沿用该地址，其他访问来源生成主站链接。外部阅读器和 WOPI 回调始终使用主站地址。清空后沿用浏览器当前地址。反向代理需要在主站转发相应的网页、公开 API 和 `/wopi/` 路径。

## 数据库与调度

将已有本地数据迁入容器时，保持存储位置标识和访问路径稳定。系统会把本地存储的绝对路径与文件元数据绑定；直接把原目录挂到另一个路径，会触发内容迁移保护并拒绝启动。本地验收沿用原绝对路径作为容器挂载目标与工作目录，使用可读写该目录的非 root UID，数据库和文件保持原样。需要改变存储位置时，应先完成明确的内容迁移。

默认 SQLite，数据保存在 `.data/`。MySQL/PostgreSQL 通过 driver/DSN 指定并执行 `db migrate up`。三种方言都使用同一组模块迁移。升级前备份数据库，迁移失败或存在 dirty 记录时，按迁移工具流程恢复。

scheduler.enabled 默认 true；任务定义与下次运行时间保存在数据库，重启后重新加载。关闭调度器会保留任务并停止派发。任务由既有 execution 生命周期执行；每次执行重新检查账号状态与权限，执行权通过版本比较领取，避免重复派发。当前本地调度适用于单个后端实例；多实例上线前配置并验证既有协调能力。

API 请求默认禁止私网、loopback、链路本地及元数据地址，重定向和 DNS 解析逐次验证。确需访问内部 API 时，管理员在 console.relay.allowedOrigins 中按协议、主机、端口显式许可，不接受来自浏览器的任意放行规则。默认最长30秒、响应体2MiB、请求体1MiB；服务端不执行任意 JavaScript。带脚本/提取器的集合不能新建服务端任务。UA/自定义允许头可用；代理和 TLS 指纹当前不支持，UI 禁用且接口返回 unsupported。
