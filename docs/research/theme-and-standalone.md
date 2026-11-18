# Antigravity 2.0 辅助栏主题 CSS 变量与双模式契约调研

本文整理 Antigravity 2.0 `Auxiliary Pane` 的主题适配、窄幅视口交互以及 Sidecar / Standalone 双模式 HTTP 服务契约，作为 `antigravity-git-worktree`（受 ADR-0001 与 ADR-0002 约束）实现前端主题、表单快捷键与本地预览夹具的事实基线。

## 一手来源

- 官方 Sidecar SDK：`C:\Users\linse\.gemini\config\node_modules\sidecar_sdk\preload.js`、`index.mjs`、`esm_resolver.js`、`register_loader.js`、`package.json`
- 官方内置插件 `swarm_board`：`C:\Users\linse\.gemini\antigravity\builtin\plugins\swarm\sidecars\swarm_board\main.mjs`、`index.html`、`app.js`、`styles.css`、`hive.css`、`hive.js`、`narrator_bootstrap.js`、`README.md`、`sidecar.json`
- 官方内置技能与在线文档：`C:\Users\linse\.gemini\antigravity\builtin\skills\generative_ui\SKILL.md`、`ui-plugin-navigation\SKILL.md`、`antigravity_guide\SKILL.md`、`https://antigravity.google/docs/sidecars`
- 工作区参考实现 `antigrative-dashboard-0.9.1`：`sidecars/panel/main.mjs`、`index.html`、`app.js`、`styles.css`、`panel-source.mjs`、`sdk.mjs`、`compat/theme.cjs`、`compat/host-theme.mjs`、`compat/usage-ui.cjs`、`tools/check-theme-ui.mjs`、`tools/check-panel-ui.mjs`、`tools/check-quota-groups-ui.mjs`、`sidecars/panel/tests/ui-browser.test.mjs`、`theme.test.mjs`、`sdk.test.mjs`

---

## 一、`theme-change` 主题变量注入、明暗检测与字体回退

### 1.1 `preload.js` 的注入机制与默认样式陷阱

宿主运行 Sidecar Web UI 时，通过 `window.postMessage` 向辅助栏 `iframe` 发送 `{ type: 'theme-change', payload: { cssVariables } }`。`sidecar_sdk/preload.js#L53-L58` 的处理逻辑如下。

- **直接写入 `:root` 内联样式**：遍历 `Object.entries(event.data.payload.cssVariables)`，调用 `document.documentElement.style.setProperty(key, value)`。
- **不维护明暗标记**：`preload.js` 不会设置 `data-theme="dark" | "light"` 或 `color-scheme`，也不校验 `event.origin` 与 `event.source`；若 `payload` 缺失 `cssVariables` 字段会抛出类型异常。
- **`applyBodyStyles` 覆盖风险**：`preload.js#L84-L99` 在 `DOMContentLoaded`（若 DOM 已就绪则立即执行）给 `document.body.style` 写入内联属性：`background = 'var(--background, #fafafa)'`、`color = 'var(--foreground, #333)'`、`fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'`。

上述内联样式带来两个实际后果。第一，未推送 `theme-change` 前，`#fafafa` 与 `#333` 是亮色硬编码，深色独立预览页会在首帧闪白。第二，`body.style.fontFamily` 直接写死系统字体，未读取 `var(--font-family)`，因此插件样式表必须用更高优先级覆盖。`swarm_board/styles.css#L913` 使用 `body { font-family: var(--sw-font) !important; }` 压过内联字体；`antigrative-dashboard-0.9.1/sidecars/panel/styles.css#L3` 使用 `body:not(.standalone) { background: ... !important; color: ... !important; }` 压过内联背景与前景色。

### 1.2 宿主 CSS 变量命名模式

综合 `swarm_board`、`generative_ui` 与 `compat/theme.cjs`，宿主下发和前端消费的 `:root` 语义变量集中在四类（均为双短横线语义名，不应直接耦合 `--vscode-*` 或 `--app-*` 内部变量）。

| 类别 | `swarm_board` 消费的变量（`styles.css#L16-L43,L102`、`app.js#L1100-L1109`） | `generative_ui` 声明的同类语义变量（`SKILL.md#L38-L48`） | `compat/theme.cjs` 探测变量（`#L140,L150,L156,L183,L192,L201`） |
| --- | --- | --- | --- |
| 表面色 | `--background`, `--card`, `--secondary`, `--muted`, `--accent` | `--background`, `--content`, `--card`, `--sidebar`, `--secondary`, `--muted`, `--accent` | `--background`, `--color-background`, `--popover`, `--card`, `--color-card` |
| 文本色 | `--foreground`, `--card-foreground`, `--secondary-foreground`, `--muted-foreground`, `--accent-foreground`, `--placeholder`, `--code-foreground` | `--foreground`, `--muted-foreground`, `--placeholder`, `--code-foreground`, `--primary-foreground`, `--secondary-foreground` | `--foreground`, `--color-foreground` |
| 边框与强调 | `--border`, `--card-border`, `--primary`, `--primary-foreground`, `--error`, `--ring` | `--border`, `--card-border`, `--primary`, `--link`, `--success`, `--warning`, `--error`, `--chart-1..6` | `--primary`, `--color-primary` |
| 字体 | `--font-family`, `--editor-font-family` | 未要求手设字体 | `--ui-font-family`, `--font-sans`, `--font-family`, `--vscode-font-family`, `--antigravity-font-family`, `--vscode-editor-font-family`, `--font-mono` |

