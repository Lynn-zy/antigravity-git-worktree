# Antigravity 2.0 Git 源代码管理与提交图表 Sidecar 架构规格（V1）

本文档定义 `antigravity-git-worktree` 插件 V1 的系统架构、接口契约、Git CLI 执行规范、前端双区交互、跨平台安装与验证标准。所有领域概念以 [GLOSSARY.md](../GLOSSARY.md) 为准，顶层约束遵守 [ADR-0001](./adr/0001-pure-official-sidecar-and-scope-focus.md) 与 [ADR-0002](./adr/0002-zero-build-esm-and-svg-graph.md)。

## 1. 目标、定位与范围

### 1.1 产品定位

本插件是面向 Antigravity 2.0 桌面端右侧 `Auxiliary Pane` 的**纯 Sidecar UI 插件**（不捆绑额外 Skill），插件标识为 `antigravity-git-worktree`，侧栏视图标题为 `Git Graph`。

插件以纯官方 Sidecar 机制与本地文件系统监听运行，保持零外部运行时依赖与零构建流程（Node.js `>=20` ESM 后端 + 原生 ES2022 模块化前端 + 内联 SVG 拓扑图），同时支持脱离宿主的 Standalone 本地 HTTP 预览模式。

### 1.2 V1 核心能力

1. **被动跟随宿主工作区**：监听宿主 `workspace-change` 事件与本地 `.git`、工作区文件变化，自动同步当前对话 `Workspace` 命中的 `Repository`、`Worktree` 与当前分支状态。面板顶部常驻「存储库」列表（对齐 VS Code「存储库」视图），每行显示仓库名、当前分支与同步状态，点击行切换当前仓库；只有一个仓库时也显示。
2. **VS Code 风格上下可拖拽双区（无 Tab）**：
   - **上区（更改）**：原生提交说明输入框（支持 `Ctrl/Cmd + Enter`）、智能主按钮（工作区有改动时始终可点「提交」，未暂存时弹窗确认自动暂存全部并提交；工作区干净时按 VS Code 的顺序切换为「发布分支」或「同步更改 N↓ M↑」，同步先快进拉取、之后仍领先上游时再推送）、可折叠的「暂存的更改」与「更改」文件列表（支持单文件与全部暂存、取消暂存，以及带确认护栏的放弃更改与未跟踪文件删除）。
   - **下区（图表）**：单行紧凑顶栏（`自动 / 全部` 分支范围、转到当前提交、`Fetch`、`Pull`、`Push / Publish`、`Refresh`、`⋯` 更多菜单）、移植自 VS Code「图表」视图的 `22px` 内联 SVG 提交拓扑图（领先或落后上游时含「传出的更改」「传入的更改」行）、点击提交行原地展开改动文件列表、点击行尾「查看提交详情」按钮打开的最小图表遮挡提交详情卡。
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
│   └── logo.svg                        # 插件图标（Codicons git-branch 字形，与无仓库空态图标一致，四周留白）
├── sidecars/
│   └── panel/
│       ├── sidecar.json                # Auxiliary Pane Sidecar 清单
│       ├── main.mjs                    # 双模式入口：释放 cwd、启动 SidecarApp 或 Standalone HTTP
│       ├── sdk.mjs                     # 延迟加载 sidecar_sdk（import + createRequire 回退）
│       ├── public-bundle.mjs           # 零构建运行时 classic 脚本装配与资源内容哈希版本化
│       ├── backend/
│       │   ├── api-router.mjs          # 全部 POST /api/* 路由、入参白名单校验与错误映射
│       │   ├── discovery.mjs           # Workspace URI 规范化、Repository 去重与 Worktree 匹配
│       │   ├── git-runner.mjs          # 安全 execFile/spawn、两级写锁队列、超时与非交互凭据
│       │   ├── git-queries.mjs         # status/log/show/remote 只读查询与 -z 二进制解析
│       │   ├── git-mutations.mjs       # stage/unstage/discard/commit/fetch/pull/push/sync 写操作
│       │   ├── watcher.mjs             # .git 与当前工作区 fs.watch、自毁守卫与变更过多降级
│       │   ├── event-bus.mjs           # 内存 revision 版本号与挂起式长轮询管理
│       │   ├── preferences.mjs         # 轻量偏好（locale/graphScope/splitRatio）持久化
│       │   └── mock-fixture.mjs        # Standalone ?fixture=mock 离线演示数据
│       └── public/
│           ├── index.html              # 面板文档骨架（保留 <script src="/preload.js">）
│           ├── styles.css              # VS Code 源代码管理视图尺寸、宿主语义色映射与窄幅 @container
│           ├── app.js                  # 顶层状态协调、宿主桥接、长轮询与事件绑定
│           ├── file-icons/             # vscode-icons 文件与文件夹 SVG（只含映射表用到的图标）与其 LICENSE
│           └── modules/
│               ├── api-client.js       # 统一 POST JSON 客户端（window.sidecar.fetch 回退 fetch）
│               ├── theme.js            # MutationObserver + 1x1 Canvas 明暗检测与对比度校正
│               ├── i18n.js             # 中英双语词典与相对/绝对时间格式化
│               ├── graph-layout.js     # 泳道布局纯函数（移植自 VS Code scmHistory.ts）
│               ├── codicons.js         # VS Code Codicons 图标路径（由 scripts/gen-codicons.mjs 生成）
│               ├── file-icon-map.js    # 文件名、扩展名、文件夹名到 vscode-icons 图标的映射（由 scripts/gen-file-icons.mjs 生成）
│               ├── file-icons.js       # 按 VS Code 图标主题顺序解析文件与文件夹图标 URL
│               ├── toast.js            # 轻提示就近定位纯函数与提示栈控制
│               ├── progress-bar.js     # 窗格标题栏底边的不定进度条（移植自 VS Code ProgressBar）
│               ├── popover.js          # 提交详情卡最小遮挡定位纯函数
│               ├── markdown.js         # 提交说明 Markdown 解析（纯函数）与 DOM 渲染
│               ├── repos-view.js       # 顶部「存储库」列表与行内分支、同步状态
│               ├── changes-view.js     # 上区「更改」渲染与确认弹窗交互
│               └── graph-view.js       # 下区提交图表、原地文件展开与顶栏交互
├── scripts/
│   ├── install.ps1                     # Windows 安装脚本（默认拷贝，支持 -Link Junction 与 -Uninstall）
│   ├── install.sh                      # macOS / Linux 安装脚本（默认拷贝，支持 --link 与 --uninstall）
│   ├── gen-codicons.mjs                # 从固定提交的 vscode-codicons 生成 codicons.js（开发用，不随插件安装）
│   └── gen-file-icons.mjs              # 从固定提交的 vscode-icons 与 VS Code 生成 file-icon-map.js 与 file-icons/（开发用）
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
| 静态资源（`/`、`/styles.css`、`/app.js`、`/preload.js`） | `GET` | `SidecarApp.page()` 提供，绑定 `127.0.0.1` | 绑定 `127.0.0.1`，校验 `Host` 匹配 `/^(127\.0\.0\.1\|localhost)(:\d+)?$/` |
| 文件类型图标（`/file-icons/<名称>.svg`） | `GET` | 启动时为 `public/file-icons/` 下每个 SVG 逐个注册 `SidecarApp.page()` | 按前缀匹配；名称只允许单层 `[a-z0-9_+-.]` 且以 `.svg` 结尾，其余一律 `404` |
| 全部业务接口（`/api/*`） | 仅允许 `POST` | `SidecarApp.api(..., 'POST')` 强制校验 `X-Sidecar-Token`；前端经 `window.sidecar.fetch` 发送 | 校验 `Host` 白名单 + 强制 `Origin === http://${host}` + `Content-Type` 以 `application/json` 开头 + 请求体上限 `1 MiB` |

