# Antigravity 2.0 Sidecar 权限、Worktree 结构与对话联动边界调研

基于纯官方机制的 Sidecar 插件在当前 Antigravity 2.0 桌面端可以读取主 `Repository` 及其兄弟 `Worktree` 目录、`~/.gemini/antigravity/worktrees/` 下的目录以及当前对话工作区上下文，并通过 `toggleConversation` 跳转到已绑定的历史对话，但无法借助 `sidecar_sdk` 或 `agentapi` 一键创建“工作区已绑定到任意指定 Worktree 目录”的新对话。

## 一、目录与权限边界

`sidecar.json` 中存在两套语义独立的配置块，分别约束后台派生的无人值守 Agent 与 Sidecar 宿主进程本身。

| 配置路径 | 目标主体 | 核心字段 | 真实作用边界 |
| --- | --- | --- | --- |
| `agent_permissions` (`SidecarAgentPermissions`) | Sidecar 启动的 Agent 对话 | `workspace_uris`、`access_grants`、`allows_user_interactions` | 写入 `~/.gemini/config/config.json` 的 `sidecars.<id>.resolvedPermissions`，只控制受管 Agent 对话权限，不控制 Node.js 进程文件读写 |
| `sandbox` (`SidecarSandboxConfig`) | Sidecar 宿主进程自身 | `disable_sandbox`、`allow_full_network`、`read_only_paths`、`read_write_paths`、`allowed_hosts` | 约束 Sidecar 进程自身的 OS 文件与网络隔离；未配置或显式禁用时才放宽宿主进程访问 |

依据官方 Sidecars 文档 `#automations` 与 `language_server.exe` 内嵌 proto schema，`agent_permissions` 中的 `workspace_uris` 与 `access_grants` 只对 Automation 或 `agentapi new-conversation` 触发的 Agent 会话生效。`SidecarSandboxConfig` 在二进制 `sidecars/sidecar_sandbox.go`（含 `sandboxEnabled`、`sandboxPolicy`、`checkRequestedPath`）中单独校验 Sidecar 进程权限，运行期拒绝授权时会输出 `Sidecar %q: not granting read access to %q in its sandbox: %s` 与 `Sidecar %q: not granting write access to %q in its sandbox: %v`；若配置文件主动关闭沙箱，则记录 `Sidecar %q runs unsandboxed: its sidecar.json disables the sandbox`。

`sidecar.json` 的模板变量解析（`sidecars.ResolveTemplates`）不支持通用 `${HOME}` 环境变量展开，可用占位符按作用范围分为三类：

| 占位符语法 | 解析位置 | 支持范围与约束 |
| --- | --- | --- |
| `${key}` | `sidecar.json` 的 `args` 与 `agent_permissions.workspace_uris` | 仅展开同一 `sidecar.json` 内 `arguments[]`（`string_arg` 或 `workspace_arg`）的用户输入值 |
| `${flag:<name>}` | 内置 Sidecar 的 `sidecar.json` | 仅限内置实验开关（如 `swarm_board/sidecar.json`），对应正则 `\$\{flag:([a-z0-9-]+)\}` |
| `${PLUGIN_ROOT}` / `${PLUGIN_DATA}` | `mcp_config.json` 与命令 Hooks 环境注入 | 指向插件安装目录与插件持久数据目录，不替代 `sidecar.json` 对 `${HOME}` 的路径替换 |

在 `language_server.exe` 与官方 `https://antigravity.google/docs/sidecars` 中，均未发现 `ResolveTemplates` 对 `${HOME}` 做展开支持。Node.js Sidecar 进程应直接通过 `os.homedir()` 或宿主注入的 `ANTIGRAVITY_EXECUTABLE_DATA_DIR` 计算 `~/.gemini/` 路径，不要在 `sidecar.json` 中书写 `${HOME}`。

关于 Sidecar Node.js 进程能否访问主仓库兄弟目录 `../<repo>.worktrees/` 与 `~/.gemini/antigravity/worktrees/`，实测表现受运行平台和沙箱开关共同决定。依据官方文档 `https://antigravity.google/docs/sandbox` 与二进制错误串 `sandboxing on Windows requires Windows 11 24H2 or later with the August 2026 or later update: %w`，Windows 的 AppContainer 沙箱要求 Windows 11 24H2 及 2026 年 8 月更新以上版本；macOS（`sandbox-exec`）与 Linux（Namespaces）中未显式挂载的路径对沙箱内进程不可见，Windows 下其他未授权的用户目录子路径隐藏，用户目录外文件夹可读不可写。本机实测 `builtin/plugins/swarm/sidecars/swarm_board` 与第三方 `antigravity-pulse/panel` 均未声明 `sandbox` 段，两者均可直接读取 `~/.gemini/antigravity/` 及项目本地目录且 `sidecar.log` 无权限报错。工程设计上，`antigravity-git-worktree` 不应误用 `agent_permissions.workspace_uris` 或 `${HOME}` 申请磁盘权限，而应通过 Node.js `os.homedir()` 与 `Workspace` 上下文解析路径；若未来插件声明严格 `SidecarSandboxConfig`，则需配套 `workspace_arg` 或合理的 `sandbox.read_only_paths` / `read_write_paths`，避免依赖 `disable_sandbox`。