需要留意两处变量缺失或命名差异。

1. **状态色回退**：`swarm_board/styles.css#L7,L31-L33` 注明绿色与琥珀色状态点没有宿主 token（"no host token exists for them"），插件需准备 `--success` / `--warning` 的亮暗双态本地回退（仅在宿主未注入时生效）。
2. **等宽字体变量名差异**：`swarm_board` 使用 `--editor-font-family`（`styles.css#L43`、`app.js#L1108`），而 `compat/theme.cjs#L192` 检测 `--vscode-editor-font-family` 与 `--font-mono`。`antigravity-git-worktree` 展示提交哈希、文件路径与 Diff 时，等宽字体栈应按 `var(--editor-font-family, var(--vscode-editor-font-family, var(--font-mono, ...)))` 依次回退。

除 DOM 内联变量外，`antigrative-dashboard` 还演示了一条只读配置回退链。`compat/host-theme.mjs#L11-L21` 在 `Node.js` 后端只读读取 `~/.gemini/config/config.json`（上限 1 MB，剥离 UTF-8 BOM）的 `userSettings`，白名单提取 `themeMode`、`customThemeSeedsDark`、`customThemeSeedsLight`（仅 3/6 位 hex 的 `primary`、`background`、`foregroundOverride`）以及 `fontFamily` / `monoFontFamily`。`sidecars/panel/main.mjs#L42-L43` 将其通过 `/api/metrics` 的 `theme` 字段下发，前端 `app.js#L416` 调用 `themeController.setHostTheme(value.theme)`；DOM 实时 CSS 变量始终优先于配置种子（`compat/theme.cjs#L112-L113`、`tools/check-theme-ui.mjs#L81,L141`）。

### 1.3 明暗识别算法（`MutationObserver` + 亮度检测）

核查到两种明暗检测实现，精度与适用边界差异明确。

**实现 A：`swarm_board/app.js#L64-L85` 探针元素法**

1. **计算值探测**：创建临时 `<span>`，设置 `position:absolute; visibility:hidden; color:var(--background, #f7f7f8)` 并挂载到 `document.documentElement`，读取 `getComputedStyle(probe).color` 后移除节点。这让浏览器自动求值 `color-mix()` 等嵌套表达式。
2. **亮度计算**：正则提取字符串前 3 个数字，若以 `color(` 开头则除以 `1`，否则除以 `255`，按线性权重 `lum = 0.2126 * r + 0.7152 * g + 0.0722 * b` 计算亮度；`lum < 0.5` 判定 `'dark'`，否则 `'light'`，写入 `document.documentElement.dataset.theme`。
3. **监听方式**：`new MutationObserver(() => { syncScheme(); postTheme(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['style'] })`。仅监听 `<html>` 的 `style` 属性，精确匹配 `preload.js` 的修改动作。
4. **已知缺陷**：现代 Chromium 对 `oklch(...)` / `lab(...)` 有时在 `getComputedStyle().color` 中原样返回非 sRGB 空间字符串（不以 `color(` 开头也不以 `rgb(` 开头），正则取前 3 个数并除以 `255` 会算出错误亮度。

**实现 B：`compat/theme.cjs#L61-L110, L220-L230` 1×1 Canvas 栅格化与多源优先级法**

1. **解析优先级（`resolve()`, `#L92-L110`）**：依次检查 `body` / `documentElement` 的显式主题属性或类名 -> `:root` 计算属性 `--background` 颜色亮度 ->（若 `embedded`）向上遍历父元素 `backgroundColor` 与 `:root` `colorScheme` -> 后端配置的 `hostTheme.mode` -> `window.matchMedia('(prefers-color-scheme: dark)')`。
2. **1×1 Canvas 像素解码（`rgb()`, `#L67-L76`）**：先校验 `CSS.supports('color', color)`，再用 `canvas.getContext('2d', { willReadFrequently: true })` 填充后读取 `getImageData(0, 0, 1, 1).data`。此方法能把浏览器支持的任意颜色格式（hex、`rgb()`、`hsl()`、`oklch()`、`color(srgb ...)`、`color-mix()`）可靠转换为 `[r, g, b]` 整数；若 Alpha 通道 `a < 250` 直接返回 `null`，避免把默认 `transparent` 背景当成黑色 `rgb(0,0,0)`。对于裸 HSL 串（如 `210 100% 40%`），`hostColor()`（`#L120`）还尝试 `rgb('hsl(' + value + ')')`。
3. **亮度阈值与监听**：`fromColor()`（`#L78`）以 `0.2126*r + 0.7152*g + 0.0722*b >= 145` 区分 `'light'` / `'dark'`；`surfaceColors()`（`#L149`）用标准 sRGB 线性化 `luminance(background) < 0.35`（`#L61`）。`MutationObserver`（`#L220-L226`）同时监听 `documentElement` 与 `body` 的 `class`、`style`、`data-theme`、`data-color-mode`、`data-theme-mode`、`data-vscode-theme-kind`、`data-font`、`data-font-family`，以及 `<head>` 样式表节点变化与 `matchMedia` `change` 事件，外加 `1500ms` 轮询兜底（`#L228`）。

