/**
 * 生成 sidecars/panel/public/modules/file-icon-map.js，并把映射用到的 vscode-icons SVG 复制到
 * sidecars/panel/public/file-icons/（先清空该目录）。
 *
 * 数据来源（均固定提交）：
 * - vscode-icons 的 src/iconsManifest（文件、文件夹、语言清单）与 icons/ 下的 SVG；
 * - VS Code 内置扩展 package.json 里声明的语言扩展名与文件名（VS Code 先按这些识别语言，再按语言 ID 取图标）。
 *
 * 用法：node scripts/gen-file-icons.mjs
 * 依赖 Node.js 22.18 及以上（直接导入 vscode-icons 的 TypeScript 清单）、git 与 tar 命令。
 * 升级上游时修改下方两个提交 SHA，重新运行后核对生成结果的 diff。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const VSCODE_ICONS_SHA = 'dc003f665c8d91ee9ffb821b9064c6a79cff09c0';
const VSCODE_SHA = '25e7ea7b8ff47efaf5dd69ee2645f1ed1962ed2c';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../sidecars/panel/public');
const OUT_MODULE = path.join(PUBLIC_DIR, 'modules', 'file-icon-map.js');
const OUT_ICONS_DIR = path.join(PUBLIC_DIR, 'file-icons');

const fetchOk = async (url, attemptsLeft = 3) => {
  let response;
  try {
    response = await fetch(url);
  } catch (error) {
    // 连接被重置等网络错误重试；HTTP 错误状态不重试
    if (attemptsLeft <= 1) throw error;
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return fetchOk(url, attemptsLeft - 1);
  }
  if (!response.ok) throw new Error(`下载失败 ${response.status}：${url}`);
  return response;
};

// raw.githubusercontent.com 同时建立上百个连接会被断开，限制并发数
const mapWithConcurrency = async (items, limit, mapper) => {
  const results = new Array(items.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
};

const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sortedObject = (obj) => Object.fromEntries(Object.entries(obj).sort(([a], [b]) => byCodePoint(a, b)));

/** 下载并解压 vscode-icons，把三个清单复制成 .mts 以便 Node 按 ES 模块直接导入 */
const loadVscodeIcons = async (workDir) => {
  const archive = Buffer.from(await (await fetchOk(
    `https://codeload.github.com/vscode-icons/vscode-icons/tar.gz/${VSCODE_ICONS_SHA}`,
  )).arrayBuffer());
  fs.writeFileSync(path.join(workDir, 'vscode-icons.tar.gz'), archive);
  // 用相对路径调用 tar：GNU tar 会把 C:\ 这类盘符路径当成远程主机
  execFileSync('tar', ['-xzf', 'vscode-icons.tar.gz'], { cwd: workDir, stdio: 'inherit' });
  const sourceRoot = path.join(workDir, `vscode-icons-${VSCODE_ICONS_SHA}`);

  const manifestDir = path.join(sourceRoot, 'src', 'iconsManifest');
  for (const name of ['languages', 'supportedExtensions', 'supportedFolders']) {
    const source = fs.readFileSync(path.join(manifestDir, `${name}.ts`), 'utf8')
      .replace("from './languages'", "from './languages.mts'");
    fs.writeFileSync(path.join(workDir, `${name}.mts`), source);
  }
  const importManifest = async (name) => import(pathToFileURL(path.join(workDir, `${name}.mts`)).href);
  return {
    iconsDir: path.join(sourceRoot, 'icons'),
    licenseFile: path.join(sourceRoot, 'LICENSE'),
    fileCollection: (await importManifest('supportedExtensions')).extensions,
    folderCollection: (await importManifest('supportedFolders')).extensions,
  };
};

/**
 * 读取 VS Code 内置扩展声明的语言；按扩展清单路径排序，重复声明时先出现的生效。
 * 扩展清单列表取自只含目录树的浅克隆，不走 GitHub API，不受未登录调用的频率限制
 */
