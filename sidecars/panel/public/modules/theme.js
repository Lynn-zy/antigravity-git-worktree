/**
 * Antigravity 2.0 辅助栏明暗主题同步、WCAG 4.5:1 对比度校正与安全字体栈模块。
 * 纯计算逻辑与浏览器 DOM 监听严格解耦；无任何外网 CDN 字体请求或定时器轮询。
 */

/** @type {string} 无宿主注入时的本地双语 UI 字体回退栈 */
export const DEFAULT_UI_FONT_STACK = '-apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif';

/** @type {string} 宿主已注入 UI 字体时追加的中文字体与泛型族回退栈 */
export const DEFAULT_UI_APPEND_STACK = '"Microsoft YaHei", sans-serif';

/** @type {string} 等宽字体回退栈 */
export const DEFAULT_MONO_FONT_STACK = 'ui-monospace, "Cascadia Mono", "Consolas", monospace';

const DARK_MODE_TOKENS = new Set([
  'dark',
  'vs-dark',
  'vscode-dark',
  'hc-black',
  'hc-dark',
  'vscode-high-contrast',
  'high-contrast-dark',
]);

const LIGHT_MODE_TOKENS = new Set([
  'light',
  'vs',
  'vs-light',
  'vscode-light',
  'hc-light',
  'vscode-high-contrast-light',
  'high-contrast-light',
]);

const GENERIC_FONT_FAMILIES = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
]);