**结论与选型建议**：`antigravity-git-worktree` 应组合两种思路。在 Standalone 与 Sidecar 环境下，通过 `MutationObserver` 监听 `<html>` 的 `style` 与 `data-theme`/`class`（参考 `swarm_board` 的零轮询轻量结构，避免 `1500ms` 定时器对测试与 CPU 的干扰），并用 `compat/theme.cjs` 的 1×1 Canvas `getImageData` 方式解码 `--background`（过滤 `a < 250`）配合 `matchMedia('(prefers-color-scheme: dark)')` 兜底，从而兼容 `oklch()` 与 `color-mix()`。同时在 `:root` 与 `:root[data-theme="dark"]` 上显式同步 `color-scheme: light | dark`（`swarm_board/styles.css#L14,L58`），保证原生滚动条、表单与复选框随宿主切换。

### 1.4 高对比度与可读性保障

两套参考代码**均未使用** `@media (forced-colors: active)` 或 `@media (prefers-contrast: more)`，高对比度与可读性通过三项机制实现。

1. **高对比度标识识别**：`compat/theme.cjs#L82-L89` 的 `explicit()` 将 `hc-light` 归为 `'light'`，将 `hc-black` / `hc-dark` 归为 `'dark'`（同时覆盖属性与 `classList`）。
2. **运行时 WCAG 4.5:1 对比度修正**：`compat/theme.cjs#L126-L163, L203-L205` 的 `readableColor(color, surfaces)` 计算 WCAG 2.1 sRGB 相对亮度与对比度公式 `(max + 0.05) / (min + 0.05)`。若文本色、强调文本（`emphasis`）或状态色（`success` / `warning` / `danger`）与卡片/背景/控件表面的最小对比度低于 `4.5`，则选取纯白或纯黑中对比度更高的端点以 `1%` 步长迭代混合直到达到 `>= 4.5`；若宿主 `--card` 与 `--background` 冲突导致黑白两极均无法同时满足 `4.5`（`commonContrast(card) < 4.5`），则放弃宿主 `--card`，改由 `background` 派生微抬升表面（暗底混 `5%` 白，亮底混 `1.5%` 黑）。
3. **相对前景色混合派生**：`swarm_board/styles.css#L35-L40` 不硬编码灰阶边框与悬停底色，而是使用 `color-mix(in srgb, var(--sw-fg) N%, transparent)`（hover `5%`–`6%`、press `9%`–`11%`、分隔线 `8%`、控件底色 `4.5%`–`6.5%`），在任意高对比度前/背景配色下自动保持可见轮廓。

此外，所有经 JS 拼装并用于内嵌帧或 `:root` 的主题变量值必须经过净化（如 `swarm_board/app.js#L1573-L1575` 过滤 `v.length <= 200 && !/[;{}<>\\]|url\(|expression/i.test(v)`）。

### 1.5 字体变量回退策略

- **禁止强制阻塞性外网字体依赖**：`swarm_board/index.html#L12-L14` 异步加载 `Google Sans Flex` / `Google Sans Code`（`media="print" onload="this.media='all'"`），在受限网络或严格 CSP 下存在请求挂起风险；`antigrative-dashboard` 完全不请求外网字体 CDN（`panel/index.html`、`panel/styles.css#L1`），遵循 ADR-0002 的零外部运行时依赖方向。
- **双语系统字体与等宽字体栈**：参考 `compat/theme.cjs#L38-L43`（`withFontFallback`）与 `panel/styles.css#L1`，当注入字体经 `sanitizeFontFamily()` 校验合法且末尾不含泛型族时，UI 字体自动追加 `'Microsoft YaHei', sans-serif`，等宽字体追加 `ui-monospace, 'Cascadia Mono', 'Consolas', monospace`；无宿主注入时回退到本地栈 `-apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif`。
- **字体安全过滤**：`compat/theme.cjs#L16-L37` 拒绝含分号、花括号、`url(`、`var(`、`expression(`、`@import`、`inherit`/`initial`/`unset` 的非法字体串，逐段校验引号与字符白名单。