## 二、Managed Worktree 结构与 `conversationId` 关联

本机与隔离临时仓库实测表明，`~/.gemini/antigravity/worktrees/` 下并非全部都是合法 Git `Worktree`，扫描逻辑必须做结构校验。

| 目录形态 | 实测路径示例 | `.git` 结构 | `git worktree list --porcelain` 可见性 | 语义判定 |
| --- | --- | --- | --- | --- |
| Native Swarm `share` 模式目录 | `~/.gemini/antigravity/worktrees/60415e43-.../swarm-w1-core-ui-fa5eb755` | 无 `.git` 文件或目录 | 仅列出主 `Repository`（如 `D:/private/awara`），不包含该子目录 | 非 Git Worktree，仅为 Swarm 共享工作副本 |
| 对话 `New worktree mode` / `branch` 模式 | UI `createWorktree` 返回的 `worktreeDirUri` | 标准 Git Worktree `.git` 文本文件 | 主 `Repository` 的 `worktree list` 可见 | 合法的 `Managed Worktree` 或 `Conversation-Bound Worktree` |
| 常规兄弟目录 Git Worktree | `../main.worktrees/feat-1` | `.git` 文件内容为 `gitdir: .../main/.git/worktrees/feat-1` | 输出 `worktree`、`HEAD` 与 `branch`（或 `detached`） | 标准外部 `Worktree`，主 `.git/worktrees/<id>/gitdir` 反向指回 `.git` |

本机检查 `C:\Users\linse\.gemini\antigravity\worktrees\60415e43-37ef-4c45-9f2e-9b044bd8767c\` 时，目录内 9 个 `swarm-*` 子目录的 `has.git` 全为 `false`，且对应 `d:\private\awara` 仓库的 `.git\worktrees\` 为空；对照 `brain\60415e43-...\swarm\members.json` 确认其模式为 `"workspace_mode": "share"`。在隔离临时仓库运行 `git worktree add -q -b feat-1 ..\main.worktrees\feat-1` 则实测证实，真实 Git Worktree 根目录的 `.git` 是单行文本文件，指向主 `Repository` 内的 `.git/worktrees/<id>`，主仓库侧的 `gitdir` 文件反向记录 `<wt>/.git` 路径。

可靠判定某个 `Worktree` 是否已关联到特定 `conversationId` 需要两步组合校验，不能单靠路径名称推测。

1. 仿照 `antigrative-dashboard-0.9.1/sidecars/panel/local-conversations.mjs` 第 13 至 33 行，只读扫描 `<appData>/conversations` 与 `<appData>/brain` 下的现存 UUID 作为候选 `conversationId` 列表；若存在 `~/.gemini/antigravity/worktrees/<conversationId>/<worktreeName>` 目录，在确认其具备合法 `.git` 指向当前主 `Repository` 后，可将第一层目录名作为强候选提示。
2. 对候选会话调用官方 `agentapi get-conversation-metadata <conversationId>`（由 `sidecar_sdk` 封装为 `getConversationMetadata`）。实测 `60415e43-37ef-4c45-9f2e-9b044bd8767c` 返回结构包含 `response.conversationMetadata.metadata.workspaces[].{ workspaceFolderAbsoluteUri, gitRootAbsoluteUri, branchName }`、`workspaceUris[]` 与 `projectId`。将 `git -C <repo> worktree list --porcelain` 返回的 `Worktree` 路径与上述元数据 URI 对齐后，即可准确确认哪些 `Worktree` 属于现存对话的 `Conversation-Bound Worktree`。

> [!WARNING]
> 同一会话元数据中存在 Windows 路径与 URI 格式不一致问题。本机实测 `agentapi` 同时返回了 `file:///d:/private/awara`（`workspaceFolderAbsoluteUri`，小写盘符未编码冒号）与 `file:///d%3A/private/awara`（`workspaceUris`，小写盘符与 `%3A` 编码冒号），而 `git worktree list --porcelain` 输出 `D:/private/awara`（大写盘符）。路径比较前必须先经过 `fs.realpathSync`、URI 解码与统一小写盘符及斜杠，防止匹配失效。

## 三、官方 `sidecar_sdk` 与 `agentapi` 联动能力

