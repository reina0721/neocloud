# 安全政策

## 私密报告

潜在漏洞请使用 [GitHub 私密漏洞报告](https://github.com/reina0721/neocloud/security/advisories/new)。此入口已启用；请勿在公开 Issue 提交凭据、利用细节或生产数据。

报告请包含受影响的 tag/commit、部署环境、影响范围、最小复现步骤和可行的缓解措施。使用脱敏数据，不要上传真实密码、Token、会话或用户文件。如入口暂不可用，可在公开 Issue 中仅询问私密联系方式，不提供漏洞细节。

## 版本与响应

NeoCloud 处于 0.x 迭代阶段，安全修复以新的正式 [GitHub Release](https://github.com/reina0721/neocloud/releases)交付。建议使用最新正式版；尚未承诺旧版本回补、长期支持周期或响应 SLA。开发分支与本地候选不等同于正式安全更新。

维护者先评估可达路径和影响，协调复现、修复与披露；修复说明应列明受影响版本、升级或迁移要求及临时缓解。凭据泄露须立即撤销或轮换，删除 Git 文件不能撤销凭据。内部处置和现有认证授权边界见[安全响应手册](docs/operations/security.md)。
