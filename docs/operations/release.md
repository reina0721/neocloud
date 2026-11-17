# 发布

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

正式流程使用指向已验证提交的 annotated `v*` tag，保留 GitHub `release` environment 审批。推送 tag 前先确认 main 同一提交的独立门禁通过，不强制覆盖已存在的 tag。workflow 使用固定工具版本，首先按 SHA 核验 `main` 已完成的 Quality（含完整前端、Go、生成物、仓库产物及安全检查）、Database 和 Container 门禁，再以 GoReleaser 创建 draft，再使用 GitHub OIDC keyless identity 签名并验证 checksum bundle。Docs gate 不启动 Go 服务或 Playwright；确定性浏览器与契约用例也不等于全部真实后端、视觉人工审查或外部协议验收。

自动发布阶段和 environment 审批者按同一 tag/source commit 核对独立 workflow 与任务证据：

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

## Docker 下载产物

正式工作流在 Go draft 创建后，分别使用 `ubuntu-24.04` 和 `ubuntu-24.04-arm` 原生 runner 构建、运行 Docker 包。两种镜像必须具有同一版本和 source commit；包内固定镜像 ID、架构和版本，不使用可漂移的 `latest` 镜像标签。ARM64 交叉构建本身不算运行验收。

完整检查由分支 push 的独立工作流执行；tag push 只运行 Release，按不可变 SHA 复用 `main` 的完整证据，避免相同输入再重复全套测试。Release 在创建 draft 与正式发布前均检查独立门禁，不接受其它分支或 tag 的局部结果；仍重新构建全部正式包并运行原生安装、持久化与最终附件验收。构建要求干净的源码 checkout，生成物不得进入发布源码。

维护者可在本地构建候选（不会创建 tag、上传镜像或发布 Release）：

```bash
bash scripts/build-docker-release.sh --version v1.0.0-rc.1 --arch amd64 --out dist/docker-amd64
bash scripts/build-docker-release.sh --version v1.0.0-rc.1 --arch arm64 --out dist/docker-arm64
node --test scripts/install.test.mjs scripts/verify-release.test.mjs scripts/release-config.test.mjs scripts/verify-elf-platform.test.mjs
node scripts/test-docker-release.mjs --release-dir dist/docker-amd64 --version v1.0.0-rc.1
```

需要免密 sudo Docker 的开发机，可显式设置 `CLOUDDRIVE_DOCKER_SUDO=1`；目标安装脚本本身不会自动调用 sudo。已有配套镜像可用 `--api-image` 与 `--web-image` 重新打包，但版本、架构、源码及镜像 ID 必须通过校验，不能仅重打标签冒充另一版本。

两个候选版本的真实升级验收使用：

```bash
node scripts/test-docker-release.mjs \
  --release-dir dist/docker-v1 --version v1.0.0-rc.1 \
  --upgrade-dir dist/docker-v2 --upgrade-version v1.0.0-rc.2 --faults
```

该脚本只创建和清理自己拥有的临时实例，验证管理员与角色、文件摘要、存储绑定、重启、备份和升级；损坏包、端口冲突及备份失败使用实际容器和文件权限验证。`--faults` 在独立数据库副本制造脏迁移，确认拒绝自动降级，再明确恢复该测试副本并核对文件内容。控制流程夹具的独立单元测试不冒充真实集成。`--keep` 可保留成功实例用于浏览器审查，失败现场始终保留；`--emulated-arch arm64` 仅用于已有 QEMU 的本地运行验收，并明确标注 daemon 架构选择夹具与模拟环境。

Docker 工作流还生成两个镜像的 SPDX SBOM。最终附件任务合并 Go 与 Docker 的完整校验清单，包含六份 SPDX SBOM，重新进行 OIDC 签名与验证，再仅向仍为 draft 的 Release 上传。之后才进入自动发布阶段，不能提前发布只有 Go 附件的中间 draft。

签名可用既有固定版本 cosign 验证：

```bash
cosign verify-blob --bundle checksums.txt.sigstore.json \
  --certificate-identity 'https://github.com/reina0721/neocloud/.github/workflows/release.yml@refs/tags/v1.0.0' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com checksums.txt
```

上例版本应替换为实际下载的 tag。目标机安装、更新及失败处理见[下载版部署](clouddrive-deployment.md#release-下载版安装与升级)。

安装和升级验收使用独立的临时目录与数据库副本，保持既有 `.data/ui-production` 独立。daemon 架构选择夹具或标注为 ARM64 的镜像不能证明程序确实以 ARM64 运行；须检查实际 ELF 架构，并以当前 tag 的原生 ARM runner 安装、操作及持久化结果为准。公开安装入口只以已发布的正式 Release 及其完整签名附件为准。
