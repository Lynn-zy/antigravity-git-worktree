# AGENTS.md

本仓库用于开发 Antigravity 2.0 桌面端 Auxiliary Pane Git Worktree & Commit Graph Sidecar 插件。

## 工程约定

- 仅使用纯官方 Sidecar 机制与本地文件系统监听，禁止通过 CDP 探测或向 Antigravity 宿主渲染进程注入脚本（见 `docs/adr/0001-pure-official-sidecar-and-scope-focus.md`）。
- 前后端保持零构建、无外部运行时依赖的纯 Node.js ESM 与原生 ES2022 模块化设计（见 `docs/adr/0002-zero-build-esm-and-svg-graph.md`）。
- 概念命名严格对齐 `GLOSSARY.md`，避免将 `Workspace`、`Repository` 与 `Worktree` 混用。

## Agent skills

### Issue tracker

GitHub Issues on `Lynn-zy/antigravity-git-worktree` (via `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical triage labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout (`GLOSSARY.md` and `docs/adr/` at repo root). See `docs/agents/domain.md`.
