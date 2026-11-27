# NeoCloud 原生部署与独立 Go 后端

GitHub 正式版提供三类原生包。部署完整文件工作区请选择 `_managed-full.zip`，由 Go 宿主提供网页、API 和 WebDAV，目标机无需 Docker、Go、Node.js 或 pnpm。`_managed-go.zip` 适合有独立 Web Host 的托管后端。其余 Go 归档包含独立后端、示例配置、语言资源和 OpenAPI。[GitHub 正式发布](https://github.com/reina0721/neocloud/releases/latest)

## 运行原生 Go 与 Web 整包

示例固定为 `v0.4.0`，适用于按 NeoCloud 格式初始化的实例。安装前从 Sigstore 获取对应平台的 Cosign 2.6.5 或验证兼容的更新版本，加入 `PATH` 后执行 `cosign version` 确认可用。下载 ZIP 和校验附件时使用同一个正式标签。先验证校验清单的签名，再核对 ZIP 的 SHA-256，最后解包运行。已有 NeoCloud 实例可以使用[更新、备份与恢复](#更新与备份恢复)。[Cosign 安装说明](https://docs.sigstore.dev/cosign/system_config/installation/)

| 目标机 | v0.4.0 整包 |
| --- | --- |
| Windows amd64 | `neocloud_v0.4.0_windows_amd64_managed-full.zip` |
| Linux amd64（`x86_64`） | `neocloud_v0.4.0_linux_amd64_managed-full.zip` |
| Linux arm64（`aarch64`） | `neocloud_v0.4.0_linux_arm64_managed-full.zip` |

### Linux Bash

需要 Bash、curl、unzip、sha256sum 和系统常用工具。用计划运行服务的普通账号执行。示例将下载附件放在 `~/neocloud-native-assets/v0.4.0/`，程序、配置和数据放在 `~/neocloud-native/`。

```bash
(
  set -euo pipefail
  umask 077
  tag=v0.4.0
  case "$(uname -m)" in
    x86_64) arch=amd64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) printf '该架构没有 Linux 原生整包\n' >&2; exit 1 ;;
  esac
  zip="neocloud_${tag}_linux_${arch}_managed-full.zip"
  assets="$HOME/neocloud-native-assets/$tag"
  root="$HOME/neocloud-native"
  test ! -e "$root" && test ! -L "$root" || { printf '实例目录已存在\n' >&2; exit 1; }
  install -d -m 700 "$assets"
  cd "$assets"
  for asset in "$zip" checksums.txt checksums.txt.sigstore.json; do
    curl --fail --location --proto '=https' --proto-redir '=https' \
      "https://github.com/reina0721/neocloud/releases/download/$tag/$asset" -o "$asset"
  done
  cosign verify-blob --new-bundle-format --bundle checksums.txt.sigstore.json \
    --certificate-identity "https://github.com/reina0721/neocloud/.github/workflows/release.yml@refs/tags/$tag" \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com checksums.txt
  awk -v file="$zip" '$2 == file {print; count++} END {if (count != 1) exit 1}' checksums.txt | sha256sum --check
  mkdir -m 700 "$root"
  unzip -q "$zip" -d "$root"
  cd "$root"
  cp config.example.yaml config.yaml
  mkdir -m 700 .data
  od -An -N32 -tx1 /dev/urandom | tr -d ' \n' > .data/setup-token
  export NEOCLOUD_APP_IAM__LOCAL__SETUPTOKEN="$(cat .data/setup-token)"
  export NEOCLOUD_APP_IAM__LOCAL__ALLOWINSECUREHTTP=true
  ./neocloud db migrate up
  ./neocloud db migrate status
  ./neocloud-host --full --root "$root" --initial "$tag"
)
```

### Windows PowerShell

需要 64 位 Windows 和 PowerShell。用计划运行服务的账号执行，将文件保存在该账号可完整读写的本地目录。可用 `Get-Command cosign -ErrorAction Stop` 检查 `PATH`。

```powershell
& {
    $ErrorActionPreference = 'Stop'
    $tag = 'v0.4.0'
    $zip = "neocloud_${tag}_windows_amd64_managed-full.zip"
    $assets = Join-Path $env:LOCALAPPDATA "NeoCloud-assets\$tag"
    $root = Join-Path $env:LOCALAPPDATA 'NeoCloud-native'
    if (Test-Path -LiteralPath $root) { throw '实例目录已存在' }
    New-Item -ItemType Directory -Force -Path $assets | Out-Null
    foreach ($asset in @($zip, 'checksums.txt', 'checksums.txt.sigstore.json')) {
        Invoke-WebRequest -UseBasicParsing `
            -Uri "https://github.com/reina0721/neocloud/releases/download/$tag/$asset" `
            -OutFile (Join-Path $assets $asset)
    }
    $manifest = Join-Path $assets 'checksums.txt'
    $bundle = Join-Path $assets 'checksums.txt.sigstore.json'
    $identity = "https://github.com/reina0721/neocloud/.github/workflows/release.yml@refs/tags/$tag"
    cosign verify-blob --new-bundle-format --bundle $bundle --certificate-identity $identity `
        --certificate-oidc-issuer https://token.actions.githubusercontent.com $manifest
    if ($LASTEXITCODE -ne 0) { throw '签名验证失败' }
    $digestLine = @(Get-Content -LiteralPath $manifest | Where-Object { ($_ -split '\s+', 2)[1] -ceq $zip })
    $archive = Join-Path $assets $zip
    $actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash
    if ($digestLine.Count -ne 1 -or ($digestLine[0] -split '\s+')[0] -ne $actual) {
        throw 'ZIP SHA-256 不匹配'
    }
    Expand-Archive -LiteralPath $archive -DestinationPath $root
    Push-Location -LiteralPath $root
    $previousToken = $env:NEOCLOUD_APP_IAM__LOCAL__SETUPTOKEN
    $previousHTTP = $env:NEOCLOUD_APP_IAM__LOCAL__ALLOWINSECUREHTTP
    try {
        Copy-Item config.example.yaml config.yaml
        New-Item -ItemType Directory .data | Out-Null
        $random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
        try {
            $bytes = New-Object byte[] 32
            $random.GetBytes($bytes)
        } finally { $random.Dispose() }
        $token = [BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()
        Set-Content -LiteralPath .data/setup-token -Value $token -Encoding Ascii -NoNewline
        $env:NEOCLOUD_APP_IAM__LOCAL__SETUPTOKEN = $token
        $env:NEOCLOUD_APP_IAM__LOCAL__ALLOWINSECUREHTTP = 'true'
        .\neocloud.exe db migrate up
        if ($LASTEXITCODE -ne 0) { throw '数据库迁移失败' }
        .\neocloud.exe db migrate status
        if ($LASTEXITCODE -ne 0) { throw '数据库迁移状态检查失败' }
        .\neocloud-host.exe --full --root $root --initial $tag
        if ($LASTEXITCODE -ne 0) { throw '原生宿主启动失败' }
    } finally {
        $env:NEOCLOUD_APP_IAM__LOCAL__SETUPTOKEN = $previousToken
        $env:NEOCLOUD_APP_IAM__LOCAL__ALLOWINSECUREHTTP = $previousHTTP
        Pop-Location
    }
}
```

### 首次设置与日常启动

迁移完成时，`db migrate status` 应显示 `compatible: true`，各迁移集 `current` 等于 `target` 且 `dirty: false`。宿主在线验签并启动后，从本机访问 `http://127.0.0.1:8080/setup`，读取实例目录 `.data/setup-token` 中的令牌，创建首位管理员。Linux 可在另一终端运行 `cat "$HOME/neocloud-native/.data/setup-token"`，Windows 使用 `Get-Content -LiteralPath "$env:LOCALAPPDATA\NeoCloud-native\.data\setup-token"`。管理员创建后可删除这个令牌文件。已有实例通过 `/login` 登录。[首次使用](https://github.com/reina0721/neocloud/blob/main/docs/getting-started/first-use.md)

在另一终端访问 `http://127.0.0.1:9090/readyz` 检查就绪，访问同一端口的 `/build` 核对实际版本。前台运行时按 Ctrl+C 停止。以后从实例目录运行 `./neocloud-host --root .`，Windows 使用 `.\neocloud-host.exe --root .`。宿主用 Cosign 复核 `.native-upgrade/` 中缓存的当前版本。若继续使用本机 HTTP，在 `config.yaml` 把 `iam.local.allowInsecureHTTP` 改为 `true`，让以后直接启动和系统服务也使用相同的 Cookie 设置。首次登录后上传一个小文件，完成配置并重启，确认可重新登录且下载内容与原文件一致。远程浏览器、公开地址和 HTTPS 反代按同一入口配置，管理端口保持回环监听。[远程访问与 HTTPS](https://github.com/reina0721/neocloud/blob/main/docs/operations/neocloud-deployment.md#远程访问与-https)

首次已经生成配置和令牌、但下载或启动失败时，排除故障后从原目录重试。重新把 `.data/setup-token` 的内容注入 `NEOCLOUD_APP_IAM__LOCAL__SETUPTOKEN`。迁移已经完成时可直接运行前文的 `--full --root … --initial v0.4.0` 启动命令。存在迁移错误时先核对迁移状态。[迁移与回滚](https://github.com/reina0721/neocloud/blob/main/docs/operations/migration-and-rollback.md)

### 启动参数与接管

| 参数或配置 | 默认值与作用 |
| --- | --- |
| `--root DIR` | 默认当前目录。指定保存 `config.yaml`、数据和 `.native-upgrade/` 的实例目录。系统服务使用绝对路径 |
| `--initial vX.Y.Z` | 首次启动、预检或接管的正式标签。普通重启沿用已记录的版本 |
| `--full` | 新建原生整包实例或从独立 Go 服务接入时使用 |
| `--web-addr HOST:PORT` | 首次启动时可指定独立网页监听，如 `127.0.0.1:4180`；省略时使用 `http.addr`。额外监听地址会记录在实例状态中 |
| `http.addr` | 默认 `127.0.0.1:8080`，Go 业务地址，也是默认网页入口。首次托管时保存到实例状态 |
| `management.addr` | 默认 `127.0.0.1:9090`，提供就绪与构建信息等管理接口。首次托管时保存到实例状态 |
| `iam.local.allowInsecureHTTP` | 默认 `false`，采用 HTTPS Cookie。回环 HTTP 示例用环境变量 `NEOCLOUD_APP_IAM__LOCAL__ALLOWINSECUREHTTP=true` 覆盖 |
| `iam.local.setupToken` | 默认空。新实例用随机令牌设定 `NEOCLOUD_APP_IAM__LOCAL__SETUPTOKEN`，创建管理员后即可取消注入 |
| `files.connections.publicOrigin` | 默认空。需要生成外部 WebDAV 地址时填写公开入口的完整 HTTP(S) Origin |
| `NEOCLOUD_COSIGN` | 默认从 `PATH` 查找 `cosign`。服务账号也可用此变量指定可执行文件的绝对路径 |
| `--release-dir DIR`、`--trust-dir DIR` | 成对使用，并显式指定 `--initial`。用于本地签名资产和独立获得的 Sigstore 信任材料 |
| `--prepare-full` | 接管前使用。同一账号可在原服务运行时验签缓存，并只读检查实例配置、数据库和监听地址。预检输出 JSON |
| `--adopt-full` | 仅用于现有 `managed-go` 实例。目标正式整包必须明确匹配当前 Go 版本和源码提交，而且没有迁移步骤 |

已有实例接管前先准备完整备份。用新宿主执行 `--prepare-full --root <实例目录> --initial <正式标签>`。原服务释放端口后，从原目录以相同账号和配置运行 `--full` 或 `--adopt-full`，根据预检结果指定 `--web-addr`。后续启动只使用 `--root`。[迁移与回滚](https://github.com/reina0721/neocloud/blob/main/docs/operations/migration-and-rollback.md)

### Linux systemd

先用同一账号完成首次设置并停止前台进程。在 `config.yaml` 保存所需的 Cookie、日志和部署设置。以下用户级 unit 使用前文的目录。安装 Cosign 到该账号可运行的路径，如 `/usr/local/bin/cosign`。系统会在用户会话启动时加载 unit。服务器需要开机启动且退出会话后继续运行时，用同一账号执行 `sudo loginctl enable-linger "$USER"`，使用户服务管理器随系统启动。[systemd 服务说明](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html)

```bash
mkdir -p "$HOME/.config/systemd/user"
cat > "$HOME/.config/systemd/user/neocloud-native.service" <<'UNIT'
[Unit]
Description=NeoCloud native host

[Service]
WorkingDirectory=%h/neocloud-native
ExecStart=%h/neocloud-native/neocloud-host --root %h/neocloud-native
Environment=NEOCLOUD_COSIGN=/usr/local/bin/cosign
UMask=0077
KillMode=mixed
Restart=on-failure
TimeoutStopSec=60

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now neocloud-native.service
systemctl --user status neocloud-native.service
journalctl --user -u neocloud-native.service -n 100
```

日常以 `systemctl --user stop neocloud-native.service` 停止实例，以 `systemctl --user start neocloud-native.service` 启动。配置改动后用 `restart`，更新状态再检查 `/readyz`。

### Windows 服务

先用实际服务账号完成首次设置并停止前台进程。在 `config.yaml` 保存实际运行配置。需要收集持续日志时，将 `logger.outputPaths` 和 `logger.errorOutputPaths` 指向服务账号可写的绝对文件路径，并先创建日志目录。用管理员 PowerShell 注册服务，使用现有实例的绝对路径和原运行账号。该账号应具有「作为服务登录」权限，服务名默认为 `NeoCloudNative`，也可用 `--service-name` 指定与服务注册一致的名称。将 Cosign 所在目录加入系统 `PATH`，确认服务账号可读取和执行 Cosign。如果 Windows 服务仍读取旧的系统环境，可重启机器后再检查服务。[New-Service](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.management/new-service) · [作为服务登录](https://learn.microsoft.com/en-us/windows/security/threat-protection/security-policy-settings/log-on-as-a-service)

```powershell
$root = Read-Host '输入已初始化实例的绝对路径'
$hostExe = Join-Path $root 'neocloud-host.exe'
if (-not (Test-Path -LiteralPath $hostExe -PathType Leaf)) { throw '找不到原生宿主' }
$credential = Get-Credential -Message '输入原运行账号和密码'
New-Service -Name NeoCloudNative -DisplayName 'NeoCloud Native' `
    -BinaryPathName ('"{0}" --root "{1}"' -f $hostExe, $root) `
    -StartupType Automatic -Credential $credential
Start-Service NeoCloudNative
Get-Service NeoCloudNative
```

通过 `Stop-Service NeoCloudNative`、`Start-Service NeoCloudNative` 或 `Restart-Service NeoCloudNative` 管理实例。启动失败时查询 Windows 事件查看器里的 Service Control Manager 事件，或停止服务后用原账号运行前台命令读取启动错误。检查应用是否就绪仍使用 `/readyz`。

### 离线安装与启动

在可信联网机器完成签名校验，保留对应平台的 `_managed-full.zip`、`checksums.txt` 和 `checksums.txt.sigstore.json`。另用 Cosign 2.6.5 从官方 TUF 镜像导出 `trusted_root.json`。将资产与信任材料放在不同目录，分别转移到目标机。已验签的 ZIP 可在传输前解包，也可在离线目标机用以下校验参数验证清单后对比 ZIP 的 SHA-256。

```bash
(
  set -euo pipefail
  umask 077
  export TUF_ROOT="$(mktemp -d)"
  unset TUF_ROOT_JSON TUF_MIRROR
  cosign initialize --mirror https://tuf-repo-cdn.sigstore.dev
  mkdir -p ./neocloud-trust
  cp "$TUF_ROOT/tuf-repo-cdn.sigstore.dev/targets/trusted_root.json" ./neocloud-trust/
)
```

```powershell
$previousTuf = $env:TUF_ROOT
$previousRoot = $env:TUF_ROOT_JSON
$previousMirror = $env:TUF_MIRROR
try {
    $env:TUF_ROOT = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString())
    Remove-Item Env:TUF_ROOT_JSON, Env:TUF_MIRROR -ErrorAction SilentlyContinue
    cosign initialize --mirror https://tuf-repo-cdn.sigstore.dev
    if ($LASTEXITCODE -ne 0) { throw 'Sigstore 信任初始化失败' }
    $trust = New-Item -ItemType Directory -Force .\neocloud-trust
    Copy-Item -LiteralPath (Join-Path $env:TUF_ROOT 'tuf-repo-cdn.sigstore.dev/targets/trusted_root.json') `
        -Destination $trust.FullName -ErrorAction Stop
} finally {
    $env:TUF_ROOT = $previousTuf
    $env:TUF_ROOT_JSON = $previousRoot
    $env:TUF_MIRROR = $previousMirror
}
```

在离线目标机沿用对应平台安装步骤，从下载后的签名验证开始。给 `cosign verify-blob` 增加 `--offline --trusted-root <信任目录中的 trusted_root.json>`，验证成功后核对 ZIP、解包、配置并执行首次迁移。将首次启动命令改成下列形式，使用各目录实际地址。

```bash
./neocloud-host --full --root . --initial v0.4.0 \
  --release-dir /mnt/transfer/release --trust-dir /mnt/transfer/trust
```

```powershell
.\neocloud-host.exe --full --root . --initial v0.4.0 `
    --release-dir 'D:\transfer\release' --trust-dir 'D:\transfer\trust'
```

宿主缓存已验签版本后，重启和回退可使用该缓存并由 Cosign 在本地复核。在线「检查」和「升级」依赖 GitHub 正式附件。

### 更新与备份恢复

系统所有者在「系统更新」检查版本、升级、取消或兼容回退，整包同时切换 Go 和 Web。也可使用下文的 `neocloud update` 命令。只接受与当前版本和提交匹配的签名候选。迁移、交接阶段和回退条件详见[原生托管实例在线迁移](https://github.com/reina0721/neocloud/blob/main/docs/operations/migration-and-rollback.md#原生托管实例在线迁移)。

默认实例的 SQLite 在 `.data/app.db`，文件在 `.data/storage/`，传输暂存在 `.data/file-transfers/`。备份完整实例时先通过前台 Ctrl+C 或服务管理器停服，等 Go 宿主和业务进程退出。将整个实例目录复制到独立存储，包含 `config.yaml`、`.data/`、语言文件、原始启动程序和隐藏目录 `.native-upgrade/`。若数据库、文件或传输目录在实例外，单独备份对应位置。操作前确认备份能读取，再启动服务。

回退程序版本会保留数据和已提交的兼容迁移。恢复历史数据前，先停服，把当前目录另存为故障现场，在原实例路径恢复配套的配置、数据库、文件和托管状态，并保持原服务账号和存储路径。恢复后检查 `/readyz`、`/build`、管理员登录和抽样文件。如迁移报告 `dirty` 或不兼容，保留现场按迁移说明修复。[迁移与回滚](https://github.com/reina0721/neocloud/blob/main/docs/operations/migration-and-rollback.md) · [所有者账号恢复](https://github.com/reina0721/neocloud/blob/main/docs/getting-started/first-use.md#无法登录)

## 运行后端

解压到独立目录，先审阅配置。正式接入前按[部署说明](https://github.com/reina0721/neocloud/blob/main/docs/operations/neocloud-deployment.md)设置认证、数据库、存储和受信监听范围；management 端口仅供受信网络使用。在线文档可在 GitHub 选择与归档对应的 tag 阅读。

```bash
./neocloud --help
cp config.example.yaml config.yaml
mkdir -p -m 700 .data
# 按实际环境修改 config.yaml，再运行迁移与服务
./neocloud db migrate up
./neocloud
```

Windows PowerShell 使用 `Copy-Item config.example.yaml config.yaml` 复制配置，预先准备受当前账号保护的 `.data` 目录，并通过 `.\neocloud.exe` 执行相同命令。所有命令从解压目录运行，保留语言文件的相对路径。已有实例的配置、数据库、用户文件和存储身份必须保留；升级前备份，不用新示例覆盖实际配置。

## 使用原生托管版自动下载和换版

正式版附件名为 `neocloud_<tag>_<os>_<arch>_managed-go.zip`，覆盖 Windows amd64、Linux amd64 与 Linux arm64。从已验签的附件取得 `neocloud-host` 和 `neocloud`，将宿主放在稳定的程序目录。实例根目录继续保存 `config.yaml`、语言资源和既有相对数据路径。新实例按上面的步骤初始化并执行首次迁移，已有实例继续使用原配置和数据。

首次切换到托管运行时，先正常停止独立 Go 服务并释放原 API 和管理端口。用原服务账号启动宿主，沿用实例原有环境变量。后续服务启动可以省略 `--initial`，由宿主读回上次提交的版本。

```bash
./neocloud-host --root /srv/neocloud --initial "<已发布的托管版 tag>"
```

本地已准备签名附件时，可在首次启动另加 `--release-dir` 与 `--trust-dir`。附件目录包含目标 ZIP、`checksums.txt` 与 `checksums.txt.sigstore.json`，信任目录单独准备 Sigstore TUF 信任材料。在线引导直接从 GitHub 获取当前平台的签名附件。Linux 可用 systemd 管理稳定宿主。Windows 提供相同 CLI，程序名加 `.exe`，也可由 Windows 服务控制管理器启动 `NeoCloudNative`。

使用同一实例路径执行更新。命令通过本机 Unix socket 或 Windows 命名管道访问宿主，账号需有该实例的控制权限。

```bash
./neocloud update check --root /srv/neocloud
./neocloud update apply --root /srv/neocloud
./neocloud update status --root /srv/neocloud
./neocloud update cancel --root /srv/neocloud
./neocloud update rollback --root /srv/neocloud
```

`check` 返回最新 GitHub 正式版和平台候选。默认 `apply` 从最新的三个候选中验签后选择声明了当前版本与提交的发行包，也可通过 `--version vX.Y.Z` 指定候选。如果已登记扩展迁移，重新执行 `apply` 会继续同一候选。下载、校验和迁移可请求取消，正式交接阶段须等待结果。事务进入交接后，未获准入的请求最多等待 5 秒，排队上限 128。超出预算的请求返回 HTTP 503 与 `Retry-After`。

版本、签名材料、状态数据库和迁移恢复点保存在实例目录下的 `.native-upgrade/`。更新期间保持实例数据和环境配置一致。候选核对运行进程启动时的配置快照。热重载后若提示配置不匹配，请在运维窗口重启托管服务以采用新快照，再提交更新。回退会启动兼容的上一个二进制，并保留数据库扩展及已写入的数据。需要还原备份时，由运维单独决定恢复点和影响范围。[在线迁移与回滚](https://github.com/reina0721/neocloud/blob/main/docs/operations/migration-and-rollback.md)

## 校验与许可

归档随 Release 提供 SHA-256 清单、SPDX SBOM 和签名 bundle，验证方式见[发布说明](https://github.com/reina0721/neocloud/blob/main/docs/operations/release.md)。Go 归档与配套 Web Host 应来自同一版本和 source commit。

项目许可见归档根 `LICENSE` 和 `NOTICE`；依赖许可及需要附带的源码保留在 `third-party/`，来源快照见 `SOURCES.json`。使用问题见[支持指南](https://github.com/reina0721/neocloud/blob/main/SUPPORT.md)，潜在漏洞见[安全政策](https://github.com/reina0721/neocloud/blob/main/SECURITY.md)。