const loadVscodeLanguages = async (workDir) => {
  const gitDir = path.join(workDir, 'vscode.git');
  const git = (...args) => execFileSync('git', [`--git-dir=${gitDir}`, ...args], { encoding: 'utf8' });
  git('init', '--bare', '--quiet');
  git('fetch', '--quiet', '--depth=1', '--filter=blob:none', 'https://github.com/microsoft/vscode.git', VSCODE_SHA);
  const manifestPaths = git('ls-tree', '-r', '--name-only', VSCODE_SHA, '--', 'extensions')
    .split('\n')
    .filter((filePath) => /^extensions\/[^/]+\/package\.json$/.test(filePath))
    .sort(byCodePoint);
  const manifests = await mapWithConcurrency(manifestPaths, 6, async (manifestPath) => (await fetchOk(
    `https://raw.githubusercontent.com/microsoft/vscode/${VSCODE_SHA}/${manifestPath}`,
  )).json());

  const extensionLanguage = {};
  const fileNameLanguage = {};
  for (const manifest of manifests) {
    for (const language of manifest.contributes?.languages ?? []) {
      // VS Code 按字面后缀匹配语言扩展名，日志语言的 "*.log.?" 这类通配写法匹配不到任何真实文件，跳过
      for (const extension of language.extensions ?? []) {
        if (/[*?]/.test(extension)) continue;
        extensionLanguage[extension.toLowerCase().replace(/^\./, '')] ??= language.id;
      }
      for (const fileName of language.filenames ?? []) fileNameLanguage[fileName.toLowerCase()] ??= language.id;
    }
  }
  return { extensionLanguage, fileNameLanguage };
};

const fileIconFile = (icon, light) => `file_type_${light ? 'light_' : ''}${icon}.svg`;
const folderIconFile = (icon, light) => `folder_type_${light ? 'light_' : ''}${icon}.svg`;

/** 与 vscode-icons 生成主题的规则一致：语言已知的文件名、扩展名在前，显式声明的覆盖在后 */
const buildFileMappings = ({ fileCollection, iconsDir }, { extensionLanguage, fileNameLanguage }) => {
  const names = {};
  const extensions = {};
  const languageNames = {};
  const languageExtensions = {};
  const languageIdIcons = {};
  const lightIcons = new Set();

  const entries = fileCollection.supported
    .filter((entry) => entry.icon && !entry.disabled)
    .sort((a, b) => byCodePoint(a.icon, b.icon));
  for (const entry of entries) {
    if (!fs.existsSync(path.join(iconsDir, fileIconFile(entry.icon, false)))) throw new Error(`缺少图标 ${entry.icon}`);
    if (entry.light) {
      if (!fs.existsSync(path.join(iconsDir, fileIconFile(entry.icon, true)))) throw new Error(`缺少浅色图标 ${entry.icon}`);
      lightIcons.add(entry.icon);
    }
    const register = (key) => {
      const lower = key.toLowerCase();
      if (entry.filename) names[lower] = entry.icon;
      else extensions[lower.replace(/^\./, '')] = entry.icon;
    };
    for (const language of entry.languages ?? []) {
      for (const id of [language.ids].flat()) languageIdIcons[id] = entry.icon;
      for (const extension of language.knownExtensions ?? []) {
        languageExtensions[extension.toLowerCase().replace(/^\./, '')] = entry.icon;
      }
      for (const fileName of language.knownFilenames ?? []) languageNames[fileName.toLowerCase()] = entry.icon;
    }
    (entry.extensions ?? []).forEach(register);
    if (entry.filenamesGlob?.length && entry.extensionsGlob?.length) {
      for (const name of entry.filenamesGlob) for (const extension of entry.extensionsGlob) register(`${name}.${extension}`);
    }
  }

  const iconsByLanguage = (keyToLanguage) => Object.fromEntries(
    Object.entries(keyToLanguage)
      .filter(([, id]) => languageIdIcons[id])
      .map(([key, id]) => [key, languageIdIcons[id]]),
  );
  const fileNames = { ...languageNames, ...iconsByLanguage(fileNameLanguage), ...names };
  const fileExtensions = { ...languageExtensions, ...iconsByLanguage(extensionLanguage), ...extensions };
  const usedIcons = new Set([...Object.values(fileNames), ...Object.values(fileExtensions)]);
  return { fileNames, fileExtensions, usedIcons, lightIcons };
};

