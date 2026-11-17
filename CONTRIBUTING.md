# 参与 CloudDrive

欢迎提交可复现的问题、使用经验和有明确目的的改进。使用问题见[支持指南](SUPPORT.md)，潜在漏洞见[安全政策](SECURITY.md)。交流请围绕事实与代码，尊重参与者，不发布他人信息或敏感数据。

## 开始开发

先阅读[项目范围](docs/repository-scope.md)、[文档入口](docs/README.md)及目标模块说明；工程约束见根 [AGENTS.md](AGENTS.md)，前端还有[补充规则](frontend/AGENTS.md)。保留现有前后端边界，业务依赖消费方需要的窄契约，由 composition 显式装配。

开发需要 Go 1.26.11、Node 24、pnpm 10.22.0。从仓库根目录执行 `node scripts/dev.mjs --prepare`，跨平台命令、配置与首次初始化见[本地开发](docs/getting-started/local-development.md)。公共仓库贡献可先 fork，再从最新 `main` 创建主题分支。

## 修改与验证

- 一次 PR 围绕一个问题，说明触发条件、修改后的行为及必要的兼容或迁移影响。
- 保留已有数据库、用户文件、存储身份和来源记录；真实验收使用隔离实例，测试产物放在忽略目录。
- 不提交凭据、Token、完整 DSN、生产日志、本地配置、数据库、依赖目录和构建产物。
- 行为变化同步更新所属主题说明；生成契约通过既有生成链更新，不手改生成物。

```bash
node scripts/verify-changed.mjs --dry-run
node scripts/verify-changed.mjs
git diff --check
```

完整回归、浏览器与外部依赖前置以[验证策略](docs/development/validation.md)为准。PR 列出实际执行的命令与结果，区分模拟、真实服务和未执行平台。失败时保留原因，不放宽断言或直接接受视觉基线。

## 提交和评审

采用 Conventional Commits，例如 `fix(files): preserve upload cancellation errors`、`docs(deploy): clarify backup recovery`。提交主题使用英文祈使句，正文与说明以中文为主。提交前审阅 diff，只暂存本次相关文件；Agent 的收尾步骤见[提交技能](.agents/skills/git-conventional-commit/SKILL.md)。

PR 应包含问题与结果、关联 Issue（如有）、验证结果，以及用户可见变化的必要截图或复现步骤。合入前须通过相应 CI 并解决评审意见。涉及 API、迁移、权限和存储时，明确兼容性与数据保护方案。

提交贡献即按根 [Apache-2.0 许可证](LICENSE)提供贡献，已有第三方版权与许可须保留。产品版本由维护者按[发布流程](docs/operations/release.md)创建，普通贡献不创建发布 tag、不上传产物。
