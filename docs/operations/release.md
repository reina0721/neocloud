# 发布

## 本地 release candidate

先安装固定版本工具，再构建本地候选：

```powershell
./scripts/Install-Tools.ps1
./scripts/Release-Local.ps1
```

Linux 使用 `scripts/install-tools.sh` 与 `scripts/release-local.sh`。工具目录和 release 输出目录由 `.scaffold/layout.json` 提供（当前输出位于忽略的 `dist/`），包括 Windows/Linux amd64 archive、`checksums.txt`、每个 archive 的 SPDX JSON SBOM，以及本轮临时密钥生成并立即验证的 checksum signature/bundle。临时私钥在脚本结束前删除；`local-rc.pub` 只证明该本地 artifact set 在本轮后未变化，不证明公开发布者身份。

本地候选不创建 tag、不 push、不创建 GitHub Release、不上传 image 或 attestation。

## 正式发布

正式流程只接受受保护的 `v*` tag，并进入 GitHub `release` environment 审批。workflow 使用固定工具版本，先运行 `scripts/verify-docs.sh` 的文档静态门禁，再运行 `scripts/verify-webui.sh --prepare` 的完整前端门禁，最后运行 `scripts/verify-quality.sh` 定义的 Go/生成物/仓库产物门禁，以 GoReleaser 创建 draft release，再使用 GitHub OIDC keyless identity 签名并验证 checksum bundle。Docs gate 检查当前 authority、链接、模块/能力索引和当前主题文档；它不启动 Go 服务或 Playwright。前端完整门禁包含确定性浏览器与契约用例，仍不等于全部真实后端、视觉人工审查或外部协议验收。

审批者必须按同一 tag/source commit 核对独立 workflow 与任务证据，而不是只看 release job 自身：

- tag、source commit、`/build` 返回值和 archive build info 一致；
- Windows/Linux Go quality、SQLite/PostgreSQL/MySQL 和 container jobs 全部通过，并确认这些独立 workflow 对应同一 commit；
- 如果该 commit 影响 WebUI，按 [WebUI 开发指南](../development/webui.md) 保存 lint、module/i18n/architecture 覆盖、typecheck、unit、build 和 registry 证据；quality/release workflow 会执行对应静态链，但 E2E 与视觉证据仍需单独保存；
- checksum、SPDX SBOM 和 Sigstore bundle 都随 draft 提供；
- OpenAPI breaking 结论、migration/rollback 说明和已知限制已审阅；
- 项目源码和 Dockerfile 的 OCI `org.opencontainers.image.licenses` 均声明 `Apache-2.0`，与根 `LICENSE`、`NOTICE` 和 README 对齐；仍应在发布验收中确认最终镜像携带该 label。

workflow 只生成 draft，不替审批者发布。发布或撤销 release、tag、registry image 仍是外部副作用，必须另有明确授权。

clouddrive 发布包含 Go 与独立 Next 服务。Go archive 不内置前端，构建、同源代理及迁移按 [部署说明](clouddrive-deployment.md) 执行。

## Docker 下载产物

正式工作流在 Go draft 创建后，分别使用 `ubuntu-24.04` 和 `ubuntu-24.04-arm` 原生 runner 构建、运行 Docker 包。两种镜像必须具有同一版本和 source commit；包内固定镜像 ID、架构和版本，不使用可漂移的 `latest` 镜像标签。ARM64 交叉构建本身不算运行验收。

完整门禁结束后仅还原 Next 自动生成的 `next-env.d.ts` 临时路由引用，并要求工作树干净，避免临时验收路径阻断 GoReleaser 或进入发布源码。其它生成物变化仍会阻断发布。

维护者可在本地构建候选（不会创建 tag、上传镜像或发布 Release）：

```bash
bash scripts/build-docker-release.sh --version v1.0.0-rc.1 --arch amd64 --out dist/docker-amd64
bash scripts/build-docker-release.sh --version v1.0.0-rc.1 --arch arm64 --out dist/docker-arm64
node --test scripts/install.test.mjs
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

Docker 工作流还生成两个镜像的 SPDX SBOM。最终附件任务合并 Go 与 Docker 的完整校验清单，重新进行 OIDC 签名与验证，再仅向仍为 draft 的 Release 上传。维护者发布前必须确认这一步及两种原生架构检查都通过；不能提前发布只有 Go 附件的中间 draft。

签名可用既有固定版本 cosign 验证：

```bash
cosign verify-blob --bundle checksums.txt.sigstore.json \
  --certificate-identity 'https://github.com/reina0721/neocloud/.github/workflows/release.yml@refs/tags/v1.0.0' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com checksums.txt
```

上例版本应替换为实际下载的 tag。目标机安装、更新及失败处理见[下载版部署](clouddrive-deployment.md#release-下载版安装与升级)。

2026-11-16 本地验收：amd64 原生与 ARM64 QEMU 容器均完成 `v0.0.0-test.1 → v0.0.0-test.2`，并以最终候选 `v0.0.0-test.1 → v0.0.0-test.3` 复验安装、重启和升级。上述失败场景及副本恢复均已实际执行；账号角色、数据库记录、文件摘要和存储绑定保持一致。ARM64 是模拟运行证据，原生 ARM runner 与远端 draft 工作流仍须在正式发布时执行。本次未创建远端 tag 或公开 Release，既有 `.data/ui-production` 未迁移或覆盖。