---

## 二、快捷键桥接豁免与窄幅 Auxiliary Pane（320px–560px）布局规则

### 2.1 `preload.js` 快捷键转发与豁免机制

因为 Sidecar 运行在独立 `iframe` 内，`sidecar_sdk/preload.js#L258-L311` 在 `window.parent !== window` 时监听冒泡阶段的 `keydown`、`keyup` 与 `blur`，将部分快捷键打包为 `{ type: 'sidecar-key-event', payload }` 转发给宿主（例如使 `Cmd/Ctrl+B` 切换侧栏继续生效）。

`shouldForwardKeyDown(e)`（`preload.js#L224-L256`）的精确豁免规则如下。

1. **前置全局拦截（满足任一即不转发）**：
   - `e.defaultPrevented || e.isComposing || e.keyCode === 229`（事件已被插件自身处理，或处于 IME 输入法组合态，`#L225-L227`）。
   - 纯修饰键 `Control`、`Meta`、`Alt`、`Shift`、`AltGraph`（`PURE_MODIFIER_KEYS`，`#L106-L112,L228-L230`）。
   - **未按任何修饰键**（`!e.ctrlKey && !e.metaKey && !e.altKey`，`#L231-L233`）：所有普通打字、回车、空格、单方向键、`Escape` 均留在 `iframe` 内部，不转发给宿主。
   - `e.getModifierState('AltGraph')` 为真（`#L234-L239`）。
   - **原生剪贴板组合键** `isNativeClipboardChord`（`#L178-L185,L241-L243`）：`(ctrl || meta) && !alt` 时的 `c`、`x`（无 `shift`）以及 `v`（含 `Ctrl/Cmd+Shift+V`），在任意焦点下都不转发。
2. **可编辑目标识别 `isEditableTarget(rawTarget)`（`#L148-L176,L244-L245`）**：
   先取 `(e.composedPath?.()[0]) || e.target` 以支持 Shadow DOM 内真实焦点元素，以下节点视为可编辑目标：
   - `<textarea>`、`<select>`（非 `disabled` 且非 `readOnly`，`#L154-L156`）；
   - `<input>`：非 `disabled` / `readOnly`，且 `type` 不在 `NON_TEXT_INPUT_TYPES`（`button, checkbox, color, file, hidden, image, radio, range, reset, submit`，`#L121-L132,L157-L165`）；
   - `[contenteditable]`：`target.isContentEditable` 为真，或 `target.closest('[contenteditable]')` 存在且属性不为 `'false'`（`#L134-L146`）；
   - `[role="textbox"]`：`target.closest('[role="textbox"]')` 存在且 `aria-disabled !== 'true'`（`#L169-L174`）。
3. **可编辑目标内豁免的文本编辑组合键 `isEditableTextChord`（`#L187-L210,L246-L248`）**：
   - 无 `Ctrl/Cmd` 时的 `Alt`/单字符键（防止 macOS `Option+c` 等变音字符输入被宿主拦截，`#L190-L194`）；
   - 带修饰符的方向与行首尾导航键 `ArrowLeft` / `ArrowRight` / `ArrowUp` / `ArrowDown` / `Home` / `End`（`#L113-L120,L195-L197`）；
   - 无 `Shift` 的 `Backspace` / `Delete`（如 `Ctrl/Alt+Backspace` 按词删除，`#L198-L200`）；
   - `(ctrl || meta) && !alt` 下的全选、重做与撤销：`a`、`y`（无 `shift`）以及 `z`（含 `Ctrl/Cmd+Shift+Z`）（`#L201-L208`）。
4. **`[contenteditable]` 专属富文本格式豁免 `isRichTextFormattingChord`（`#L212-L222,L249-L254`）**：
   - 仅当 `isContentEditableTarget(rawTarget)` 为真时，豁免 `(ctrl || meta) && !alt && !shift` 的 `b`、`i`、`u`。
   - **有意差异**：在普通 `<input>` 与 `<textarea>` 中，`Ctrl/Cmd+B/I/U` **不会被豁免**，仍会转发给宿主，从而保证用户在搜索框或 Commit 输入框聚焦时仍能用 `Cmd/Ctrl+B` 切换主界面侧栏（`#L212-L214` 注释明确说明该意图）。

**对本插件前端表单的工程约束**：
- 分支筛选框、Worktree 创建输入框、Commit Message 输入框必须使用原生 `<input type="text" | "search">` 或 `<textarea>`（不要使用 `contenteditable`），这样剪贴板、全选、撤销、按词跳转/删除全部由 `preload.js` 自动豁免，同时保留 `Cmd/Ctrl+B` 全局侧栏开关。
- 插件自身若绑定带修饰符快捷键（例如 `Ctrl/Cmd+Enter` 提交、`Ctrl/Cmd+K` 聚焦过滤框），事件监听器必须调用 `e.preventDefault()`，利用 `shouldForwardKeyDown` 首行的 `e.defaultPrevented` 阻止向宿主重复冒泡转发。
- 插件若绑定无修饰符全局快捷键（如 `ArrowLeft`/`ArrowRight`/`Space` 切换提交图节点），必须仿照 `swarm_board/app.js#L1984` 显式跳过表单控件：`e.target.matches('input, select, textarea, button, [role="tab"], [contenteditable]')`。

