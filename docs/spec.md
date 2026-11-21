# Antigravity 2.0 Git 源代码管理与提交图表 Sidecar 架构规格（V1）

本文档定义 `antigravity-git-worktree` 插件 V1 的系统架构、接口契约、Git CLI 执行规范、前端双区交互、跨平台安装与验证标准。所有领域概念以 [GLOSSARY.md](../GLOSSARY.md) 为准，顶层约束遵守 [ADR-0001](./adr/0001-pure-official-sidecar-and-scope-focus.md) 与 [ADR-0002](./adr/0002-zero-build-esm-and-svg-graph.md)。

## 1. 目标、定位与范围

### 1.1 产品定位

本插件是面向 Antigravity 2.0 桌面端右侧 `Auxiliary Pane` 的**纯 Sidecar UI 插件**（不捆绑额外 Skill），插件标识为 `antigravity-git-worktree`，侧栏视图标题为 `Git Graph`。

插件以纯官方 Sidecar 机制与本地文件系统监听运行，保持零外部运行时依赖与零构建流程（Node.js `>=20` ESM 后端 + 原生 ES2022 模块化前端 + 内联 SVG 拓扑图），同时支持脱离宿主的 Standalone 本地 HTTP 预览模式。

### 1.2 V1 核心能力

1. **被动跟随宿主工作区**：监听宿主 `workspace-change` 事件与本地 `.git`、工作区文件变化，自动同步当前对话 `Workspace` 命中的 `Repository`、`Worktree` 与当前分支状态。单仓库场景下顶部不占额外高度；当单个 `Workspace` 同时命中 2 个及以上 `Repository` 时，顶部显示一行紧凑仓库切换栏。
2. **VS Code 风格上下可拖拽双区（无 Tab）**：
   - **上区（源代码管理）**：原生提交说明输入框（支持 `Ctrl/Cmd + Enter`）、智能主按钮（工作区有改动时始终可点「提交」，未暂存时弹窗确认自动暂存全部并提交；工作区干净时随上游状态切换为「推送更改 N↑」「发布分支」或「拉取更改 N↓」）、可折叠的「暂存的更改」与「更改」文件列表（支持单文件与全部暂存、取消暂存，以及带确认护栏的放弃更改与未跟踪文件删除）。
   - **下区（图表）**：单行紧凑顶栏（`自动 / 全部` 分支范围、`Fetch`、`Pull`、`Push / Publish`、`Refresh`、`⋯` 更多菜单）、`24px` 紧凑内联 SVG 提交拓扑树、点击提交行原地缩进展开改动文件列表、最小图表遮挡的悬浮提交详情卡。
3. **宿主原生文件打开**：点击上区更改文件或下区展开的历史提交文件，统一调用 `window.sidecar.ui.toggleAuxPane({ tabType: 'fileView', uri })` 在宿主辅助栏打开文件，插件内不自建 Diff 查看器。
4. **外观与双语适配**：通过语义 CSS 变量与 1×1 Canvas 亮度检测同步宿主明暗主题，支持窄幅视口（`320px–560px`）零横向溢出，支持中英双语切换。

### 1.3 明确不在 V1 范围

以下能力不纳入 V1 实现，后续开发会话不得自行增补：

- 通过 CDP（`DevToolsActivePort`）或未公开内部通道探测、注入 Antigravity 宿主渲染进程。
- 面板内手动跨 `Worktree` 作用域切换、`Worktree` CRUD（新建、锁定、移除、清理）、分支 Checkout 弹窗与跨历史对话跳转。
- 插件内自建 Unified / Split Diff 查看器与历史提交 Patch 渲染。
- 行级或 Hunk 级局部暂存与还原、Stash 队列管理、Merge / Rebase 三栏冲突编辑器、交互式 Rebase、`--amend` 与 Force Push。
- 随插件捆绑面向主对话的辅助 Skill。
- Antigravity 独立 IDE（VS Code）VSIX 扩展或 CLI 状态栏适配。

## 2. 目录结构与模块划分

仓库根目录直接作为插件源目录组织，安装脚本按运行白名单同步到 `~/.gemini/config/plugins/antigravity-git-worktree/`。

```text
/
├── plugin.json                         # Antigravity 插件清单
├── assets/
│   └── logo.svg                        # 插件图标（轻量矢量 SVG）
├── sidecars/
│   └── panel/
│       ├── sidecar.json                # Auxiliary Pane Sidecar 清单
│       ├── main.mjs                    # 双模式入口：释放 cwd、启动 SidecarApp 或 Standalone HTTP
│       ├── sdk.mjs                     # 延迟加载 sidecar_sdk（import + createRequire 回退）
│       ├── backend/
│       │   ├── api-router.mjs          # 全部 POST /api/* 路由、入参白名单校验与错误映射
│       │   ├── discovery.mjs           # Workspace URI 规范化、Repository 去重与 Worktree 匹配
│       │   ├── git-runner.mjs          # 安全 execFile/spawn、两级写锁队列、超时与非交互凭据
│       │   ├── git-queries.mjs         # status/log/show/remote 只读查询与 -z 二进制解析
│       │   ├── git-mutations.mjs       # stage/unstage/discard/commit/fetch/pull/push 写操作
│       │   ├── watcher.mjs             # .git 与当前工作区 fs.watch、自毁守卫与风暴降级
│       │   ├── event-bus.mjs           # 内存 revision 版本号与挂起式长轮询管理
│       │   ├── preferences.mjs         # 轻量偏好（locale/graphScope/splitRatio）持久化
│       │   └── mock-fixture.mjs        # Standalone ?fixture=mock 离线演示数据
│       └── public/
│           ├── index.html              # 面板文档骨架（保留 <script src="/preload.js">）
│           ├── styles.css              # 宿主语义变量、窄幅 @container、双区与图谱样式
│           ├── app.js                  # 顶层状态协调、宿主桥接、长轮询与事件绑定
│           └── modules/
│               ├── api-client.js       # 统一 POST JSON 客户端（window.sidecar.fetch 回退 fetch）
│               ├── theme.js            # MutationObserver + 1x1 Canvas 明暗检测与对比度校正
│               ├── i18n.js             # 中英双语词典与相对/绝对时间格式化
│               ├── graph-layout.js     # 动态 SVG 拓扑车道纯函数计算（computeGraphTopology）
│               ├── popover.js          # 最小可见图表遮挡悬浮定位纯函数与详情卡控制
│               ├── changes-view.js     # 上区源代码管理渲染与确认弹窗交互
│               └── graph-view.js       # 下区提交图表、原地文件展开与顶栏交互
├── scripts/
│   ├── install.ps1                     # Windows 安装脚本（默认拷贝，支持 -Link Junction 与 -Uninstall）
│   └── install.sh                      # macOS / Linux 安装脚本（默认拷贝，支持 --link 与 --uninstall）
├── tests/
│   ├── unit/                           # 纯函数与解析器单元测试（node:test）
│   ├── integration/                    # 真实临时多仓库/Worktree/HTTP 401 集成测试
│   └── browser/                        # Standalone 与 opaque srcdoc iframe 窄幅回归验证
├── docs/
│   ├── spec.md                         # 本文档
│   ├── adr/
│   └── agents/
├── GLOSSARY.md
└── AGENTS.md
```

