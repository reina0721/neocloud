# 来源记录

[排除的上游浏览器归档](excluded-source-artifacts.json)记录导入时未保留的上游产物及其摘要；其中 path 是原始归档身份，不是当前文件链接或输出目录。源码、版本和许可证来源仍以根 SOURCES.json 为准。

## 随产物交付的许可

根 `LICENSE`、`NOTICE` 与 `SOURCES.json` 进入 Go 归档及两个容器。Go 依赖由固定版本 `go-licenses` 按目标平台收集许可、声明和工具要求附带的源码，归档保留 `third-party/` 下的包路径；Go 标准库许可一并交付。工具对汇编等非 Go 依赖的分析有限，结果不能代替人工审查。

Web 生产构建使用 pnpm 10.22.0 的生产依赖清单，保留依赖内的许可文件、声明、README、包元数据及 `licenses/node/inventory.json`，覆盖服务端追踪和客户端打包依赖。字体与 PDF 资源许可继续随原资源分发。生成内容只进入忽略的构建目录，路径与验收见[构建与容器](../operations/build-and-container.md)。

当前上游发布包存在没有独立许可文件的情况，包括 `@img/sharp-libvips-*`、`@napi-rs/canvas-*`、`@next/env`、`@next/swc-*`、`@tokenizer/token`、`client-only` 和 `custom-error-instance`；`combine-errors` 的包元数据未声明许可，但 README 声明 MIT。清单保留原始情况，不推测或补造许可；实际平台以当次 inventory 为准。发布维护者仍需核对这些上游声明及所捆绑原生库的再分发要求，SBOM 和源码许可标签不能替代该步骤。