### 2.2 窄幅 Auxiliary Pane（320px–560px）`@container` 与响应式断点

在 `antigrative-dashboard-0.9.1` 与 `swarm_board` 中，窄面板布局遵循以下断点与防溢出模式：

- **容器查询（`@container`）**：`antigrative-dashboard-0.9.1/sidecars/panel/styles.css#L6,L12,L32` 在卡片外壳 `.widget` 声明 `container: ag-panel / inline-size`：
  - `@container ag-panel (max-width: 360px)`：隐藏次要信息（如 `.version-tag { display: none }`），确保品牌名与操作控件不被挤出，同时将隐藏信息写入父元素的 `title` 属性保留可发现性（`panel-source.mjs#L41-L42`、`tools/check-panel-ui.mjs#L127-L128`）。
  - `@container ag-panel (min-width: 380px)`：将复杂长名下拉框从 `88px`（`<= 360px` 时 `76px`）放宽至 `116px`。
  - 对于内嵌了分栏（如 Worktree 列表 + 详情/Diff、或独立预览壳限制容器宽为 `480px`）的组件，基于容器自身行内宽度使用 `@container` 比 `@media` 更准确。
- **媒体查询与宽窄双态列宽**：
  - `panel/styles.css#L101-L102` 设置 `@media (max-width: 360px)`（收紧外边距与内边距、缩小大字号数值）和 `@media (max-width: 300px)`（允许辅助元数据 `flex-wrap: wrap`、隐藏装饰性图标）。
  - `swarm_board/styles.css#L53-L55,L864-L870` 采用 `--pad-x: 16px; --col: 760px; --inline: max(var(--pad-x), calc((100% - var(--col)) / 2));`，在 320px–560px 面板内自然铺满，超过 `760px` 自动居中；在 `@media (max-width: 420px)` 下将 `--pad-x` 降为 `14px`，`<select>` 上限从 `180px` 降至 `140px`，并将工具栏二级行子项拆为整行（`flex: 1 0 100%`）。
- **窄屏防横向溢出四件套**：
  1. Flex/Grid 文本列必须设置 `min-width: 0`，配合 `overflow: hidden; text-overflow: ellipsis; white-space: nowrap`（单行标签/分支名）或 `overflow-wrap: anywhere`（长路径/提交消息，`swarm_board/styles.css#L459,L498`）。
  2. 长文件路径采用从左截断保留文件名，如 `swarm_board/styles.css#L676` 与 `app.js#L1054` 的 `<span class="path" style="direction: rtl; text-align: left"><span dir="ltr">...</span></span>`。
  3. 横向标签栏/筛选 chip 行使用 `overflow-x: auto; overscroll-behavior-x: contain; scrollbar-width: none` 加右侧渐隐遮罩 `mask-image: linear-gradient(to right, #000 calc(100% - 24px), transparent)`（`swarm_board/styles.css#L167,L401-L406,L427-L431`）。
  4. SVG 拓扑图在计算宽度时设下限 `Math.max(svg.clientWidth || 0, 320)`（`swarm_board/app.js#L794`），并在面板从 `hidden` 切换可见及 `window.resize`（`requestAnimationFrame` 节流）时重算布局。

### 2.3 滚动条与布局稳定性规则

- **防抖动滚动条沟槽**：主滚动区域使用 `overflow-y: auto; overflow-x: hidden; scrollbar-gutter: stable`（`panel/styles.css#L39`、`compat/usage-ui.cjs#L12`）。切换 Worktree 过滤或展开/折叠变更文件列表时，即使列表在“有滚动条”与“无滚动条”间切换，横向宽度（含 `Commit Graph` SVG 宽度）也不会抖动 6–15px（`ui-browser.test.mjs#L549-L560` 对此有专门回归测试）。
- **滚动边界隔离**：内部滚动面板设置 `overscroll-behavior: contain`（`panel/styles.css#L39`），避免滚动到底后带动整页或宿主。
- **细滚动条配色**：同时写标准属性与 WebKit 伪元素。标准属性使用 `scrollbar-width: thin; scrollbar-color: color-mix(in srgb, var(--fg) 22%, transparent) transparent`（`swarm_board/styles.css#L88`）；WebKit 下可选 `6px` 无按钮圆角滑块（`compat/usage-ui.cjs#L13-L17`）或 `10px` 宽度配 `border: 3px solid transparent; background-clip: padding-box` 保留点击热区（`swarm_board/styles.css#L89-L94`）。
- **Sticky 吸顶与全宽底线**：当头部高度可能随 Worktree/Repository 标签换行而变化时，用 `ResizeObserver` 测量 `.header.offsetHeight` 同步到 CSS 变量 `--header-h`，二级工具栏设 `position: sticky; top: var(--header-h, 0px)`，并利用 `box-shadow: 0 0 0 100vmax var(--bg); clip-path: inset(0 -100vmax -1px)` 让吸顶背景和底边线铺满左右边距而不触发横向滚动条（`swarm_board/styles.css#L210-L218`、`app.js#L1946-L1948`）。