模块划分遵守两项约束：

1. 前端业务逻辑与纯计算模块（`graph-layout.js`、`popover.js`、`i18n.js`、`theme.js`）不直接耦合 `window.sidecar` 全局对象，便于 `node:test` 直接导入测试。
2. 后端 Git 解析函数与进程执行分离，`git-queries.mjs` 中的 NUL 分隔解析器导出为纯函数，可直接用字节夹具测试。

## 3. 双模式运行时与安全契约

### 3.1 启动分支与 Windows 句柄释放

`sidecars/panel/main.mjs` 启动后按以下顺序初始化：

1. **释放运行时目录句柄**：宿主拉起 Sidecar 时进程初始 `cwd` 位于 `sidecars/panel/`。Windows 下该目录句柄会阻止后续覆盖安装或目录重命名。进程启动首步读取完 `import.meta.url` 计算插件路径常量后，立即执行 `process.chdir(os.tmpdir())`。后续所有 Git 命令显式传 `cwd` 参数或 `-C`，绝不依赖进程 `cwd`。
2. **判断运行模式**：
   - 检测到 `process.env.ANTIGRAVITY_SIDECAR_WEB_PORT` 时，进入 **Sidecar 模式**，在分支内动态调用 `loadSidecarSdk()`（先 `await import('sidecar_sdk')`，失败时通过 `createRequire(import.meta.url).resolve('sidecar_sdk')` 转为 `file://` URL 导入）。严禁在 `main.mjs` 顶层静态 `import 'sidecar_sdk'`。
   - 未检测到该环境变量时，进入 **Standalone 模式**，用原生 `node:http` 创建本地预览服务器。

### 3.2 鉴权边界与 CSRF 防护

官方 `SidecarApp`（`sidecar_sdk/index.mjs`）仅对非 `GET` 请求校验 `X-Sidecar-Token`，`GET` 路由绕过 Token 检查。为同时防止未授权写入和本机跨站探测，所有路由遵守统一边界：

| 路由类别 | HTTP 方法 | Sidecar 模式防护 | Standalone 模式防护 |
| --- | --- | --- | --- |
| 静态资源（`/`、`/styles.css`、`/app.js`、`/modules/*.js`、`/preload.js`） | `GET` | `SidecarApp.page()` 提供，绑定 `127.0.0.1` | 绑定 `127.0.0.1`，校验 `Host` 匹配 `/^(127\.0\.0\.1\|localhost)(:\d+)?$/` |
| 全部业务接口（`/api/*`） | 仅允许 `POST` | `SidecarApp.api(..., 'POST')` 强制校验 `X-Sidecar-Token`；前端经 `window.sidecar.fetch` 发送 | 校验 `Host` 白名单 + 强制 `Origin === http://${host}` + `Content-Type` 以 `application/json` 开头 + 请求体上限 `1 MiB` |

补充约束：

- `SidecarApp.page(pathname, handler)` 按精确路径匹配且无目录通配符；此外，若 handler 直接返回字符串，SDK 仅对 `.js` 设 `application/javascript`，其余路径默认标为 `text/html`。因此 `main.mjs` 必须按静态文件白名单逐个注册 `/`、`/styles.css`、`/app.js` 与 `/modules/*.js`，并全部返回带显式 `Content-Type`（`text/html; charset=utf-8`、`text/css; charset=utf-8`、`text/javascript; charset=utf-8`）的 `Response` 实例，避免样式表因 MIME 错误被浏览器拦截。
- 所有 `/api/*` 响应统一附带 `Cache-Control: no-store` 与 `X-Content-Type-Options: nosniff`。
- Standalone 模式在 JSON 解析失败或超长时返回 `400` / `413` JSON 错误；`SidecarApp` 模式下业务层对所有入参字段做类型与路径范围校验，不信任客户端传值。
- Standalone 模式必须提供 `GET /preload.js`，返回 `200` 与 `Content-Type: text/javascript; charset=utf-8`（默认返回空注释桩；当页面带 `?sdk=1` 时可注入测试用的模拟 `window.sidecar` 桥接对象）。

### 3.3 Standalone 启动参数

Standalone 模式用于本地开发调试与自动化回归，支持以下配置：

- 监听端口：`AG_GIT_PORT`（默认 `17892`），始终显式传 `'127.0.0.1'` 给 `server.listen(port, '127.0.0.1')`。
- 默认工作区目录：优先读取 CLI 位置参数，其次读取 `AG_GIT_PATHS`（按 `path.delimiter` 分隔多个本地目录），均未提供时默认指向插件源码所在目录的父级或当前目录（存在 `.git` 时）。
- 离线夹具：前端 URL 带 `?fixture=mock` 或后端设置 `AG_GIT_FIXTURE=mock` 时，由 `mock-fixture.mjs` 返回涵盖多分支合并、暂存/未暂存/未跟踪改动、领先/落后上游计数与中文路径的静态演示状态，且支持内存内模拟暂存、提交、推送状态流转。

## 4. 领域规则：`Workspace -> Repository -> Worktree` 被动跟随

### 4.1 路径规范化

前端通过 `window.sidecar.getWorkspaceUris()` 与 `window.sidecar.onWorkspaceChange()` 获取宿主当前对话的 `workspaceUris`（`string[]`），每次请求上下文时将其传给后端。后端按以下步骤处理每条 URI：

1. 仅接受 `file:` 协议 URI，通过 `node:url` 的 `fileURLToPath()` 解码百分比编码字符（如 `%3A`、中文路径）和 UNC 路径。
2. 路径存在于磁盘时，调用 `fs.realpathSync.native(fsPath)` 展开符号链接/Junction 并获取 Windows 真实盘符大写与 NTFS 大小写。
3. 路径不存在或不可达时，走非抛出兜底规范化：`path.win32.normalize()`（Windows）或 `path.normalize()`（POSIX），去掉非盘符根目录的末尾分隔符，Windows 下统一大写盘符。
4. 路径比较键（`pathKey`）：Windows 统一转为正斜杠并小写化；POSIX 保持大小写敏感并规范斜杠。

### 4.2 Repository 发现与去重

对每个有效的本地目录路径 `wsPath` 执行第一阶段探测：

```text
git -c core.quotepath=false --no-optional-locks rev-parse \
  --path-format=absolute --git-common-dir --git-dir --is-inside-work-tree --is-bare-repository
```

探测规则如下：

