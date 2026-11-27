# NeoCloud 改名与升级

## 已有发行版升级

先确认当前版本、安装类型、数据目录和独立备份。发布工作流在 v0.3.4 使用桥接产物格式，后续版本默认使用 NeoCloud 产物格式。通过原有命令升级到发布说明指定的桥接版。旧工具识别旧产物契约，切换版使用新的签名产物。两个阶段沿用同一个 GitHub 发布源及签名身份。

原生实例从已校验的桥接包提取稳定宿主，停掉原服务后换入宿主，沿用现有实例目录和启动参数。Windows 原服务仍以 `CloudDriveNative` 登记时，切换宿主时保留旧程序名，或加 `--service-name CloudDriveNative` 明确指定。旧 Docker 安装器升级桥接版后，在启用网页运维的实例中执行 `install.sh update-maintenance --release-dir <已验签的桥接版目录>`。切换后核对 `/readyz`、`/build`、管理员登录、抽样文件和 WebDAV。

## 原生实例停机改名

在实例目录以外放置配套 `neocloud` 程序，沿用实例服务账号与环境。旧、新目录需要位于同一父目录。以下示例假定已有签名托管实例和可读取的本地签名缓存。

```text
neocloud rename-instance plan --root <旧目录> --target <新目录>
neocloud rename-instance apply --root <旧目录> --target <新目录>
neocloud rename-instance status --root <旧目录> --target <新目录>
neocloud rename-instance rollback --root <旧目录> --target <新目录>
```

只读预检会报告版本、包类型、复制字节和目标目录。执行前停止原生宿主及业务进程。经摘要校验的完整副本在同一文件系统上切换，原目录保留并加隔离标记。新版程序启动前复核签名及现有配置。推荐先核对新路径下的服务注册，保留其账号、端口、权限和启动参数，再启动新服务。许多系统服务标识由部署者登记，改名时同样需要切换注册名。启动后核对就绪地址、登录、下载和已有上传是否可续传。

在实例目录内的数据库、内容与暂存使用相对路径。已有绝对路径若指向实例内部，应先改为解析结果相同的相对路径。外部路径保持原值。当前自动重绑定支持实例内 SQLite。若数据库在外部，而内容或暂存位置随目录移动，改名工具会拒绝，须保留这些原有数据位置或另行设计受控迁移。

回退时停止新服务，从当前活动数据生成回到旧目录的完整副本，切换服务注册和启动参数后验证。改名之前的原副本仍可用于恢复，但其中的数据只覆盖原改名时间点。

## Docker Compose 项目停机改名

先用已验签的桥接包完成 `update-maintenance`。新版维护工具校验正式包、本地镜像、挂载、目标项目是否占用及在途任务后，才会停服。以下流程使用原安装目录以及同一份数据。

```text
neocloud-maintenance rename --action plan --root <已有安装目录> --target <新项目名>
neocloud-maintenance rename --action apply --root <已有安装目录> --target <新项目名>
neocloud-maintenance rename --action status --root <已有安装目录> --target <新项目名>
neocloud-maintenance rename --action rollback --root <已有安装目录> --target <新项目名>
```

目标使用形如 `neocloud-0123456789ab` 的项目名。迁移先制作完整恢复点，并保留旧项目归属记录。回退复用当前数据，保持迁移后的写入。当前工具仅支持同目录和未启用 systemd 网页运维的实例。安装目录迁移及已启用网页运维的实例会在预检退出。

## 标识与回退

新实例示例使用 `NEOCLOUD_APP_` 和 `NEOCLOUD_`。可在桥接及回退时继续读取旧环境变量，发现同一逻辑字段含有不同值时需先更正定义。浏览器沿用原域名才能看到先前的 Cookie 和同源数据。用户设置的站点名称及图标保留。
