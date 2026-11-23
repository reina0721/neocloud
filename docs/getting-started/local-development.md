# clouddrive 本地开发

当前启动权威为根 README 及本页。统一入口使用 Go 1.26.11 和带 npm 的 Node 24，由脚本调用固定版本的 pnpm 10.22.0。

## 跨平台统一入口

从仓库根目录执行：

```bash
node scripts/dev.mjs
```

入口检查端口后按锁文件同步前端依赖。新设备会下载缺失的依赖，已有安装会复用 pnpm 缓存并按当前锁文件更新。安装失败会在编译、迁移和启动服务前停止，具体原因由 pnpm 输出到终端。旧命令中的 `--prepare` 仍可使用。

工具在前台拥有前后端及生成器进程。构建、迁移后等待 Go readiness、前端登录页和同源 API 全部成功。Ctrl+C 或任一服务退出时清理其余进程；日志在 `.data/dev/`，数据保留。探活超时会提示对应服务的日志文件及最近收到的 HTTP 状态。普通开发使用根 `config.yaml`，不存在时运行原生 `config init`；已有数据库不重置；浏览器 Origin 仅在子进程环境中按实际端口覆盖。

启动器按当前实例的状态提示登录或首次设置。首次设置令牌默认位于 `.data/dev/setup-token`。如果启动前设置了 `APP_IAM__LOCAL__SETUPTOKEN`，本次服务使用环境变量中的值，终端只提示令牌来源。已有实例无法登录时，使用[账号恢复](first-use.md#无法登录)。令牌不写入聊天或 Git。

预览与一次性浏览器验收使用隔离环境：

```bash
node scripts/dev.mjs --preview
node scripts/dev.mjs --acceptance
```

预览使用 `.data/preview/` 的 SQLite、文件、传输目录和账号，默认端口 4180 / 8120 / 9120。账号信息位于 `.data/preview/access.json`，重启复用账号与数据。设置 `CLOUDDRIVE_FILE_TEST_ACCESS` 为该文件的**绝对路径**后，在 frontend 运行 `pnpm exec playwright test --config playwright.files.config.ts file-tests/material-workspace.spec.ts`。

一次性验收每次在 `.data/acceptance/` 创建新目录，运行 Playwright Chromium 后关闭前后端，保留日志用于诊断。默认端口为 4185 / 8088 / 9098。预览和验收都忽略继承的 `APP_` 环境变量，前缀大小写均视为相同。`run.lock` 防止同一环境并发启动。异常退出留下锁时，先确认原进程已停止再移除锁。

`--web-port`、`--api-port`、`--management-port` 可覆盖端口，不会终止占用端口的其它进程。默认使用 Turbopack；需要明确选择 webpack 时加 `--webpack`，不会在失败后静默更换编译器。

Linux 上出现 `inotify` / `EMFILE` 时先检查 `fs.inotify.max_user_instances` 与 `fs.inotify.max_user_watches`；进程文件句柄上限和用户监听配额是不同限制。启动器不修改系统配额。SQLite 使用私有目录权限；在宽松 umask 的环境执行后端测试时使用 `umask 077`，不放宽数据库检查。

## Windows 既有入口

PowerShell 的 `scripts/Start-Dev.ps1` 和 `scripts/Test-Integration.ps1` 调用统一的 Node 入口。Go 不在 PATH 时传入 `--go-executable C:\路径\go.exe`，兼容脚本使用 `-GoExecutable`。前台服务使用 Ctrl+C 关闭。旧版后台开发进程可通过 `scripts/Stop-Dev.ps1` 退出。根配置、数据及仍在使用的 `.data/dev-setup-token` 沿用原路径。

原 Windows 文件预览可继续使用 `scripts/Start-FilePreview.ps1`，该入口仍使用 `.data/file-preview/` 与 `.data/preview-access.json`。新版统一入口可通过 `--preview --legacy-preview` 选择同一目录。

## 分别启动

```powershell
$env:APP_IAM__LOCAL__SETUPTOKEN = '<自行生成的随机设置令牌>'
go run ./cmd/app db migrate up
go run ./cmd/app
# 另一个终端进入 frontend
npx --yes pnpm@10.22.0 install --frozen-lockfile
npx --yes pnpm@10.22.0 dev
```

config.yaml 必须存在，可复制 config.example.yaml 或运行 go run ./cmd/app config init。使用 config init 后，应配置 http.cors.allowedOrigins 为实际前端 Origin，如 http://127.0.0.1:4173。

业务 API 使用 /api/v1；控制台使用 /api/console/v1。浏览器请求同源地址，Next.js 将 /api 与 /management 转发到 CLOUDDRIVE_BACKEND_URL（默认 http://127.0.0.1:8080）。管理端口默认 127.0.0.1:9090。

## 数据与模拟模式

默认 SQLite 数据位于 .data/app.db；不导入源项目数据库或账户。MySQL/PostgreSQL 通过 APP_DATABASE__DRIVER 和 APP_DATABASE__DSN 配置，启动前执行相同迁移命令。

只有显式 NEXT_PUBLIC_AUTH_MODE=mock 才进入演示模式。Mock 和纯 UI/参考页面保留演示用途，真实业务接口失败不会降级。切换 NEXT_PUBLIC 配置后须重启开发服务器或重新构建生产前端。

## 验证

日常从仓库根运行 `node scripts/verify-changed.mjs --dry-run` 查看选择，再执行 `node scripts/verify-changed.mjs`。环境准备、按包及调用方选择、浏览器配置与完整回归见[验证策略](../development/validation.md)。

前端完整 `pnpm check` 包含模拟与拦截式契约测试。运行 `node scripts/dev.mjs --acceptance` 可用独立数据库验证实际创建、密码规则及登录退出。

[完整部署说明](../operations/clouddrive-deployment.md)
