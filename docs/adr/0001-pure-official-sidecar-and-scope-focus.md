# 0001: 采用纯官方 Sidecar 规范与作用域聚焦（Scope Focus）模型

- Status: accepted

在 Antigravity 2.0 桌面端中，辅助栏 Web UI 运行在受控的 `iframe` 内。官方 `sidecar_sdk` 原生提供 `workspace-change`、`theme-change`、`conversationId` 与 `agentapi` 接口，但并未公开直接读写或改写桌面端对话框上方原生分支选择控件的接口。

我们决定严格遵守纯官方 Sidecar 规范与本地文件系统监听，**不引入**通过 CDP（`DevToolsActivePort`）向 Electron 渲染进程探测或注入脚本的宿主侵入层；并将面板内的 Worktree 切换建模为“作用域聚焦（Scope Focus）”——点击任意 Worktree 立即切换面板内的拓扑图、分支操作与暂存区目标，同时高亮标记 `Conversation-Bound Worktree` 并提供“以该 Worktree 开启新对话”的显式联动。

## Considered Options

- 引入 CDP 渲染进程注入层强行驱动对话框原生控件（被拒绝：跨 Antigravity 版本脆弱、破坏安全边界，且维护成本高）。
- 仅限制在当前对话所在目录做 branch checkout，不允许面板切换聚焦到其他隔离 Worktree（被拒绝：无法解决并行多智能体 Worktree 的全局观测与清理痛点）。

## Consequences

- 当用户在桌面端对话框上方或任意终端切换分支/创建 Worktree 时，面板通过监听 `.git/HEAD`、`refs`、`.git/worktrees` 与 `workspace-change` 实时同步状态；
- 当用户在面板中选定另一个 Worktree 时，面板可操作该目录的 Git 状态，但若需让 AI 对话上下文也切过去，用户需点击「在该 Worktree 开启新对话」（由 `agentapi` 触发）。
