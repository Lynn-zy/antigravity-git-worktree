# 0001: 采用纯官方 Sidecar 规范与宿主工作区被动跟随模型

- Status: accepted (revised after #7)

在 Antigravity 2.0 桌面端中，辅助栏 Web UI 运行在受控的 `iframe` 内。官方 `sidecar_sdk` 提供 `workspace-change`、`theme-change`、`conversationId` 与 `toggleAuxPane(fileView)` 接口，不提供改写对话框上方原生分支控件的接口，也不提供独立的 `gitDiff` 视图类型或按目录创建新对话的参数。

经 `#7` 交互原型评审，我们决定严格使用纯官方 Sidecar 规范与本地文件系统监听，不引入通过 CDP（`DevToolsActivePort`）向 Electron 渲染进程探测或注入脚本的宿主侵入层。面板采用宿主工作区被动跟随模型：当用户在 Antigravity 中切换对话、工作树或分支时，面板自动同步更新上方的 `Working Tree Changes` 与下方的 `Commit Graph`。点击任意改动文件或历史提交展开的文件，统一调用宿主原生 `window.sidecar.ui.toggleAuxPane({ tabType: 'fileView', uri })` 打开，不在插件内自建 Diff 查看器。

## Considered Options

- 引入 CDP 渲染进程注入层强行驱动对话框原生控件（被拒绝：跨 Antigravity 版本脆弱，破坏安全边界，且维护成本高）。
- 在辅助栏内提供三 Tab 多 Worktree 作用域切换、Worktree CRUD（新建、锁定、清理）及跨对话跳转（在 `#7` 原型评审后撤回：窄幅辅助栏交互过重，超出实际使用诉求，且宿主本身已承担工作树与对话切换）。
- 在面板内自建 Unified Diff 抽屉以补充历史提交差异查看（在 `#7` 原型评审后撤回：用户优先轻量简洁，文件查看统一交给宿主原生 `fileView`）。

## Consequences

- 当用户在桌面端切换对话、Worktree 或分支，或在终端操作 Git 时，面板通过 `workspace-change` 与 `.git`、工作区文件监听自动刷新当前上下文的更改列表与提交图谱；顶部常驻对齐 VS Code「存储库」视图的仓库列表，用于查看各仓库的分支与同步状态并切换当前仓库。
- 面板专注 VS Code 风格的上下双区交互（上区暂存、放弃更改、提交与提交后切换为同步更改；下区提交拓扑图、原地展开文件列表与最小遮挡悬浮提交详情卡），不再承担 Worktree 生命周期管理或自定义 Diff 渲染。
