# clouddrive 项目范围

当前构建范围为根 Go 后端与 frontend/ 内完整 Next.js 工作区。后端来自 community-go，前端来自 console-web；导入分支和完整提交号见根 SOURCES.json。只导入源码快照，不导入上游数据库、凭据、嵌套 Git 或提交历史。

## 当前产品与边界

文件入口为 `/home`，管理入口为 `/workspace`。私有文件与身份、权限、组织、导航、字典、通知、工作台、运维及 API 工作台共用现有 IAM、数据库和 Storage。具体文件能力、预算与未实现项以[文件管理说明](operations/file-management.md)为 authority，不用历史功能计数代替当前行为。

正式发行的原生整包由 Go 宿主同源提供静态页面、业务 API 和 WebDAV，运行时使用整包内的程序。Docker 和从源码构建的 Go + Node 本机包分别运行 Next.js Web Host 与 Go 服务。各入口共用 Cookie 会话和同源接口。原生 `/api/v1` 保留，`/api/console/v1` 投影复用业务能力。部署详见[安装与部署](operations/clouddrive-deployment.md)，开发默认通过 `http://127.0.0.1:4180` 访问，见[本地开发](getting-started/local-development.md)。

当前包含持久上传、WebDAV、私有版本、HTTP/BT 下载、ZIP/7Z、PDF 与媒体应用、文件权限和分享协作。BT 面向受信节点；无共享挂载的远程下载代理、脱离分享链接的跨账号挂载共享仍不在已实现范围。WOPI 的发现与编辑已有宿主和协议适配，真实外部 Office 服务仍须单独联调，不能由本地模拟通过推定兼容。客户端密码遮蔽不构成服务端授权边界。

community-go 的 frontend、webui、old-frontend、old-backend 未导入；Go 不再加载旧浏览器源码或构建旧 SPA。部分 Reference 页面保留演示用途，不能当成真实业务验收。

## 项目阶段与数据

项目采用 0.x 版本迭代，公开交付以 GitHub 正式 Release 及配套校验清单为准。不能把 origin/main、历史迁移或本地运行数据等同于正式发布。已有数据库、文件和审计数据必须保留；清理文档与源码不授权重置数据。迁移、清空或破坏性操作仍须检查实际数据与明确影响。

## 开发与证据

普通任务遵循[轻量协作流程](development/agent-workflow.md)和[范围验证](development/validation.md)，当前功能说明写入主题文档，重要决定保留 [ADR](architecture/adr/README.md)。历史任务目录已退出工作树，原始记录通过 Git 查阅；验证只证明具体平台、环境与范围，不把局部或模拟通过写成全量/真实部署通过。