1. **禁止在第一阶段混入 `--show-toplevel`**：在 `bare` 仓库或 `.git` 目录内部执行 `--show-toplevel` 会导致整条命令以退出码 `128` 中止。
2. **旧版本 Git 兜底**：若 stderr 含 `unknown option`（Git `< 2.31.0` 不支持 `--path-format=absolute`），自动去掉该参数重跑并用 `path.resolve(wsPath, line)` 绝对化。
3. **非 Git 目录与嵌套 Submodule 边界**：退出码非 `0` 的普通目录静默忽略；不主动递归扫描仓库内部的子目录或嵌套 Submodule。仅当用户把某个 Submodule 目录本身作为 `Workspace` 根打开时，因其 `--git-common-dir` 指向 `<superproject>/.git/modules/<name>`，自然按独立 `Repository` 纳入。
4. **去重键**：以规范化后的 `gitCommonDir`（取 `pathKey`）作为 `Repository.id`。多个 `Workspace` URI 落在同一仓库的不同子目录或不同 `Worktree` 时，合并为同一个 `Repository`，只执行一次 `git worktree list --porcelain -z`。
5. **命中当前 `Worktree`**：在 `worktree list` 返回的所有非 `bare` 条目中，使用**路径段前缀匹配**（比较规范化后相等，或 `wsPath` 以 `wt.path + '/'` 开头，避免 `D:/repo` 误匹配 `D:/repo-wt`）查找包含 `wsPath` 的 `Worktree`，多重嵌套时取 `wt.path` 长度最长者。若同一 `Repository` 命中多个 `Workspace` 目录，按 `workspaceUris` 传入顺序取第一个命中的 `Worktree` 作为当前被动跟随目标。

### 4.3 特殊仓库状态处理

| 状态 | 判定依据 | 后端与界面行为 |
| --- | --- | --- |
| 无仓库（`repositories.length === 0`） | 当前 `Workspace` 全部为非 Git 目录或为空 | 返回空仓库列表；前端显示单页空态提示（说明当前对话工作区未包含 Git 仓库） |
| 单个 `Repository` | `repositories.length === 1` | 顶部不渲染仓库切换栏，垂直空间全部留给上下双区 |
| 多个 `Repository` | `repositories.length >= 2` | 面板最顶部显示一行紧凑下拉切换条（仓库目录名 + 当前分支），默认按 `workspaceUris` 顺序选中第一个，切换后仅在当前会话内存中保持（当 `workspaceUris` 列表变化且旧 `selectedRepoId` 不再命中时自动切回第一个） |
| `bare` 仓库 | `isBareRepository === true` 且未命中非 bare 工作树 | 进入只读态：上区提示「裸仓库不支持工作区修改」并隐藏提交/暂存区，下区仍可正常浏览 `Commit Graph` 与执行 `Fetch` |
| 0 提交（Unborn） | `status --porcelain=v2 --branch` 返回 `# branch.oid (initial)` | `Commit Graph` 返回空列表并显示空提交提示（不执行带 `HEAD` 的 `git log`）；上区支持正常暂存、取消暂存（走 `git rm --cached`）与首次提交；工作区干净且无提交时隐藏推送/发布主按钮 |
| 游离 HEAD（`Detached HEAD`） | `# branch.head (detached)` | 上区顶部显示轻量提示条，允许知情提交；工作区干净时不展示推送/发布主按钮；下区顶栏 `Pull` 与 `Push` 禁用，`Fetch` 与 `Refresh` 保持可用 |

## 5. 后端 API 契约

所有业务接口均为 `POST`，请求体与响应体均为 UTF-8 JSON。

### 5.1 统一响应格式与错误码

成功响应：

```json
{ "ok": true, "data": { ... } }
```

失败响应（HTTP 状态码：`400` 参数错误、`401` 未鉴权、`403` Origin/Host 拒绝、`409` 业务前置状态冲突、`504` 超时、`500` 未预期异常）：

```json
{
  "ok": false,
  "error": {
    "code": "NON_FAST_FORWARD",
    "message": "远程分支已领先或与本地分叉，无法快进拉取，请在终端手动合并或变基。",
    "detail": "fatal: Not possible to fast-forward, aborting."
  }
}
```

标准错误码清单：

- `INVALID_REQUEST`：入参缺失、类型错误或含非法控制字符。
- `OUT_OF_WORKTREE`：文件路径试图越出目标 `Worktree` 根目录（含 `..` 或符号链接逃逸）。
- `NO_REPOSITORY`：目标 `worktreePath` 或 `repoId` 不在当前已发现仓库中。
- `CONFLICT_BLOCKED`：工作树存在未解决合并冲突，阻断 `commit` 或不安全的 `discard`。
- `EMPTY_COMMIT_MESSAGE`：去空白后提交说明为空。
- `NOTHING_TO_COMMIT`：暂存区与工作区均无变更（或 `autoStageAll` 为 `false` 且暂存区为空）。
- `GIT_LOCKED`：经过 3 次短退避重试后仍存在 `.lock` 冲突（`detail` 包含锁路径原文）。
- `GIT_TIMEOUT`：超过只读 `10s` 或网络 `45s` 硬超时。
- `AUTH_REQUIRED`：非交互模式下远端鉴权失败（退出码 `128` 且匹配凭据/交互禁用特征）。
- `NON_FAST_FORWARD`：`git pull --ff-only` 或 `git push` 因远端分叉被拒。
- `NO_REMOTE`：仓库未配置任何远端，无法执行远程同步。
- `GIT_ERROR`：其他 Git CLI 非零退出错误。

### 5.2 端点定义

#### 1. `POST /api/snapshot`

获取当前对话 `Workspace` 的完整渲染快照，并同步更新后端监听焦点。

- **Request**：
  ```json
  {
    "workspaceUris": ["file:///d%3A/private/AGY-GitWorktree"],
    "selectedRepoId": "d:/private/agy-gitworktree/.git",
    "graphScope": "auto",
    "graphLimit": 150,
    "forceRefresh": false
  }
  ```
- **Response `data`**：
  ```json
  {
    "workspaceKey": "<hash-of-active-repo-and-worktree>",
    "revision": 12,
    "repositories": [
      { "id": "...", "name": "AGY-GitWorktree", "worktreePath": "D:/private/AGY-GitWorktree", "branch": "main", "isBare": false }
    ],
    "activeRepo": {
      "id": "...",
      "name": "AGY-GitWorktree",
      "gitCommonDir": "D:/private/AGY-GitWorktree/.git",
      "gitDir": "D:/private/AGY-GitWorktree/.git",
      "worktreePath": "D:/private/AGY-GitWorktree",
      "isBare": false,
      "isUnborn": false,
      "isDetached": false,
      "headOid": "2a76567...",
      "branch": "main",
      "upstream": "origin/main",
      "ahead": 1,
      "behind": 0,
      "remotes": ["origin"]
    },
    "changes": {
      "conflicted": [],
      "staged": [{ "path": "docs/spec.md", "origPath": null, "status": "M", "fileUri": "file:///..." }],
      "unstaged": [{ "path": "README.md", "origPath": null, "status": "M", "untracked": false, "fileUri": "file:///..." }],
      "totalEntries": 2,
      "truncated": false
    },
    "graph": {
      "scope": "auto",
      "limit": 150,
      "hasMore": true,
      "reachedSoftLimit": false,
      "commits": [
        {
          "sha": "2a76567...",
          "shortSha": "2a76567",
          "parents": ["5af2c1e..."],
          "refs": [{ "type": "head", "name": "main", "fullRef": "refs/heads/main" }],
          "authorName": "Lynn-zy",
          "authorEmail": "lynn@example.com",
          "timestamp": 1795251200,
          "subject": "docs: align domain docs with dual-pane passive scope"
        }
      ]
    },
    "watchState": { "active": true, "degraded": false, "reason": null },
    "preferences": { "locale": "auto", "graphScope": "auto", "splitRatio": 0.42 }
  }
  ```
