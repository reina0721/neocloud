# 发布

## 版本与变更记录

产品继续采用 `v0.MINOR.PATCH` annotated tag；修复递增 PATCH，新增能力或需要明确升级说明的兼容变化递增 MINOR。0.x 仍须说明不兼容影响，不因版本阶段而重置数据。预发布使用 `-rc.N`；本地快照从当前版本派生为下一 PATCH 的 `-next.<commit>`，不能当成正式发布。前端私有包版本是包元数据，不表示独立产品发布。

[GitHub Releases](https://github.com/reina0721/neocloud/releases) 是产品版本变更的唯一来源。正式版由 GoReleaser 从上一公开正式版至当前 tag 的真实 Git 提交生成记录，分为功能、修复和其他维护，包含直接提交；维护者须审阅用户影响、迁移、升级和已知限制。不维护重复的 CHANGELOG，不补写未经核验的历史发布内容。

## 仓库设置与发布前提

截至 2026-11-17，`reina0721/neocloud` 为公开仓库，Issues 开启、Discussions 关闭；已配置产品简介及 Topics，私密漏洞报告已启用。协作入口见[贡献指南](../../CONTRIBUTING.md)、[支持指南](../../SUPPORT.md)和[安全政策](../../SECURITY.md)。CloudDrive 名称与既有 Go module 保留，GitHub 仓库路径不要求源码包路径迁移。

本次核查没有 classic branch protection 或 ruleset；`release` environment 已存在，但没有 required reviewers、等待规则或部署分支限制。因此 environment 声明本身不表示有人审批；发布仍依靠工作流同 SHA 门禁及 tag 推送授权。每次正式发布前重新核对实际规则、维护责任与所需凭据。本次基础设置维护不修改分支保护、审批或发布权限。

发布前确认 main 目标提交全量通过、审阅版本差异和生成说明、核验许可和签名附件，并确认备份及迁移恢复步骤。不得移动已发布 tag，源码修复使用新版本；本地准备不自动创建 tag、push 或公开 Release。

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

正式流程使用指向已验证提交的 annotated `v*` tag，使用 GitHub `release` environment；是否需要人工审批取决于其实际保护规则。推送 tag 前先确认 main 同一提交的独立门禁通过，不强制覆盖已存在的 tag。workflow 使用固定工具版本，首先按 SHA 核验 `main` 已完成的 Quality（含完整前端、Go、生成物、仓库产物及安全检查）、Database 和 Container 门禁，再以 GoReleaser 创建 draft，再使用 GitHub OIDC keyless identity 签名并验证 checksum bundle。Docs gate 不启动 Go 服务或 Playwright；确定性浏览器与契约用例也不等于全部真实后端、视觉人工审查或外部协议验收。

自动发布阶段及维护者（若配置审批则包括审批者）按同一 tag/source commit 核对独立 workflow 与任务证据：

- tag、source commit、`/build` 返回值和 archive build info 一致；
- Windows/Linux Go quality、SQLite/PostgreSQL/MySQL 和 container jobs 全部通过，并确认这些独立 workflow 对应同一 commit；
- 如果该 commit 影响 WebUI，按 [WebUI 开发指南](../development/webui.md) 保存 lint、module/i18n/architecture 覆盖、typecheck、unit、build 和 registry 证据；quality/release workflow 会执行对应静态链，但 E2E 与视觉证据仍需单独保存；
- checksum、SPDX SBOM 和 Sigstore bundle 都随 draft 提供；
- OpenAPI breaking 结论、migration/rollback 说明和已知限制已审阅；
- 项目源码和 Dockerfile 的 OCI `org.opencontainers.image.licenses` 均声明 `Apache-2.0`，与根 `LICENSE`、`NOTICE` 和 README 对齐；仍应在发布验收中确认最终镜像携带该 label。

对 `v主版本.次版本.修订号` 正式 tag，最终 `publish` job 等待同一提交在 `main` 上最新的 Quality、Database、Container push 运行全部成功（其它分支或 tag 的局部检查不能替代主分支全量检查），重新下载并校验完整附件与签名后，自动发布为非预发布的 latest。预发布 tag 保持 draft。任何失败、缺失或等待超时均不会提升 draft；需要源代码修复时使用新的 patch tag，不移动旧 tag。推送正式 tag 即进入该自动发布流程，应在明确发布授权下执行；environment 规则仍可要求指定审批者。

`scripts/verify-release.mjs` 是发布附件与独立检查的门禁：拒绝缺少任一架构、SBOM、签名、未纳入 checksum 的附件、摘要错误或源码提交不一致的镜像清单。签名的密码学验证仍由固定版本 cosign 完成，不以文件存在代替签名有效。

读取待发布 draft 时，使用具有仓库写权限的工作流令牌分页调用 [List releases](https://docs.github.com/en/rest/releases/releases#list-releases)，通过 `gh api --paginate --slurp` 收集所有页面，再按 tag 精确选择唯一的正式版本 draft；缺失、重复或状态不符均终止发布。`GET /releases/tags/{tag}` 只查询已发布版本，不能用于发布前的 draft 附件验收。

安全门禁持续执行 govulncheck、gosec 与完整 Git 历史的 Gitleaks。协议规定的 SHA-1、随机 nonce API、公开权限标识和工具生成源码权限等静态误报，必须在对应语句说明依据；不得全局关闭规则。Gitleaks 对公开迁移摘要、RFC 测试向量与固定测试 UUID 的例外同时约束路径和值，不忽略整个文件或提交。

clouddrive 发布包含 Go 与独立 Next 服务。Go archive 不内置前端，构建、同源代理及迁移按 [部署说明](clouddrive-deployment.md) 执行。

## 原生 Go 托管包

正式版同时提供 Windows amd64、Linux amd64、Linux arm64 的托管 ZIP。每包包含稳定宿主、Go 业务进程、平台与源码清单。GitHub Workflow 发版时读取上一托管正式版的 tag 与 commit，并将它们写入本版的已签名兼容清单。第一个托管版可以没有前序版本。

若本版包含在线迁移，在同一提交提供 `.github/managed-go-migrations.json`。其中 `fromVersion` 与 `fromCommit` 对应上一托管构建，`onlinePlans` 按 SQLite、PostgreSQL、MySQL 对应的驱动名声明迁移步骤。每一步必须绑定现有模块 SQL 的 SHA-256、连续版本和批准的增量操作。下一版应删除已发布的声明，或按新的前序版本提供新声明。更新器会核对实际内嵌 SQL、当前数据库版本及旧版兼容性。需要停机的迁移按单独的运维流程交付。[在线迁移与回滚](migration-and-rollback.md)

发布门禁运行真实原生 Go 子进程，Windows 覆盖 SQLite，Linux 两种 CPU 架构覆盖三种数据库。附件与各自的 SPDX SBOM 纳入正式签名清单。正式发布后，流水线另从空缓存下载 GitHub 正式附件，并验证本地缓存可独立读回。[原生托管版使用说明](backend-archive.md#使用原生托管版自动下载和换版)

## Docker 下载产物

正式工作流在 Go draft 创建后，分别使用 `ubuntu-24.04` 和 `ubuntu-24.04-arm` 原生 runner 构建、运行 Docker 包。两种镜像必须具有同一版本和 source commit；包内固定镜像 ID、架构和版本，不使用可漂移的 `latest` 镜像标签。ARM64 交叉构建本身不算运行验收。

完整检查由分支 push 的独立工作流执行；tag push 只运行 Release，按不可变 SHA 复用 `main` 的完整证据，避免相同输入再重复全套测试。Release 在创建 draft 与正式发布前均检查独立门禁，不接受其它分支或 tag 的局部结果；仍重新构建全部正式包并运行原生安装、持久化与最终附件验收。构建要求干净的源码 checkout，生成物不得进入发布源码。

维护者可在本地构建候选（不会创建 tag、上传镜像或发布 Release）：

```bash
bash scripts/build-docker-release.sh --version v1.0.0-rc.1 --arch amd64 --out dist/docker-amd64
bash scripts/build-docker-release.sh --version v1.0.0-rc.1 --arch arm64 --out dist/docker-arm64
node --test scripts/install.test.mjs scripts/verify-release.test.mjs scripts/release-config.test.mjs scripts/verify-elf-platform.test.mjs scripts/docker-image-config-id.test.mjs
```

需要免密 sudo Docker 的开发机，可显式设置 `CLOUDDRIVE_DOCKER_SUDO=1`。常规安装使用当前账户的 Docker 权限，注册或更新网页运维服务需要宿主机管理权限。已有配套镜像可用 `--api-image` 与 `--web-image` 重新打包，版本、架构、源码及镜像配置摘要必须通过校验。

包内 `API_ID`、`WEB_ID` 固定记录原始镜像配置 JSON 的 SHA-256；配置还引用各层的 `rootfs.diff_ids`。Docker 传统存储与 containerd 存储的显示 ID 定义不同，安装器在显示 ID 不匹配时仅从本地导出已载入的对应平台镜像，核对原始配置内容摘要，再继续检查架构、版本和源码。该步骤不访问镜像仓库、不增加目标机 Node 依赖，也不把版本 label 当成内容身份校验。

安装包保留 `NETWORK=1`，新增 `ENTRYPOINT=1` 表示支持自动同源入口。原生发布任务分别通过回环地址和 `--network-host` 指定的 runner 非回环 IPv4 访问默认安装，不传外部地址或 HTTP 开关；实际核对默认监听、Cookie、初始化、文件、WebDAV 地址与读写、伪造 Origin/CSRF 拒绝、会话与重启。开发机可以给 `scripts/test-docker-release.mjs` 添加 `--network-host <当前机器IPv4>` 重现；不能以 localhost 的安全上下文代替普通 HTTP 浏览器验收。HTTP 的真实浏览器操作需要额外验证，不能由 Node HTTP 客户端通过推定。

`manifest.txt` 中的 `INSTANCE_LAYOUT=1` 标记支持自定义 Compose 项目名和数据目录，`OFFLINE_MAINTENANCE=1` 标记有配套的离线维护工具。该版本升级旧实例时沿用已有布局。使用自定义布局的实例须选择具有该标记的版本。[自定义实例与安装检查](clouddrive-deployment.md#自定义实例与安装检查)

在已准备好独立信任目录的 Linux 主机上，用两个完整签名附件目录执行真实升级验收。`build-docker-release.sh` 生成的本地构建产物由发布流程签名后进入这一验收。

```bash
CLOUDDRIVE_OFFLINE_TRUST_DIR=/path/to/trust node scripts/test-docker-release.mjs \
  --release-dir /path/to/signed-v1 --version v1.0.0 \
  --upgrade-dir /path/to/signed-v2 --upgrade-version v1.1.0 --faults
```

该脚本只创建和清理自己拥有的临时实例，验证管理员与角色、文件摘要、存储绑定、重启、备份和升级；损坏包、端口冲突及备份失败使用实际容器和文件权限验证。`--faults` 在独立数据库副本制造脏迁移，确认拒绝自动降级，再明确恢复该测试副本并核对文件内容。控制流程夹具的独立单元测试不冒充真实集成。`--keep` 可保留成功实例用于浏览器审查，失败现场始终保留；`--emulated-arch arm64` 仅用于已有 QEMU 的本地运行验收，并明确标注 daemon 架构选择夹具与模拟环境。

Docker 工作流还生成两个镜像的 SPDX SBOM。最终附件任务合并 Go 与 Docker 的校验清单，涵盖独立 Go 归档、托管 ZIP 和镜像的 SPDX SBOM。它使用新版 Sigstore bundle 进行 OIDC 签名与验证，再向 draft Release 上传。随后两个原生架构分别在无外网路由的网络命名空间验证签名安装、维护和旧版切换。信任材料通过 Sigstore TUF 单独准备。[离线信任准备](clouddrive-deployment.md#自动化与离线安装)

签名可用既有固定版本 cosign 验证：

```bash
cosign verify-blob --bundle checksums.txt.sigstore.json \
  --certificate-identity 'https://github.com/reina0721/neocloud/.github/workflows/release.yml@refs/tags/v1.0.0' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com checksums.txt
```

上例版本应替换为实际下载的 tag。目标机安装、更新及失败处理见[下载版部署](clouddrive-deployment.md#release-下载版安装与升级)。

安装和升级验收使用独立的临时目录与数据库副本，保持既有 `.data/ui-production` 独立。daemon 架构选择夹具或标注为 ARM64 的镜像不能证明程序确实以 ARM64 运行；须检查实际 ELF 架构，并以当前 tag 的原生 ARM runner 安装、操作及持久化结果为准。公开安装入口只以已发布的正式 Release 及其完整签名附件为准。


### 网页运维附件与验收

每个平台同时构建 `clouddrive-maintenance_<tag>_linux_<arch>`。最终签名清单覆盖维护工具，发布门禁检查真实 ELF 架构。维护工具具有独立进程和版本周期，普通应用升级期间由原工具继续持有实例锁和网关端口。

正式发布前的原生验收从上一正式版初始化文件和分享，下载签名候选，启动 systemd 网关并通过 Chromium 检查和选择本地包。停服期间检查同址维护页与 WebDAV 503，升级后核对原文件，验证系统所有者授权、兼容回退、备份和恢复。若旧版未包含所有者校验接口，首次跨版验收使用宿主恢复凭据发起任务。验收实例只使用独立临时目录。
