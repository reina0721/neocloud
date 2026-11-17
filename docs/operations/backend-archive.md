# CloudDrive 独立 Go 后端归档

此说明随 Windows/Linux amd64 Go 下载归档交付。归档包含后端程序、示例配置、默认语言资源、OpenAPI、来源及许可，不包含 Next.js Web Host。

需要完整文件工作区时，优先使用 [GitHub Release 的 Docker 安装包](https://github.com/reina0721/neocloud/releases/latest)。源码与贡献方式见 [CloudDrive 仓库](https://github.com/reina0721/neocloud)。

## 运行后端

解压到独立目录，先审阅配置。正式接入前按[部署说明](https://github.com/reina0721/neocloud/blob/main/docs/operations/clouddrive-deployment.md)设置认证、数据库、存储和受信监听范围；management 端口仅供受信网络使用。在线文档可在 GitHub 选择与归档对应的 tag 阅读。

```bash
./clouddrive --help
cp config.example.yaml config.yaml
mkdir -p -m 700 .data
# 按实际环境修改 config.yaml，再运行迁移与服务
./clouddrive db migrate up
./clouddrive
```

Windows PowerShell 使用 `Copy-Item config.example.yaml config.yaml` 复制配置，预先准备受当前账号保护的 `.data` 目录，并通过 `.\clouddrive.exe` 执行相同命令。所有命令从解压目录运行，保留语言文件的相对路径。已有实例的配置、数据库、用户文件和存储身份必须保留；升级前备份，不用新示例覆盖实际配置。

## 校验与许可

归档随 Release 提供 SHA-256 清单、SPDX SBOM 和签名 bundle，验证方式见[发布说明](https://github.com/reina0721/neocloud/blob/main/docs/operations/release.md)。Go 归档与配套 Web Host 应来自同一版本和 source commit。

项目许可见归档根 `LICENSE` 和 `NOTICE`；依赖许可及需要附带的源码保留在 `third-party/`，来源快照见 `SOURCES.json`。使用问题见[支持指南](https://github.com/reina0721/neocloud/blob/main/SUPPORT.md)，潜在漏洞见[安全政策](https://github.com/reina0721/neocloud/blob/main/SECURITY.md)。
