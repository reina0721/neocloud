# Navigation 模块

Navigation 管理已注册菜单的启停、标题、显示权限、父级及排序。生产目录由前端插件贡献生成，Go 通过 `binding/consolecatalog/` 嵌入同一目录。Web Host 消费生效后的菜单策略。

## 边界

- `service/` 通过调用方定义的 `NavigationCatalog` 窄端口读取静态定义并校验策略投影。
- `repo/` 与 `binding/migration/` 独占 `navigation_menu_policies` 及 `navigation_schema_migrations`。
- `handler/` 与 `binding/http/` 提供菜单读取、策略修改和稳定错误语义；修改请求复用 composition 提供的 IAM Session Origin/CSRF 守卫。
- 菜单管理页面经现有控制台接口读取策略，保存后刷新 Host 导航。
- `binding/permission/` 贡献 `navigation:menu:read` 与 `navigation:menu:write`。

数据库保存静态导航 ID 对应的呈现策略。禁用菜单只影响菜单投影，已注册路由和服务端授权继续有效。每次菜单读取使用一致的策略快照。

目录内容修订随生成内容变化。对于已审阅、保持策略兼容的展示变更，适配器可按精确内容摘要指定原策略修订。读取与写入仍校验策略归属及层级，兼容发布期间新写入沿用原策略修订，便于旧版本回退。其他目录修订继续按当前校验规则处理。Go 与 Web 目录应配套发布。
