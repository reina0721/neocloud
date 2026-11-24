# Kira · Material UI 视觉与交互规范

CloudDrive 使用 **Material UI（MUI）** 作为实际组件库，在 `packages/ui-adapter` 内二次封装。文件、管理、登录、公开分享及内部组件示例消费同一套语义组件。颜色、密度、形状和动效数值以 `packages/design-system/design-system.schema.json` 为唯一来源；生成 CSS 与 JavaScript 参数共同消费这份 Schema。

## 设计参考与表达

核心参考为 [kirakira.moe](https://kirakira.moe/) 的首页、搜索及外观设置：白色轻表面、粉色几何横幅、纤细图标侧轨、品牌星芒、轻量阴影、下划线章节导航和短距离淡入。CloudDrive 使用自己的品牌、图形与内容，不复制参考站的视频内容、人物素材或标志。

Material 的交互语义以 [MUI 组件](https://mui.com/material-ui/getting-started/overview/)与 [Material 3 色彩角色](https://m3.material.io/styles/color/roles)为基础。几何横幅、文件卡片和产品导航由 Surface Foundation 组合，不将视频站的信息架构直接套用到文件操作。主要动作保持显著，内容阅读区克制使用装饰。

## 实际组件库与隔离

- 按钮、输入、选择、自动补全、单选、复选、开关、Tab、BottomNavigation、Dialog、Drawer、Menu、Tooltip、Popover、Progress、Avatar、Accordion 和 Paper 使用 MUI。
- 日期控件使用 MUI X Date Pickers 与 Dayjs adapter；公开值仍为 `YYYY-MM-DD` 或 null，第三方日期对象不穿越 Adapter。
- 表格与树保留 React Aria 的成熟集合交互，Material Table、排序和按钮参与组合，保留列宽调整、固定列、键盘选择及按需展开。ToggleGroup 使用相同的成熟选择机制与 MUI ToggleButton。
- 通知使用 notistack 的有界可见队列和 MUI SnackbarContent，首次通知时加载渲染器；加载期间支持入队、关闭和清空，业务子树保持稳定。业务只调用现有 Feedback 契约。
- HeroUI 依赖和 CSS 已退出。边界检查禁止恢复其导入；业务不能直接导入 MUI、Emotion 或 notistack。Host 仅在根 layout 装配官方 Next SSR Cache。
- 按 [MUI Next 集成](https://mui.com/material-ui/integrations/nextjs/)使用 `AppRouterCacheProvider` 收集流式 SSR 样式。按 [MUI/Tailwind 集成](https://mui.com/material-ui/integrations/tailwindcss/tailwindcss-v4/)声明 `theme → base → mui → components → utilities`，项目语义样式拥有明确优先级。
- 项目组件规则位于 `@scope ([data-ui-system='kira'])`；根 html 是设计边界，Portal 仍在同一边界内。禁止加载历史主题表、vendor 全局主题或以页面 CSS 覆盖基础组件。

手机导航由 Adapter 的 `MobileNavigation` 封装实际 MUI BottomNavigation，文件工作区与管理 Shell 共用；导航示例页在窄屏下的底部目的地就是同源运行示例。断点由 CSS 决定，仅在底部预留区可见时加载渲染器，桌面不加载这份移动导航脚本。

`MaterialThemeProvider` 只映射 Token 与 MUI 的公开主题 API，不提供万能 props 转发。交互组件公开业务需要的语义接口，不向消费方暴露 vendor DOM、slot、具体类型或内部类名。

## 字体与排版稳定性

Host 随构建自托管 Inter Variable 5.3.0 和 Noto Sans SC Variable 5.3.1，均来自 Fontsource，使用 OFL-1.1；许可证随公共资源分发于 `/fonts/licenses/`。字体家族仍由 Design System Schema 的 `fontSans` 声明，根样式只装配资源，Adapter 与业务继承同一 Token。CSS 使用 unicode-range 按实际字符加载字形分片，不请求第三方字体服务。加载失败仍可使用系统回退字体，但正常产品与截图验收必须实际加载两种分发字体。

应用样式保持原有 48KiB gzip 预算；自托管字体声明单独限制为 40KiB gzip，完整字体文件限制为 6MiB，同时报告总 CSS。登录首屏实际字体下载上限为 512KiB。浏览器契约验证真实 FontFace 加载与同源请求；视觉截图等待 `document.fonts.ready`。各平台基线逐张审阅，保持现有截图阈值，不能用机器上的系统字体差异代替产品字体交付。

## 色彩、形状与密度

| 语义角色                       | Material 职责             | 产品用途             |
| ------------------------------ | ------------------------- | -------------------- |
| canvas                         | surface container low     | 页面画布             |
| surface                        | surface                   | 内容、表单和阅读区域 |
| surface-muted / surface-raised | container / high          | 搜索、辅助内容和浮层 |
| brand / on-brand               | primary / on primary      | 主要动作、品牌与标题 |
| brand-soft                     | primary container         | 轻量选中态与预览     |
| ink / ink-muted                | on surface / variant      | 正文与辅助说明       |
| border / border-strong         | outline variant / outline | 分区与可交互边界     |
| danger / danger-soft           | error / error container   | 失败与破坏性操作     |

默认樱花粉使用具有文字对比度的深粉主色，浅粉用于装饰与容器；既有紫、蓝、绿、橙色偏好保留。浅色背景以白色为主，深色使用暖灰层次。主题与强调色同时作用于 Portal、日期、焦点、进度和确认动作。

标准字段圆角 8px、内容容器 10px、Shell/Dialog 20px；按钮保持 Material 的 full 形状，导航项使用轻量小圆角。标准控件高 44px，小型控件 36px，明确的窄屏导航、图标和日期控件按各自可用空间安排。紧凑与宽松 Profile 独立于字号、主题和内容宽度。所有数值从 Schema 或产品层几何 Token 获取。

每个交互组件必须具备 hover、pressed、keyboard focus、selected、disabled、pending 和 error 状态。焦点有独立可见轮廓；颜色不能成为状态的唯一信号。对比度检查覆盖浮层、悬停、深色与各强调色。

## 页面与导航

`ProductMasthead` 是产品品牌横幅，接收品牌名、说明和可选动作槽；文件、管理、登录与公开分享使用同源实现。`PageHeader` 维持一个一级标题、简短描述与页面动作。Section、Toolbar、Collection、SettingsLayout 与 StateSurface 统一组合内容。

桌面文件工作区使用粉色横幅、横向文件类型导航与默认 80px 图标侧轨；展开侧栏后提供目录树、固定项、回收站、协作、任务和管理。已有账号保存的展开偏好保持不变。

导航图标槽统一 24px，展开导航中的图标左边界与品牌标志共线，行尾目录动作与 44px 收缩按钮共线。侧轨隐藏滚动条而保留键盘与滚动行为，避免滚动条占宽使图标相对顶部按钮偏移。类型导航使用 MUI Nav Tabs，路径栏使用 MUI Breadcrumbs，工具栏使用 MUI Toolbar；不以链接加伪元素模拟这些组件。

小于 768px 时切换信息架构：隐藏横幅、桌面侧轨和类型栏，使用 56px 品牌任务栏、紧凑搜索行和带安全区的 56px 底部目的地导航。分类入口打开完整导航抽屉；搜索入口直接聚焦搜索框。目录标题、全选与数量位于同一行，路径通过祖先菜单访问，排序、视图和搜索工具保持单行；手机网格为两列，640px 起使用三列，目录使用紧凑图标与名称。主内容与导航分别拥有滚动边界，不把桌面横向工具栏缩进手机。

手机设置使用自己的 56px 分类任务栏，关闭动作回到文件工作区；隐藏全局 Shell 导航和页面 Tab。主题与强调色按独立章节呈现，横向预览行保留真正的 RadioGroup 选择语义。普通任务 Dialog 与表单 Drawer 使用完整手机视口；导航 Drawer 保留边缘上下文。PDF 工作区在手机和短横屏使用全屏阅读布局，编辑工具按需展开，查找输入独占可用行；默认按页宽显示，放大、缩小和文档导航始终可达。

文件列表保留多选、上下文菜单、键盘选择、排序、分页、拖拽与队列状态。网格卡片使用低阴影和轻选中边界；没有内容的目录提供实际下一步，读取失败不能显示成空目录。页面链接保留复制地址、在新标签页打开和 `aria-current`。

音乐播放器与账户入口在各断点共用同一个挂载位置，利用布局顺序响应屏幕宽度，禁止同时挂载两套后再以 CSS 隐藏。播放器保留顶部图标入口和 48px 主播放键。底栏、悬浮和全屏共用一个音频节点，停止动作负责释放资源。

管理导航仍按用户权限呈现。提交路由、导航就绪或切换展开模式时，将当前项定位到导航自己的可视区域；用户开始探索后停止自动拉回。设置页采用稳定的分类导航和内容区，主题及调色板通过无交互预览卡比较，真正的选择语义由 RadioGroup 提供。

## 动效

控件快速反馈为 140ms，浮层与异步反馈 220ms，页面转场 320ms。位移以短距离和透明度表达连续性；品牌装饰保持静止，不干扰文件操作。用途、关键帧与关闭策略见[动效规范](motion-foundation.md)。

路由提交由 Host 统一观测，不因动画重建文件 Runtime、上传队列或页面 Provider。默认向前导航轻移入，其它进入轻抬升；同路由 Tab 内容替换使用 ContentSwapTransition。用户选择关闭或系统减少动效时，所有相应动画降级。焦点、取消和请求结果不等待装饰动画才能生效。

## 同源示例与验收

组件状态从 `/ui-elements/*` 进入，页面组合从 `/page-patterns/*`、`/page-archetypes/*` 进入；示例与实际业务使用相同 Adapter 和 Token。不得专门为截图重建控件或提高截图差异阈值。

结构检查包括 `foundation:check`、`architecture:check`、`dependency:check` 和生成 freshness。完整门禁按[统一验证策略](../../docs/development/validation.md)执行。真实 Go 文件预览使用 `node scripts/dev.mjs --preview`，再按 `playwright.files.config.ts` 验证文件闭环、导航和权限；模拟/拦截结果不得当成真实集成。

桌面、窄屏、短屏、浅色、深色、英文、焦点和打开的浮层分别观察。截图通过每用例 `outputPath` 写入忽略目录；视觉基线须逐张查看后单独更新。Docker 镜像构建、容器启动和容器中真实操作分别取得证据，源码构建不能替代部署验证。

Docker 验收环境的构建、账号入口与数据保留规则见[构建与容器](../../docs/operations/build-and-container.md)。

## 文件阅读与已打开应用

文件页沿用 CloudDrive 的表面、颜色和控件尺寸。共用顶栏呈现文件名、返回、下载、最小化和关闭，低频操作使用更多菜单。正文填满剩余高度，工具栏与侧栏按文件类型组织。正文、目录和缩略图在各自区域滚动。

左下角的应用盒子按应用归组，保持固定宽度与有界高度。文件使用缩略卡片，点击卡片回到独立文件页。数量只显示在应用按钮角标，盒子内独立滚动。手机入口在底部导航上方。桌面与手机都保留清晰的键盘焦点和卡片关闭按钮。

## 音乐与视频控制

每次打开音频从折叠底栏开始。底部居中把手支持鼠标移入、触屏点按和键盘激活；顶部图标也能展开。鼠标移出时收起，正在操作滑杆或使用键盘时保留控件直至操作完成。底栏固定在视口底部，手机上贴在底部导航上缘。只有可见区域接收指针事件，文件工作区继续接收点击、滚动和快捷键。

桌面底栏单行展示曲目、进度及主控，窄屏改为两行。音量、循环、队列和停止通过「更多播放控制」展开，队列可独立滚动。悬浮和全屏保留独立的曲目信息、进度和对称的控制区。全屏竖向展示大封面及底部主控，宽屏改为双列，短横屏缩小封面并保留正文滚动与固定收纳入口。

底栏用独立按钮进入悬浮或全屏，悬浮复用 MUI Modal/Popper，全屏复用 MUI Dialog。两种视图的「收回底部」会折叠底栏并把焦点放回底部把手。底栏使用非模态区域，Escape 在控件获得焦点时收起底栏。收起和切换布局保留当前曲目、播放状态及进度。

视频小窗共用底部中央把手。音乐和视频只展示前排卡片，通过其上沿的切换按钮调出另一张卡片。展开和收起不改变文件列表高度，视频在文件页与小窗之间复用同一个播放元素。