- 说明：`forceRefresh: true` 时若监听之前处于风暴降级态，尝试恢复文件监听。

#### 2. `POST /api/commit/detail`

用户展开某条提交的文件列表，或悬停打开提交详情卡时按需调用（前端按 `sha` 做内存缓存，切换仓库或强制刷新时清空）。

- **Request**：`{ "worktreePath": "...", "sha": "2a76567..." }`（校验 `sha` 匹配 `/^[0-9a-f]{7,64}$/i`）
- **Response `data`**：
  ```json
  {
    "sha": "2a76567...",
    "subject": "docs: align domain docs with dual-pane passive scope",
    "body": "完整提交正文（不含已解析出的 Co-authored-by 行）",
    "coAuthors": [{ "name": "Claude Opus 5.5", "email": "noreply@anthropic.com" }],
    "files": [
      {
        "status": "M",
        "path": "GLOSSARY.md",
        "origPath": null,
        "existsInWorktree": true,
        "fileUri": "file:///D:/private/AGY-GitWorktree/GLOSSARY.md"
      }
    ]
  }
  ```

#### 3. `POST /api/events/wait`

挂起式长轮询端点，用于替代 `SidecarApp` 不支持的流式 SSE。

- **Request**：`{ "workspaceKey": "...", "sinceRevision": 12, "timeoutMs": 20000 }`（后端将 `timeoutMs` 钳制在 `1000–20000` 毫秒）
- **行为**：
  - 若当前内存 `revision > sinceRevision` 或监听刚切换为降级态，立即返回 `{ "revision": current, "changed": true, "watchDegraded": false }`。
  - 否则挂起 Promise 注册到 `event-bus.mjs`；当 `fs.watch` 防抖触发或写操作完成后，立刻 `resolve` 全部等待者；到达 `timeoutMs` 仍无变化则返回 `{ "revision": current, "changed": false, "watchDegraded": false }`。
  - 同一客户端重连或关闭时通过上限清理避免内存泄漏（最多同时挂起 8 个等待者，超出时提前唤醒最旧者返回 `changed: false`）。

#### 4. `POST /api/changes/stage` 与 `POST /api/changes/unstage`

- **Request**：`{ "worktreePath": "...", "all": false, "paths": ["README.md"] }`（`all: true` 或非空 `paths[]` 二选一）
- **Response `data`**：`{ "revision": 13 }`（写操作成功后递增内存版本号，前端随之拉取最新快照）。

#### 5. `POST /api/changes/discard`

- **Request**：
  - 单文件/批量已跟踪文件还原：`{ "worktreePath": "...", "allTracked": false, "paths": ["README.md"], "untracked": false }`
  - 单文件未跟踪删除：`{ "worktreePath": "...", "allTracked": false, "paths": ["temp.txt"], "untracked": true }`（仅当 `untracked: true` 时强制校验 `paths.length === 1` 且该路径确在最新未跟踪列表中）
- **护栏约束**：`allTracked: true` 绝不删除未跟踪文件；`paths` 禁止包含处于合并冲突的文件；所有路径必须通过 `worktreePath` 边界校验。

#### 6. `POST /api/commit`

- **Request**：`{ "worktreePath": "...", "message": "feat: ...", "autoStageAll": false }`
- **行为**：
  - 检查冲突列表非空则返回 `409 CONFLICT_BLOCKED`。
  - 检查 `message.trim()` 为空则返回 `400 EMPTY_COMMIT_MESSAGE`。
  - 在同一仓库写队列内，若 `autoStageAll === true` 先执行 `git add -A`，随后通过 `stdin` 执行 `git commit -F -`。

#### 7. `POST /api/remote/fetch`、`POST /api/remote/pull`、`POST /api/remote/push`

- **`fetch`**：请求体传入 `{ "worktreePath": "..." }`，执行 `git fetch --all --prune`。
- **`pull`**：请求体传入 `{ "worktreePath": "..." }`，校验非 unborn、非 detached 且存在上游后执行 `git pull --ff-only`。
- **`push`**：请求体传入 `{ "worktreePath": "...", "remote": "origin" }`（`remote` 仅在无上游 Publish Branch 时必填；存在上游时忽略并执行 `git push`）。所有推送路径均禁止使用 `--force` 与 `--force-with-lease`。

#### 8. `POST /api/preferences`

- **Request**：`{ "locale": "zh-CN", "graphScope": "all", "splitRatio": 0.4 }`（任意子集字段，缺省字段保留原值）
- **行为**：校验字段白名单与范围（`splitRatio` 钳制在 `0.15–0.85`），原子写入 `ANTIGRAVITY_EXECUTABLE_DATA_DIR/prefs.json`（先写临时文件再 `rename`）；Standalone 模式写 `os.tmpdir()/antigravity-git-worktree-prefs.json`（前端也可叠加 `localStorage`）。

## 6. Git CLI 执行、并发锁与文件监听策略

### 6.1 进程执行安全红线

所有 Git 子进程调用集中在 `git-runner.mjs`，无例外遵守：

1. 仅使用 `child_process.execFile('git', args, opts)` 或 `spawn('git', args, opts)`，**严禁 `shell: true`**。
2. 必传 `windowsHide: true` 与 `stdio: ['pipe' | 'ignore', 'pipe', 'pipe']`。
3. 所有命令在子命令前固定注入：`-c core.quotepath=false`、`-c i18n.logOutputEncoding=utf-8`、`--no-pager`。
4. 所有只读查询命令额外注入：`--no-optional-locks` 以及环境变量 `GIT_OPTIONAL_LOCKS=0`，防止 `git status` 改写 `.git/index` 与 `.git/index.lock` 引发监听自激死循环。
5. 所有文件路径参数前强制加 `--`；所有数据驱动的 ref、branch、remote、sha 参数前强制加 `--end-of-options`。
6. 带 `-z` 输出的命令以原始 `Buffer` 接收，按字节 `0x00` 切分后再 `toString('utf8')`。

### 6.2 核心命令与解析契约