### 2.4 内联焦点样式与重渲染保焦

- **仅键盘可见焦环**：全局禁用鼠标点击焦框 `:focus { outline: none; }`，统一声明 `:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }`（`swarm_board/styles.css#L83-L84`，`panel/styles.css#L5` 用 `outline-offset: 2px`）。
- **贴边与裁剪安全**：处于 `overflow: hidden` / `overflow-x: auto` 容器边缘的元素（如 `.tab`、`.channel-tab`、24px 紧凑图标按钮）必须改用负偏移 `outline-offset: -2px`（`swarm_board/styles.css#L188,L445`、`compat/inline-widget.cjs#L956`），否则容器会裁切焦环外框。
- **自定义开关控件**：将原生 `<input type="checkbox">` 透明铺满整个 `<label>`（`position: absolute; inset: 0; opacity: 0`），把 `:focus-visible` 环画在紧邻的视觉轨道上：`input:focus-visible + .switch-track { outline: 2px solid var(--ring); outline-offset: 2px; }`（`swarm_board/styles.css#L289-L306`）。复合搜索栏则用 `.search:focus-within` 高亮外框并把内部 `<input>` 置 `outline: none`（`styles.css#L233-L239`）。
- **可滚动区域与 Tablist 键盘规范**：可滚动详情/Diff 面板设置 `tabindex="0"` 与 `:focus-visible`（`panel/styles.css#L5`、`index.html#L51`）。`role="tablist"` 实现 roving `tabindex`（仅当前项 `0`，其余 `-1`），支持 `ArrowLeft` / `ArrowRight` / `Home` / `End` 并调用 `e.preventDefault(); e.stopPropagation();`（`swarm_board/app.js#L1854-L1866`、`panel/app.js#L49,L55-L59`）。
- **重渲染保焦**：局部 DOM 重建（如切换 Worktree、筛选 chip、或刷新列表）前记录焦点，重建后仅当原元素通过键盘聚焦（或检查 `matches(':focus-visible')`）时重新调用 `.focus({ preventScroll: true })`（`panel/app.js#L236-L239`、`swarm_board/app.js#L1894`），防止键盘操作时焦点跳回 `body`。

---

## 三、双模式 HTTP 服务与鉴权隔离

### 3.1 `ANTIGRAVITY_SIDECAR_WEB_PORT` 双启动路径对比

官方 `sidecar_sdk/index.mjs`（`SidecarApp`）构造函数（`#L46-L60`）强制校验三个环境变量：`ANTIGRAVITY_LS_ADDRESS`、`ANTIGRAVITY_CSRF_TOKEN`、`ANTIGRAVITY_SIDECAR_WEB_PORT`，缺一即抛错退出。除此之外，宿主还会按需注入：

- `ANTIGRAVITY_SIDECAR_UI_TOKEN`：UI 接口鉴权 Token（`index.mjs#L58`）。
- `ANTIGRAVITY_PROJECT_ID`、`ANTIGRAVITY_CONVERSATION_ID`：当前会话标识（`index.mjs#L62-L67`）。
- `ANTIGRAVITY_AGENTAPI_EXE`：Windows 下直接调用语言服务器 `agentapi` 子命令，避免 `.bat` shim 的 `ENOENT` 与 `shell: true` 注入风险（`index.mjs#L93-L107`）。
- `ANTIGRAVITY_EXECUTABLE_DATA_DIR`：Sidecar 持久化目录 `<appData>/sidecar_data/<plugin>/<sidecar>/data`（`swarm_board/main.mjs#L112`、`https://antigravity.google/docs/sidecars`）。

对比两种启动架构：

