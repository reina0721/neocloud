# 开发验证策略

本页是日常与完整验证的唯一流程 authority。日常选择与影响匹配的检查；主分支、发布和显式完整验收保留全量覆盖。局部通过只证明实际范围。

## 日常入口

从仓库根目录执行，需要项目 Go 工具链与 Node 24；前端使用 pnpm 10.22.0：

```bash
node scripts/verify-changed.mjs --dry-run
node scripts/verify-changed.mjs
node scripts/verify-changed.mjs --base origin/main
node scripts/verify-changed.mjs --race
node scripts/verify-changed.mjs --browser apps/web/e2e/authentication.spec.ts
node scripts/verify-changed.mjs --browser file-tests/time-zones.spec.ts --browser-config playwright.files.config.ts
```

浏览器真实后端配置需要先按[文件管理说明](../operations/file-management.md)准备独立预览。没有自动生成账号或迁移用户数据库的隐式步骤。`--browser` 可重复；不存在的配置、用例和空选择必须失败。

`--dry-run` 输出计划，不安装、生成、构建、测试或写报告。`--classify` 只读取 Git 与工作区元数据，输出 CI 分类 JSON。`--scope backend|frontend|docs` 用于 CI 分流，不代替默认入口的总体范围判断；手动限制范围时须明确其余检查未执行。`--go-executable <path>` 可选择已有 Go。

## 范围和扩大条件

| 改动                                    | 默认检查                                                                                            |
| --------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 纯 Markdown/规则                        | 文档链接、索引和可达性；交付前检查 Diff 空白                                                        |
| 局部 Go                                 | 改动包与反向调用方（包含测试导入）的 test、vet、改动文件格式                                        |
| 并发与生命周期                          | 上述范围增加 race；kernel/composition/bootstrap 和并发底层能力自动启用                              |
| 局部前端                                | 轻量治理与生成 freshness、改动文件 lint/格式、所属工作区与使用方的类型和单元测试；交互按需选择 spec |
| 共享组件、Token、Adapter                | 完整前端、生产构建/预算、现有完整浏览器门禁                                                         |
| API/HTTP 生成输入                       | 双端完整检查与生成一致性                                                                            |
| 依赖、构建/测试配置、删除包、跨平台源码 | 扩大相关栈；无法证明归属时扩大双端并说明原因                                                        |

Git 集合包含提交基线、暂存、未暂存、未跟踪、删除与改名两端；错误 ref 或图读取失败不能当作零变更。首次无基线明确扩大。`docs/` 内的可执行工具或生成输入不因目录名而跳过。

包依赖图不能证明授权、文件保存/删除、迁移或浏览器交互正确；这些改动仍须对应真实链路及失败场景。模拟、拦截契约、真实后端的证据分开报告。不得提高截图阈值、跳过失败断言或自动接受视觉基线来提速。

## 准备与完整回归

日常验证不隐式安装依赖。需要时明确加 `--prepare`；准备时间与验证时间分开看。前端完整入口保留：

```bash
bash scripts/verify-webui.sh --prepare  # 首次准备或依赖/浏览器需要更新
bash scripts/verify-webui.sh            # 已准备环境的完整前端检查
bash scripts/verify-quality.sh          # 完整后端、生成、race、构建与产物检查
node scripts/verify-changed.mjs --full  # 双端完整回归
```

PowerShell 对应 `Verify-WebUI.ps1 -Prepare` 和 `Verify-Quality.ps1 -GoExecutable <path>`。依赖使用冻结锁文件，准备失败直接停止。源码与业务完整验收以本地入口为准。手动 CI 使用对应验证流程，正式发布使用独立的产物检查。

两种后端入口共用 `scripts/verify-go-format.mjs`，按 Git 清单检查已跟踪和未忽略的新 Go 源码。忽略目录中的运行诊断、临时 checkout 不参与格式门禁；Git 或 gofmt 执行失败仍会终止验证。

普通 Go 测试使用原生结果缓存；明确重现、外部数据库/文件服务和完整回归可用 `-count=1`。缓存不能证明外部环境的当前状态。前端依赖筛选使用 pnpm 原生反向依赖，不自建另一套缓存或前端依赖图。

Windows 完整后端门禁将普通测试和 race 按包串行执行（`-p 1`），避免受限子进程与真实数据库、调度器的集成测试争抢 runner 资源；保留原有用例、资源上限与等待预算。归档内存夹具让父进程安装的限制与子进程声明的最小预算一致，再实际请求两倍预算的分配。

Windows 热重载夹具通过原子替换发布候选配置，仅对并发读取时 Windows 可能返回的 `ERROR_SHARING_VIOLATION`、`ERROR_ACCESS_DENIED` 有界重试；不先删除旧文件，不延长恢复断言预算。原生 Windows 用例会持续占用删除共享，确认重试终止后旧配置与候选配置均完整保留。

SQLite 等私有数据夹具使用 `testkit.PrivateTempDir`，不依赖测试进程的 umask，不放宽生产目录权限校验。仓库源码边界检查跳过运行数据、依赖与构建目录，不遍历已有生产数据库。

## 停止条件、耗时与证据

本次验收与必要回归通过后结束。只有相关源码、依赖、配置、工具/环境变化或新增覆盖缺口才重跑对应检查；只补任务说明或准备提交不重跑已通过代码检查。交付说明列明范围、命令、结果、未运行项及原因。

调度器区分通过、失败、取消与超时，把每步退出状态、参数和耗时写入忽略目录 `.data/validation/`，不保存环境快照、凭据或原始输出。报告用于追溯，不根据同名文件或旧成功自动跳过测试。日常步骤默认上限 15 分钟；完整前端套件为 90 分钟、完整后端套件为 45 分钟，以覆盖数百浏览器用例及全量 race，仍保留超时与取消。取消时终止拥有的命令树并等待，失败与报告写入失败均保留。

截图使用 Playwright 每用例 outputPath，trace/截图/下载放入忽略的 test-results，不输出到文档目录。 CI 失败附件同时保留截图、trace 与错误上下文；原生浏览器取证任务先重复验证后端注册的最终落地与账号菜单，再执行视觉矩阵，并在 320、390px 重复检查日历与批量确认的无障碍语义。DatePicker 与确认浮层均先通过现有 `waitForVisualReadiness` 等待字体和有限入场过渡，再运行完整 Axe 对比度检查，避免把淡入时与底层控件混合的颜色当成最终呈现。独立 Windows 生命周期取证在 race 下重复验证保存分享、重启及终止排空，以及配置替换和读取占用；沿用用例原有断言预算。跨文档导航用例应等待最终业务路由和页面就绪；后端模式的 `/` 会继续重定向到 `/home`，中间地址不代表导航完成。 网络拦截夹具在释放受控请求后使用 `unrouteAll({ behavior: 'wait' })` 等待在途处理器，完成清理后再关闭浏览器上下文，不忽略处理器错误。先测量准备、类型检查、测试、构建与浏览器耗时，再决定进一步优化；不在缺少证据时承诺提速百分比。

## CI

自动 `Quality` 在 PR 和 `main` push 执行工作流语法、文档链接和仓库产物检查。涉及 OpenAPI 的 PR 比较基分支契约。普通分支的 push 由对应 PR 提供检查结果。

在 Actions 的手动入口可以运行完整 `Quality`、`Database`、`Container` 和 `Visual review`。它们保留原有平台矩阵、业务用例、fuzz、浏览器和安全扫描。本机工具版本见 `scripts/tool-versions.env`。发布 tag 核对经过本地完整验收的源提交并启动 [Release 产物检查](../operations/release.md#正式发布)。