| 场景 | Git 命令 | 解析与边界注意事项 |
| --- | --- | --- |
| 工作区变更 | `git ... --no-optional-locks status --porcelain=v2 --branch --show-stash -z` | 顺序指针消费 NUL token：普通项 `1` 占 1 token（按前 8 个空格切分保留路径空格）；重命名 `2` 占 2 token（**`newPath` 在前、`origPath` 在后**）；冲突项 `u` 单独归入 `conflicted[]`；未跟踪 `?` 归入 `unstaged[]` 并标 `untracked: true`。`XY` 均非 `.`（如 `MM`）时同时进入 `staged[]` 与 `unstaged[]`。总变更超 `2000` 条时设 `truncated: true` 并触发监听降级。 |
| 图谱（`全部`） | `git ... --no-optional-locks log --exclude=refs/stash --all --topo-order --decorate=full -z -n <limit+1> --format=%H%x1f%P%x1f%D%x1f%an%x1f%ae%x1f%at%x1f%s` | 排除 `refs/stash` 伪节点；多拉 1 条判断 `hasMore`；0 提交 unborn 仓库安全返回空串。`%D` 按 `", "` 与 `" -> "` 安全拆分（Git 禁止 ref 名含空格）。 |
| 图谱（`自动`） | 非 unborn 时：`git ... --no-optional-locks log --topo-order --decorate=full -z -n <limit+1> --format=... --end-of-options HEAD [<upstream>]` | 若当前分支有上游跟踪分支则同时传入 `HEAD` 与 `<upstream>`，同时显示领先与落后分支；unborn 仓库跳过调用直接返回空数组。 |
| 图谱分页 | 首屏 `limit = 150`，点击「加载更多」每次 `+200`，硬上限 `2000` | 采用增大 `limit` 重拉并在前端按 `sha` 稳定合并，避免提交新增导致 `--skip` 漂移重复。达到 `2000` 时置 `reachedSoftLimit: true` 提示缩小范围。 |
| 提交正文 | `git ... --no-optional-locks show -s --format=%B --end-of-options <sha>` | 逐行提取末尾 `Co-authored-by: Name <email>`（大小写不敏感）至 `coAuthors[]`，其余文本归入 `body`。 |
| 提交文件清单 | `git ... --no-optional-locks show --name-status -M -m --first-parent --format= -z --end-of-options <sha>` | 根提交与 Merge Commit 均稳定输出标准状态，空提交返回空 Buffer 解析为 `files: []`。普通项占 2 token（`<status>`, `<path>`），`R*`/`C*` 重命名复制项占 3 token（`<status>`, **`origPath` 在前、`newPath` 在后**，与 `status -z` 相反）。对每个最终路径检查 `existsSync` 返回 `existsInWorktree`。 |
| 暂存 | 单/多文件 `git add -- <paths>`；全部 `git add -A` | 走 Worktree 级写队列。 |
| 取消暂存 | 有提交：`git restore --staged -- <paths>`（全部不传路径或传 `.`）；**unborn 仓库**：`git rm --cached -r -- <paths>` | 实测 unborn 仓库执行 `git restore --staged` 会报 `fatal: could not resolve 'HEAD'`，必须走 `git rm --cached`。 |
| 放弃更改 | 已跟踪：`git restore --worktree -- <paths>`（批量 `git restore --worktree -- .`）；单文件未跟踪：`git clean -f -- <path>` | 仅还原工作区，保留已暂存改动（`MM` 态不伤暂存区）；批量绝不执行 `git clean`。 |
| 提交 | `git commit -F -`（`stdin` 写入 UTF-8 正文） | 规避 Windows 命令行长度与引号转义问题。 |
| 远程同步 | `git fetch --all --prune` / `git pull --ff-only` / `git push` 或 `git push -u --end-of-options <remote> <branch>` | 全部走 Repository 级写队列与非交互凭据环境。 |

### 6.3 并发队列、超时与非交互凭据

1. **两级写队列与只读并发池**：
   - **Worktree 级串行队列**（键：规范化 `worktreePath`）：`stage`、`unstage`、`discard`。
   - **Repository 级串行队列**（键：规范化 `gitCommonDir`）：`commit`、`fetch`、`pull`、`push`（`commit` 若带 `autoStageAll` 需同时串行化对应 Worktree 队列，防止边暂存边提交）。
   - **只读并发池**：无写锁，全局并发上限 `4`。
2. **瞬时锁冲突重试**：写命令遇到 stderr 匹配 `/Unable to create '.*\.lock': File exists\./i` 时，按 `80ms`、`200ms`、`400ms` 退避重试最多 3 次；仍失败时返回 `GIT_LOCKED` 及原始锁路径，**绝不自动删除用户的 `.lock` 文件**。
3. **超时阈值**：只读命令硬超时 `10s`，网络命令（`fetch`、`pull`、`push`）硬超时 `45s`，超时后终止子进程、释放队列并返回 `GIT_TIMEOUT`。
4. **非交互网络环境**：`fetch`、`pull`、`push` 固定注入：
   - `GIT_TERMINAL_PROMPT: '0'`
   - `GCM_INTERACTIVE: 'never'`
   - `GIT_ASKPASS: ''`
   - `SSH_ASKPASS_REQUIRE: 'never'`
   - 当宿主环境未显式设置 `GIT_SSH_COMMAND` 时，注入 `GIT_SSH_COMMAND: 'ssh -o BatchMode=yes'`。
   - 若命令以退出码 `128` 失败且 stderr 匹配交互禁用、鉴权失败或 `Permission denied (publickey)`，映射为 `AUTH_REQUIRED` 引导用户在终端完成登录。

### 6.4 文件监听与风暴降级

后端仅对当前活跃 `Repository` 与当前命中的 `Worktree` 挂载监听，切换仓库或离开工作区时立即关闭旧句柄：

1. **监听目标**：
   - `.git/`（非递归）：仅响应 `HEAD`、`packed-refs`、`index` 与 `worktrees`，忽略 `*.lock`、`*.new`、`objects`、`COMMIT_EDITMSG` 等过程文件。
   - `.git/refs/`（`{ recursive: true }`）：捕获分支、标签与远端跟踪引用变更。
   - `.git/worktrees/`（动态挂载）：仅在目录存在时挂载 `{ recursive: true }`，目录被删除时卸载，避免无 linked Worktree 时抛出 `ENOENT`。
   - 当前命中 `Worktree` 根目录（`{ recursive: true }`）：过滤 `.git` 目录、`node_modules`、`.next`、`dist`、`build`、`target`、`__pycache__` 等高频产物目录。
2. **Windows `ReadDirectoryChangesW` 自毁守卫**：所有 `fs.watch` 回调第一行强制执行：
   ```js
   if (!existsSync(watchedDir) || (typeof filename === 'string' && filename.startsWith('\\\\?\\'))) {
     watcher.close();
     return;
   }
   ```
3. **防抖与风暴降级**：
   - 元数据通道防抖 `200ms`，工作区通道防抖 `300ms`。
   - 滑动 1 秒窗口内收到超过 `200` 次有效工作区事件，或最近一次 `status` 返回超过 `2000` 条变更时，暂停工作区自动监听并置 `watchState = { active: false, degraded: true, reason }`，同时递增 `revision` 通知前端在顶部展示「变更过多或文件写入频繁，已暂停自动监听，请手动刷新」。用户点击 `Refresh` 时重置计数器并尝试重新挂载监听。

## 7. 前端架构、交互与视觉规范

> 正式编码阶段按 Antigravity 2.0 宿主 CSS 变量与视觉语言从零编写样式与线性 SVG 图标，不照搬原型阶段的临时外观；交互行为与布局骨架以本节及已验证原型结论为准。

### 7.1 布局骨架与窄幅响应式（`320px–560px`）

- **根结构**：全高 Flex 纵向布局（`100vh`，零页面级横向溢出），外层容器声明 `container: ag-git-pane / inline-size`。
- **多仓顶部栏**：仅 `repositories.length >= 2` 时渲染一行 `28px` 紧凑仓库下拉条；单仓时不渲染。
- **双区与中缝拖拽**：
  - 上区 `∨ 源代码管理` 与下区 `∨ 图表` 各自独立支持点击标题栏折叠/展开。
  - 双区均展开时中间显示 `4px` 可拖拽分隔条（指针拖动实时更新上区占比 `splitRatio`，范围 `0.15–0.85`，松手后写入 `/api/preferences`；双区各自内部 `overflow-y: auto; overflow-x: hidden; scrollbar-gutter: stable; overscroll-behavior: contain`）。
  - 任一区折叠时，另一展开区自动撑满剩余高度。
