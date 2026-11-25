/**
 * 文件与文件夹图标（vscode-icons）解析模块。
 * 文件的匹配顺序与 VS Code 文件图标主题一致：带直接父文件夹的文件名（如 `.husky/pre-commit`）优先，
 * 其次完整文件名，再次从最长到最短的多段扩展名，最后回退默认文件图标；
 * 文件夹按文件夹名匹配，未命中时回退默认文件夹图标。
 */

import {
  FILE_ICON_NAMES,
  FILE_ICON_EXTENSIONS,
  FILE_ICON_LIGHT_VARIANTS,
  FOLDER_ICON_NAMES,
  FOLDER_ICON_LIGHT_VARIANTS,
} from './file-icon-map.js';

/** @type {string} 图标静态资源的 URL 路径前缀（与后端 `/file-icons/*.svg` 路由对应） */
const FILE_ICON_URL_PREFIX = '/file-icons/';

// 用 Map 查找，避免文件名恰好是 constructor、toString 等时命中 Object 原型属性
const iconByName = new Map(Object.entries(FILE_ICON_NAMES));
const iconByExtension = new Map(Object.entries(FILE_ICON_EXTENSIONS));
const lightVariants = new Set(FILE_ICON_LIGHT_VARIANTS);
const folderIconByName = new Map(Object.entries(FOLDER_ICON_NAMES));
const folderLightVariants = new Set(FOLDER_ICON_LIGHT_VARIANTS);

/**
 * 解析变更路径对应的图标资源 URL。
 *
 * @param {string} filePath 仓库内相对路径（`/` 分隔）；以 `/` 结尾表示文件夹（git status 对整个未跟踪目录的写法）
 * @param {'dark' | 'light'} themeMode 当前明暗主题，浅色主题下优先使用图标的浅色变体
 * @returns {string} 图标资源 URL 路径，如 `/file-icons/file_type_js.svg`（无副作用）
 */
export const resolveFileIconUrl = (filePath, themeMode) => {
  const isFolder = filePath.endsWith('/');
  const pathSegments = (isFolder ? filePath.slice(0, -1) : filePath).toLowerCase().split('/');
  const baseName = pathSegments.pop();
  const parentName = pathSegments.pop();
  const isLight = themeMode === 'light';

  if (isFolder) {
    const folderIcon = folderIconByName.get(baseName);
    if (!folderIcon) return `${FILE_ICON_URL_PREFIX}default_folder.svg`;
    const variant = isLight && folderLightVariants.has(folderIcon) ? 'light_' : '';
    return `${FILE_ICON_URL_PREFIX}folder_type_${variant}${folderIcon}.svg`;
  }

  let icon = (parentName && iconByName.get(`${parentName}/${baseName}`)) || iconByName.get(baseName);
  for (let dot = baseName.indexOf('.'); !icon && dot !== -1; dot = baseName.indexOf('.', dot + 1)) {
    icon = iconByExtension.get(baseName.slice(dot + 1));
  }
  if (!icon) return `${FILE_ICON_URL_PREFIX}default_file.svg`;
  const variant = isLight && lightVariants.has(icon) ? 'light_' : '';
  return `${FILE_ICON_URL_PREFIX}file_type_${variant}${icon}.svg`;
};