| 维度 | `swarm_board/main.mjs`（纯 Sidecar + 人工环境预览） | `antigrative-dashboard-0.9.1/sidecars/panel/main.mjs`（真双模式） |
| --- | --- | --- |
| `sidecar_sdk` 导入方式 | 顶层静态 `import { SidecarApp, Response } from 'sidecar_sdk'`（`#L19`）并无条件 `new SidecarApp()`（`#L1320`） | 分支内延迟 `await loadSidecarSdk()`（`#L87`，`sdk.mjs#L9-L24` 先 `import()` 再回退 `createRequire.resolve`） |
| 脱离宿主直接运行 `node main.mjs` | 失败：缺少 `--import .../register_loader.js` 会报 `ERR_MODULE_NOT_FOUND`，且 `new SidecarApp()` 缺环境变量直接抛错 | 成功：`ANTIGRAVITY_SIDECAR_WEB_PORT` 未设置时走 `else` 分支（`#L111-L154`），用 `node:http` `createServer` 直接监听 `AG_PULSE_PORT \|\| 17891` |
| 路由与能力复用 | 仅 `GET /api/swarm`，无宿主时通过 `?conversationId=` 参数覆盖并扫描全部 `~/.gemini/<product>/brain/`（`#L111-L126,L1388-L1390`） | 宿主与 Standalone 共享同一套业务采集函数与前端源码（`panelPageSource()`、`panelAppSource()`） |

**架构要求（针对 `antigravity-git-worktree`）**：不得在 `main.mjs` 顶层静态 `import 'sidecar_sdk'`。必须在 `if (process.env.ANTIGRAVITY_SIDECAR_WEB_PORT)` 分支内动态 `await import('sidecar_sdk')`（可附带 `createRequire(import.meta.url).resolve('sidecar_sdk')` 兼容 `NODE_PATH` 场景），无该环境变量时进入原生的 `node:http` Standalone 预览服务器。

### 3.2 `X-Sidecar-Token`、`127.0.0.1` 绑定与 Origin 校验

核查 `sidecar_sdk/index.mjs` 与 `antigrative-dashboard` 的安全边界，存在一项关键鉴权特性必须严格遵守。

1. **`SidecarApp` 中 `GET` 路由绕过 Token 校验**：
   `sidecar_sdk/index.mjs#L139-L143, L218-L224` 明确规定 `if (req.method !== 'GET' && !this.#validateToken(req, url))` 才返回 `401`。`preload.js#L315-L322` 的 `window.sidecar.fetch` 会自动附带 `X-Sidecar-Token` 请求头（同时强制添加 `Content-Type: application/json`），供非 `GET` 请求通过校验；`swarm_board/app.js#L53` 因全部是只读 `GET` 接口才允许裸 `fetch` 回退。
   **安全红线**：`antigravity-git-worktree` 包含 `git worktree add/remove`、`git stage/unstage/discard`、`git commit/checkout`、`git fetch/pull/push` 等破坏性或状态变更操作，这些接口**严禁设计为 `GET` 路由**，必须使用 `POST`（或 `DELETE`）从而自动受 `SidecarApp` 的 `X-Sidecar-Token` 保护，且前端所有写请求必须通过 `window.sidecar.fetch` 发出。
   另需注意：`SidecarApp` 对请求体未设长度上限，且 `JSON.parse` 失败直接返 500（`index.mjs#L164-L192`），业务 handler 内部仍应做好参数白名单与结构校验。
2. **Loopback `127.0.0.1` 强制绑定**：
   `sidecar_sdk/index.mjs#L26, L207` 硬编码 `BIND_HOST = '127.0.0.1'`；Standalone 模式（`panel/main.mjs#L153`）同样必须显式传 `server.listen(port, '127.0.0.1')`，禁止省略 host 导致 Node 监听全网卡或双栈通配地址。
3. **Standalone 模式的 Host / Origin / CSRF 防护（`panel/main.mjs#L115-L139`）**：
   Standalone 分支不经过 `SidecarApp` 与 `X-Sidecar-Token`，须自行防御跨站请求与 DNS Rebinding：
   - **Host 白名单**：校验 `req.headers.host` 必须匹配 `/^(127\.0\.0\.1|localhost)(:\d+)?$/`，否则返回 `403`。
   - **Origin 同源检查**：对 `GET` 数据接口，若存在 `req.headers.origin` 且不等于 `http://${host}` 返回 `403`；对所有 `POST` 写接口，强制要求 `req.headers.origin === 'http://' + host` 且 `Content-Type` 以 `application/json` 开头，同时限制请求体字节上限并用 `try/catch` 解析 JSON（异常返回 `400`）。
   - **安全响应头**：设置 `Cache-Control: no-store` 与 `X-Content-Type-Options: nosniff`。

### 3.3 `/preload.js` 降级桩与前端无宿主适配

- **`/preload.js` 路由**：`SidecarApp` 模式下 `index.mjs#L123` 自动挂载官方 `PRELOAD_JS`。Standalone 模式下 `index.html` 仍保留 `<script src="/preload.js"></script>`，后端必须主动提供 `GET /preload.js` 降级桩（`panel/main.mjs#L142` 返回 `200` + `Content-Type: text/javascript` + `'// Standalone preview: no host bridge.'`），避免 404 错误或 MIME 拦截。
- **前端契约降级**：
  - 所有对 `window.sidecar` 的访问必须使用可选链：`const transport = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;`（`swarm_board/app.js#L55`、`panel/app.js#L30,L410`）。
  - 宿主独家能力（`window.sidecar?.getWorkspaceUris`、`onWorkspaceChange`、`ui.toggleConversation`、`ui.toggleAuxPane`、`agent.startConversation`）在 Standalone 下不可用时，需明确降级（如隐藏或禁用「在该 Worktree 开启新对话」按钮，或提示仅在桌面端内可用，参考 `swarm_board/app.js#L277,L1459-L1469`）。
  - Standalone 可通过 `!window.sidecar` 为 `body` 添加 `.standalone` 类（`panel/app.js#L27-L28`），用于套用居中窄框预览外壳（`.standalone .widget { width: min(480px, calc(100vw - 24px)) }`）或本地调试主题切换器。

