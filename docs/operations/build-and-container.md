# 构建与容器

本机打包执行 `node scripts/build.mjs`。先同步锁文件并生成契约、插件和后端导航目录，再并行编译 Go 和 Next，最后归档两个进程及许可。Windows 的产物位于 `dist/native/windows-amd64/clouddrive-windows-amd64.zip`，Linux 生成对应架构的 `.tar.gz`。包与 Next 编译缓存使用独立目录。Windows 的 `scripts/Build.ps1` 调用同一入口。完整命令和反向代理配置见[部署说明](clouddrive-deployment.md)。

Go 质量入口为 `scripts/Verify-Quality.ps1`，包括格式、生成物、测试、race、vet 和无 CGO 构建；前端入口 `scripts/Verify-WebUI.ps1` 执行工作区完整 `check`；文档入口 `scripts/Verify-Docs.ps1`。各项以实际退出结果为准，单项通过不能替代浏览器和部署验收。

## 许可随包交付

Go 归档包含根 LICENSE、NOTICE、SOURCES.json 和按目标平台收集的 `third-party/`；固定版本 `go-licenses save` 保留依赖许可、声明及该工具要求附带的源码，另附 Go 工具链许可。Go 镜像中位于 `/usr/share/licenses/clouddrive/`。

Next standalone 在 `licenses/node/` 保存 pnpm 生产依赖的许可文件、上游 package.json、README 及 inventory.json，覆盖客户端打包依赖；Web 镜像在 `/usr/share/licenses/clouddrive/third-party/node/` 提供相同清单。根许可、来源和字体许可也随镜像交付；PDF 的主许可、字体、WASM、色彩配置与本地化许可继续随对应 public 资源保留。

依赖使用自己的许可，根 Apache-2.0 声明不替代第三方条款。清单保留上游未知许可和缺少许可文件的事实，不能将元数据或 SBOM 当作完整许可审查；发布前须审阅缺口及再分发要求。基础镜像自带的软件也须结合镜像 SBOM 审阅。

## OCI image

根目录 `Dockerfile` 只构建 Go 服务，`frontend/Dockerfile` 构建 Next 服务，两者构建上下文均为仓库根目录：

```sh
docker build -t clouddrive-api .
docker build -f frontend/Dockerfile -t clouddrive-web .
```

Next 的 server 构建输出为 `frontend/apps/web/dist/standalone/`；其中 `apps/web/server.js` 连同追踪依赖、页面静态资源及本地 PDF worker 可整体迁移。Web 镜像不复制完整源码工作区，运行时通过 `CLOUDDRIVE_BACKEND_URL` 配置 Go Origin。`pnpm --dir frontend standalone:check` 会把产物复制到仓库外验证依赖与资源闭包，并以两个不同上游检查真实代理传输。该检查同时进入 `pnpm check` 和 Web 镜像构建，Container CI 分别验证两种镜像。

Go 镜像同时携带默认配置引用的公共语言资源与 Todo 模块语言资源；默认数据目录归 nonroot 所有且权限为 `0700`。构建阶段预制包含 `.data` 的目录树，再将其内容复制到 `/app/`，保留子目录的私有权限，避免依赖不同 BuildKit 后端对空目标目录的 `COPY --chmod` 行为。

多架构构建通过 `docker buildx build --platform linux/amd64` 或 `linux/arm64` 选择目标；Dockerfile 的 `TARGETOS`、`TARGETARCH` 直接继承 BuildKit 自动参数，不设置覆盖目标架构的默认值。Container 门禁在 amd64、arm64 原生 runner 分别验证 Go 容器探针、迁移及停止。离线打包除检查 OCI 平台、版本和源码标签，还会读取镜像内 `/app/clouddrive` 的 ELF 文件头，拒绝程序架构与镜像平台不一致的包；两种架构仍须分别通过原生安装与持久化验收。

运行时显式提供配置与可写数据库卷，management 监听仅暴露给受信网络。Go runtime 为 nonroot；探针使用 management `/startupz`、`/livez`、`/readyz`。`scripts/container-smoke.sh` 检查后端探针和 API 不回退 HTML，前端由独立部署和浏览器验收覆盖。迁移应在启动前显式执行，不隐藏在容器启动中。

容器构建、外部数据库及线上发布必须分别验证；本地源码构建不证明这些检查已经通过。

日常增量检查见[验证策略](../development/validation.md)。上述脚本是完整回归，前端首次准备使用 `Verify-WebUI.ps1 -Prepare` 或 `verify-webui.sh --prepare`，不会在每次局部更新时自动安装。

## 独立 UI 生产测试环境

在仓库根目录运行：

```sh
node scripts/deploy-ui-test.mjs --build
# 本机 Docker 需要免密 sudo 时：
CLOUDDRIVE_DOCKER_SUDO=1 node scripts/deploy-ui-test.mjs --build
```

脚本使用 `compose.ui-test.yaml` 构建 Go 与 Next 生产镜像，显式迁移数据库、启用任务调度并启动服务，再通过真实 API 初始化隔离管理员。默认 Web 为 `http://127.0.0.1:4194/home`，API 为 8130，management 为 9130，均只映射到 loopback。可用 `CLOUDDRIVE_UI_WEB_PORT`、`CLOUDDRIVE_UI_API_PORT`、`CLOUDDRIVE_UI_MANAGEMENT_PORT` 覆盖；需选择浏览器允许访问的端口。

账号资料存于 `.data/ui-production-control/access.json`，权限为 `0600`，不会输出密码或进入镜像、Git。数据库、文件与传输暂存保存在 `.data/ui-production`；重复部署保留数据、存储身份和管理员，不复用开发数据库。去掉 `--build` 可启动已有镜像。停止服务使用 `docker compose --env-file .data/ui-production-control/compose.env --file compose.ui-test.yaml stop`，不删除持久化目录。

使用该环境执行真实文件验收：

```sh
CLOUDDRIVE_FILE_TEST_ACCESS="$PWD/.data/ui-production-control/access.json" \
  pnpm --dir frontend exec playwright test --config playwright.files.config.ts
```

完整文件用例中需要第二账号、一次性清空夹具或外部编辑服务的项目，以用例声明的环境变量为准。必须区分真实 API 操作、拦截故障用例和未配置外部集成，不能用模拟结果代替实际部署证据。