对 `sidecar_sdk`（`v1.0.0`）、`agentapi` CLI 与宿主 `postMessage` 桥接协议的核验表明，“在该 Worktree 开启新对话”受限于当前宿主 API 边界，无法把任意新目录直接绑定给新建对话。

### 1. 服务端 `sidecar_sdk/index.mjs` 与 `agentapi` CLI

`SidecarApp`（`sidecar_sdk/index.mjs`）绑定在 `127.0.0.1`（`L10-26`），启动必须具备 `ANTIGRAVITY_LS_ADDRESS`、`ANTIGRAVITY_CSRF_TOKEN`、`ANTIGRAVITY_SIDECAR_WEB_PORT` 与可选 `ANTIGRAVITY_SIDECAR_UI_TOKEN`（`L46-59`），`app.config` 提供 `projectId`（`ANTIGRAVITY_PROJECT_ID`）与 `conversationId`（`ANTIGRAVITY_CONVERSATION_ID`）（`L62-67`）。在 Windows 环境下，`#exec()`（`L87-108`）优先直连宿主注入的 `ANTIGRAVITY_AGENTAPI_EXE`（即 `language_server.exe`）并前置 `'agentapi'` 参数执行 `execFileSync`，从而避开直接调用 `.bat` 垫片时触发的 `spawnSync agentapi ENOENT` 错误。

实测 `C:\Users\linse\.gemini\antigravity\bin\agentapi.bat --help` 与子命令帮助文档确认，`agentapi` 仅开放三个子命令，全部不含工作目录参数。

| 能力面 | 公开签名与 CLI 参数 | 关键限制 |
| --- | --- | --- |
| `agentapi get-conversation-metadata` | `get-conversation-metadata <conversation_id>` | 只读查询，返回 `workspaces`、`workspaceUris`、`projectId` 等元数据 |
| `agentapi send-message` | `send-message [--title=<title>] <recipient_id> <content>` | 向已有会话追加消息，无工作区参数 |
| `agentapi new-conversation` | `new-conversation [--model=<...>] [--title=<...>] [--profile=<...>] <prompt>` | 无 `--workspace`、`--cwd` 或 `--worktree` 参数，工作区完全由 `ANTIGRAVITY_PROJECT_ID` 决定 |
| `SidecarApp.prototype.startConversation` | `startConversation(message, { model = 'flash', projectId } = {})` | `/_sidecar/new-conversation` 路由未透传 `title`（`index.mjs:129`），同样无法传目录参数 |

查看 `~/.gemini/config/projects/*.json` 可以明确其工作区绑定原理。全局 Sidecar 关联的受管项目 JSON（如 `b680ba51-927c-494d-b94d-7c410a953026.json`）中 `"projectResources": {}`，未绑定任何代码目录；普通项目 JSON（如 `a4d115c9-97d1-40a0-8d5d-d4fb93197a0e.json`）在 `projectResources.resources[].gitFolder.folderUri` 中静态保存主仓库 URI。由于独立创建的子分支 `Worktree` 通常没有预先注册为单独的 Antigravity Project，仅切换 `ANTIGRAVITY_PROJECT_ID` 也无法指向新建立的任意 `Worktree`；同时 `language_server.exe` 内存在项目归属校验 `sidecar does not own the project it references`，Sidecar 也不能越权改写外部项目配置。

### 2. 前端 `sidecar_sdk/preload.js` 与宿主渲染器协议

| 前端 API (`window.sidecar`) | 底层机制 (`preload.js` 与宿主 UI) | 实际行为与工作区限制 |
| --- | --- | --- |
| `getWorkspaceUris()` / `onWorkspaceChange(fn)` | 接收宿主 `workspace-change`（`preload.js:53-77, 352-388`） | 仅当 Sidecar iframe URL 的 `conversationId` 缺失或等于当前焦点对话时，宿主 `Evc` 才推送当前工作区 URI |
| `agent.startConversation(message, title)` | 调用 `/_sidecar/new-conversation`（`preload.js:405-417`） | 强制使用当前会话关联的 `projectIdPromise`，前端既不能切换 `projectId`，也不能传目录或自动跳进新对话 |
| `ui.toggleConversation(convId, opts)` | `window.parent.postMessage({ type: 'toggle-conversation', payload })`（`preload.js:432-436`） | 宿主 `swc` 处理器仅可切换到**已存在**的 `conversationId`（支持 `split`、`replace`、`openSidePanel`），不创建新对话 |
| `ui.toggleAuxPane(request)` | `window.parent.postMessage({ type: 'toggle-aux-pane', payload })`（`preload.js:428-430`） | 宿主 `Iwc` 白名单仅限 `fileView`、`artifactView`、`browserView`、`sidecarView`、`subagentView` 与 `{ open: false }` |
| `antigravity://` Deep Link | Electron 主进程 `handleDeepLink`（`app.asar/dist/main.js`） | UI 通用消费逻辑 `P$b` 仅提取 `prompt` 与 `project`/`section` 预填首页输入框或响应插件 OAuth，不支持任意目录建会话 |