### 3.4 Standalone 多 Repository / 多 Worktree 夹具注入模式

参考 `antigrative-dashboard` 的测试与预览体系，Standalone 与无头浏览器验证可采用三种夹具机制组合：

1. **轻量预览桩与 URL 参数注入**：参考 `tools/check-panel-ui.mjs#L34-L38` 与 `swarm_board/app.js#L51,L2002-L2005`。在 Standalone 模式下，可通过环境变量（如 `AG_WORKTREE_PATHS` 指定本地多 Repository 路径）或查询参数（如 `?theme=dark|light`、`?fixture=1`）切换数据源与外观；`/preload.js` 桩在 `?sdk` 模式下可按需注入模拟的 `window.sidecar`（提供 `getWorkspaceUris()` 与 `onWorkspaceChange()` 返回多个 `file://` URI）。
2. **真实临时 Git 目录夹具（端到端测试）**：Node 测试脚本在 `os.tmpdir()` 中用真实 `git init` 与 `git worktree add` 构造包含主 `Worktree`、`Managed Worktree` 隔离路径、多分支分叉、合并冲突以及暂存/未暂存/未跟踪文件变更（`Working Tree Changes`）的多 Repository 目录，传入 Standalone 服务作为 `Workspace` 根路径，验证真实 `git` CLI 输出解析与前端交互。
3. **Opaque `srcdoc` `iframe` + Playwright/Edge 回归模式**：参考 `tools/check-panel-ui.mjs#L35-L38,L84-L87,L113-L142` 与 `tools/check-theme-ui.mjs#L53-L58,L381-L390`。用一个父页将真实侧栏 HTML 以 `<iframe sandbox="allow-scripts" srcdoc="...">`（头部注入 `<base href="...">`）包裹，验证 `self.origin === 'null'` 隔离环境、向 `:root` 注入或通过 `postMessage` 发送 `theme-change` / `workspace-change` 时的动态响应，并在 `320px`、`360px`、`420px`、`560px` 视口下断言零横向溢出（`scrollWidth <= clientWidth`）与控件无重叠。

---

## 四、对 `antigravity-git-worktree` 的约束汇总

| 模块 | 必须遵守的设计契约 | 一手来源 |
| --- | --- | --- |
| CSS 主题与明暗检测 | 只消费语义变量（含 `--editor-font-family` 与 `--vscode-editor-font-family` 回退）；`MutationObserver` 监听 `<html>` `style`/`data-theme`/`class` 并用 1×1 Canvas 解码 `--background`；`body` 样式用 `!important` 压过 `preload.js` 内联值；不请求外网字体 CDN | `preload.js#L53-L58,L84-L99`、`swarm_board/styles.css#L16-L43,L913`、`compat/theme.cjs#L38-L43,L67-L110` |
| 表单与快捷键 | Commit 框与搜索框使用 `<textarea>` / `<input>`；前端自定义组合键执行 `e.preventDefault()` 阻断 `preload.js` 转发；全局单键跳过表单元素 | `preload.js#L134-L256`、`swarm_board/app.js#L1984` |
| 窄幅视口布局（320px–560px） | 声明 `@container` 断点（360px/380px）及 `@media` 窄屏降级；列表容器设 `scrollbar-gutter: stable` 与 `overscroll-behavior: contain`；文本列 `min-width: 0`；边缘部件 `:focus-visible` 用 `outline-offset: -2px`，重渲染后键盘保焦 | `panel/styles.css#L6,L12,L32,L39,L101-L102`、`swarm_board/styles.css#L83-L94,L188,L864-L870`、`panel/app.js#L236-L239` |
| 双模式与安全边界 | 按 `ANTIGRAVITY_SIDECAR_WEB_PORT` 分支动态加载 `sidecar_sdk`；**所有 Git 写操作必须用 `POST` 走 `X-Sidecar-Token`**（因 `SidecarApp` 对 `GET` 免 Token）；Standalone 绑定 `127.0.0.1` 并做 Host + Origin + `application/json` 校验，提供 `/preload.js` 200 空桩 | `sidecar_sdk/index.mjs#L26,L139-L143,L218-L224`、`panel/main.mjs#L86-L154`、`sdk.mjs#L9-L24` |
