import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

/**
 * 前端零构建经典脚本装配的显式依赖拓扑顺序。
 * 源码目录 `public/` 保持原生 ES2022 模块以便 `node:test` 直接导入与维护；
 * 运行时由本模块在内存中装配为单个 classic script（无 `import`/`export`），
 * 避免 Antigravity 2.0 自定义协议侧栏 iframe 拦截需要 CORS 的 `<script type="module">`。
 */
export const PANEL_APP_MODULES = Object.freeze([
  'modules/theme.js',
  'modules/i18n.js',
  'modules/graph-layout.js',
  'modules/popover.js',
  'modules/markdown.js',
  'modules/api-client.js',
  'modules/changes-view.js',
  'modules/graph-view.js',
  'modules/repos-view.js',
  'modules/progress-bar.js',
  'modules/codicons.js',
  'modules/file-icon-map.js',
  'modules/file-icons.js',
  'modules/toast.js',
  'app.js',
]);

const STATIC_ASSET_ATTR_PATTERN = /(href|src)="\/(styles\.css|app\.js)(?:\?[^"]*)?"/g;
const NAMED_IMPORT_PATTERN = /^import\s*\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"]\s*;?[ \t]*$/gm;
const NAMED_EXPORT_PATTERN = /^export\s+(?:(async\s+)?function|class|const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/gm;

const bundleCache = new Map();

function normalizePosixRelative(fromRelPath, specifier) {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
    throw new Error(`Unsupported bare or external module specifier "${specifier}" in ${fromRelPath}`);
  }
  const fromDir = path.posix.dirname(fromRelPath);
  return path.posix.normalize(path.posix.join(fromDir, specifier));
}

function parseNamedImportBindings(rawBindings, relPath) {
  const withoutComments = rawBindings
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  const bindings = [];
  for (const rawPart of withoutComments.split(',')) {
    const part = rawPart.trim();
    if (!part) continue;
    const aliasMatch = /^([A-Za-z_$][A-Za-z0-9_$]*)\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(part);
    if (aliasMatch) {
      bindings.push(`${aliasMatch[1]}: ${aliasMatch[2]}`);
      continue;
    }
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(part)) {
      bindings.push(part);
      continue;
    }
    throw new Error(`Unsupported import binding "${part}" in ${relPath}`);
  }
  return bindings;
}

function wrapSingleModule(relPath, rawSource, loadedModules) {
  const normalized = rawSource.replace(/\r\n?/g, '\n');

  const withImportsReplaced = normalized.replace(
    NAMED_IMPORT_PATTERN,
    (_fullMatch, rawBindings, specifier) => {
      const targetId = normalizePosixRelative(relPath, specifier);
      if (!loadedModules.has(targetId)) {
        throw new Error(`Module "${relPath}" imports "${targetId}" before it is registered in PANEL_APP_MODULES.`);
      }
      const bindings = parseNamedImportBindings(rawBindings, relPath);
      return `const { ${bindings.join(', ')} } = __modules[${JSON.stringify(targetId)}];`;
    },
  );

  const exportedNames = [];
  const transformedBody = withImportsReplaced.replace(
    NAMED_EXPORT_PATTERN,
    (fullMatch, _asyncPrefix, identifier) => {
      exportedNames.push(identifier);
      return fullMatch.replace(/^export\s+/, '');
    },
  );

  const returnLine = exportedNames.length > 0
    ? `  return { ${exportedNames.join(', ')} };`
    : '  return {};';

  return `  __modules[${JSON.stringify(relPath)}] = (() => {\n${transformedBody}\n${returnLine}\n  })();`;
}

function readSourceSnapshot(publicDir) {
  const files = ['index.html', 'styles.css', ...PANEL_APP_MODULES];
  const signatureParts = [];
  const fullPaths = new Map();
  for (const relPath of files) {
    const absPath = path.join(publicDir, ...relPath.split('/'));
    const stat = fs.statSync(absPath);
    signatureParts.push(`${relPath}:${stat.mtimeMs}:${stat.size}`);
    fullPaths.set(relPath, absPath);
  }
  return {
    signature: signatureParts.join('|'),
    fullPaths,
  };
}

function compilePanelAssets(publicDir) {
  const resolvedDir = path.resolve(publicDir);
  const { signature, fullPaths } = readSourceSnapshot(resolvedDir);
  const cached = bundleCache.get(resolvedDir);
  if (cached && cached.signature === signature) {
    return cached;
  }

  const loadedModules = new Set();
  const moduleBlocks = [];
  for (const relPath of PANEL_APP_MODULES) {
    const rawSource = fs.readFileSync(fullPaths.get(relPath), 'utf8');
    moduleBlocks.push(wrapSingleModule(relPath, rawSource, loadedModules));
    loadedModules.add(relPath);
  }

  const appBundle = `(() => {\n  'use strict';\n  const __modules = Object.create(null);\n${moduleBlocks.join('\n\n')}\n})();\n`;

  // 启动或热更新时直接通过 V8 classic parser 校验，确保产物不含任何残留 ESM import/export 语法
  new vm.Script(appBundle, { filename: 'panel-app.classic.js' });

  const rawHtml = fs.readFileSync(fullPaths.get('index.html'), 'utf8');
  const stylesBuffer = fs.readFileSync(fullPaths.get('styles.css'));
  const version = createHash('sha256')
    .update(rawHtml)
    .update(stylesBuffer)
    .update(appBundle)
    .digest('hex')
    .slice(0, 12);

  const html = rawHtml.replace(
    STATIC_ASSET_ATTR_PATTERN,
    (_match, attr, assetPath) => `${attr}="/${assetPath}?v=${version}"`,
  );

  if (/\btype\s*=\s*['"]module['"]/i.test(html)) {
    throw new Error('Served panel HTML must not use <script type="module">; custom-scheme sidecars require classic scripts.');
  }
  if (!html.includes('/preload.js') || !html.includes(`/app.js?v=${version}`)) {
    throw new Error('Served panel HTML must include /preload.js and versioned /app.js.');
  }

  const compiled = {
    signature,
    version,
    appBundle,
    html,
    stylesBuffer,
  };
  bundleCache.set(resolvedDir, compiled);
  return compiled;
}

/**
 * 将 `public/modules/*.js` 与 `public/app.js` 按显式依赖拓扑装配为单个 classic JavaScript 字符串，
 * 并通过 V8 `vm.Script` 校验其可直接由 `<script defer src="/app.js">` 在自定义协议侧栏内运行。
 *
 * @param {string} publicDir 前端静态资源根目录（`sidecars/panel/public`）
 * @returns {string} 可直接作为 `/app.js` 响应体返回的 UTF-8 经典脚本源码
 */
export function buildPanelAppBundle(publicDir) {
  return compilePanelAssets(publicDir).appBundle;
}

/**
 * 生成带内容哈希缓存破坏参数（`?v=<sha256-12>`）的面板首页 HTML，并强制断言不含 `type="module"`。
 *
 * @param {string} publicDir 前端静态资源根目录（`sidecars/panel/public`）
 * @returns {string} 完整首页 HTML 文本
 */
export function buildPanelPageHtml(publicDir) {
  return compilePanelAssets(publicDir).html;
}

/**
 * 读取带缓存的面板样式表原始字节内容。
 *
 * @param {string} publicDir 前端静态资源根目录（`sidecars/panel/public`）
 * @returns {Buffer} `styles.css` 原始字节流
 */
export function readPanelStyles(publicDir) {
  return compilePanelAssets(publicDir).stylesBuffer;
}