### 3. “在该 Worktree 开启新对话”的可行落地策略

遵循 ADR-0001（只使用官方 Sidecar 机制与标准 Git 命令），插件对“点击 Worktree 开启对话”按钮应按绑定状态提供分层能力，不对宿主未公开的目录传参接口做虚假承诺。

1. 目标为已有 `Conversation-Bound Worktree` 时，直接调用 `window.sidecar.ui.toggleConversation(conversationId)`（`swarm_board/app.js:287-288` 已验证）切换到该既有对话。
2. 目标 `Worktree` 恰好在只读扫描 `~/.gemini/config/projects/*.json` 时匹配到其自身独立登记的 `projectId` 时，即使由 Sidecar 自定义服务端路由传该 `projectId` 调用 `app.startConversation(prompt, { projectId })`，仍可能受前述受管项目归属校验拦截，因此不可将其作为主路径，且绝对禁止自动修改 `~/.gemini/config/projects/`。
3. 绝大多数新建或兄弟 `Worktree` 无独立对话与项目绑定，此时应直接提供务实的辅助组合，包括一键复制该 `Worktree` 规范绝对路径或含目标工作区提示语的 Prompt 模板，以及结合 `window.sidecar.ui.toggleAuxPane({ tabType: 'fileView', uri })`（`swarm_board/app.js:1467` 已验证）在 `Auxiliary Pane` 内快速预览该 `Worktree` 中的变更文件。

## 四、对本仓库架构与范围的直接约束

1. Node.js 入口参考 `antigrative-dashboard-0.9.1/sidecars/panel/sdk.mjs:9-24` 与 `main.mjs:18-24`，兼容原生 ESM `import('sidecar_sdk')` 与 `createRequire` 回退，并注意 Windows 下目录句柄被工作目录占用导致无法替换更新的限制。
2. 插件持久化索引与临时缓存优先写入宿主注入的 `ANTIGRAVITY_EXECUTABLE_DATA_DIR`（`swarm_board/main.mjs:111-126` 与 `antigrative-dashboard-0.9.1/compat/platform.mjs:27` 一致验证），绝不修改用户 `~/.gemini/config/` 文件。
3. Worktree 列表坚持以 Git 自身元数据为权威来源。结合当前 `Workspace` 或用户配置的 `Repository`，使用 `git worktree list --porcelain` 获取全量列表；涉及 `~/.gemini/antigravity/worktrees/` 的识别必须通过 `.git` `gitdir:` 指向校验，过滤 Swarm `share` 普通拷贝目录。
4. 产品界面与规划严格对齐边界。由于 `agentapi new-conversation` 缺乏目录参数，核心工作流应聚焦在 `Worktree` 状态总览、`Commit Graph` 浏览、`Auxiliary Pane` 文件审阅、已有 `Conversation-Bound Worktree` 快速跳转，以及新建 Worktree 路径或提示词的一键复制。

---

## 主要参考来源

- 官方在线文档 `https://antigravity.google/docs/sidecars`、`https://antigravity.google/docs/projects`、`https://antigravity.google/docs/sandbox`、`https://antigravity.google/docs/permissions`、`https://antigravity.google/docs/plugins`
- 官方 SDK 与 CLI `C:\Users\linse\.gemini\config\node_modules\sidecar_sdk\{index.mjs,preload.js,package.json}` 与 `C:\Users\linse\.gemini\antigravity\bin\agentapi.bat` 帮助及实测输出
- 宿主二进制与壳进程 `C:\Users\linse\AppData\Local\Programs\antigravity\resources\bin\language_server.exe`（proto 描述、Go 符号及内嵌 UI bundle `main.js`）与 `app.asar/dist/{customScheme,externalUrl,main,remote/remoteSidecars}.js`
- Builtin 与参考 Sidecar `C:\Users\linse\.gemini\antigravity\builtin\plugins\swarm\sidecars\swarm_board\{sidecar.json,main.mjs,app.js}` 与 `d:\private\Antigrative-Dashboard\antigrative-dashboard-0.9.1\{sidecars/panel/{sidecar.json,sdk.mjs,main.mjs,updater.mjs,local-conversations.mjs},compat/platform.mjs,COMPATIBILITY.md}`
- 本机环境与临时实验 `C:\Users\linse\.gemini\config\{config.json,projects/*.json}`、`C:\Users\linse\.gemini\antigravity\worktrees\60415e43-37ef-4c45-9f2e-9b044bd8767c\`、`git -C d:\private\awara worktree list --porcelain` 与隔离临时仓库 `git worktree add` 实测
