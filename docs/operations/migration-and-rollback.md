# 数据库迁移与回滚

本文是部署、发布和生产回滚场景的迁移权威说明。本地首次启动使用 [本地启动指南](../getting-started/local-development.md)：`config init -> db migrate up -> Service`。

## 部署顺序

1. 备份数据库并验证恢复路径。
2. 使用与目标二进制相同版本的 artifact 执行 `db migrate status`。
3. 在受控 one-shot job 中执行 `db migrate up`。
4. 再次执行 `status`，要求每个 set 的 version 精确等于各自 target、`dirty=false`、completion 已完成且聚合 `compatible=true`。
5. 启动 Service；Service 只读检查兼容性，不执行 DDL。

```powershell
./clouddrive.exe db migrate status
./clouddrive.exe db migrate up
```

`status` 和 `up` 都会在 one-shot operation 边界输出结构化日志：start 为 Debug，成功兼容完成为 Info，
dirty/incompatible 等需要人工动作的完成态为 Warn，最终失败为 Error。CLI 的 JSON 结果仍只写 stdout；运行日志写入
配置 logger 或入口基线 stderr，不得与机器可解析输出混在一起。

CLI 输出 `sets[]`，每项保留 `moduleId`、`setName`、current/target/dirty/empty/compatible。当前 IAM 使用 `iam_schema_migrations` 000001，Organization 使用 `organization_schema_migrations` 000001，Navigation 使用 `navigation_schema_migrations` 000001，Todo 使用 `todo_schema_migrations` 000001；四个 set 必须分别精确兼容。

若检测到已退休的 `schema_migrations`、`webui_users` 或 `webui_sessions`，`status/up` 会在创建 runner 或执行 SQL 前返回 `pre_release_baseline_reset_required`。项目不会自动删除、改写或迁移本地数据；先停止操作，确认是否保留数据并制定显式方案。

## 失败处理

- lock timeout：确认没有存活 migration owner，再重试同一版本；不要并发执行第二套客户端。
- dirty version：停止发布并保留现场。当前 CLI 不暴露 `force`，不得直接篡改版本表冒充成功。
- completion required：按错误中的 module identity 执行该模块明确记录的数据完成流程；不要用默认用户或时间推断业务值。
- DSN/权限/网络失败：修复外部条件后重新执行 `status`，错误日志只看 `operation`、`phase`、`error_type` 和
  `cause_type`；不得粘贴完整 DSN、凭据、SQL body 或未经审查的错误文本。

## 回滚与 forward-fix

普通迁移 CLI 提供 `up/status/version`。应用回滚必须满足旧二进制仍兼容当前 schema。无法兼容时停止流量切换，优先发布 forward-fix。确需数据库恢复时，只能使用部署前验证过的备份恢复流程，并由数据库 owner 审批。不得把仓库中的 `.down.sql` 当作自动生产回滚授权。

### 原生托管实例在线迁移

原生 Go 升级只执行签名计划中的兼容扩展。候选在旧版继续服务时只读检查版本，由内嵌 SQL 和签名摘要共同锁定实际语句。允许新增独立表或添加单个可空列。旧版只接纳计划中明确列出的每个已提交前缀。普通 `db migrate up` 与托管在线迁移共用迁移互斥锁。

- SQLite 要求已启用 WAL。升级前执行 `VACUUM INTO` 并验证快照，DDL 与版本记录在同一事务提交。
- PostgreSQL 18 使用受限锁等待和事务。备份需要与服务端兼容的 `pg_dump`、`pg_restore`，实例连接使用单端点 PostgreSQL URI。
- MySQL 8.4 使用 InnoDB 和 `ALGORITHM=INSTANT`。备份需要 `mysqldump`，实例连接使用 TCP 和标准 TLS 配置。DDL 和版本记录之间若发生中断，重试同一个签名任务时复用恢复点，核对实际结构后继续。存在未完成记录时，普通迁移入口拒绝推进版本。

数据库恢复点用于明确恢复。在线升级取消或失败时，已提交的兼容扩展与并发业务写入均予保留。


### 安装器托管实例

安装了新版宿主维护工具的实例可从命令行或[网页运维](clouddrive-deployment.md#网页运维)回退与恢复。宿主机要保留当前和目标版本的本地镜像，或按[离线检查与升级](clouddrive-deployment.md#离线检查与升级)导入签名包。缺少镜像或验证失败时，任务在停服前结束。

1. `install.sh backup --full` 创建完整恢复点。记录返回的编号，使用 `install.sh status` 核对对应版本与时间。SQLite 单独备份仍按人工流程恢复。
2. `install.sh rollback --offline` 验证上一版本的全部迁移集。兼容时保留当前 SQLite、用户文件和传输数据。
3. 需要恢复历史数据时，选定完整恢复点，用 `install.sh restore --offline --backup-id ID --confirm-restore ID` 确认恢复。执行器将归档解包到同一文件系统中的独立目录，核对摘要、版本和数据库兼容性后切换数据与应用配置。
4. 恢复后核对实际服务版本、浏览器登录、抽样文件和 WebDAV。就绪检查失败会保留恢复现场，原数据目录和应用配置位于该任务对应的宿主恢复目录。
