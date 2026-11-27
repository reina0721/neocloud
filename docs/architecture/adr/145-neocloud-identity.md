# NeoCloud 发布与运行标识

## 决定

v0.4.0 起使用 NeoCloud 发行契约。Go module 为 `github.com/reina0721/neocloud`，前端使用 `@neocloud/*`。命令为 `neocloud`、`neocloud-host` 和 `neocloud-maintenance`。归档、配套镜像、默认实例目录、Compose 项目、Cookie 和浏览器存储均使用 NeoCloud 标识。Go 配置覆盖采用 `NEOCLOUD_APP_`，其他产品环境变量采用 `NEOCLOUD_` 或 `NEXT_PUBLIC_NEOCLOUD_`。

v0.3.4 曾交付桥接包。v0.4.0 移除桥接分发、双命名读取和实例改名工具，以全新实例为安装边界。GitHub 已公开的版本与附件仍保留在各自标签下。已有数据、配置和备份应继续保留在原实例。切换至 NeoCloud 的安装步骤见[部署手册](../../operations/neocloud-deployment.md)。

## 保持数据身份

API 路径、数据库迁移历史、账号 ID、文件 ID 和对象存储键继续沿用。用于持久化数据或互斥协调的既有标识保持稳定，避免替换源码时丢失业务状态或取得第二组写入锁。NeoCloud 浏览器端使用同源的 NeoCloud 存储，旧会话需要重新登录。

保留的持久化身份包括 MySQL 在线迁移记录、SQLite 和 MySQL 工作负载锁、数据库迁移互斥锁、Redis 调度命名空间与租约标识，以及文件库内已保存的分享快捷方式媒体类型。

## 发布与验证

v0.4.0 的原生托管包没有可在线换版的前序版本。后续 NeoCloud 版本继续使用签名兼容清单锁定前序版本与提交，继续提供相同格式内的升级、回退和备份恢复。签名验证保持原 GitHub 工作流发布者、可信根、摘要校验、版本、提交和二进制或镜像身份验证。正式发布前，在 Windows、Linux 和 Docker 目标平台用签名附件检查新实例启动。发布工作流与附件清单见[发布手册](../../operations/release.md)。
