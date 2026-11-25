# clouddrive 前端启动

当前只运行 frontend/ 下的 console-web 工作区。旧 Vite WebUI 的静态托管、5173 端口、webui build/generate 命令及模块内浏览器源码已退出运行链。

请按 [本地开发](local-development.md) 启动 Next.js（4173）和 Go（8080/9090）。菜单、权限及模块元数据仍由后端维护；导航目录由 console-web 插件目录生成，菜单隐藏不改变接口权限。

在管理侧栏打开“接口调试”进入 API 工作台。查找账号使用“用户”，打开详情后可执行当前权限允许的账号操作。原账号管理地址也进入同一用户列表。“权限目录”用于查阅原生权限，在角色详情修改授权。

[生产部署](../operations/clouddrive-deployment.md)；[前端工程说明](../../frontend/README.md)。
