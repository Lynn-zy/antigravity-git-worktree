# 0002: 采用零构建纯 Node.js ESM 与原生 ES2022 + SVG 技术栈

- Status: accepted

作为面向 Antigravity 2.0 的 Sidecar 插件，后端由宿主使用系统 Node.js 拉起，前端通过本地 HTTP 服务运行在 Auxiliary Pane 中。我们参考同工作区 `antigrative-dashboard` 与官方内置 `swarm_board` 的架构实践，决定采用**零外部运行时依赖的纯 Node.js（`>=20`）ESM 后端 + 原生 ES2022 模块化前端 + 内联 SVG 拓扑图**，不引入 Vite/Webpack/React/TypeScript 编译构建链，并从架构上要求同时支持 Standalone 无宿主本地 HTTP 预览模式。

## Considered Options

- Vite + React/Preact + TypeScript 构建型前端（被拒绝：需要维护编译流水线及提交或安装打包产物，增加插件分发和调试摩擦；对于窄幅辅助栏内的工作区变更列表与分页式 Git 拓扑图属于过度工程）。

## Consequences

- 插件目录无需 `npm install` 即可直接通过 `agy plugin install` 或放入 `~/.gemini/config/plugins/` 运行，跨平台安装门槛极低；
- 前端必须坚持轻量模块化（拆分状态、SVG 拓扑车道、悬浮详情定位与 i18n 词典模块），并保持主题仅依赖宿主注入 CSS 变量与本地回退变量。
