# CloudDrive Docker 安装与管理

## Release 下载版安装与升级

下载版支持 Linux amd64、arm64，使用 SQLite 和本地文件存储。目标机需预装本机 Docker Engine、Docker Compose >=2.20，以及 Bash、curl、GNU tar/coreutils、gzip、sha256sum、flock。当前账号应有 Docker 权限；脚本不安装系统软件、不自动提权，不需要源码、Git、Go、Node 或 pnpm。

### 安装当前正式版

从公开 `latest` 下载脚本，再用显式子命令启动安装。下例只开放服务器本机访问。

```bash
curl -fL --proto '=https' --proto-redir '=https' \
  https://github.com/reina0721/neocloud/releases/latest/download/install.sh -o install.sh
bash install.sh install --dir "$HOME/clouddrive" --bind 127.0.0.1
```

从 `http://127.0.0.1:4173/setup` 使用 `~/clouddrive/.control/setup-token` 创建管理员。旧版本的非回环访问需要显式指定外部 Origin 和 HTTP 策略。以下安装向导与新增命令取决于目标 Release 的安装器。

### 安装向导

```bash
curl -fL --proto '=https' --proto-redir '=https' \
  https://github.com/reina0721/neocloud/releases/latest/download/install.sh | bash
```

向导询问安装目录、监听地址和端口，默认 `~/clouddrive`、`0.0.0.0:4173`。确认安装时也可选择启用网页运维。安装器解析最新正式 Release，固定版本下载配套产物、检查摘要和镜像身份，执行 `docker image load`、数据库迁移、启动及就绪检查。下载与导入阶段显示进度，低速停滞会有界重试；下载失败不会停止已有服务。

安装后访问 `http://服务器地址:4173/setup` 创建自己的管理员。设置令牌位于安装目录 `.control/setup-token`（0600），脚本仅提示路径，没有默认管理员或预置密码。HTTP 是该 Docker 配置的明确默认选择；Go 的通用 Cookie 策略默认值仍保留 HTTPS 保护。API 8080、management 9090 只在容器网络内，宿主机只发布 Web 端口。

网络接入由项目外部管理。应用安装不询问公网 IP、域名或外部端口。

### 自动化与离线安装

```bash
curl -fL https://github.com/reina0721/neocloud/releases/latest/download/install.sh -o install.sh
bash install.sh install --dir "$HOME/clouddrive" --port 4173 --yes
# 固定版本、监听地址或使用独立实例目录
bash install.sh install --dir "$HOME/clouddrive-two" --bind 127.0.0.1 --port 44173 --version v0.2.2 --yes
```

显式 `install` 保持非交互行为；`--yes` 也支持省略 `install`。管道安装通过 `/dev/tty` 交互；没有终端且未明确使用命令或 `--yes` 时立即提示用法，不等待输入。

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

安装包保持 `FORMAT=1`、`NETWORK=1` 和原五项文件集合；`ENTRYPOINT=1` 表示支持无固定外部地址的 Web 入口。旧安装器可以升级到新包；新安装器拒绝把自动入口实例更新到缺少该能力的包。签名、SBOM 与维护者发布验收见[发布说明](release.md)。

### 数据与升级失败

安装目录中的 `data/` 持久化数据库、文件和传输暂存；所有版本保持容器内 `/app/.data` 的挂载目标及工作目录不变。`runtime.env` 保留用户配置与设置令牌，`.control/` 记录当前版本和实例标记，`releases/` 保留已校验的 Compose 与镜像清单。

升级先完成下载、摘要及配套镜像校验，再停止前后端，等待退出，备份 SQLite 主文件、存在的 WAL/SHM 及配置，然后执行目标镜像的迁移和严格兼容检查，最后启动并核对 `/readyz` 和 `/build` 版本。启动检查默认等待 120 秒，可通过 `--wait-timeout 180` 调整（5–600 秒）。

备份位于 `backups/时间戳/`，包含 `database.tar`、`runtime.env`、原版本、实例标记和校验和。文件 Blob 留在原 `data/storage`，不在每次升级时重复复制全部大文件；外部灾难恢复仍需要独立的文件内容备份。

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
- 兼容回退使用上一套程序及当前数据。恢复完整备份会重新启用当时的数据和应用配置。确认前核对备份时间和恢复点编号。恢复通过原子重命名切换目录，实例数据与恢复目录需要在同一个文件系统。原数据保留在 `.control/maintenance/restore-<任务编号>/`，宿主网关配置、恢复凭据和任务记录继续生效。
- CLI 的 `check-update`、`upgrade`、`backup`、`rollback` 和 `restore --backup-id <编号> --confirm-restore <编号>` 使用相同执行路径。服务名按实例标记命名为 `<实例标记>-gateway.service` 和 `<实例标记>-maintenance.service`。任务失败的详细阶段可在后一个服务的宿主日志中查看。

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
