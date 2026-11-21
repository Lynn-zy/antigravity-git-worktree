import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AppError, ERROR_CODES } from './git-runner.mjs';

export const ALLOWED_LOCALES = Object.freeze(['auto', 'zh-CN', 'en']);
export const ALLOWED_GRAPH_SCOPES = Object.freeze(['auto', 'all']);
export const MIN_SPLIT_RATIO = 0.15;
export const MAX_SPLIT_RATIO = 0.85;

export const DEFAULT_PREFERENCES = Object.freeze({
  locale: 'auto',
  graphScope: 'auto',
  splitRatio: 0.42,
});

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 解析当前运行模式下的偏好持久化文件路径。
 * 优先使用显式传入路径；其次读取宿主注入的 `ANTIGRAVITY_EXECUTABLE_DATA_DIR/prefs.json`；
 * Standalone 模式下默认写入 `os.tmpdir()/antigravity-git-worktree-prefs.json`。
 *
 * @param {string | null | undefined} [customPath] 显式覆写路径（供测试注入）
 * @returns {string} 偏好 JSON 文件绝对路径
 */
export function resolvePreferencesPath(customPath) {
  if (typeof customPath === 'string' && customPath.trim().length > 0) {
    return path.resolve(customPath);
  }
  const executableDataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (typeof executableDataDir === 'string' && executableDataDir.trim().length > 0) {
    return path.join(executableDataDir, 'prefs.json');
  }
  return path.join(os.tmpdir(), 'antigravity-git-worktree-prefs.json');
}

/**
 * 按严格白名单校验并规范化偏好更新字段。
 * `locale` 限 `auto|zh-CN|en`、`graphScope` 限 `auto|all`、`splitRatio` 校验为有限数并钳制在 `0.15–0.85`。
 *
 * @param {unknown} rawPatch 客户端提交的偏好部分或完整字段对象
 * @returns {{ locale?: 'auto' | 'zh-CN' | 'en', graphScope?: 'auto' | 'all', splitRatio?: number }} 校验通过的规范化增量对象
 */
export function validatePreferencesPatch(rawPatch) {
  if (!isPlainObject(rawPatch)) {
    throw new AppError(ERROR_CODES.INVALID_REQUEST, 'Preferences payload must be a JSON object.');
  }

  const patch = {};

  if (rawPatch.locale !== undefined) {
    if (typeof rawPatch.locale !== 'string' || !ALLOWED_LOCALES.includes(rawPatch.locale)) {
      throw new AppError(
        ERROR_CODES.INVALID_REQUEST,
        `Invalid locale "${String(rawPatch.locale)}". Allowed: ${ALLOWED_LOCALES.join(', ')}.`,
      );
    }
    patch.locale = rawPatch.locale;
  }

  if (rawPatch.graphScope !== undefined) {
    if (typeof rawPatch.graphScope !== 'string' || !ALLOWED_GRAPH_SCOPES.includes(rawPatch.graphScope)) {
      throw new AppError(
        ERROR_CODES.INVALID_REQUEST,
        `Invalid graphScope "${String(rawPatch.graphScope)}". Allowed: ${ALLOWED_GRAPH_SCOPES.join(', ')}.`,
      );
    }
    patch.graphScope = rawPatch.graphScope;
  }

  if (rawPatch.splitRatio !== undefined) {
    if (typeof rawPatch.splitRatio !== 'number' || !Number.isFinite(rawPatch.splitRatio)) {
      throw new AppError(ERROR_CODES.INVALID_REQUEST, 'splitRatio must be a finite number.');
    }
    const clamped = Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, rawPatch.splitRatio));
    patch.splitRatio = Number(clamped.toFixed(4));
  }

  return patch;
}

function sanitizeStoredPreferences(rawStored) {
  const result = { ...DEFAULT_PREFERENCES };
  if (!isPlainObject(rawStored)) {
    return result;
  }
  if (typeof rawStored.locale === 'string' && ALLOWED_LOCALES.includes(rawStored.locale)) {
    result.locale = rawStored.locale;
  }
  if (typeof rawStored.graphScope === 'string' && ALLOWED_GRAPH_SCOPES.includes(rawStored.graphScope)) {
    result.graphScope = rawStored.graphScope;
  }
  if (typeof rawStored.splitRatio === 'number' && Number.isFinite(rawStored.splitRatio)) {
    const clamped = Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, rawStored.splitRatio));
    result.splitRatio = Number(clamped.toFixed(4));
  }
  return result;
}

async function atomicWriteJson(filePath, payload) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tempName = `${path.basename(filePath)}.tmp.${process.pid}.${randomBytes(6).toString('hex')}`;
  const tempPath = path.join(dir, tempName);
  const content = `${JSON.stringify(payload, null, 2)}\n`;

  try {
    await fs.writeFile(tempPath, content, 'utf8');
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * 创建带原子写入与内存串行队列的轻量用户偏好存储控制器。
 *
 * @param {{ filePath?: string }} [options] 可选自定义存储路径（用于测试隔离）
 * @returns {{
 *   filePath: string,
 *   load: () => Promise<{ locale: 'auto' | 'zh-CN' | 'en', graphScope: 'auto' | 'all', splitRatio: number }>,
 *   update: (rawPatch: unknown) => Promise<{ locale: 'auto' | 'zh-CN' | 'en', graphScope: 'auto' | 'all', splitRatio: number }>
 * }} 偏好读写控制器
 */
export function createPreferencesStore(options = {}) {
  const filePath = resolvePreferencesPath(options.filePath);
  let writeChain = Promise.resolve();

  const readFromDisk = async () => {
    try {
      const rawText = await fs.readFile(filePath, 'utf8');
      const parsed = JSON.parse(rawText);
      return sanitizeStoredPreferences(parsed);
    } catch {
      return { ...DEFAULT_PREFERENCES };
    }
  };

  const load = () => writeChain.then(() => readFromDisk());

  const update = async (rawPatch) => {
    const patch = validatePreferencesPatch(rawPatch);
    const task = writeChain.then(async () => {
      const current = await readFromDisk();
      const next = {
        ...current,
        ...patch,
      };
      await atomicWriteJson(filePath, next);
      return next;
    });
    // 单次更新失败不能阻断后续偏好读写链路
    writeChain = task.catch(() => {});
    return task;
  };

  return {
    filePath,
    load,
    update,
  };
}