const UNSAFE_CSS_FONT_PATTERN = /[;{}<>\\]|url\s*\(|var\s*\(|expression\s*\(|@import|javascript:|data:/i;
const CSS_KEYWORD_FONT_PATTERN = /^(inherit|initial|unset|revert|revert-layer|none)$/i;
const SAFE_FONT_NAME_PATTERN = /^[a-zA-Z0-9 _\-.+\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]+$/;

const clampByte = (value) => Math.max(0, Math.min(255, Math.round(value)));

const formatHexColor = ({ r, g, b }) => {
  const toHex = (channel) => clampByte(channel).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
};

const toRgbTuple = (color) => {
  if (!color) return null;

  if (Array.isArray(color)) {
    if (color.length < 3) return null;
    const [red, green, blue, alpha] = color;
    if (!Number.isFinite(red) || !Number.isFinite(green) || !Number.isFinite(blue)) return null;
    if (Number.isFinite(alpha) && alpha < 250) return null;
    return { r: clampByte(red), g: clampByte(green), b: clampByte(blue) };
  }

  if (typeof color === 'object') {
    const red = color.r;
    const green = color.g;
    const blue = color.b;
    const alpha = color.a;
    if (!Number.isFinite(red) || !Number.isFinite(green) || !Number.isFinite(blue)) return null;
    if (Number.isFinite(alpha) && alpha < 250) return null;
    return { r: clampByte(red), g: clampByte(green), b: clampByte(blue) };
  }

  if (typeof color !== 'string') return null;
  const trimmed = color.trim();
  if (!trimmed) return null;

  const shortHexMatch = /^#([0-9a-f]{3})$/i.exec(trimmed);
  if (shortHexMatch) {
    const digits = shortHexMatch[1];
    return {
      r: parseInt(digits[0] + digits[0], 16),
      g: parseInt(digits[1] + digits[1], 16),
      b: parseInt(digits[2] + digits[2], 16),
    };
  }

  const fullHexMatch = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(trimmed);
  if (fullHexMatch) {
    if (fullHexMatch[2] && parseInt(fullHexMatch[2], 16) < 250) {
      return null;
    }
    const hex = fullHexMatch[1];
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
    };
  }

  const rgbMatch = /^rgba?\(\s*([\d.]+)\s*[,\s]\s*([\d.]+)\s*[,\s]\s*([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i.exec(trimmed);
  if (rgbMatch) {
    if (rgbMatch[4] !== undefined) {
      const alphaText = rgbMatch[4];
      const alphaUnit = alphaText.endsWith('%')
        ? parseFloat(alphaText) / 100
        : parseFloat(alphaText);
      if (Number.isFinite(alphaUnit) && alphaUnit * 255 < 250) {
        return null;
      }
    }
    return {
      r: clampByte(parseFloat(rgbMatch[1])),
      g: clampByte(parseFloat(rgbMatch[2])),
      b: clampByte(parseFloat(rgbMatch[3])),
    };
  }

  return null;
};

const parseFontItems = (rawFontList) => {
  if (typeof rawFontList !== 'string') return null;
  const trimmed = rawFontList.trim();
  if (!trimmed || trimmed.length > 240) return null;
  if (UNSAFE_CSS_FONT_PATTERN.test(trimmed)) return null;
  if (CSS_KEYWORD_FONT_PATTERN.test(trimmed)) return null;

  const segments = trimmed.split(',');
  const cleanedItems = [];

  for (const rawSegment of segments) {
    const segment = rawSegment.trim();
    if (!segment) return null;

    const firstChar = segment[0];
    const lastChar = segment[segment.length - 1];
    const isDoubleQuoted = firstChar === '"' && lastChar === '"' && segment.length >= 2;
    const isSingleQuoted = firstChar === "'" && lastChar === "'" && segment.length >= 2;

    if (isDoubleQuoted || isSingleQuoted) {
      const inner = segment.slice(1, -1).trim();
      if (!inner || inner.includes('"') || inner.includes("'") || !SAFE_FONT_NAME_PATTERN.test(inner)) {
        return null;
      }
      if (CSS_KEYWORD_FONT_PATTERN.test(inner)) return null;
      cleanedItems.push({ raw: `"${inner}"`, key: inner.toLowerCase(), isGeneric: false });
      continue;
    }

    if (segment.includes('"') || segment.includes("'")) return null;
    if (!SAFE_FONT_NAME_PATTERN.test(segment)) return null;
    if (CSS_KEYWORD_FONT_PATTERN.test(segment)) return null;

    const normalizedKey = segment.toLowerCase();
    cleanedItems.push({
      raw: segment,
      key: normalizedKey,
      isGeneric: GENERIC_FONT_FAMILIES.has(normalizedKey),
    });
  }

  return cleanedItems.length > 0 ? cleanedItems : null;
};

/**
 * 将宿主或 DOM 传入的主题标识字符串规范化为 `'dark' | 'light' | null`。
 * 兼容标准模式名、VS Code 主题类名以及高对比度标识（`hc-light`、`hc-black`、`hc-dark`）。
 *
 * @param {unknown} rawMode 原始主题值或类名字符串
 * @returns {'dark' | 'light' | null} 规范化后的明暗模式；无法明确判断时返回 `null`（无副作用）
 */
export const normalizeThemeMode = (rawMode) => {
  if (typeof rawMode !== 'string') return null;
  const normalized = rawMode.trim().toLowerCase();
  if (!normalized || normalized === 'auto' || normalized === 'system') {
    return null;
  }

  if (LIGHT_MODE_TOKENS.has(normalized)) return 'light';
  if (DARK_MODE_TOKENS.has(normalized)) return 'dark';

  const tokens = normalized.split(/\s+/);
  for (const token of tokens) {
    if (LIGHT_MODE_TOKENS.has(token)) return 'light';
    if (DARK_MODE_TOKENS.has(token)) return 'dark';
  }

  if (normalized.includes('light')) return 'light';
  if (normalized.includes('dark') || normalized.includes('hc-black') || normalized.includes('high-contrast')) {
    return 'dark';
  }

  return null;
};

/**
 * 按 WCAG 2.1 sRGB 规范计算颜色的相对亮度（Relative Luminance）。
 *
 * @param {{ r: number, g: number, b: number } | number[] | string} color RGB 对象、数组或十六进制/rgb() 颜色字符串
 * @returns {number | null} 范围 `[0, 1]` 的相对亮度值；输入无效时返回 `null`（无副作用）
 */
export const relativeLuminance = (color) => {
  const rgb = toRgbTuple(color);
  if (!rgb) return null;

  const linearize = (channelByte) => {
    const srgb = channelByte / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };

  return (
    0.2126 * linearize(rgb.r)
    + 0.7152 * linearize(rgb.g)
    + 0.0722 * linearize(rgb.b)
  );
};

/**
 * 计算两种颜色之间的 WCAG 2.1 对比度比值 `(L1 + 0.05) / (L2 + 0.05)`。
 *
 * @param {{ r: number, g: number, b: number } | number[] | string} colorA 前景色或第一种颜色
 * @param {{ r: number, g: number, b: number } | number[] | string} colorB 背景色或第二种颜色
 * @returns {number} 范围 `[1, 21]` 的对比度数值；若任一颜色无效则返回 `1`（无副作用）
 */
export const contrastRatio = (colorA, colorB) => {
  const lumA = relativeLuminance(colorA);
  const lumB = relativeLuminance(colorB);
  if (lumA === null || lumB === null) return 1;

  const lighter = Math.max(lumA, lumB);
  const darker = Math.min(lumA, lumB);
  return (lighter + 0.05) / (darker + 0.05);
};

/**
 * 校验前景色与一组表面背景色之间的最小对比度；若低于目标阈值（默认 `4.5:1`），
 * 则朝纯白或纯黑中对比度更高的一极以 `1%` 步长迭代混合，直至满足要求。
 *
 * @param {{ r: number, g: number, b: number } | number[] | string} foreground 原始前景色或状态文本色
 * @param {{ r: number, g: number, b: number } | number[] | string | Array<{ r: number, g: number, b: number } | number[] | string>} backgrounds 单个背景色或表面背景色数组
 * @param {number} [minRatio=4.5] 目标最低 WCAG 对比度阈值
 * @returns {string} 满足对比度要求（或达最大可能对比度）的 `#rrggbb` 颜色字符串（无副作用）
 */
export const adjustForegroundContrast = (foreground, backgrounds, minRatio = 4.5) => {
  const fgRgb = toRgbTuple(foreground);
  if (!fgRgb) return typeof foreground === 'string' ? foreground : '#ffffff';

  const rawBgList = Array.isArray(backgrounds) && typeof backgrounds[0] !== 'number'
    ? backgrounds
    : [backgrounds];
  const bgList = rawBgList.map(toRgbTuple).filter(Boolean);
  if (bgList.length === 0) {
    return formatHexColor(fgRgb);
  }

  const getMinContrast = (candidate) => {
    let minFound = Infinity;
    for (const bg of bgList) {
      const ratio = contrastRatio(candidate, bg);
      if (ratio < minFound) minFound = ratio;
    }
    return minFound;
  };

  if (getMinContrast(fgRgb) >= minRatio) {
    return formatHexColor(fgRgb);
  }

  const whitePole = { r: 255, g: 255, b: 255 };
  const blackPole = { r: 0, g: 0, b: 0 };
  const targetPole = getMinContrast(whitePole) >= getMinContrast(blackPole) ? whitePole : blackPole;

  let bestCandidate = fgRgb;
  let bestContrast = getMinContrast(fgRgb);

  for (let percent = 1; percent <= 100; percent += 1) {
    const ratio = percent / 100;
    const candidate = {
      r: Math.round(fgRgb.r + (targetPole.r - fgRgb.r) * ratio),
      g: Math.round(fgRgb.g + (targetPole.g - fgRgb.g) * ratio),
      b: Math.round(fgRgb.b + (targetPole.b - fgRgb.b) * ratio),
    };
    const candidateContrast = getMinContrast(candidate);
    if (candidateContrast > bestContrast) {
      bestContrast = candidateContrast;
      bestCandidate = candidate;
    }
    if (candidateContrast >= minRatio) {
      return formatHexColor(candidate);
    }
  }

  return formatHexColor(bestCandidate);
};

/**
 * 对宿主注入的 CSS 字体列表字符串进行安全白名单净化，拦截注入字符与危险表达式，
 * 并自动追加双语本地安全回退字体栈（严禁外网字体 CDN）。
 *
 * @param {unknown} rawFontValue 宿主 CSS 变量传入的字体列表字符串
 * @param {string} [fallbackStack=DEFAULT_UI_FONT_STACK] 净化失败或为空时使用的默认回退字体栈
 * @param {string} [appendStack=fallbackStack] 当宿主字体合法时追加在末尾的回退字体栈
 * @returns {string} 安全可用的 CSS `font-family` 值（无副作用）
 */
export const sanitizeCssFontList = (
  rawFontValue,
  fallbackStack = DEFAULT_UI_FONT_STACK,
  appendStack,
) => {
  const safeFallback = typeof fallbackStack === 'string' && fallbackStack.trim()
    ? fallbackStack.trim()
    : DEFAULT_UI_FONT_STACK;
  const resolvedAppendStack = appendStack !== undefined
    ? appendStack
    : (safeFallback === DEFAULT_UI_FONT_STACK ? DEFAULT_UI_APPEND_STACK : safeFallback);

  const hostItems = parseFontItems(rawFontValue);
  if (!hostItems) {
    return safeFallback;
  }

  const appendItems = parseFontItems(resolvedAppendStack) ?? [];
  const seenKeys = new Set();
  const nonGeneric = [];
  const generics = [];

  const pushItem = (item) => {
    if (seenKeys.has(item.key)) return;
    seenKeys.add(item.key);
    if (item.isGeneric) {
      generics.push(item.raw);
    } else {
      nonGeneric.push(item.raw);
    }
  };

  for (const item of hostItems) pushItem(item);
  for (const item of appendItems) pushItem(item);

  const combined = [...nonGeneric, ...generics];
  return combined.length > 0 ? combined.join(', ') : safeFallback;
};

/**
 * 纯函数解析计算样式与背景像素，产出面板所需的明暗模式、WCAG 4.5:1 校正后状态色变量与安全字体变量。
 *
 * @param {{
 *   computedStyle?: { getPropertyValue?: (name: string) => string } | Record<string, string>,
 *   explicitTheme?: string | null,
 *   backgroundRgb?: { r: number, g: number, b: number, a?: number } | number[] | null,
 *   cardRgb?: { r: number, g: number, b: number, a?: number } | number[] | null,
 *   statusRgbs?: {
 *     success?: { r: number, g: number, b: number, a?: number } | number[] | null,
 *     warning?: { r: number, g: number, b: number, a?: number } | number[] | null,
 *     error?: { r: number, g: number, b: number, a?: number } | number[] | null
 *   },
 *   prefersDark?: boolean
 * }} [options] 样式读取器、像素解码结果与系统偏好
 * @returns {{
 *   mode: 'dark' | 'light',
 *   colorScheme: 'dark' | 'light',
 *   cssVariables: {
 *     '--gw-success': string,
 *     '--gw-warning': string,
 *     '--gw-error': string,
 *     '--gw-font-ui': string,
 *     '--gw-font-mono': string
 *   }
 * }} 解析完成的主题状态对象（无副作用）
 */
export const resolveThemeVariablesFromComputed = (options = {}) => {
  const computedStyle = options?.computedStyle;
  const readVar = (name) => {
    if (!computedStyle) return '';
    const value = typeof computedStyle.getPropertyValue === 'function'
      ? computedStyle.getPropertyValue(name)
      : computedStyle[name];
    return typeof value === 'string' ? value.trim() : '';
  };

  const explicitMode = normalizeThemeMode(options?.explicitTheme);
  const bgRgb = toRgbTuple(options?.backgroundRgb) ?? toRgbTuple(readVar('--background'));

  let mode = explicitMode;
  if (!mode && bgRgb) {
    const lum = relativeLuminance(bgRgb);
    mode = lum !== null && lum < 0.35 ? 'dark' : 'light';
  }
  if (!mode) {
    mode = options?.prefersDark ? 'dark' : 'light';
  }

  const effectiveBgRgb = bgRgb ?? (
    mode === 'dark' ? { r: 24, g: 24, b: 26 } : { r: 248, g: 248, b: 249 }
  );
  const cardRgb = toRgbTuple(options?.cardRgb) ?? toRgbTuple(readVar('--card'));
  const surfaces = cardRgb ? [effectiveBgRgb, cardRgb] : [effectiveBgRgb];

  const modeDefaults = mode === 'dark'
    ? { success: '#73c991', warning: '#e2b969', error: '#f87171' }
    : { success: '#1a7f37', warning: '#9a6700', error: '#cf222e' };

  const rawSuccess = toRgbTuple(options?.statusRgbs?.success)
    ?? toRgbTuple(readVar('--success'))
    ?? modeDefaults.success;
  const rawWarning = toRgbTuple(options?.statusRgbs?.warning)
    ?? toRgbTuple(readVar('--warning'))
    ?? modeDefaults.warning;
  const rawError = toRgbTuple(options?.statusRgbs?.error)
    ?? toRgbTuple(readVar('--error'))
    ?? modeDefaults.error;

  const rawUiFont = readVar('--font-family') || readVar('--ui-font-family') || readVar('--font-sans');
  const rawMonoFont = readVar('--editor-font-family') || readVar('--vscode-editor-font-family') || readVar('--font-mono');

  return {
    mode,
    colorScheme: mode,
    cssVariables: {
      '--gw-success': adjustForegroundContrast(rawSuccess, surfaces, 4.5),
      '--gw-warning': adjustForegroundContrast(rawWarning, surfaces, 4.5),
      '--gw-error': adjustForegroundContrast(rawError, surfaces, 4.5),
      '--gw-font-ui': sanitizeCssFontList(rawUiFont, DEFAULT_UI_FONT_STACK, DEFAULT_UI_APPEND_STACK),
      '--gw-font-mono': sanitizeCssFontList(rawMonoFont, DEFAULT_MONO_FONT_STACK, DEFAULT_MONO_FONT_STACK),
    },
  };
};

/**
 * 启动宿主主题同步：使用 `MutationObserver` 监听 `<html>` 的 `style`、`data-theme` 与 `class` 属性，
 * 通过 1×1 Canvas 解码 `--background`（alpha < 250 时回退系统 `prefers-color-scheme`），
 * 自动写入 `data-theme`、`color-scheme` 及 WCAG 4.5:1 校正后的 `--gw-*` 变量。
 * 禁用 `setInterval` 轮询；所有 DOM 操作仅在本函数被显式调用时执行。
 *
 * @param {{
 *   root?: HTMLElement,
 *   win?: Window,
 *   onThemeChange?: (themeState: ReturnType<typeof resolveThemeVariablesFromComputed>) => void
 * }} [options] 根元素、窗口对象与主题变化回调
 * @returns {{
 *   sync: () => ReturnType<typeof resolveThemeVariablesFromComputed> | null,
 *   dispose: () => void,
 *   getTheme: () => ReturnType<typeof resolveThemeVariablesFromComputed> | null
 * }} 主题控制器实例（有 DOM 读写与事件监听副作用）
 */
export const initThemeSync = (options = {}) => {
  const win = options?.win ?? (typeof window !== 'undefined' ? window : null);
  const root = options?.root ?? win?.document?.documentElement ?? (typeof document !== 'undefined' ? document.documentElement : null);
  if (!win || !root) {
    return {
      sync: () => null,
      dispose: () => {},
      getTheme: () => null,
    };
  }

  const doc = root.ownerDocument ?? win.document;
  let cachedCanvasCtx = null;

  const getCanvasContext = () => {
    if (cachedCanvasCtx) return cachedCanvasCtx;
    const canvas = doc?.createElement?.('canvas');
    if (!canvas) return null;
    canvas.width = 1;
    canvas.height = 1;
    cachedCanvasCtx = canvas.getContext?.('2d', { willReadFrequently: true }) ?? null;
    return cachedCanvasCtx;
  };

  const resolveVarToRgbViaCanvas = (varName) => {
    const ctx = getCanvasContext();
    const computed = win.getComputedStyle?.(root);
    const rawVarValue = computed?.getPropertyValue?.(varName)?.trim() ?? '';
    if (!rawVarValue) return null;

    let colorToRasterize = rawVarValue;
    if (colorToRasterize.includes('var(') && doc?.createElement && root.appendChild) {
      // 仅当变量值仍含嵌套 var(...) 时借助临时探针节点解析计算颜色
      const probe = doc.createElement('span');
      probe.style.position = 'absolute';
      probe.style.visibility = 'hidden';
      probe.style.pointerEvents = 'none';
      probe.style.color = `var(${varName})`;
      root.appendChild(probe);
      const probeColor = win.getComputedStyle?.(probe)?.color?.trim();
      probe.remove?.();
      if (probeColor) {
        colorToRasterize = probeColor;
      }
    }

    if (!ctx) {
      return toRgbTuple(colorToRasterize);
    }

    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = 'rgba(0, 0, 0, 0)';
    ctx.fillStyle = colorToRasterize;
    ctx.fillRect(0, 0, 1, 1);
    const pixel = ctx.getImageData(0, 0, 1, 1).data;
    if (!pixel || pixel[3] < 250) {
      return null;
    }
    return { r: pixel[0], g: pixel[1], b: pixel[2], a: pixel[3] };
  };

  let observer = null;
  let explicitDataThemeOverride = null;
  let lastWrittenMode = null;
  let currentTheme = null;
  let lastSnapshotKey = '';

  const readExplicitHostTheme = (hasOpaqueBackground) => {
    const hostKind = root.getAttribute?.('data-vscode-theme-kind')
      || root.getAttribute?.('data-color-mode')
      || root.getAttribute?.('data-theme-mode');
    const fromHostAttr = normalizeThemeMode(hostKind);
    if (fromHostAttr) return fromHostAttr;

    const fromClass = normalizeThemeMode(root.className ?? '');
    if (fromClass) return fromClass;

    if (explicitDataThemeOverride) {
      return explicitDataThemeOverride;
    }

    // 仅在首次同步前且缺少不透明背景时读取初始 data-theme，避免插件自身写入值阻断后续回退 matchMedia
    if (!hasOpaqueBackground && lastWrittenMode === null) {
      return normalizeThemeMode(root.getAttribute?.('data-theme') ?? root.dataset?.theme);
    }

    return null;
  };

  const sync = () => {
    const computedStyle = win.getComputedStyle?.(root) ?? root.style;
    const mediaQuery = win.matchMedia?.('(prefers-color-scheme: dark)');
    const prefersDark = Boolean(mediaQuery?.matches);
    const backgroundRgb = resolveVarToRgbViaCanvas('--background');
    const cardRgb = resolveVarToRgbViaCanvas('--card');
    const statusRgbs = {
      success: resolveVarToRgbViaCanvas('--success'),
      warning: resolveVarToRgbViaCanvas('--warning'),
      error: resolveVarToRgbViaCanvas('--error'),
    };
    const explicitTheme = readExplicitHostTheme(Boolean(backgroundRgb));

    const nextTheme = resolveThemeVariablesFromComputed({
      computedStyle,
      explicitTheme,
      backgroundRgb,
      cardRgb,
      statusRgbs,
      prefersDark,
    });

    if (root.dataset) {
      if (root.dataset.theme !== nextTheme.mode) {
        root.dataset.theme = nextTheme.mode;
      }
    } else if (root.getAttribute?.('data-theme') !== nextTheme.mode) {
      root.setAttribute?.('data-theme', nextTheme.mode);
    }

    if (root.style) {
      if (root.style.colorScheme !== nextTheme.colorScheme) {
        root.style.colorScheme = nextTheme.colorScheme;
      }
      for (const [cssVarName, cssVarValue] of Object.entries(nextTheme.cssVariables)) {
        if (root.style.getPropertyValue?.(cssVarName) !== cssVarValue) {
          root.style.setProperty?.(cssVarName, cssVarValue);
        }
      }
    }

    // 丢弃本轮同步写入导致的同步属性变动记录，防止触发 MutationObserver 自激循环
    observer?.takeRecords?.();

    lastWrittenMode = nextTheme.mode;
    currentTheme = nextTheme;

    const snapshotKey = JSON.stringify(nextTheme);
    if (snapshotKey !== lastSnapshotKey) {
      lastSnapshotKey = snapshotKey;
      options?.onThemeChange?.(nextTheme);
    }

    return nextTheme;
  };

  const ObserverCtor = win.MutationObserver ?? (typeof MutationObserver !== 'undefined' ? MutationObserver : null);
  if (ObserverCtor) {
    observer = new ObserverCtor((mutations) => {
      if (Array.isArray(mutations)) {
        const hasStyleMutation = mutations.some((record) => record?.attributeName === 'style');
        const hasDataThemeMutation = mutations.some((record) => record?.attributeName === 'data-theme');
        if (hasStyleMutation) {
          explicitDataThemeOverride = null;
        } else if (hasDataThemeMutation) {
          const observedDataTheme = normalizeThemeMode(
            root.getAttribute?.('data-theme') ?? root.dataset?.theme,
          );
          if (observedDataTheme && observedDataTheme !== lastWrittenMode) {
            explicitDataThemeOverride = observedDataTheme;
          }
        }
      }
      sync();
    });
    observer.observe(root, {
      attributes: true,
      attributeFilter: ['style', 'data-theme', 'class'],
    });
  }

  const mediaQuery = win.matchMedia?.('(prefers-color-scheme: dark)');
  const onMediaChange = () => {
    sync();
  };
  mediaQuery?.addEventListener?.('change', onMediaChange);

  sync();

  return {
    sync,
    getTheme: () => currentTheme,
    dispose: () => {
      observer?.disconnect?.();
      observer = null;
      mediaQuery?.removeEventListener?.('change', onMediaChange);
    },
  };
};