- **窄屏防溢出约束**：
  - Flex/Grid 文本列强制 `min-width: 0`，单行标题与路径使用 `overflow: hidden; text-overflow: ellipsis; white-space: nowrap`。
  - 长目录路径按目录/文件名拆分展示（优先保留文件名完整可见）。
  - `@container ag-git-pane (max-width: 340px)` 下收紧左右内边距并隐藏次要辅助文字，仅保留带 `title` / `aria-label` 的紧凑图标按钮。

### 7.2 上区：源代码管理（`Working Tree Changes`）

1. **特殊状态横幅**：
   - 存在 `conflicted.length > 0` 时置顶显示只读「合并冲突」告警分组，允许点击冲突文件打开宿主 `fileView` 审阅，在冲突清零前禁用提交按钮并说明原因。
   - 处于 `Detached HEAD` 时显示紧凑提示条。
2. **提交输入区**：
   - 使用原生 `<textarea>`（自动匹配 `preload.js` 文本编辑快捷键豁免，并保留宿主 `Cmd/Ctrl+B` 侧栏切换）。
   - 按 `repo.id` 在前端内存中保留未提交草稿（切换多仓不丢字，提交成功后清空）。
   - 监听 `keydown`：`Ctrl/Cmd + Enter` 时必须调用 `e.preventDefault()` 阻断 `preload.js` 转发，并触发智能主按钮提交逻辑。
3. **智能主按钮状态机**（按以下优先级互斥判定）：
   - **冲突阻断态**（`conflicted.length > 0`）：按钮禁用，文案「存在冲突，请先解决」。
   - **提交态**（存在任何 `staged` 或 `unstaged` 变更）：按钮文案「提交」且**始终可点击**。
     - 点击时若 `message.trim()` 为空：聚焦 `<textarea>` 并显示轻量校验提示，不发请求。
     - 若 `staged.length > 0`：直接调用 `POST /api/commit`（`autoStageAll: false`）。
     - 若 `staged.length === 0 && unstaged.length > 0`：弹出轻量确认框「没有要提交的暂存更改。是否自动暂存全部 N 个更改并直接提交？」，确认后调用 `POST /api/commit`（`autoStageAll: true`）。
   - **同步态**（工作区干净且非 unborn、非 detached）：
     - 若 `upstream === null` 且 `remotes.length > 0`：显示「发布分支」（单远端直接 `push -u`，多远端弹窗选远端）。
     - 若 `ahead > 0`：显示「推送更改 N↑」（若同时 `behind > 0` 则在点击失败或文案中提示先拉取）。
     - 若 `ahead === 0 && behind > 0`：显示「拉取更改 N↓」（调用 `pull --ff-only`）。
     - 工作区干净且与上游同步（或无远端）：显示禁用态「提交」（或保持无待同步状态）。
4. **可折叠文件分组与行操作**：
   - 「暂存的更改 (N)」：悬停显示「打开文件」「取消暂存 (`−`)」；分组标题悬停显示「全部取消暂存」。
   - 「更改 (N)」：合并未暂存与未跟踪文件，右侧显示单字母状态徽标（`M`/`A`/`D`/`R`/`U`）。悬停显示「打开文件」「放弃更改 (`↶`)」「暂存更改 (`+`)」；分组标题悬停显示「全部放弃更改」「全部暂存」。
   - `MM` 双态文件同时出现在两组中，对「更改」组执行放弃更改仅调用 `git restore --worktree`，保留暂存区内容。
5. **安全确认护栏**：
   - `Stage` / `Unstage`（单文件与全部）免确认直接执行。
   - `Discard` 全部需确认：单文件已跟踪弹出普通确认（列文件名）；单文件未跟踪弹出红字高危确认（提示永久删除磁盘文件不可恢复）；「全部放弃更改」弹出强确认（列受影响已跟踪文件数，并明示不会删除未跟踪文件）。

### 7.3 下区：图表（`Commit Graph`）

1. **单行紧凑顶栏**：
   - 左侧标题 `∨ 图表`（可折叠）。
   - 右侧紧凑动作组：`自动 / 全部` 范围切换、`Fetch`（提取）、`Pull`（拉取）、`Push`（推送/发布）、`Refresh`（刷新）、`⋯`（更多菜单）。
   - `⋯` 菜单固定包含 3 项：**本地提交搜索栏显隐**（按提交标题、短 SHA、作者与分支名即时过滤已加载节点，不发后端请求）、**折叠全部已展开提交**、**切换界面语言（中文 / English）**。
2. **紧凑提交行与原地展开**：
   - 每条提交行固定 `24px` 高度：左侧为内联 SVG 拓扑列，中间为单行截断提交标题，右侧按优先级（`HEAD` > 本地分支 > 远端分支 > Tag）内联最多 `2–3` 个紧凑 Pill，超出折叠为 `+N`，悬停行末显示文档详情图标。
   - 点击提交行（或按 `Enter`/`Space`）调用 `/api/commit/detail` 并在该行下方原地缩进展开文件列表（按 `A/M/D/R` 标记）。展开的文件行左侧保留穿行 SVG 泳道竖线，确保拓扑连线不断裂。
   - 列表底部在 `hasMore === true` 且未达软上限时显示「加载更多 (+200)」按钮；达到 `2000` 条软上限时显示提示引导切换为 `自动` 范围。
3. **文件打开契约（上区与下区统一）**：
   - Sidecar 模式下点击有效文件调用 `window.sidecar.ui.toggleAuxPane({ tabType: 'fileView', uri: file.fileUri })`。
   - 历史提交中 `existsInWorktree === false` 的文件（例如已删除或已重命名的旧路径）以置灰样式展示、禁止点击，并在 `title` 中提示「该文件在当前工作区已不存在」。
   - Standalone 模式下无宿主 `toggleAuxPane`，点击文件显示轻量提示「文件预览仅在 Antigravity 桌面端辅助栏内可用」。

### 7.4 SVG 动态拓扑车道算法（`graph-layout.js`）

采用纯函数 `computeGraphTopology(commits)` 对当前可见提交数组逐行计算车道结构，不硬编码主干通道：

1. 维护当前活跃车道槽位数组 `activeLanes`（每槽保存该车道正在等待匹配的 `expectedSha` 与分配的颜色索引 `colorIndex`）。
2. 处理第 `i` 条提交 `commit` 时：
   - **定位自有车道**：查找 `activeLanes` 中所有 `expectedSha === commit.sha` 的槽位；若存在多个（多条分支指向同一祖先，汇入该节点），取最左侧槽位作为 `ownLane`，其余重复槽位记为 `exitingLanes`（本行上半段收束至 `ownLane` 并释放）。若不存在（新的分支顶端），在最左空闲槽位（或数组末尾）分配 `ownLane`。
   - **记录上半段与穿行车道**：`incomingOnOwnLane` 标记 `ownLane` 在进入本行前是否已有上游连线（顶端提交为 `false`，中间/祖先提交为 `true`）；`passThroughLanes` 记录除 `ownLane` 与 `exitingLanes` 外所有持续向下穿行的活跃车道（提交展开文件子行时，直接按下一行前活跃车道绘制垂直延伸线，保证连续无断口）。
   - **处理父提交与下半段出边（`outgoingEdges`）**：
     - 仅跟踪**存在于当前可见 `commits` 集合中**的父提交（防止 `自动` 模式或分页边界产生指向未知节点的悬空线头，同时在分页截断边界允许单条继续向下的淡出短尾）。
     - 第一个可见父提交优先沿用 `ownLane`（若已有其他车道在等待该父提交，则从 `ownLane` 画合并弧线汇入该既有车道并释放 `ownLane`）。
     - 其余可见父提交（Merge Commit 的第二及更多父提交）若已有车道在等待则直接连曲线汇入，否则分配新空闲车道并记入 `outgoingEdges` 绘出三阶贝塞尔分叉曲线。
