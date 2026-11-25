/**
 * 生成 sidecars/panel/public/modules/codicons.js：从固定提交的 vscode-codicons 下载下方列出的图标 SVG，
 * 原样提取路径数据。
 *
 * 用法：node scripts/gen-codicons.mjs
 * 新增图标时把名字加进 ICON_NAMES；升级上游时修改 CODICONS_SHA。重新运行后核对生成结果的 diff。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CODICONS_SHA = '8d1826a9bce0a52283ecaeb63499c149e97a4f14';

/** 输出顺序即列表顺序；键名为短横线转驼峰，如 git-branch → gitBranch */
const ICON_NAMES = [
  'chevron-down', 'chevron-right', 'git-branch', 'git-commit', 'target', 'cloud', 'cloud-upload', 'tag',
  'repo-fetch', 'repo-pull', 'repo-push', 'fold-down', 'refresh', 'ellipsis', 'check', 'discard', 'add', 'remove',
  'go-to-file', 'file', 'copy', 'close', 'search', 'info', 'warning', 'error', 'account', 'history',
];

const OUT_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../sidecars/panel/public/modules/codicons.js');

const fetchIconSvg = async (name) => {
  const url = `https://raw.githubusercontent.com/microsoft/vscode-codicons/${CODICONS_SHA}/src/icons/${name}.svg`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`下载失败 ${response.status}：${url}`);
  return response.text();
};

// 只按顶层 <path> 原样提取；带裁剪、遮罩或变换的 SVG 需要另行处理，直接报错而不是生成错误的图形
const toPathEntries = (name, svg) => {
  if (/<(?:defs|clipPath|mask)\b|\stransform=/.test(svg)) throw new Error(`${name}.svg 含裁剪、遮罩或变换，不能直接提取路径`);
  return [...svg.matchAll(/<path\b([^>]*)\/?>/g)].map(([, attrs]) => {
    const d = /\sd="([^"]+)"/.exec(attrs)?.[1];
    if (!d) throw new Error(`${name}.svg 的 path 缺少 d 属性`);
    return /fill-rule="evenodd"/.test(attrs) ? `{ d: '${d}', evenOdd: true }` : `'${d}'`;
  });
};

const svgs = await Promise.all(ICON_NAMES.map(fetchIconSvg));
const entries = ICON_NAMES.map((name, index) => {
  const key = name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
  return `  ${key}: [${toPathEntries(name, svgs[index]).join(', ')}],`;
});

fs.writeFileSync(OUT_FILE, `/**
 * VS Code Codicons 图标路径（16×16 填充式）。
 * 图标作者 Microsoft Corporation，来源 https://github.com/microsoft/vscode-codicons （提交 ${CODICONS_SHA}），
 * 以 CC BY 4.0（https://creativecommons.org/licenses/by/4.0/）授权。
 * 由 scripts/gen-codicons.mjs 从源 SVG 机械提取路径数据，图形未作修改，请勿手工编辑。
 */

/** @type {Readonly<Record<string, ReadonlyArray<string | { d: string, evenOdd: true }>>>} 图标名到路径列表的映射 */
export const CODICON_PATHS = Object.freeze({
${entries.join('\n')}
});
`);
console.log(`已写入 ${entries.length} 个图标：${path.relative(process.cwd(), OUT_FILE)}`);
