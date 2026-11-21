# 0001: 采用纯官方 Sidecar 规范与作用域聚焦（Scope Focus）模型

- Status: accepted (revised after #2 and #5)

在 Antigravity 2.0 桌面端中，辅助栏 Web UI 运行在受控的 `iframe` 内。官方 `sidecar_sdk` 提供 `workspace-change`、`theme-change`、`conversationId` 与 `agentapi` 接口，但不提供读写或改写对话框上方原生分支控件的接口。`#2` 实测同时确认，`agentapi new-conversation` 与 `SidecarApp.startConversation` 均不接受工作区目录参数，无法直接为任意本地目录创建已绑定工作区的新对话。

我们决定严格使用纯官方 Sidecar 规范与本地文件系统监听，不引入通过 CDP（`DevToolsActivePort`）向 Electron 渲染进程探测或注入脚本的宿主侵入层。面板内的 Worktree 切换建模为作用域聚焦（Scope Focus），点击任意 Worktree 立即切换面板内的拓扑图、远程同步、分支操作与暂存区目标。对话联动按绑定状态分层处理：高亮标记 `Conversation-Bound Worktree`，对含 `Linked Conversation` 的托管工作树提供一键跳转原对话，对无绑定对话的 Worktree 提供路径与上下文 Prompt 复制、系统文件管理器定位和辅助栏文件预览。

## Considered Options

- 引入 CDP 渲染进程注入层强行驱动对话框原生控件（被拒绝：跨 Antigravity 版本脆弱，破坏安全边界，且维护成本高）。
- 仅允许在当前对话所在目录做 branch checkout，不支持切换聚焦到其他隔离 Worktree（被拒绝：无法观测和清理并行的多 Worktree）。
- 对未绑定对话的 Worktree 强行调用 `agentapi new-conversation` 在原项目下发提示消息（被拒绝：新建对话的宿主 `Workspace` 仍停留在原目录，会造成工作区绑定状态与面板显示不一致）。

## Consequences

- 当用户在桌面端对话框上方或任意终端切换分支、增删 Worktree 时，面板通过监听 `.git` 目录、`refs`、`.git/worktrees` 与 `workspace-change` 实时同步状态。
- 在面板中选定其他 Worktree 后，可直接操作该目录的 Git 状态。含 `Linked Conversation` 的 `Managed Worktree` 可通过 `window.sidecar.ui.toggleConversation` 切回原对话；无绑定对话的 Worktree 需借助复制路径或带目录说明的 Prompt 模板配合手动切换工作区，并可通过 `toggleAuxPane(fileView)` 在辅助栏查看变更文件。