3. **可视宽度限制**：泳道间距 `12px`、圆点半径 `3.5px`（`HEAD` 双环 `4.5px`）、曲线线宽 `1.6px`，最大泳道槽位宽度上限 `72px`（6 列，超出时横向压缩间距或折叠边缘槽位），保障 `320px` 窄栏下提交标题可读。

### 7.5 最小遮挡悬浮提交详情卡（`popover.js`）

鼠标悬停提交行（延迟 `260ms` 打开，移入卡片区域保活，移出 `180ms` 关闭）或点击行末文档图标（固定开启直至点击外部或按 `Escape`）显示 VS Code 风格提交详情卡，包含：作者名、相对时间与本地绝对时间（如 `1 天前 (2026-11-20 11:17)`）、共同创作者列表（若有）、完整提交正文 `%B` 与一键复制完整 SHA 按钮。

定位由纯函数 `computeMinOcclusionPopoverStyle(anchorRect, cardSize, graphContentRect, viewportRect)` 计算：

1. 计算两种候选垂直位置：
   - **上方候选** `topAbove = anchorRect.top - gap - cardSize.height`（允许借用上区「源代码管理」空间，钳制在 `viewportRect.top + pad` 以上；若仍撞到锚点行则记录不可行）。
   - **下方候选** `topBelow = anchorRect.bottom + gap`（钳制在 `viewportRect.bottom - pad - cardSize.height` 以内；若撞到锚点行则记录不可行）。
2. 对每个可行候选位置，计算卡片矩形 `[top, top + cardSize.height]` 与**可见图表列表内容区** `graphContentRect` 的垂直交集像素长度（`occludedGraphPx`）。
3. 决策规则：
   - 优先选择 `occludedGraphPx` 更小的位置（因此悬停在第 1、2 条提交时，上方借用上区空间，遮挡图表行像素少于下方，自动向上弹出）。
   - 若上下两个可行位置的 `occludedGraphPx` 相等（如悬停在图表区中部），默认选**下方**。
   - 若某一方向在 `iframe` 视口内空间不足，自动翻转至另一方向并严格钳制在 `viewportRect` 内，确保内容可内部纵向滚动且绝不被 `iframe` 裁切。

### 7.6 主题、字体、快捷键与无障碍

1. **纯语义 CSS 变量与 `!important` 覆盖**：
   - 仅消费宿主语义变量（`--background`、`--card`、`--secondary`、`--muted`、`--accent`、`--foreground`、`--muted-foreground`、`--placeholder`、`--border`、`--primary`、`--primary-foreground`、`--error`、`--ring`、`--font-family`、`--editor-font-family`），并为 `--success`、`--warning` 与 `--vscode-editor-font-family` / `--font-mono` 提供本地亮暗双态回退。
   - 严禁请求外网字体 CDN；UI 与等宽字体按安全白名单校验后追加双语本地回退栈（`'Microsoft YaHei', sans-serif` 与 `ui-monospace, 'Cascadia Mono', 'Consolas', monospace`）。
   - 使用 `body { background: ... !important; color: ... !important; font-family: ... !important; }` 覆盖 `preload.js` 在 `DOMContentLoaded` 写入的内联亮色与字体。
2. **明暗同步与对比度**：
   - 用 `MutationObserver` 监听 `document.documentElement` 的 `style`、`data-theme`、`class` 属性（无定时器轮询），通过 1×1 Canvas `getImageData` 解码 `--background`（过滤 alpha `< 250`，兼容 `oklch()` / `color-mix()`），结合 `matchMedia('(prefers-color-scheme: dark)')` 同步 `data-theme="dark" | "light"` 与 `color-scheme`。
   - 边框与悬停底色优先由 `color-mix(in srgb, var(--foreground) N%, transparent)` 派生；状态文本色在运行时按 WCAG `4.5:1` 校验并微调亮度，适配高对比度主题。
3. **键盘与焦点**：
   - 全局快捷键（如在图表列表内用 `ArrowUp`/`ArrowDown`/`Enter` 浏览）显式跳过表单控件 `input, select, textarea, button, [contenteditable]`。
   - 隐藏鼠标焦点框，为键盘操作统一提供 `:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }`（贴边与溢出裁切容器内改用 `outline-offset: -2px`）。
   - 列表局部重渲染前记录 `:focus-visible` 元素标识，重渲染后恢复焦点（`focus({ preventScroll: true })`）。
4. **双语 i18n**：
   - 内置 `zh-CN` 与 `en` 完整词典，默认 `locale: 'auto'` 按 `navigator.language` 匹配（`zh` 前缀用中文，其余用英文）；在 `⋯` 菜单中切换后持久化保存。

## 8. 插件清单、安装脚本与验证体系

### 8.1 `plugin.json` 与 `sidecars/panel/sidecar.json`

`plugin.json`：

```json
{
  "name": "antigravity-git-worktree",
  "displayName": "Git Graph",
  "version": "0.1.0",
  "description": "VS Code-style Source Control and inline SVG Commit Graph in the Antigravity Auxiliary Pane.",
  "logo": "assets/logo.svg",
  "repository": "https://github.com/Lynn-zy/antigravity-git-worktree"
}
```

`sidecars/panel/sidecar.json`（禁止书写 `${HOME}` 模板，不滥用 `agent_permissions` 与 `disable_sandbox`）：

```json
{
  "command": "node",
  "args": ["--max-old-space-size=192", "main.mjs"],
  "restart_policy": "always",
  "display_name": "Git Graph",
  "description": "Source Control and Commit Graph following the active conversation workspace.",
  "has_web_ui": true,
  "ui_config": {
    "display_name": "Git Graph",
    "views": [
      {
        "path": "/",
        "entrypoint": "SIDECAR_UI_ENTRYPOINT_AUX_PANE",
        "title": "Git Graph"
      }
    ]
  }
}
```

### 8.2 跨平台安装脚本（`scripts/install.ps1` 与 `scripts/install.sh`）

- **目标路径**：`~/.gemini/config/plugins/antigravity-git-worktree/`（Windows 下基于 `$HOME` / `$env:USERPROFILE`）。
- **默认模式（安全拷贝）**：仅复制运行必需文件（`plugin.json`、`assets/`、`sidecars/panel/`），跳过 `.git`、`docs`、`tests`、`scripts`、`README.md`。若目标已存在先做校验并安全替换（兼容先前曾用链接安装的目录，绝不误删源仓库文件）。
- **开发者链接模式（`-Link` / `--link`）**：
  - Windows：`New-Item -ItemType Junction -Path $target -Target $repoRoot`（无需管理员权限）。
  - macOS / Linux：`ln -s "$repoRoot" "$target"`。