补充约束：

- `SidecarApp.page(pathname, handler)` 按精确路径匹配且无目录通配符；此外，若 handler 直接返回字符串，SDK 仅对 `.js` 设 `application/javascript`，其余路径默认标为 `text/html`。同时，Antigravity 2.0 侧栏 iframe 通过自定义协议加载静态资源，Chromium 对 `<script type="module">` 强制执行 CORS 检查会直接拦截加载。因此 `public/modules/*.js` 与 `public/app.js` 在源码层保持原生 ES2022 模块，由 `public-bundle.mjs` 在运行期按显式依赖拓扑零构建装配为单个 classic script 通过 `GET /app.js` 下发，`index.html` 在 `<head>` 中以 `<script src="/preload.js">` 与 `<script defer src="/app.js?v=<hash>">` 加载。`main.mjs` 按白名单注册 `/`、`/styles.css`、`/app.js`，全部返回带显式 `Content-Type`（`text/html; charset=utf-8`、`text/css; charset=utf-8`、`text/javascript; charset=utf-8`）及 `Cache-Control: no-store`、`X-Content-Type-Options: nosniff` 的 `Response` 实例。
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
5. 写操作的 `paths` 与提交文件的链接由 `createWorktreePathResolver(worktreePath)` 校验：拒绝空字节、控制字符、绝对路径、`..`，以及经符号链接或 Junction 指到 Worktree 外的路径（`OUT_OF_WORKTREE`）。每个请求建一个解析器：根目录真实路径只求一次，文件本身只做 `lstat`（是符号链接时才求它指向的真实路径），所在目录的真实路径在解析器内缓存。Windows 上 `realpath` 要打开文件句柄，逐个文件求真实路径会让 1120 个文件的提交详情多花约 700 ms。文件是否存在也取自 `lstat` 结果，符号链接按指向判断。
6. 变更列表的链接不经过上述解析器，也不做第 5 条的各项拒绝：根目录真实路径只求一次，再与 `git status` 输出的相对路径直接拼成 `file:` URI，不查文件系统；文件名含控制字符时按百分号编码。路径来自 git 自身；宿主 `fileView` 是只读预览，打开的文件也不进入 Agent 上下文，所以指向 Worktree 外的符号链接照常可打开，与编辑器行为一致，安全边界在写操作的路径校验上。逐条 `lstat` 与路径规范化会让 5000 条变更的解析多花约 120 ms。

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
4. **去重键**：以规范化后的 `gitCommonDir`（取 `pathKey`）作为 `Repository.id`。多个 `Workspace` URI 落在同一仓库的不同子目录或不同 `Worktree` 时，合并为同一个 `Repository`，取第一个命中目录的 `git worktree list --porcelain -z` 结果。
5. **并行探测**：每次完整快照（包括切换仓库）都会重跑发现，Windows 上单个 Git 进程启动约 `60ms`。各 `Workspace` 目录并行探测，`git worktree list` 不依赖探测结果，与第一阶段 `rev-parse` 同时启动，发现只占一轮进程启动的时间。
6. **命中当前 `Worktree`**：在 `worktree list` 返回的所有非 `bare` 条目中，使用**路径段前缀匹配**（比较规范化后相等，或 `wsPath` 以 `wt.path + '/'` 开头，避免 `D:/repo` 误匹配 `D:/repo-wt`）查找包含 `wsPath` 的 `Worktree`，多重嵌套时取 `wt.path` 长度最长者。若同一 `Repository` 命中多个 `Workspace` 目录，按 `workspaceUris` 传入顺序取第一个命中的 `Worktree` 作为当前被动跟随目标。

### 4.3 特殊仓库状态处理

