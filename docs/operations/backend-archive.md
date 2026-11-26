# CloudDrive 独立 Go 后端归档

此说明随 Go 下载归档交付。归档包含后端程序、示例配置、默认语言资源、OpenAPI、来源及许可。Next.js Web Host 需要单独部署。

需要完整文件工作区时，优先使用 [GitHub Release 的 Docker 安装包](https://github.com/reina0721/neocloud/releases/latest)。源码与贡献方式见 [CloudDrive 仓库](https://github.com/reina0721/neocloud)。

## 运行后端

解压到独立目录，先审阅配置。正式接入前按[部署说明](https://github.com/reina0721/neocloud/blob/main/docs/operations/clouddrive-deployment.md)设置认证、数据库、存储和受信监听范围；management 端口仅供受信网络使用。在线文档可在 GitHub 选择与归档对应的 tag 阅读。

```bash
./clouddrive --help
cp config.example.yaml config.yaml
mkdir -p -m 700 .data
# 按实际环境修改 config.yaml，再运行迁移与服务
./clouddrive db migrate up
./clouddrive
```

Windows PowerShell 使用 `Copy-Item config.example.yaml config.yaml` 复制配置，预先准备受当前账号保护的 `.data` 目录，并通过 `.\clouddrive.exe` 执行相同命令。所有命令从解压目录运行，保留语言文件的相对路径。已有实例的配置、数据库、用户文件和存储身份必须保留；升级前备份，不用新示例覆盖实际配置。

## 使用原生托管版自动下载和换版

正式版附件名为 `clouddrive_<tag>_<os>_<arch>_managed-go.zip`，覆盖 Windows amd64、Linux amd64 与 Linux arm64。从已验签的附件取得 `clouddrive-host` 和 `clouddrive`，将宿主放在稳定的程序目录。实例根目录继续保存 `config.yaml`、语言资源和既有相对数据路径。新实例按上面的步骤初始化并执行首次迁移，已有实例继续使用原配置和数据。

首次切换到托管运行时，先正常停止独立 Go 服务并释放原 API 和管理端口。用原服务账号启动宿主，沿用实例原有环境变量。后续服务启动可以省略 `--initial`，由宿主读回上次提交的版本。

```bash
./clouddrive-host --root /srv/clouddrive --initial "<已发布的托管版 tag>"
```

本地已准备签名附件时，可在首次启动另加 `--release-dir` 与 `--trust-dir`。附件目录包含目标 ZIP、`checksums.txt` 与 `checksums.txt.sigstore.json`，信任目录单独准备 Sigstore TUF 信任材料。在线引导直接从 GitHub 获取当前平台的签名附件。Linux 可用 systemd 管理稳定宿主。Windows 提供相同 CLI，程序名加 `.exe`，也可由 Windows 服务控制管理器启动 `CloudDriveNative`。

使用同一实例路径执行更新。命令通过本机 Unix socket 或 Windows 命名管道访问宿主，账号需有该实例的控制权限。

```bash
./clouddrive update check --root /srv/clouddrive
./clouddrive update apply --root /srv/clouddrive
./clouddrive update status --root /srv/clouddrive
./clouddrive update cancel --root /srv/clouddrive
./clouddrive update rollback --root /srv/clouddrive
```

`check` 返回最新 GitHub 正式版和平台候选。默认 `apply` 从最新的三个候选中验签后选择声明了当前版本与提交的发行包，也可通过 `--version vX.Y.Z` 指定候选。如果已登记扩展迁移，重新执行 `apply` 会继续同一候选。下载、校验和迁移可请求取消，正式交接阶段须等待结果。事务进入交接后，未获准入的请求最多等待 5 秒，排队上限 128。超出预算的请求返回 HTTP 503 与 `Retry-After`。

版本、签名材料、状态数据库和迁移恢复点保存在实例目录下的 `.native-upgrade/`。更新期间保持实例数据和环境配置一致。候选核对运行进程启动时的配置快照。热重载后若提示配置不匹配，请在运维窗口重启托管服务以采用新快照，再提交更新。回退会启动兼容的上一个二进制，并保留数据库扩展及已写入的数据。需要还原备份时，由运维单独决定恢复点和影响范围。[在线迁移与回滚](https://github.com/reina0721/neocloud/blob/main/docs/operations/migration-and-rollback.md)

## 校验与许可

归档随 Release 提供 SHA-256 清单、SPDX SBOM 和签名 bundle，验证方式见[发布说明](https://github.com/reina0721/neocloud/blob/main/docs/operations/release.md)。Go 归档与配套 Web Host 应来自同一版本和 source commit。

项目许可见归档根 `LICENSE` 和 `NOTICE`；依赖许可及需要附带的源码保留在 `third-party/`，来源快照见 `SOURCES.json`。使用问题见[支持指南](https://github.com/reina0721/neocloud/blob/main/SUPPORT.md)，潜在漏洞见[安全政策](https://github.com/reina0721/neocloud/blob/main/SECURITY.md)。
