# 发布

## 版本与变更记录

产品采用 `v0.MINOR.PATCH` annotated tag。修复递增 PATCH，新增能力或不兼容变化递增 MINOR。0.x 仍须说明不兼容影响并保留已有数据。预发布使用 `-rc.N`；本地快照从当前版本派生为下一 PATCH 的 `-next.<commit>`，不能当成正式发布。前端私有包版本是包元数据，不表示独立产品发布。

[GitHub Releases](https://github.com/reina0721/neocloud/releases) 是产品版本变更的唯一来源。正式版由 GoReleaser 从上一公开正式版至当前 tag 的真实 Git 提交生成记录，分为功能、修复和其他维护，包含直接提交；维护者须审阅用户影响、迁移、升级和已知限制。不维护重复的 CHANGELOG，不补写未经核验的历史发布内容。

## 仓库设置与发布前提

`reina0721/neocloud` 是正式发布仓库。协作入口见[贡献指南](../../CONTRIBUTING.md)、[支持指南](../../SUPPORT.md)和[安全政策](../../SECURITY.md)。NeoCloud 产物命名与升级边界见[发布和运行标识决策](../architecture/adr/145-neocloud-identity.md)。

发布使用 GitHub 的 `release` environment。人工审批取决于仓库实际配置。维护者确认目标提交的本地验收结果后，按现有授权推送发布标签。

发布前在本地对 main 目标提交执行[完整验收](../development/validation.md#准备与完整回归)，记录通过的提交 SHA，审阅版本差异、发布说明、许可和迁移恢复步骤。已发布的 tag 保持原位。源码修复使用新版本，本地准备阶段只生成候选产物。

## 本地 release candidate

先安装固定版本工具，再构建本地候选：

```powershell
./scripts/Install-Tools.ps1
./scripts/Release-Local.ps1
```

GoReleaser 的 `dist` 不支持模板，所有发布入口先通过 `scripts/release-config.mjs` 按布局生成临时配置，再用 `--config` 构建，避免归档、SBOM 和校验清单落入不同目录。临时配置由入口负责清理。

Linux 使用 `scripts/install-tools.sh` 与 `scripts/release-local.sh`。工具目录和 release 输出目录由 `.scaffold/layout.json` 提供（当前输出位于忽略的 `dist/`），包括 Windows/Linux amd64 archive、`checksums.txt`、每个 archive 的 SPDX JSON SBOM，以及本轮临时密钥生成并立即验证的 checksum signature/bundle。临时私钥在脚本结束前删除；`local-rc.pub` 只证明该本地 artifact set 在本轮后未变化，不证明公开发布者身份。

本地候选不创建 tag、不 push、不创建 GitHub Release、不上传 image 或 attestation。

## 正式发布

正式流程由指向本地已验收提交的 annotated `v*` tag 触发。工作流核对标签指向的 SHA、提交属于 `main` 的历史，以及上一正式版的提交关系。运行摘要记录实际构建的 tag 与 SHA。正式包发布前还执行 Linux Go 测试和发布控制脚本测试。

应在同一 tag 和源提交上核对以下证据。

- tag、源提交、`/build` 返回值和 archive build info 一致。
- 本地按 [验证策略](../development/validation.md) 保留 Go、WebUI、数据库和相关业务场景的验收结果。视觉和外部协议证据按实际环境记录。
- 完整附件集合、SPDX SBOM 及最终 Sigstore bundle 随草稿提供。
- OpenAPI 兼容性、迁移和回滚说明以及已知限制已审阅。
- 项目源码和 Dockerfile 的 OCI `org.opencontainers.image.licenses` 均声明 `Apache-2.0`，与根 `LICENSE`、`NOTICE` 和 README 对齐；仍应在发布验收中确认最终镜像携带该 label。

正式 tag 的完整附件汇总后，在 `release.yml` 用 GitHub OIDC 身份对最终 SHA-256 清单签名一次。目标平台分别用签名包执行最小安装或启动检查。最终 `publish` 重新下载草稿附件，校对包清单、版本和签名，随后将正式版设为 latest。附件缺失、摘要或签名错误、启动失败都会阻止公开。预发布保持草稿。发布后检查公开安装直链和原生包下载路径，传播失败作为公开后的状态报告。

`scripts/verify-release.mjs` 核对草稿附件的完整性，拒绝缺少任一架构、SBOM 或签名，以及未受校验清单保护、摘要错误或源提交不符的附件。签名由固定版本的 cosign 验证。

读取待发布 draft 时，使用具有仓库写权限的工作流令牌分页调用 [List releases](https://docs.github.com/en/rest/releases/releases#list-releases)，通过 `gh api --paginate --slurp` 收集所有页面，再按 tag 精确选择唯一的正式版本 draft；缺失、重复或状态不符均终止发布。`GET /releases/tags/{tag}` 只查询已发布版本，不能用于发布前的 draft 附件验收。

手动 `Quality` 保留 govulncheck、gosec 与完整 Git 历史的 Gitleaks。协议规定的 SHA-1、随机 nonce API、公开权限标识和工具生成源码权限等静态误报，必须在对应语句说明依据，规则仍按全局范围执行。Gitleaks 对公开迁移摘要、RFC 测试向量与固定测试 UUID 的例外同时约束路径和值。

发布包含独立 Go、原生 Go 与 Web 整包，以及配对的 Docker 镜像。构建和迁移分别见 [原生部署](backend-archive.md) 和 [Docker 安装](neocloud-deployment.md)。

## 原生 Go 托管包

正式版同时提供 Windows amd64、Linux amd64、Linux arm64 的托管 ZIP。每包包含稳定宿主、Go 业务进程、平台与源码清单。GitHub Workflow 发版时读取上一 NeoCloud 托管正式版的 tag 与 commit，并将它们写入本版的已签名兼容清单。v0.4.0 是首个 NeoCloud 托管版，清单无前序版本。

同一发布还提供对应的 `_managed-full.zip`，包含同一提交产出的真实静态 Web。签名绑定静态文件清单、构建标识和 Go 版本。整包在目标平台直接运行，验收确认主机无需启动 Node 或容器。[原生整包使用说明](backend-archive.md#运行原生-go-与-web-整包)

若本版包含在线迁移，在同一提交提供 `.github/managed-go-migrations.json`。其中 `fromVersion` 与 `fromCommit` 对应上一托管构建，`onlinePlans` 按 SQLite、PostgreSQL、MySQL 对应的驱动名声明迁移步骤。每一步必须绑定现有模块 SQL 的 SHA-256、连续版本和批准的增量操作。下一版应删除已发布的声明，或按新的前序版本提供新声明。更新器会核对实际内嵌 SQL、当前数据库版本及旧版兼容性。需要停机的迁移按单独的运维流程交付。[在线迁移与回滚](migration-and-rollback.md)

Windows amd64、Linux amd64、Linux arm64 各启动一次实际签名整包，核对运行版本、静态页面和最小数据读写。完整 Go 进程交接和多数据库回归沿用本地或手动验收。发布后从空缓存检查 GitHub 正式包的下载、验签和回读。[原生托管版使用说明](backend-archive.md#使用原生托管版自动下载和换版)

## Docker 下载产物

正式工作流分别使用 `ubuntu-24.04` 和 `ubuntu-24.04-arm` 原生 runner 构建 Docker 包，并各对签名正式包执行一次安装与健康检查。配套镜像具有同一版本和源提交，包内固定镜像 ID、架构和标签。ARM64 运行证据来自原生平台。

正式构建从干净的 tag checkout 生成附件。非回环、浏览器、持久化、NeoCloud 版本间断网升级和完整恢复验收继续由现有脚本按需运行。

维护者可在本地构建候选（不会创建 tag、上传镜像或发布 Release）：

```bash
bash scripts/build-docker-release.sh --version v1.0.0-rc.1 --arch amd64 --out dist/docker-amd64
bash scripts/build-docker-release.sh --version v1.0.0-rc.1 --arch arm64 --out dist/docker-arm64
node --test scripts/install.test.mjs scripts/verify-release.test.mjs scripts/release-config.test.mjs scripts/verify-elf-platform.test.mjs scripts/docker-image-config-id.test.mjs
```

需要免密 sudo Docker 的开发机，可显式设置 `NEOCLOUD_DOCKER_SUDO=1`。常规安装使用当前账户的 Docker 权限，注册或更新网页运维服务需要宿主机管理权限。已有配套镜像可用 `--api-image` 与 `--web-image` 重新打包，版本、架构、源码及镜像配置摘要必须通过校验。

包内 `API_ID`、`WEB_ID` 固定记录原始镜像配置 JSON 的 SHA-256；配置还引用各层的 `rootfs.diff_ids`。Docker 传统存储与 containerd 存储的显示 ID 定义不同，安装器在显示 ID 不匹配时仅从本地导出已载入的对应平台镜像，核对原始配置内容摘要，再继续检查架构、版本和源码。该步骤不访问镜像仓库、不增加目标机 Node 依赖，也不把版本 label 当成内容身份校验。

安装包以 `NETWORK=1` 和 `ENTRYPOINT=1` 标记网络和自动同源入口能力。完整验收可以给 `scripts/test-docker-release.mjs` 添加 `--network-host <当前机器IPv4>`，核对非回环监听、Cookie、文件、WebDAV、Origin/CSRF、会话与重启。普通 HTTP 的浏览器行为使用真实浏览器复验。

`manifest.txt` 中的 `INSTANCE_LAYOUT=1` 标记支持自定义 Compose 项目名和数据目录，`OFFLINE_MAINTENANCE=1` 标记有配套的离线维护工具。该版本升级旧实例时沿用已有布局。使用自定义布局的实例须选择具有该标记的版本。[自定义实例与安装检查](neocloud-deployment.md#自定义实例与安装检查)

在已准备好独立信任目录的 Linux 主机上，用两个完整签名附件目录执行真实升级验收。`build-docker-release.sh` 生成的本地构建产物由发布流程签名后进入这一验收。

```bash
NEOCLOUD_OFFLINE_TRUST_DIR=/path/to/trust node scripts/test-docker-release.mjs \
  --release-dir /path/to/signed-v1 --version v1.0.0 \
  --upgrade-dir /path/to/signed-v2 --upgrade-version v1.1.0 --faults
```

该脚本只创建和清理自己拥有的临时实例，验证管理员与角色、文件摘要、存储绑定、重启、备份和升级；损坏包、端口冲突及备份失败使用实际容器和文件权限验证。`--faults` 在独立数据库副本制造脏迁移，确认拒绝自动降级，再明确恢复该测试副本并核对文件内容。控制流程夹具的独立单元测试不冒充真实集成。`--keep` 可保留成功实例用于浏览器审查，失败现场始终保留；`--emulated-arch arm64` 仅用于已有 QEMU 的本地运行验收，并明确标注 daemon 架构选择夹具与模拟环境。

Docker 工作流为两种镜像生成 SPDX SBOM。最终签名清单同时涵盖独立 Go 归档、托管 ZIP、镜像包、维护程序和对应的 SBOM。专项断网验收可用 `scripts/test-offline-release.sh` 执行。信任材料通过 Sigstore TUF 单独准备。[离线信任准备](neocloud-deployment.md#自动化与离线安装)

签名可用既有固定版本 cosign 验证：

```bash
cosign verify-blob --bundle checksums.txt.sigstore.json \
  --certificate-identity 'https://github.com/reina0721/neocloud/.github/workflows/release.yml@refs/tags/v1.0.0' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com checksums.txt
```

上例版本应替换为实际下载的 tag。目标机安装、更新及失败处理见[下载版部署](neocloud-deployment.md#release-下载版安装与升级)。

安装和升级验收使用独立的临时目录与数据库副本。架构覆盖以实际 ELF 与目标平台运行结果为准。公开安装入口读取已发布的正式 Release 及其完整签名附件。


### 网页运维附件与验收

每个平台同时构建 `neocloud-maintenance_<tag>_linux_<arch>`。最终签名清单覆盖维护工具，发布门禁检查真实 ELF 架构。维护工具具有独立进程和版本周期，普通应用升级期间由原工具继续持有实例锁和网关端口。

网页运维变更可按需运行 `scripts/test-docker-maintenance.mjs`，使用上一 NeoCloud 正式版及签名候选验证 systemd 接管、Chromium 维护页、WebDAV、数据保留、授权、回退和恢复。所有步骤使用独立临时实例。
