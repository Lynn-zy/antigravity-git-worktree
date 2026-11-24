# Antigravity Git Worktree（Git Graph）

面向 **Antigravity 2.0 桌面端**右侧 `Auxiliary Pane`（辅助栏）的 Git 源代码管理与提交图表 Sidecar 插件（插件标识 `antigravity-git-worktree`，视图标题 `Git Graph`）。

插件采用纯官方 Sidecar 机制与本地文件系统监听，后端使用零外部依赖的 Node.js（`>=20`）ESM，前端使用原生 ES2022 模块与内联 SVG 拓扑图，无需构建步骤，同时支持脱离宿主的 Standalone 本地 HTTP 预览。

## 功能概览

- **被动跟随宿主 `Workspace`**：自动发现当前对话 `Workspace` 命中的 `Repository` 与 `Worktree`，并随宿主 `workspace-change` 与 `.git`/工作区文件变化同步；单 `Repository` 时顶部不占高度，多 `Repository` 时显示一行紧凑切换条。
- **界面对齐 VS Code 源代码管理视图**：尺寸、间距、泳道图形、引用徽标与 Codicons 图标沿用 VS Code（图表泳道算法移植自 VS Code 源码），文件按类型显示 vscode-icons 彩色图标，表面色跟随宿主主题；第三方许可见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。操作结果提示就近显示在触发它的按钮旁。
- **上区「更改」（`Working Tree Changes`）**：支持提交说明输入（`Ctrl/Cmd + Enter` 快捷键）、智能主按钮（有更改时提交，仅有未暂存更改时确认自动暂存全部，工作区干净时按上游状态切换为推送、发布分支或拉取）、分组暂存/取消暂存，以及带确认弹窗护栏的放弃更改与未跟踪文件永久删除。
- **下区「图表」（`Commit Graph`）**：提供 `自动 / 全部` 范围切换、转到当前提交、`Fetch` / `Pull` / `Push` / `Refresh`、本地即时搜索、全部折叠与中英双语切换；渲染内联 SVG 提交拓扑连线，支持点击提交行原地展开文件列表（保留连续穿行竖线，历史已删文件不可点击）与最小遮挡悬浮提交详情卡（含复制完整 SHA）。
- **宿主文件打开与外观适配**：点击更改文件或历史现存文件统一调用宿主原生 `fileView` 在辅助栏打开（Standalone 模式给出轻提示）；自动同步宿主明暗主题与对比度，适配 `320px–560px` 窄幅视口无横向溢出。

## 环境要求

- **Node.js**：`>= 20`（运行浏览器端到端回归测试需 `v22+` 内置 `WebSocket` 与 `fetch`）
- **Git**：系统 `PATH` 中可用的 `git` CLI
- **浏览器**（仅运行浏览器端到端回归时需要）：本机已安装 Microsoft Edge 或 Google Chrome

## 安装到 Antigravity 桌面端

安装脚本仅同步运行时必需文件（`plugin.json`、`assets/`、`sidecars/panel/`）至 `~/.gemini/config/plugins/antigravity-git-worktree`，不会修改 `~/.gemini/config/config.json`。安装完成后请在 Antigravity Customizations 页面手动启用 **Git Graph**。

### Windows（PowerShell）

```powershell
# 默认拷贝安装（覆盖更新前会安全处理旧链接，不触碰源仓库）
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1

# 开发者链接模式（创建免管理员权限的 Junction 指向源码目录）
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -Link

# 卸载（仅移除安装目录或 Junction 本身）
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -Uninstall
```

### macOS / Linux（Bash）

```bash
# 默认拷贝安装
bash ./scripts/install.sh

# 开发者链接模式（创建符号链接指向源码目录）
bash ./scripts/install.sh --link

# 卸载
bash ./scripts/install.sh --uninstall
```

## Standalone 本地预览

未注入宿主环境变量 `ANTIGRAVITY_SIDECAR_WEB_PORT` 时，`sidecars/panel/main.mjs` 会启动绑定在 `127.0.0.1` 的 Standalone HTTP 服务（默认端口 `17892`，可通过 `AG_GIT_PORT` 覆盖）：

1. **指向当前或指定本地仓库启动**：

```bash
# 直接以当前仓库或传入目录启动
node sidecars/panel/main.mjs
node sidecars/panel/main.mjs /path/to/repo1 /path/to/repo2
```

```powershell
# PowerShell 通过 AG_GIT_PATHS 指定多个本地目录（Windows 使用分号分隔）
$env:AG_GIT_PORT = "17892"
$env:AG_GIT_PATHS = "D:\workspace\repo-a;D:\workspace\repo-b"
node sidecars/panel/main.mjs
```

```bash
# macOS / Linux 通过 AG_GIT_PATHS 指定多个本地目录（使用冒号分隔）
AG_GIT_PORT=17892 AG_GIT_PATHS="/path/to/repo-a:/path/to/repo-b" node sidecars/panel/main.mjs
```

2. **离线 Mock 演示与模拟宿主桥接**：
   - 打开 `http://127.0.0.1:17892/?fixture=mock` 可使用内存离线演示数据体验完整提交与同步流转。
   - 追加 `?sdk=1` 可由 `/preload.js?sdk=1` 注入模拟 `window.sidecar` 桥接对象，用于调试 `theme-change` 与 `workspace-change` 消息。

## 运行自动化测试

项目全部测试均使用 Node.js 内置 `node:test` 运行，无需 `npm install`：

```bash
# 运行全部单元测试、后端集成测试与无头浏览器端到端回归
node --test tests/unit/*.test.mjs tests/integration/*.test.mjs tests/browser/*.test.mjs

# 分别运行各层级测试
node --test tests/unit/*.test.mjs
node --test tests/integration/*.test.mjs
node --test tests/browser/m5-e2e-browser.test.mjs
```

> 若系统浏览器不在默认安装路径，可通过环境变量 `AG_BROWSER_PATH` 指定 `msedge.exe` / `chrome` 可执行文件路径。

## 规格与领域文档

- 架构规格与 V1 验收标准：[docs/spec.md](./docs/spec.md)
- 领域术语表：[GLOSSARY.md](./GLOSSARY.md)
- 架构决策记录：[docs/adr/](./docs/adr/)
- 工程协作约定：[AGENTS.md](./AGENTS.md)