- **卸载模式（`-Uninstall` / `--uninstall`）**：安全移除目标目录或链接（删 Junction/Symlink 仅移链接本身，不动源仓库）。
- **安装后提示**：输出明确提示，引导用户在 Antigravity Customizations 页面启用插件（严禁脚本直接篡改 `~/.gemini/config/config.json`）。

### 8.3 自动化测试与回归验证

测试须遵守行为驱动原则，通过公开接口与真实 Git 进程验证可观察行为：

1. **后端单元与集成测试（`node --test tests/unit/*.test.mjs tests/integration/*.test.mjs`）**：
   - `discovery`：Windows 盘符大小写与 `%3A` URI、多 `Workspace` 指向同仓不同 `Worktree` 去重、非 Git 目录忽略、嵌套 Submodule 边界、`bare` 仓探测。
   - `git-queries` & `git-mutations`：在 `os.tmpdir()` 构建真实临时仓库，覆盖中文路径、空格文件名、`-weird.txt`、0 提交 unborn 仓库暂存/取消暂存（`rm --cached`）/首次提交、`MM` 双态文件放弃更改不伤暂存区、单文件未跟踪删除、批量放弃不删未跟踪、外部合并冲突阻断提交、`Detached HEAD`、`git show --name-status -z` 重命名与 Merge Commit 解析、`autoStageAll` 自动暂存提交。
   - 锁与凭据：人为创建 `.git/index.lock` 验证 3 次退避后返回 `GIT_LOCKED` 且不删锁文件；起本地 `127.0.0.1` HTTP 401 服务验证 `fetch` 在 `GCM_INTERACTIVE=never` 下 2 秒内快速返回 `AUTH_REQUIRED` 而不卡死。
   - 监听与长轮询：触发 `.git` 与工作区写入验证 `POST /api/events/wait` 及时唤醒；删除被监听目录验证 Windows `\\?\` 自毁守卫生效且不发风暴；验证 Standalone 的 Host / Origin / Content-Type / 越界路径拦截。
2. **前端纯逻辑与浏览器回归（`tests/browser/`）**：
   - `graph-layout.js` 测试：单线、分支分叉、多父 Merge Commit 连续无断口、`自动` 模式无悬空线头、展开文件行穿行竖线连续。
   - `popover.js` 测试：顶部第 1/2 项向上弹出、中部默认向下、底部空间不足翻转并钳制在视口内。
   - 真实浏览器（Standalone + `<iframe sandbox="allow-scripts" srcdoc="...">` 注入 `theme-change` / `workspace-change`）：验证 `320px`、`360px`、`420px`、`560px` 零横向溢出（`scrollWidth <= clientWidth`）、0 控制台报错、深浅主题切换、未暂存时点击提交弹窗确认且提交完成后主按钮切换为推送更改、键盘焦点与重渲染保焦。

### 8.4 Windows Antigravity 2.0 桌面端真机验收清单

该清单同步写入 V1 最终人工验收 Issue（`ready-for-human`）：

- [ ] 运行 `scripts/install.ps1` 成功安装至 `~/.gemini/config/plugins/antigravity-git-worktree/`，在 Antigravity Customizations 启用后侧栏正常渲染 `Git Graph`，无控制台或 `sidecar.log` 报错。
- [ ] 在 Antigravity 中切换不同仓库对话、新建/切换宿主 Worktree、在终端 `git checkout` / 编辑文件，辅助栏均在 1 秒内自动同步，无 `index.lock` 竞争报错。
- [ ] 在仅存在未暂存更改时填好说明点击「提交」，确认弹窗后完成提交，工作区干净且领先上游时主按钮自动切换为「推送更改 N↑」；验证 `MM` 文件放弃未暂存不伤暂存区、未跟踪单文件红字二次确认删除。
- [ ] 在图表中切换 `自动 / 全部`、测试含 Merge 分支仓库的连线完整性、展开提交文件列表、分别悬停顶部/中部/底部提交行验证悬浮卡最小遮挡与不裁切。
- [ ] 点击上区更改文件与下区展开文件，确认宿主原生 `fileView` 正确打开对应文件；历史已删文件不可点击并显示提示。
- [ ] 切换 Antigravity 深色/浅色主题与调整辅助栏宽度（含 `320px` 极窄态），确认配色、对比度、字体与无横向溢出表现正常，输入框内 `Ctrl+C/V/Z/A`、`Ctrl+Enter` 与 `Ctrl+B` 表现符合预期。
- [ ] 再次运行 `scripts/install.ps1` 覆盖安装，确认无 Windows 目录句柄锁定报错。

## 9. V1 实施里程碑与任务拆解

V1 划分为 6 个按垂直能力递进、可独立验收的实施任务，已同步在 GitHub 创建并建立原生 `blocked_by` 依赖链：

| 顺序 | 里程碑任务 | 依赖 | 标签 | 核心验收标准 |
| --- | --- | --- | --- | --- |
| M1 | [M1: 后端 Repository 发现、Git CLI 安全执行层与只读查询](https://github.com/Lynn-zy/antigravity-git-worktree/issues/9) | 无 | `ready-for-agent` | 通过多仓库/Worktree、中文路径、unborn、重命名、Merge Commit 与 401 非交互凭据测试 |
| M2 | [M2: 后端写操作、文件监听降级、长轮询与双模式安全 HTTP 服务](https://github.com/Lynn-zy/antigravity-git-worktree/issues/10) | M1 | `ready-for-agent` | 全部 `POST /api/*` 就绪，通过锁重试、Windows 自毁守卫、Origin/Host 防护与 Standalone 冒烟测试 |
| M3 | [M3: 前端主题与快捷键骨架、双区布局及「源代码管理」上区](https://github.com/Lynn-zy/antigravity-git-worktree/issues/11) | M2 | `ready-for-agent` | 深浅主题同步、双区拖拽折叠、提交与推送主按钮状态机、`Discard` 护栏与 `fileView` 跳转可运行 |
| M4 | [M4: 前端「图表」下区（动态 SVG 车道、原地展开、最小遮挡悬浮卡、分页与 i18n）](https://github.com/Lynn-zy/antigravity-git-worktree/issues/12) | M3 | `ready-for-agent` | Merge 连续拓扑、最小遮挡定位、本地搜索、`自动/全部`、分页加载与中英切换就绪 |
| M5 | [M5: 插件清单、跨平台安装脚本（install.ps1 / install.sh）与端到端浏览器回归套件](https://github.com/Lynn-zy/antigravity-git-worktree/issues/13) | M4 | `ready-for-agent` | 补齐 `plugin.json` / `sidecar.json` / `logo.svg` / 安装脚本，自动化单元、集成与 320–560px 浏览器回归全绿 |
| M6 | [M6: Windows Antigravity 2.0 桌面端真机安装与验收](https://github.com/Lynn-zy/antigravity-git-worktree/issues/14) | M5 | `ready-for-human` | 逐项完成第 8.4 节真机验收清单并记录结果 |