| 状态 | 判定依据 | 后端与界面行为 |
| --- | --- | --- |
| 无仓库（`repositories.length === 0`） | 当前 `Workspace` 全部为非 Git 目录或为空 | 返回空仓库列表；前端显示单页空态提示（说明当前对话工作区未包含 Git 仓库） |
| 一个或多个 `Repository` | `repositories.length >= 1` | 面板顶部常驻可折叠的「存储库」区，每个仓库一行（见 7.1），当前仓库高亮。默认按 `workspaceUris` 顺序选中第一个，点击行切换，切换后仅在当前会话内存中保持（当 `workspaceUris` 列表变化且旧 `selectedRepoId` 不再命中时自动切回第一个） |
| `bare` 仓库 | `isBareRepository === true` 且未命中非 bare 工作树 | 进入只读态：上区提示「裸仓库不支持工作区修改」并隐藏提交/暂存区，下区仍可正常浏览 `Commit Graph` 与执行 `Fetch` |
| 0 提交（Unborn） | `status --porcelain=v2 --branch` 返回 `# branch.oid (initial)` | `Commit Graph` 返回空列表并显示空提交提示（不执行带 `HEAD` 的 `git log`）；上区支持正常暂存、取消暂存（走 `git rm --cached`）与首次提交；工作区干净且无提交时不显示同步/发布主按钮 |
| 游离 HEAD（`Detached HEAD`） | `# branch.head (detached)` | 上区顶部显示轻量提示条，允许知情提交；工作区干净时不展示同步/发布主按钮；下区顶栏 `Pull` 与 `Push` 禁用，`Fetch` 与 `Refresh` 保持可用 |

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
- `NON_FAST_FORWARD`：`git pull --ff-only`（含同步更改的拉取步骤）或 `git push` 因远端分叉被拒。
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
      {
        "id": "...", "name": "AGY-GitWorktree", "worktreePath": "D:/private/AGY-GitWorktree",
        "isBare": false, "isDetached": false, "headOid": "2a76567...", "branch": "main"
      }
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
      ],
      "mergeBase": "5af2c1e..."
    },
    "watchState": { "active": true, "degraded": false, "reason": null },
    "preferences": { "locale": "auto", "graphScope": "auto", "splitRatio": 0.42 }
  }
  ```
- 说明：`forceRefresh: true` 时若监听处于降级态（变更过多或监听出错），清除降级并重新挂载文件监听。`changes.truncated` 为 `true` 表示变更超过上限，列表只含前 `5000` 条。
- `repositories` 每项供「存储库」行显示仓库名与分支：当前仓库取自 `activeRepo`，其余仓库取自 `git worktree list`，不额外执行 Git 命令。摘要不带上游与领先、落后数：后端只监听当前仓库，其余仓库的同步状态在终端或 Agent 提交、推送后会过时，所以不提供；当前仓库那一行的同步状态由前端取自 `activeRepo`。
- `graph.mergeBase` 为当前分支与上游的合并基（`git merge-base HEAD <upstream>`），只在存在上游且领先或落后时查询，否则为 `null`。前端用它定位「传入的更改」「传出的更改」行（见 7.4）。

#### 2. `POST /api/status`

只有工作区文件变化时，前端用它代替完整快照：沿用上次快照记录的仓库，只执行一次 `git status`，不重跑仓库发现、`git log` 与 `git remote`。

- **Request**：`{ "workspaceKey": "...", "sinceRevision": 12 }`（`workspaceKey` 必须来自本进程内的一次 `/api/snapshot`，否则返回 `NO_REPOSITORY`，前端随即回退到完整快照）
- **Response `data`**：`{ "workspaceKey", "revision", "activeRepo", "changes", "watchState" }`，字段格式与 `/api/snapshot` 相同；`activeRepo` 的 HEAD、分支、上游与领先落后数取自本次 status，其余字段沿用上次快照。
- **版本号**：在执行 `git status` 前取当前版本号返回，执行期间到达的变更由下一轮长轮询补上；若 `sinceRevision` 之后还有未处理的 `full` 级变更，则原样返回 `sinceRevision`，让下一轮长轮询立即要求完整快照。

#### 3. `POST /api/commit/detail` 与 `POST /api/commit/stats`

用户展开某条提交的文件列表，或点击「查看提交详情」按钮打开提交详情卡时调用 `detail`；`stats` 只在打开详情卡时调用，展开文件列表不等它。前端按 `sha` 做内存缓存（「传入/传出的更改」行按比较两端缓存），切换仓库或 Worktree、强制刷新时清空；切换前发出、切换后才返回的请求结果直接丢弃，不写进新缓存。

- **Request**（两者相同）：`{ "worktreePath": "...", "sha": "2a76567..." }`（校验 `sha` 匹配 `/^[0-9a-f]{7,64}$/i`）
- `detail` 可另传 `parentSha`（同样校验），文件清单改为 `git diff --name-status -M -z --end-of-options <parentSha> <sha>` 的两点比较。展开「传出的更改」时传 `sha = HEAD`、`parentSha = mergeBase`，展开「传入的更改」时传上游提交与 `mergeBase`，同 VS Code 以合并基为比较基。
- **`detail` 的 Response `data`**：
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
- **`stats` 的 Response `data`**：`{ "files": 6, "insertions": 336, "deletions": 78 }`。出错时前端不显示统计区：超时（`GIT_TIMEOUT`）说明提交太大，不再重试；其他错误在下次打开详情卡时重试。

#### 4. `POST /api/events/wait`

挂起式长轮询端点，用于替代 `SidecarApp` 不支持的流式 SSE。

- **Request**：`{ "workspaceKey": "...", "sinceRevision": 12, "timeoutMs": 20000 }`（后端将 `timeoutMs` 钳制在 `1000–20000` 毫秒）
- **行为**：
  - 每次变更都带刷新级别：工作区文件变化、监听降级通知，以及 `stage`、`unstage`、`discard` 写操作为 `status` 级；`.git` 元数据变化（`HEAD`、`refs`、`packed-refs`、`index`、`config`、`worktrees`）、`commit`、`fetch`、`pull`、`push` 与不带作用域的广播为 `full` 级。
  - 返回 `{ "revision": current, "refresh": "none" | "status" | "full" }`：`sinceRevision` 之后没有变更为 `none`；全部是 `status` 级为 `status`（前端调用 `/api/status`）；其中有任意一次 `full` 级为 `full`（前端调用 `/api/snapshot`）。
  - 已有变更时立即返回；否则挂起 Promise 注册到 `event-bus.mjs`，当 `fs.watch` 防抖触发或写操作完成后立刻 `resolve`；到达 `timeoutMs` 仍无变化则返回 `refresh: "none"`。会话未知、监听已被 LRU 淘汰或 Sidecar 重启时直接返回 `full`。
  - 同一客户端重连或关闭时通过上限清理避免内存泄漏（最多同时挂起 8 个等待者，超出时提前唤醒最旧者返回 `refresh: "none"`）。

#### 5. `POST /api/changes/stage` 与 `POST /api/changes/unstage`

- **Request**：`{ "worktreePath": "...", "all": false, "paths": ["README.md"] }`（`all: true` 或非空 `paths[]` 二选一）
- **Response `data`**：`{ "revision": 13 }`（写操作成功后递增内存版本号，前端随之拉取最新快照）。

#### 6. `POST /api/changes/discard`

- **Request**：
  - 单文件/批量已跟踪文件还原：`{ "worktreePath": "...", "allTracked": false, "paths": ["README.md"], "untracked": false }`
  - 单文件未跟踪删除：`{ "worktreePath": "...", "allTracked": false, "paths": ["temp.txt"], "untracked": true }`（仅当 `untracked: true` 时强制校验 `paths.length === 1` 且该路径确在最新未跟踪列表中）
- **护栏约束**：`allTracked: true` 绝不删除未跟踪文件；`paths` 禁止包含处于合并冲突的文件；所有路径必须通过 `worktreePath` 边界校验。

#### 7. `POST /api/commit`

- **Request**：`{ "worktreePath": "...", "message": "feat: ...", "autoStageAll": false }`
- **行为**：
  - 检查冲突列表非空则返回 `409 CONFLICT_BLOCKED`。
  - 检查 `message.trim()` 为空则返回 `400 EMPTY_COMMIT_MESSAGE`。
  - 在同一仓库写队列内，若 `autoStageAll === true` 先执行 `git add -A`，随后通过 `stdin` 执行 `git commit -F -`。

#### 8. `POST /api/remote/fetch`、`POST /api/remote/pull`、`POST /api/remote/push`

- **`fetch`**：请求体传入 `{ "worktreePath": "..." }`，执行 `git fetch --all --prune`。
- **`pull`**：请求体传入 `{ "worktreePath": "..." }`，校验非 unborn、非 detached 且存在上游后执行 `git pull --ff-only`。
- **`push`**：请求体传入 `{ "worktreePath": "...", "remote": "origin" }`（`remote` 仅在无上游 Publish Branch 时必填；存在上游时忽略并执行 `git push`）。所有推送路径均禁止使用 `--force` 与 `--force-with-lease`。
- **`sync`**：请求体传入 `{ "worktreePath": "..." }`，流程同 VS Code「同步更改」：校验条件与 `pull` 相同，先执行 `git pull --ff-only`，再重新读取领先数，仍领先上游时执行 `git push`。与 VS Code 的差异是拉取用 `--ff-only` 而不是普通 `git pull`：分叉时拉取失败返回 `NON_FAST_FORWARD`，本地不合并、不变基，也不推送。插件没有合并编辑器，宿主 `fileView` 只读，面板也没有中止合并的入口，留在合并或变基的中间状态无法在面板里收尾。不弹确认框，同 VS Code Agents 窗口的 `git.confirmSync` 默认值。

#### 9. `POST /api/preferences`

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
| 工作区变更 | `git ... --no-optional-locks status --porcelain=v2 --branch --show-stash -z` | 顺序指针消费 NUL token：普通项 `1` 占 1 token（按前 8 个空格切分保留路径空格）；重命名 `2` 占 2 token（**`newPath` 在前、`origPath` 在后**）；冲突项 `u` 单独归入 `conflicted[]`；未跟踪 `?` 归入 `unstaged[]` 并标 `untracked: true`。`XY` 均非 `.`（如 `MM`）时同时进入 `staged[]` 与 `unstaged[]`。边读 stdout 边解析，变更条目超过 `5000` 条时立即结束 git 进程，只保留前 `5000` 条并设 `truncated: true`。 |
| 图谱（`全部`） | `git ... --no-optional-locks log --exclude=refs/stash --all --topo-order --decorate=full -z -n <limit+1> --format=%H%x1f%P%x1f%D%x1f%an%x1f%ae%x1f%at%x1f%s` | 排除 `refs/stash` 伪节点；多拉 1 条判断 `hasMore`；0 提交 unborn 仓库安全返回空串。`%D` 按 `", "` 与 `" -> "` 安全拆分（Git 禁止 ref 名含空格）。 |
| 图谱（`自动`） | 非 unborn 时：`git ... --no-optional-locks log --topo-order --decorate=full -z -n <limit+1> --format=... --end-of-options HEAD [<upstream>]` | 若当前分支有上游跟踪分支则同时传入 `HEAD` 与 `<upstream>`，同时显示领先与落后分支；unborn 仓库跳过调用直接返回空数组。 |
| 图谱分页 | 首屏 `limit = 150`，每加载一页 `+200`，硬上限 `2000` | 采用增大 `limit` 重拉并在前端按 `sha` 稳定合并，避免提交新增导致 `--skip` 漂移重复。达到 `2000` 时置 `reachedSoftLimit: true` 提示缩小范围。 |
| 提交正文 | `git ... --no-optional-locks show -s --format=%B --end-of-options <sha>` | 逐行提取末尾 `Co-authored-by: Name <email>`（大小写不敏感）至 `coAuthors[]`，其余文本归入 `body`。 |
| 提交文件清单 | `git ... --no-optional-locks show --name-status -M -m --first-parent --format= -z --end-of-options <sha>` | 根提交与 Merge Commit 均稳定输出标准状态，空提交返回空 Buffer 解析为 `files: []`。普通项占 2 token（`<status>`, `<path>`），`R*`/`C*` 重命名复制项占 3 token（`<status>`, **`origPath` 在前、`newPath` 在后**，与 `status -z` 相反）。每个最终路径经 Worktree 路径解析器校验（见 4.1），并由它返回 `existsInWorktree`。 |
| 提交改动统计 | `git ... --no-optional-locks show --numstat -M -m --first-parent --format= -z --end-of-options <sha>` | 每个文件一条 `<增>\t<删>\t<路径>`，汇总为 `stats.files`、`stats.insertions`、`stats.deletions`。重命名复制项的路径字段为空，源路径与新路径各占随后一个 token；二进制文件的增删为 `-`，只计入文件数。不用 `--shortstat`，因为它的文案会随 Git 界面语言翻译。numstat 要逐个比较文件内容，在 1120 个文件的提交上实测比 name-status 慢约 3 倍（约 370 ms 对 115 ms），所以由 `/api/commit/stats` 单独执行，不拖慢文件列表。 |
| 暂存 | 单/多文件 `git add -- <paths>`；全部 `git add -A` | 走 Worktree 级写队列。 |
| 取消暂存 | 有提交：`git restore --staged -- <paths>`（全部不传路径或传 `.`）；**unborn 仓库**：`git rm --cached -r -- <paths>` | 实测 unborn 仓库执行 `git restore --staged` 会报 `fatal: could not resolve 'HEAD'`，必须走 `git rm --cached`。 |
| 放弃更改 | 已跟踪：`git restore --worktree -- <paths>`（批量 `git restore --worktree -- .`）；单文件未跟踪：`git clean -f -- <path>` | 仅还原工作区，保留已暂存改动（`MM` 态不伤暂存区）；批量绝不执行 `git clean`。 |
| 提交 | `git commit -F -`（`stdin` 写入 UTF-8 正文） | 规避 Windows 命令行长度与引号转义问题。 |
| 远程同步 | `git fetch --all --prune` / `git pull --ff-only` / `git push` 或 `git push -u --end-of-options <remote> <branch>`；同步更改为 `git pull --ff-only` 后按需 `git push` | 全部走 Repository 级写队列与非交互凭据环境；同步更改的拉取与推送在同一次队列任务里完成。 |

### 6.3 并发队列、超时与非交互凭据

1. **两级写队列与只读并发池**：
   - **Worktree 级串行队列**（键：规范化 `worktreePath`）：`stage`、`unstage`、`discard`。
   - **Repository 级串行队列**（键：规范化 `gitCommonDir`）：`commit`、`fetch`、`pull`、`push`、`sync`（`commit` 若带 `autoStageAll` 需同时串行化对应 Worktree 队列，防止边暂存边提交）。
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

### 6.4 文件监听、刷新级别与变更过多降级

后端仅对当前活跃 `Repository` 与当前命中的 `Worktree` 挂载监听，切换仓库或离开工作区时立即关闭旧句柄：

1. **监听目标**：
   - `.git/`（非递归）：仅响应 `HEAD`、`packed-refs`、`index`、`config` 与 `worktrees`（`config` 覆盖 `git remote add`、设置上游等只改配置的操作），忽略 `*.lock`、`*.new`、`objects`、`COMMIT_EDITMSG` 等过程文件。
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
3. **防抖与刷新级别**：
   - 元数据通道防抖 `200ms`，工作区通道防抖 `300ms`、连续写入时最长等待 `1s`。写入再频繁也只是合并成更少的刷新，不暂停监听。
   - 工作区通道触发 `status` 级刷新（前端只调用 `/api/status`），元数据通道触发 `full` 级刷新（前端调用 `/api/snapshot`）。
4. **变更过多降级**：
   - 每次 `status`（快照或 `/api/status`）之后都按结果重新判断。`truncated: true` 时置 `watchState = { active: true, degraded: true, reason: "too_many_changes" }`，状态随这次响应返回，不另行递增 `revision`（避免前端为同一结果再跑一遍 status）；前端在顶部展示「变更超过 5,000 条，只显示前 5,000 条；文件改动的自动刷新已放慢」与刷新按钮。
   - 降级期间工作区监听照常挂载，但工作区通道的刷新放慢：距上次 `status`（刷新触发时即开始计时，不等 status 跑完）不满 `15s` 时等到满 `15s` 再触发，已排期的刷新不再被后续事件推迟；监听出错（`watch_error`）期间 status 结果不改变降级原因；没有文件变化时不触发任何 `status`。在 Git 之外删掉多余文件后，最迟 `15s` 内会跑一次 `status`，回落到上限以内即恢复正常节奏。`.git` 元数据监听不受影响，提交、切分支、暂存等操作仍立即触发完整快照。
   - 工作区监听连续出错 3 次时置 `reason: "watch_error"` 并递增 `revision`（`status` 级）通知前端，前端提示「文件监听出错，已暂停自动刷新，请手动刷新」。用户点击刷新（`forceRefresh: true`）时清除降级并重新挂载监听。

## 7. 前端架构、交互与视觉规范

> 视觉对齐 VS Code 源代码管理视图。尺寸、间距、泳道图形与 Codicons 图标沿用 VS Code（来源与许可见 `THIRD_PARTY_NOTICES.md`），表面色取宿主 CSS 变量，宿主未注入时回退到 VS Code Dark Modern / Light Modern 默认值。交互行为与布局骨架以本节为准。

### 7.1 布局骨架与窄幅响应式（`320px–560px`）

- **根结构**：全高 Flex 纵向布局（`100vh`，零页面级横向溢出），外层容器声明 `container: ag-git-pane / inline-size`。
- **存储库区**：面板顶部常驻 `∨ 存储库` 窗格（有仓库时始终显示，可折叠），每个仓库一行 `22px`，超过 `10` 行（VS Code `scm.repositories.visible` 默认值）后在区内滚动。行内依次为仓库图标（多个仓库时当前仓库换成带勾的 `repo-selected`）、仓库名，行尾为分支项与同步项，规则同 VS Code Git 扩展状态栏：分支项为 `git-branch` 图标加分支名，游离 HEAD 为 `git-commit` 图标加 8 位短 SHA，裸仓库只显示「裸仓库」；同步项在没有远端时不显示，有上游时为 `sync` 图标，领先或落后时再加 `落后↓ 领先↑`，没有上游时为 `cloud-upload` 图标，unborn 与游离 HEAD 只显示 `sync` 图标；同步、拉取、推送或发布期间 `sync` 图标旋转。同步项只在当前仓库那一行显示：后端只监听当前仓库，其他仓库的领先、落后数会过时，所以不显示。悬停提示同 VS Code 的 `syncTooltip`。同步项同 VS Code 状态栏可以点击：有上游时执行同步更改（`POST /api/remote/sync`），没有上游时发布分支；unborn、游离 HEAD 与同步进行中时不可点，其他写操作进行中时禁用。同步与推送不改动工作区里未提交的文件，工作区有改动、主按钮显示「提交」时也能用它推送。点同步项不切换当前仓库。分支项只用于显示，不提供 VS Code 的切换分支与 `⋯` 菜单（分支 Checkout 不在 V1 范围）。点击行或按 `Enter`/`Space` 切换仓库，`↑`/`↓`/`Home`/`End` 在行间移动焦点。点击后高亮立即移到该行，不等快照返回；快照返回前更改与图表仍是原仓库，两个标题栏底边显示进度条，原仓库那一行也不再显示同步项；切换请求失败时高亮回到原仓库。选中与悬停的高亮为 `4px` 圆角块，列表左右各留出与滚动条沟槽等宽的空白（`scrollbar-gutter: stable both-edges`），高亮块左右对称，行首图标仍与更改区的文件图标对齐。当前仓库这一行用 `activeRepo`，只刷新 `git status` 时也会更新；其余仓库的分支要等下一次完整快照。窄栏下先截断仓库名，再截断分支名，同步数字不截断。
- **双区与中缝拖拽**：
  - `∨ 存储库`、上区 `∨ 更改` 与下区 `∨ 图表` 为 `28px` 窗格标题栏，各自独立支持点击折叠/展开；更改与图表的标题栏上边框即各区分界线。标题文字为 `13px` 粗体，比 VS Code 的 `11px` 大，因为中文标题在 `11px` 下偏小。`13px` 标题放在 VS Code 的 `22px` 栏高里上下拥挤，所以栏高改为 `28px`。
  - 双区均展开时两区交界处有一条不占高度的 `4px` 拖拽条，悬停 `300ms` 后显示强调色（指针拖动实时更新上区占比 `splitRatio`，范围 `0.15–0.85`，松手后写入 `/api/preferences`）。
  - 上区只滚动文件列表，横幅与提交输入区固定在列表上方。上区矮到放不下输入区加三行列表时，整个上区改为一起滚动。下区滚动整个提交列表。上区文件列表与下区提交列表均为 `overflow-y: auto; overflow-x: hidden; scrollbar-gutter: stable; overscroll-behavior: contain`；上区横幅与输入区留出等宽的滚动条沟槽，右缘与文件行对齐。
  - 任一区折叠时，另一展开区自动撑满剩余高度。
- **窄屏防溢出约束**：
  - Flex/Grid 文本列强制 `min-width: 0`，单行标题与路径使用 `overflow: hidden; text-overflow: ellipsis; white-space: nowrap`。
  - 长目录路径按目录/文件名拆分展示（优先保留文件名完整可见）。

### 7.2 上区：更改（`Working Tree Changes`）

1. **特殊状态横幅**：
   - 存在 `conflicted.length > 0` 时置顶显示只读「合并冲突」告警分组，允许点击冲突文件打开宿主 `fileView` 审阅，在冲突清零前禁用提交按钮并说明原因。
   - 处于 `Detached HEAD` 时显示紧凑提示条。
2. **提交输入区**：
   - 使用原生 `<textarea>`（自动匹配 `preload.js` 文本编辑快捷键豁免，并保留宿主 `Cmd/Ctrl+B` 侧栏切换），单行起始、随内容增高至 10 行；占位文案为 `消息(Ctrl+Enter 在“<分支>”提交)`，游离 HEAD 时省略分支名。
   - 不保留草稿：切换仓库或 Worktree 时清空输入框（不同 Worktree 的提交说明不应带到另一个 Worktree 提交），提交成功后也清空。
   - 监听 `keydown`：`Ctrl/Cmd + Enter` 时必须调用 `e.preventDefault()` 阻断 `preload.js` 转发，并触发智能主按钮提交逻辑。
3. **智能主按钮状态机**（按以下优先级互斥判定）：
   - **冲突阻断态**（`conflicted.length > 0`）：按钮禁用，文案「存在冲突，请先解决」。
   - **提交态**（存在任何 `staged` 或 `unstaged` 变更）：按钮文案「提交」且**始终可点击**。
     - 点击时若 `message.trim()` 为空：聚焦 `<textarea>` 并显示轻量校验提示，不发请求。
     - 若 `staged.length > 0`：直接调用 `POST /api/commit`（`autoStageAll: false`）。
     - 若 `staged.length === 0 && unstaged.length > 0`：弹出轻量确认框「没有要提交的暂存更改。是否自动暂存全部 N 个更改并直接提交？」，确认后调用 `POST /api/commit`（`autoStageAll: true`）。
   - **同步态**（工作区干净且非 unborn、非 detached），顺序同 VS Code Git 扩展的 ActionButton：
     - 若 `upstream === null` 且 `remotes.length > 0`：显示「发布分支」（单远端直接 `push -u`，多远端弹窗选远端）。
     - 若存在上游且 `ahead > 0 || behind > 0`：显示 `sync` 图标与「同步更改」，后跟落后数加 `arrow-down` 图标、领先数加 `arrow-up` 图标（为 0 的一侧省略），如「同步更改 3↓ 21↑」。只领先或只落后时同样是「同步更改」，不再区分推送与拉取。悬停提示同 VS Code 的 `syncTooltip`（「将 21 个提交推送到 origin/main」「从 origin/main 拉取 3 个提交」「在 origin/main 之间拉取 3 个提交并推送 21 个提交」）。点击调用 `POST /api/remote/sync`。
     - 工作区干净且与上游同步（或无远端）：显示禁用态「提交」。
   - **操作进行中**（同 VS Code）：按钮保留原文案并禁用，进度由「更改」标题栏底边的进度条表示（见 7.6），不再换成「正在提交…」之类的文案。当前仓库同步、推送、拉取或发布期间，「同步更改」与「发布分支」的图标换成旋转的 `sync`，悬停提示分别为「正在同步更改...」与「正在发布分支…」；提交期间悬停提示为「正在提交更改...」。
4. **可折叠文件分组与行操作**：
   - 分组行行尾显示文件数徽标；文件行依次为文件类型图标（与分组标题文字左对齐，距左缘 `30px`）、文件名、淡色目录，行尾为按 Git 装饰色着色的单字母状态（`M`/`A`/`D`/`R`/`U`/`!`），已删除文件加删除线。工作区干净时列表留空，不显示占位文案。
   - 整个未跟踪的目录在 `git status` 中只占一项，路径以 `/` 结尾（如 `docs/public/`）。这一行显示文件夹图标，文件名位置显示文件夹名 `public`，淡色目录显示上级目录 `docs`。
   - 「暂存的更改」：悬停显示「打开文件」「取消暂存 (`−`)」；分组行悬停显示「全部取消暂存」。
   - 「更改」：合并未暂存与未跟踪文件。悬停显示「打开文件」「放弃更改 (`↶`)」「暂存更改 (`+`)」；分组行悬停显示「全部放弃更改」「全部暂存」。
   - `MM` 双态文件同时出现在两组中，对「更改」组执行放弃更改仅调用 `git restore --worktree`，保留暂存区内容。
   - 单个分组超过 `500` 行时只渲染可视区上下各多 `10` 行（行高固定 `22px`），其余位置用占位元素撑起高度，滚动或面板尺寸变化时下一帧重算窗口；窗口移动只增删两端的行，留在窗口内的行原地不动。带焦点的行滚出窗口时焦点交给列表本身（同 VS Code 列表），下一次 Tab 进入可视区第一行，列表不跳动。重建列表时占位先撑满整表高度再计算窗口，同一 Worktree 刷新时滚动位置不变；切换到另一个 Worktree 时回到顶部，列表里原有的键盘焦点属于上一个 Worktree，随之释放、不再还原。`500` 行以内整表渲染，Tab 可遍历全部文件。后台 status 刷新结果与当前一致时不重绘。
5. **安全确认护栏**：
   - `Stage` / `Unstage`（单文件与全部）免确认直接执行。
   - `Discard` 全部需确认：单文件已跟踪弹出普通确认（列文件名）；单文件未跟踪弹出红字高危确认（提示永久删除磁盘文件不可恢复）；「全部放弃更改」弹出强确认（列受影响已跟踪文件数，并明示不会删除未跟踪文件）。

### 7.3 下区：图表（`Commit Graph`）

1. **单行紧凑顶栏**：
   - 左侧标题 `∨ 图表`（可折叠）。
   - 右侧紧凑动作组：`自动 / 全部` 范围切换、转到当前提交（定位并聚焦 `HEAD` 行）、`Fetch`（提取）、`Pull`（拉取）、`Push`（推送/发布）、`Refresh`（刷新）、`⋯`（更多菜单）。
   - `⋯` 菜单固定包含 3 项：**本地提交搜索栏显隐**（按提交标题、短 SHA、作者与分支名即时过滤已加载节点，不发后端请求）、**折叠全部已展开提交**、**切换界面语言（中文 / English）**。
2. **紧凑提交行与原地展开**：
   - 行结构对齐 VS Code「图表」视图。每行固定 `22px`，左侧 SVG 图形列宽度按本行泳道数计算（`11px × (泳道数 + 1)`），标题紧随其后，作者以淡色小字附在标题后，`HEAD` 行加粗；行尾为引用徽标，悬停或聚焦时显示「查看提交详情」按钮。窄栏下泳道极多时，图形列在右侧裁切，至少给标题留出 `96px`。
   - 引用徽标按当前分支 > 上游 > 其他有色引用排序；首个有色引用显示图标与名称，其余按颜色、图标归组只显示图标（多于 1 个时带数量）。`自动` 范围只显示当前分支与上游；`全部` 范围的其余引用取所在泳道颜色。图标为当前分支 `target`、本地分支 `git-branch`、远程分支 `cloud`、标签 `tag`。
   - 点击提交行（或按 `Enter`/`Space`）调用 `/api/commit/detail` 并在该行下方原地展开文件列表（按 `A/M/D/R` 标记）。文件行左侧绘制所属提交的输出泳道竖线，并加粗该提交向下接续第一父提交的泳道（根提交没有接续泳道，不加粗），提交行自身的下行线同步加粗；文件图标位于泳道列之后 `8px`。
   - 领先或落后上游时，同 VS Code `scm.graph.showOutgoingChanges` / `showIncomingChanges` 的默认行为插入两种虚拟行：「传出的更改」在 `HEAD` 行上方，作者位置显示当前分支名；「传入的更改」在合并基上方，作者位置显示上游名，上游泳道止于这一行。圆点为当前分支色或上游色的虚线圆，标题不加粗，没有「查看提交详情」按钮。点击原地展开相对合并基的改动文件（`/api/commit/detail` 带 `parentSha`）。`HEAD` 或合并基不在已加载的提交里时不插入；本地搜索期间父子关系已被截断，也不插入。
   - 列表底部在 `hasMore === true` 且未达软上限时显示「加载更多...」行（左侧泳道向下淡出）。这一行进入可视区下方一屏以内时自动加载下一页，用户滚到底之前新提交已经接上，对应 VS Code 的 `scm.graph.pageOnScroll`。自动加载失败时，列表停在同一状态期间不再自动重试，这一行显示「加载更多...」按钮，由用户点击重试。本地搜索期间结果很短，这一行一出现就在可视区内，为避免一页页拉到软上限，搜索时只能点击加载。达到 `2000` 条软上限时显示提示引导切换为 `自动` 范围。切换到另一个仓库或 Worktree 时图表回到顶部，图表里原有的键盘焦点随之释放（各 Worktree 的提交相同，不释放会按 sha 还原到原来那一行，下一次按键又滚回去）；同一 Worktree 刷新与加载更多时滚动位置不变。
3. **文件打开契约（上区与下区统一）**：
   - Sidecar 模式下点击有效文件调用 `window.sidecar.ui.toggleAuxPane({ tabType: 'fileView', uri: file.fileUri })`。
   - 历史提交中 `existsInWorktree === false` 的文件（例如已删除或已重命名的旧路径）以置灰样式展示、禁止点击，并在 `title` 中提示「该文件在当前工作区已不存在」。
   - Standalone 模式下无宿主 `toggleAuxPane`，点击文件显示轻量提示「文件预览仅在 Antigravity 桌面端辅助栏内可用」。

### 7.4 SVG 泳道布局（`graph-layout.js`）

逐段移植 VS Code `scmHistory.ts` 的 `toISCMHistoryItemViewModelArray`、`renderSCMHistoryItemGraph` 与 `renderSCMHistoryGraphPlaceholder`，以纯函数输出图形描述，由 `graph-view.js` 生成 SVG 节点。

1. **泳道模型**：每行有输入、输出两组泳道，每条泳道以它等待的提交 sha 标识，上一行的输出就是下一行的输入。处理一条提交时，输入中第一条等待它的泳道改为等待第一父提交，其余等待它的泳道在本行收拢到圆点；其余父提交依次追加到输出末尾。泳道数组始终紧凑，某条泳道结束后右侧泳道左移一列。
2. **颜色**：当前分支引用所在泳道固定蓝色（`--gw-graph-ref`），上游引用所在泳道固定紫色（`--gw-graph-remote-ref`），其余新泳道在 `--gw-graph-1..5` 五色间轮换。
3. **图形**：泳道间距 `11px`、线宽 `1px`；泳道左移用两段半径 `5px` 的圆角，合并与收拢用半径 `11px` 的圆弧。普通提交为半径 `5px` 的实心圆，合并提交为同心圆，`HEAD` 为空心圆环；圆点用与行背景同色的 `2px` 描边切开穿过的连线。
4. **列表边界**：父提交不在已加载列表内时，泳道一直延伸到列表末尾，由「加载更多」行的淡出竖线承接。本地搜索时只连接结果集内部的父子关系。
5. **传入/传出的更改**：移植 `addIncomingOutgoingChangesHistoryItems`。算完全部行的泳道后，以 `graph.mergeBase` 定位：`HEAD` 不等于合并基时在 `HEAD` 行上方插入「传出的更改」，它的输出比输入多一条通往 `HEAD` 的当前分支色泳道，`HEAD` 行随之多一条输入泳道；上游提交不等于合并基时在合并基行上方插入「传入的更改」，并把上一行里通往合并基的上游色泳道改为通往这一行。传入的更改已被合并（上一行是以合并基为父提交之一的合并提交）时不插入。虚拟行的圆点依次是带色实心圆、背景色描边圆与 `4,2` 虚线圆。
6. **与 VS Code 原实现的差异**：根提交处保留其余泳道（原实现会丢弃，多根仓库会断线）。

### 7.5 最小遮挡提交详情卡（`popover.js`、`markdown.js`）

点击提交行行尾的「查看提交详情」按钮打开提交详情卡。点击卡片右上角的关闭按钮、再次点击「查看提交详情」按钮、点击卡片外部或按 `Escape` 关闭。关闭按钮在卡片内容滚动时始终停在右上角，作者行文字绕开它。悬停提交行不弹出卡片。卡片打开期间该行保持高亮。列表滚动、窗口缩放或后台刷新时卡片只跟随该行移动、不重建内容，卡片内的滚动位置、选中的文字与按钮焦点保持不变；只有详情或统计加载完成、该提交的引用变化或切换界面语言时才重建。该行整行滚出图表可视区时卡片关闭，还露出一部分时保持打开。卡片的无障碍名称是提交标题。

卡片分区与 VS Code Git 扩展的提交悬浮卡一致，各区之间以横线分隔：

1. **作者行**：账号图标、作者名（链接色粗体）、时钟图标、相对时间与长日期，如 `9 小时前 (2026年11月24日 11:21)`、`9 hours ago (November 24, 2026 at 11:21 AM)`。插件不联网获取头像，始终显示账号图标，与 VS Code 取不到头像时一致。每位共同作者另起一行，名字后标注「(共同作者)」。
2. **提交说明**：标题与正文按 Markdown 渲染，分块规则取自 VS Code 的 `formatCommitMessage`。每行各自成块，空行处留出段落间距，围栏代码块与缩进代码块整体保留。支持标题、列表（含嵌套）、引用、分隔线、行内代码、粗体、斜体、删除线与链接。HTML 标签与图片语法按原文显示。链接文字里不再识别链接。链接只保留 `http`、`https`、`mailto` 三种协议，以新窗口打开，由宿主交给系统浏览器。渲染只创建 DOM 节点，不拼接 HTML 字符串。
3. **改动统计**：相对第一父提交的改动，如 `已更改 6 个文件, 336 行插入(+), 78 行删除(-)`。插入、删除分别用 Git 新增、删除装饰色；为 0 的部分省略。统计与详情分开请求，统计返回前不显示这一区，统计超时或失败时也不显示；详情返回前提交说明下方显示「正在加载提交详情…」。
4. **引用**：提交上有引用时显示，样式同图表行的引用徽标。
5. **SHA**：提交图标、短 SHA 与复制完整 SHA 按钮。

定位由纯函数 `computeMinOcclusionPopoverStyle(anchorRect, cardSize, graphContentRect, viewportRect)` 计算：

1. 计算两种候选垂直位置：
   - **上方候选** `topAbove = anchorRect.top - gap - cardSize.height`（允许借用上区「源代码管理」空间，钳制在 `viewportRect.top + pad` 以上；若仍撞到锚点行则记录不可行）。
   - **下方候选** `topBelow = anchorRect.bottom + gap`（钳制在 `viewportRect.bottom - pad - cardSize.height` 以内；若撞到锚点行则记录不可行）。
2. 对每个可行候选位置，计算卡片矩形 `[top, top + cardSize.height]` 与**可见图表列表内容区** `graphContentRect` 的垂直交集像素长度（`occludedGraphPx`）。
3. 决策规则：
   - 优先选择 `occludedGraphPx` 更小的位置（因此第 1、2 条提交的详情卡借用上方的上区空间，遮挡图表行像素少于下方，向上弹出）。
   - 若上下两个可行位置的 `occludedGraphPx` 相等（如图表区中部的提交），默认选**下方**。
   - 若某一方向在 `iframe` 视口内空间不足，自动翻转至另一方向并严格钳制在 `viewportRect` 内，确保内容可内部纵向滚动且绝不被 `iframe` 裁切。

### 7.6 主题、字体、图标、提示、快捷键与无障碍

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
   - 列表局部重渲染前记录 `:focus-visible` 元素标识，重渲染后恢复焦点（`focus({ preventScroll: true })`）。行尾按钮与分组标题按钮只在所在行、标题获得焦点或悬停时显示，恢复到这类按钮时先聚焦所在行或标题里的折叠按钮。原元素已不存在（如暂存后该行移到别的分组）时，焦点落到同一分组同一位置的行，并滚到最近的可见位置。
4. **文件类型图标**：
   - 上区文件行与图表展开的文件行使用 vscode-icons 图标，以 `<img src="/file-icons/<名称>.svg">` 按需加载。
   - 匹配顺序与 VS Code 文件图标主题一致：带直接父文件夹的文件名规则（如 `.husky/pre-commit`、`.vscode/launch.json`）优先，其次完整文件名，再次从最长到最短的多段扩展名（如 `d.ts` 先于 `ts`），都不命中时用默认文件图标；不区分大小写。
   - 映射表由 `scripts/gen-file-icons.mjs` 从固定提交的 vscode-icons 与 VS Code 内置语言声明生成，每条规则都能被某个文件路径命中。VS Code 按字面后缀匹配语言扩展名，日志语言声明的 `*.log.?` 在 VS Code 里匹配不到任何文件，生成时跳过。因此 `app.log.1` 与 VS Code 一样显示默认文件图标。
   - 以 `/` 结尾的未跟踪目录按文件夹名匹配 vscode-icons 的文件夹图标（如 `tests` 用测试文件夹图标、`public` 用 public 文件夹图标），不区分大小写；未命中时用默认文件夹图标。
   - 浅色主题下，有浅色变体的图标改用 `file_type_light_*.svg` 或 `folder_type_light_*.svg`；主题切换时就地替换已渲染图标的 `src`。
5. **进度条**（移植 VS Code `ProgressBar` 的 infinite 模式，`progress-bar.js`）：
   - 贴在窗格标题栏底边的 `2px` 横条，宽 `2%` 的小段每 `4s` 从左走到右，中途拉长到 `3` 倍；超过 `10s` 改为 `steps(100)` 的步进动画以降低 GPU 占用。颜色取主题强调色。系统要求减少动态效果时改为铺满整条的静止横条。进度条本身对读屏隐藏，进行中时所在窗格带 `aria-busy="true"`。
   - 只表示用户发起的操作。「更改」标题栏：任一写操作（提交、暂存、取消暂存、放弃、同步、发布、推送、拉取、提取）进行期间显示，全部结束后再留 `300ms`（同 VS Code 源代码管理范围），连续操作之间不闪烁。「图表」标题栏：从图表顶栏触发的写操作执行期间同时显示。点击刷新与切换仓库时两个标题栏都显示。
   - 文件变化、`.git` 变化、切回窗口、切换范围、加载更多等触发的快照与 status 刷新不显示进度条。这与 VS Code 不同（VS Code 每次 `git status` 都显示进度），Agent 频繁写文件时标题栏不会反复闪烁。
   - 操作成功时不弹提示（同 VS Code），提交、同步、推送、拉取、提取、刷新后面板本身的变化就是反馈；失败仍弹出错误提示。复制完整 SHA 没有可见变化，保留成功提示。
6. **就近轻提示**：
   - 位置在提示出现时按触发控件计算。提示贴在控件下方。下方剩余空间不足 `96px` 时，放到上下两侧中空间较大的一侧。控件只露出一部分时，贴在露出部分的下方。控件不可见（折叠、滚出视口、被所在滚动区域裁掉或已移除）时，停靠面板底部。提示存续期间不随列表滚动移动。
   - 提示条除关闭按钮外点击穿透，压在列表行上时不妨碍继续操作这些行。
   - 上区操作（提交、暂存、取消暂存、放弃、发布、同步）的错误提示锚定提交按钮；存储库行同步、发布与切换仓库的错误提示锚定存储库列表（行在操作开始时就会重绘）；图表顶栏操作（范围切换、提取、拉取、推送、刷新）锚定图表标题栏；打开文件、复制 SHA 等锚定被点击的行或按钮；后台同步失败等无明确来源的提示停靠底部。
7. **禁用态**：所有禁用按钮悬停时显示 `not-allowed` 光标。
8. **双语 i18n**：
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
   - `git-queries` & `git-mutations`：在 `os.tmpdir()` 构建真实临时仓库，覆盖中文路径、空格文件名、`-weird.txt`、0 提交 unborn 仓库暂存/取消暂存（`rm --cached`）/首次提交、`MM` 双态文件放弃更改不伤暂存区、单文件未跟踪删除、批量放弃不删未跟踪、外部合并冲突阻断提交、`Detached HEAD`、`git show --name-status -z` 重命名与 Merge Commit 解析、`autoStageAll` 自动暂存提交；同步更改只领先时只推送、只落后时只快进、分叉时返回 `NON_FAST_FORWARD` 且本地与远端都不变；非当前仓库的摘要只带分支信息，`graph.mergeBase` 与带 `parentSha` 的文件清单。
   - 锁与凭据：人为创建 `.git/index.lock` 验证 3 次退避后返回 `GIT_LOCKED` 且不删锁文件；起本地 `127.0.0.1` HTTP 401 服务验证 `fetch` 在 `GCM_INTERACTIVE=never` 下 2 秒内快速返回 `AUTH_REQUIRED` 而不卡死。
   - 监听与长轮询：触发 `.git` 与工作区写入验证 `POST /api/events/wait` 及时唤醒；删除被监听目录验证 Windows `\\?\` 自毁守卫生效且不发风暴；验证 Standalone 的 Host / Origin / Content-Type / 越界路径拦截。
2. **前端纯逻辑与浏览器回归（`tests/browser/`）**：
   - `graph-layout.js` 测试：单线、分支分叉、多父 Merge Commit 连续无断口、`自动` 模式无悬空线头、展开文件行穿行竖线连续；分叉、只领先、只落后时「传出/传入的更改」的插入位置、比较两端与泳道连续。
   - `changes-view.js` 与 `repos-view.js` 测试：主按钮按发布分支 → 同步更改 → 禁用的提交排序、同步数落后在前领先在后；存储库行按 VS Code 状态栏规则显示分支项与同步项，同步项只在当前仓库那一行显示。
   - `popover.js` 测试：顶部第 1/2 项向上弹出、中部默认向下、底部空间不足翻转并钳制在视口内。
   - `markdown.js` 测试：逐行分块与段落间隔、列表续行与嵌套、行内格式、不安全链接与 HTML 按原文显示、代码块保留内部空行。
   - `file-icons.js` 测试：带父文件夹的文件名规则只在直接父文件夹同名时生效；映射表里每条文件名、扩展名规则都能被对应路径命中。
   - 真实浏览器（Standalone + `<iframe sandbox="allow-scripts" srcdoc="...">` 注入 `theme-change` / `workspace-change`）：验证 `320px`、`360px`、`420px`、`560px` 零横向溢出（`scrollWidth <= clientWidth`）、0 控制台报错、深浅主题切换、未暂存时点击提交弹窗确认且提交完成后主按钮切换为「同步更改 1↑」且提交、同步进行中按钮保留原文案并禁用、「更改」标题栏底边显示进度条、刷新时两个标题栏底边都显示进度条、终端提交与文件写入触发的后台刷新不显示进度条、操作成功不弹提示、工作区有改动时点存储库行的同步状态只推送且不动改动、存储库行同步状态随之更新、「传出的更改」展开的文件与 `git diff @{upstream} HEAD` 一致、点击同步后推到远端且传出的更改消失、点击存储库行切换仓库（高亮先于快照移动并显示进度条，切换失败时高亮回到原仓库）、上区文件列表滚动时提交输入框不动、详情卡关闭按钮、提交行滚出可视区时关闭与后台刷新不重建详情卡、长历史滚动时不点击即预先加载下一页（切换范围回到首页后仍然有效，搜索期间不自动加载）、键盘焦点与重渲染保焦。

### 8.4 Windows Antigravity 2.0 桌面端真机验收清单

该清单同步写入 V1 最终人工验收 Issue（`ready-for-human`）：

- [ ] 运行 `scripts/install.ps1` 成功安装至 `~/.gemini/config/plugins/antigravity-git-worktree/`，在 Antigravity Customizations 启用后侧栏正常渲染 `Git Graph`，无控制台或 `sidecar.log` 报错。
- [ ] 在 Antigravity 中切换不同仓库对话、新建/切换宿主 Worktree、在终端 `git checkout` / 编辑文件，辅助栏均在 1 秒内自动同步，无 `index.lock` 竞争报错。
- [ ] 在仅存在未暂存更改时填好说明点击「提交」，确认弹窗后完成提交，工作区干净且领先上游时主按钮自动切换为「同步更改 N↑」，图表 `HEAD` 上方出现「传出的更改」；远端有新提交且本地已分叉时点击同步提示到终端合并，仓库不变；验证 `MM` 文件放弃未暂存不伤暂存区、未跟踪单文件红字二次确认删除。
- [ ] 在图表中切换 `自动 / 全部`、测试含 Merge 分支仓库的连线完整性、展开提交文件列表、分别点击顶部/中部/底部提交行的「查看提交详情」按钮，验证详情卡最小遮挡与不裁切、提交说明按 Markdown 渲染、改动统计与 VS Code 一致。
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