/** 文件夹按 vscode-icons 的 extensions 字段（即文件夹名）匹配，按图标名排序后写入，后写覆盖先写 */
const buildFolderMappings = ({ folderCollection, iconsDir }) => {
  const folderNames = {};
  const lightIcons = new Set();
  const entries = folderCollection.supported
    .filter((entry) => entry.icon && !entry.disabled)
    .sort((a, b) => byCodePoint(a.icon, b.icon));
  for (const entry of entries) {
    if (!fs.existsSync(path.join(iconsDir, folderIconFile(entry.icon, false)))) throw new Error(`缺少文件夹图标 ${entry.icon}`);
    if (entry.light) {
      if (!fs.existsSync(path.join(iconsDir, folderIconFile(entry.icon, true)))) throw new Error(`缺少浅色文件夹图标 ${entry.icon}`);
      lightIcons.add(entry.icon);
    }
    for (const name of entry.extensions ?? []) folderNames[name.toLowerCase()] = entry.icon;
  }
  return { folderNames, usedIcons: new Set(Object.values(folderNames)), lightIcons };
};

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-file-icons-'));
try {
  const vscodeIcons = await loadVscodeIcons(workDir);
  const files = buildFileMappings(vscodeIcons, await loadVscodeLanguages(workDir));
  const folders = buildFolderMappings(vscodeIcons);

  const copied = ['default_file.svg', 'default_folder.svg'];
  for (const icon of files.usedIcons) {
    copied.push(fileIconFile(icon, false));
    if (files.lightIcons.has(icon)) copied.push(fileIconFile(icon, true));
  }
  for (const icon of folders.usedIcons) {
    copied.push(folderIconFile(icon, false));
    if (folders.lightIcons.has(icon)) copied.push(folderIconFile(icon, true));
  }
  fs.rmSync(OUT_ICONS_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_ICONS_DIR, { recursive: true });
  for (const name of copied) fs.copyFileSync(path.join(vscodeIcons.iconsDir, name), path.join(OUT_ICONS_DIR, name));
  fs.copyFileSync(vscodeIcons.licenseFile, path.join(OUT_ICONS_DIR, 'LICENSE'));

  const fileLight = [...files.lightIcons].filter((icon) => files.usedIcons.has(icon)).sort(byCodePoint);
  const folderLight = [...folders.lightIcons].filter((icon) => folders.usedIcons.has(icon)).sort(byCodePoint);
  fs.writeFileSync(OUT_MODULE, `/**
 * 文件与文件夹图标映射，由 scripts/gen-file-icons.mjs 从 vscode-icons（MIT，https://github.com/vscode-icons/vscode-icons ，
 * 提交 ${VSCODE_ICONS_SHA}）的 src/iconsManifest 与 VS Code（提交 ${VSCODE_SHA}）内置语言扩展声明生成，请勿手工编辑。
 * 文件优先级从低到高：vscode-icons 语言已知的文件名、扩展名，VS Code 内置语言识别出的语言对应的图标，
 * vscode-icons 显式声明的文件名、扩展名；键均为小写。
 */

/** @type {Readonly<Record<string, string>>} 完整文件名（小写）到图标名；可带直接父文件夹前缀，如 .husky/pre-commit */
export const FILE_ICON_NAMES = Object.freeze(${JSON.stringify(sortedObject(files.fileNames))});

/** @type {Readonly<Record<string, string>>} 扩展名（小写、不含开头的点，可含多段如 d.ts）到图标名 */
export const FILE_ICON_EXTENSIONS = Object.freeze(${JSON.stringify(sortedObject(files.fileExtensions))});

/** @type {readonly string[]} 提供浅色主题变体（file_type_light_*.svg）的图标名 */
export const FILE_ICON_LIGHT_VARIANTS = Object.freeze(${JSON.stringify(fileLight)});

/** @type {Readonly<Record<string, string>>} 文件夹名（小写）到图标名 */
export const FOLDER_ICON_NAMES = Object.freeze(${JSON.stringify(sortedObject(folders.folderNames))});

/** @type {readonly string[]} 提供浅色主题变体（folder_type_light_*.svg）的文件夹图标名 */
export const FOLDER_ICON_LIGHT_VARIANTS = Object.freeze(${JSON.stringify(folderLight)});
`);
  console.log(`已写入 ${path.relative(process.cwd(), OUT_MODULE)}，复制 ${copied.length} 个 SVG 到 ${path.relative(process.cwd(), OUT_ICONS_DIR)}`);
} finally {
  fs.rmSync(workDir, { recursive: true, force: true });
}
