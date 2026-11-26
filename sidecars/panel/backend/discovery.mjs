import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  AppError,
  ERROR_CODES,
  runGitRead,
  splitNullTokens,
} from './git-runner.mjs';

const CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/;
const UNKNOWN_OPTION_PATTERN = /unknown option|unrecognized option/i;

function stripNonRootTrailingSlashes(normalized, platform) {
  if (platform === 'win32') {
    if (/^[A-Z]:\/+$/.test(normalized)) {
      return normalized.slice(0, 3);
    }
    if (/^\/\/[^/]+\/[^/]+\/*$/.test(normalized)) {
      return normalized.replace(/\/+$/, '');
    }
    return normalized.replace(/\/+$/, '');
  }
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
}

/**
 * 将本地文件系统路径规范化为统一斜杠格式（存在时调用 realpathSync.native，离线时非抛出兜底）。
 * Windows 下统一盘符大写并去掉非根目录末尾斜杠。
 *
 * @param {string} rawPath 原始本地路径
 * @param {{ resolveRealpath?: boolean, platform?: NodeJS.Platform }} [options] 规范化选项
 * @returns {string | null} 规范化后的路径，入参非法时返回 null
 */
export function normalizeFsPath(rawPath, options = {}) {
  if (typeof rawPath !== 'string' || rawPath.trim().length === 0 || CONTROL_CHAR_PATTERN.test(rawPath)) {
    return null;
  }

  const { resolveRealpath = true, platform = process.platform } = options;
  let candidate = rawPath;

  if (resolveRealpath) {
    try {
      candidate = fs.realpathSync.native(rawPath);
    } catch {
      candidate = rawPath;
    }
  }

  if (platform === 'win32') {
    let normalized = path.win32.normalize(candidate).replaceAll('\\', '/');
    normalized = normalized.replace(/^([a-z]):/, (_, drive) => `${drive.toUpperCase()}:`);
    return stripNonRootTrailingSlashes(normalized, platform);
  }

  const normalized = path.posix.normalize(candidate.replaceAll('\\', '/'));
  return stripNonRootTrailingSlashes(normalized, platform);
}

/**
 * 生成用于路径去重和前缀比较的规范比较键。
 * Windows 下转为正斜杠并全小写，POSIX 保持大小写敏感。
 *
 * @param {string} rawPath 原始或已规范化的本地路径
 * @param {{ resolveRealpath?: boolean, platform?: NodeJS.Platform }} [options] 规范化选项
 * @returns {string | null} 路径比较键，入参非法时返回 null
 */
export function toPathKey(rawPath, options = {}) {
  const platform = options.platform ?? process.platform;
  const normalized = normalizeFsPath(rawPath, options);
  if (!normalized) {
    return null;
  }
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/**
 * 将 `file:` URI 安全解码并规范化为本地文件系统路径；非 `file:` 协议或格式错误时返回 null。
 *
 * @param {string} uri 宿主传递的工作区 URI
 * @param {{ resolveRealpath?: boolean, platform?: NodeJS.Platform }} [options] 规范化选项
 * @returns {string | null} 规范化本地路径，无效 URI 返回 null
 */
export function normalizeWorkspaceUri(uri, options = {}) {
  if (typeof uri !== 'string' || uri.trim().length === 0) {
    return null;
  }
  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'file:') {
    return null;
  }
  let fsPath;
  try {
    fsPath = fileURLToPath(parsed);
  } catch {
    return null;
  }
  return normalizeFsPath(fsPath, options);
}

/**
 * 将本地文件系统路径编码为标准 `file://` URI 字符串（供宿主 fileView 使用）。
 *
 * @param {string} fsPath 本地文件或目录路径
 * @returns {string} 标准 `file:` URI
 */
export function toFileUri(fsPath) {
  if (typeof fsPath !== 'string' || fsPath.length === 0) {
    throw new AppError(ERROR_CODES.INVALID_REQUEST, 'Cannot convert empty path to file URI.');
  }
  return pathToFileURL(fsPath).href;
}

/**
 * 判断 `childPath` 是否等于或严格位于 `parentPath` 路径段边界内，避免 `D:/repo` 误匹配 `D:/repo-wt`。
 *
 * @param {string} parentPath 父目录路径
 * @param {string} childPath 待检查的子路径
 * @param {{ resolveRealpath?: boolean, platform?: NodeJS.Platform }} [options] 规范化选项
 * @returns {boolean} 是否命中路径段前缀归属
 */
export function isPathInside(parentPath, childPath, options = {}) {
  const parentKey = toPathKey(parentPath, options);
  const childKey = toPathKey(childPath, options);
  if (!parentKey || !childKey) {
    return false;
  }
  if (childKey === parentKey) {
    return true;
  }
  const prefix = parentKey.endsWith('/') ? parentKey : `${parentKey}/`;
  return childKey.startsWith(prefix);
}

/**
 * 为同一 Worktree 内的一批相对路径创建校验解析器，拒绝空字节、控制字符、绝对路径、`..` 与符号链接逃逸，越界时抛出 `OUT_OF_WORKTREE`。
 * 根目录的真实路径在创建时只求一次，各级目录的校验结果在解析器内缓存：Windows 上 realpath 要打开文件句柄，
 * 逐个文件求真实路径会让上千个文件的列表多花数百毫秒。缓存假设一次请求期间目录结构不变，因此每个请求各建一个解析器。
 *
 * @param {string} worktreePath Worktree 根目录路径
 * @returns {(relPath: string) => { fullPath: string, relativePath: string, fileUri: string, exists: boolean }}
 *   解析函数：返回校验后的绝对路径、POSIX 相对路径、file URI，以及目标是否存在（符号链接按指向判断，悬空链接视为不存在）
 */
export function createWorktreePathResolver(worktreePath) {
  const normalizedRoot = normalizeFsPath(worktreePath);
  if (!normalizedRoot) {
    throw new AppError(ERROR_CODES.INVALID_REQUEST, 'Invalid worktreePath.');
  }
  const rootRealPath = normalizeFsPath(normalizedRoot, { resolveRealpath: true }) ?? normalizedRoot;
  const rootKey = toPathKey(normalizedRoot, { resolveRealpath: false });
  const assertTargetInside = (targetPath, message) => {
    if (!isPathInside(rootRealPath, targetPath, { resolveRealpath: false })) {
      throw new AppError(ERROR_CODES.OUT_OF_WORKTREE, message);
    }
  };
  // 悬空符号链接按它记录的目标判断；读不出目标时无法确认没有越界，按越界处理
  const readLinkTarget = (linkPath) => {
    try {
      return path.resolve(path.dirname(linkPath), fs.readlinkSync(linkPath));
    } catch {
      throw new AppError(ERROR_CODES.OUT_OF_WORKTREE, 'Cannot read symlink target.');
    }
  };

  // 目录存在时它的真实路径须在 Worktree 内；不存在时检查悬空符号链接的目标，再逐级向上，直到根目录。
  // 只缓存已确认存在的目录：此刻不存在的目录之后可能被建成指向外部的链接
  const verifiedDirs = new Set();
  const assertDirectoryInside = (dirPath) => {
    if (verifiedDirs.has(dirPath)) {
      return;
    }
    let realDir = null;
    try {
      realDir = fs.realpathSync.native(dirPath);
    } catch {
      // 目录不存在或是悬空符号链接
    }
    if (realDir) {
      assertTargetInside(realDir, 'Path traverses through a symlink outside the active worktree.');
      verifiedDirs.add(dirPath);
      return;
    }
    let lstat = null;
    try {
      lstat = fs.lstatSync(dirPath);
    } catch {
      // 目录不存在
    }
    if (lstat?.isSymbolicLink()) {
      assertTargetInside(readLinkTarget(dirPath), 'Path traverses through a dangling symlink outside worktree.');
    } else if (toPathKey(dirPath, { resolveRealpath: false }) !== rootKey && path.dirname(dirPath) !== dirPath) {
      assertDirectoryInside(path.dirname(dirPath));
    }
  };

  return (relPath) => {
    if (typeof relPath !== 'string' || relPath.length === 0 || CONTROL_CHAR_PATTERN.test(relPath)) {
      throw new AppError(ERROR_CODES.INVALID_REQUEST, 'Relative path must be a non-empty string without control characters.');
    }

    if (
      relPath.startsWith('/') ||
      relPath.startsWith('\\') ||
      /^[A-Za-z]:/.test(relPath) ||
      path.isAbsolute(relPath) ||
      path.win32.isAbsolute(relPath) ||
      path.posix.isAbsolute(relPath)
    ) {
      throw new AppError(ERROR_CODES.OUT_OF_WORKTREE, 'Absolute paths are not allowed inside worktree scope.');
    }

    const cleanSegments = [];
    for (const segment of relPath.split(/[\\/]+/)) {
      if (segment === '' || segment === '.') {
        continue;
      }
      if (segment === '..') {
        throw new AppError(ERROR_CODES.OUT_OF_WORKTREE, 'Path traversal ("..") outside worktree is forbidden.');
      }
      cleanSegments.push(segment);
    }
    if (cleanSegments.length === 0) {
      throw new AppError(ERROR_CODES.INVALID_REQUEST, 'Relative file path must target a file inside the worktree.');
    }

    const relativePath = cleanSegments.join('/');
    const candidatePath = path.join(normalizedRoot, ...cleanSegments);
    if (!isPathInside(normalizedRoot, candidatePath, { resolveRealpath: false })) {
      throw new AppError(ERROR_CODES.OUT_OF_WORKTREE, 'Resolved path escapes worktree boundary.');
    }

    // lstat 不打开文件句柄，比 realpath 快一两个数量级；只有目标本身是符号链接时才求它指向的真实路径
    let stat = null;
    try {
      stat = fs.lstatSync(candidatePath);
    } catch {
      // 文件不存在
    }
    let exists = stat !== null;
    if (stat?.isSymbolicLink()) {
      let targetReal = null;
      try {
        targetReal = fs.realpathSync.native(candidatePath);
      } catch {
        // 悬空符号链接
      }
      assertTargetInside(targetReal ?? readLinkTarget(candidatePath), 'Target symlink resolves outside the active worktree.');
      exists = targetReal !== null;
    }
    assertDirectoryInside(path.dirname(candidatePath));

    const normalizedFullPath = normalizeFsPath(candidatePath, { resolveRealpath: false }) ?? candidatePath;
    return {
      fullPath: normalizedFullPath,
      relativePath,
      fileUri: toFileUri(normalizedFullPath),
      exists,
    };
  };
}

/**
 * 解析 `git worktree list --porcelain -z` 的原始 NUL 分隔字节流。
 *
 * @param {Buffer | Uint8Array | string} buffer Git 命令原始 stdout 输出
 * @returns {Array<{ path: string, pathKey: string | null, head: string | null, branch: string | null, branchRef: string | null, isBare: boolean, isDetached: boolean, isLocked: boolean, lockReason: string | null, isPrunable: boolean, pruneReason: string | null }>} 解析后的 Worktree 条目列表
 */
export function parseWorktreeListPorcelainZ(buffer) {
  const tokens = splitNullTokens(buffer);
  const worktrees = [];
  let current = null;

  const commitCurrent = () => {
    if (current) {
      worktrees.push(current);
      current = null;
    }
  };

  for (const token of tokens) {
    if (token === '') {
      commitCurrent();
      continue;
    }
    if (token.startsWith('worktree ')) {
      commitCurrent();
      const rawPath = token.slice('worktree '.length);
      const normalized = normalizeFsPath(rawPath) ?? rawPath;
      current = {
        path: normalized,
        pathKey: toPathKey(normalized),
        head: null,
        branch: null,
        branchRef: null,
        isBare: false,
        isDetached: false,
        isLocked: false,
        lockReason: null,
        isPrunable: false,
        pruneReason: null,
      };
      continue;
    }
    if (!current) {
      continue;
    }
    if (token.startsWith('HEAD ')) {
      current.head = token.slice('HEAD '.length).trim() || null;
    } else if (token.startsWith('branch ')) {
      const ref = token.slice('branch '.length).trim();
      current.branchRef = ref || null;
      current.branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref || null;
    } else if (token === 'bare') {
      current.isBare = true;
    } else if (token === 'detached') {
      current.isDetached = true;
    } else if (token === 'locked') {
      current.isLocked = true;
    } else if (token.startsWith('locked ')) {
      current.isLocked = true;
      current.lockReason = token.slice('locked '.length) || null;
    } else if (token === 'prunable') {
      current.isPrunable = true;
    } else if (token.startsWith('prunable ')) {
      current.isPrunable = true;
      current.pruneReason = token.slice('prunable '.length) || null;
    }
  }

  commitCurrent();
  return worktrees;
}

function resolveMaybeRelative(baseDir, targetPath) {
  if (path.isAbsolute(targetPath) || path.win32.isAbsolute(targetPath)) {
    return targetPath;
  }
  return path.resolve(baseDir, targetPath);
}

async function runRevParseWithVersionFallback(wsPath, argsWithPathFormat, argsFallback, runReadFn, timeoutMs) {
  const firstResult = await runReadFn(argsWithPathFormat, {
    cwd: wsPath,
    allowNonZero: true,
    timeoutMs,
  });
  if (firstResult.exitCode === 0) {
    return { result: firstResult, usedFallback: false };
  }
  if (UNKNOWN_OPTION_PATTERN.test(firstResult.stderrText)) {
    const fallbackResult = await runReadFn(argsFallback, {
      cwd: wsPath,
      allowNonZero: true,
      timeoutMs,
    });
    return { result: fallbackResult, usedFallback: true };
  }
  return { result: firstResult, usedFallback: false };
}

/**
 * 执行第一阶段 `git rev-parse` 探测，绝不混入 `--show-toplevel`，并兼容 Git `<2.31` 缺少 `--path-format=absolute`。
 *
 * @param {string} wsPath 规范化后的本地工作区目录
 * @param {{ runGitRead?: typeof runGitRead, timeoutMs?: number }} [options] 执行选项
 * @returns {Promise<{ wsPath: string, wsKey: string, gitCommonDir: string, gitCommonDirKey: string, gitDir: string, isInsideWorkTree: boolean, isBareRepository: boolean } | null>} 探测结果，非 Git 目录返回 null
 */
export async function probeWorkspaceGitRoot(wsPath, options = {}) {
  const runReadFn = options.runGitRead ?? runGitRead;
  const timeoutMs = options.timeoutMs;
  const baseFlags = ['--git-common-dir', '--git-dir', '--is-inside-work-tree', '--is-bare-repository'];

  const { result } = await runRevParseWithVersionFallback(
    wsPath,
    ['rev-parse', '--path-format=absolute', ...baseFlags],
    ['rev-parse', ...baseFlags],
    runReadFn,
    timeoutMs
  );

  if (result.exitCode !== 0) {
    return null;
  }

  const lines = result.stdoutText.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length < 4) {
    return null;
  }

  const rawCommonDir = resolveMaybeRelative(wsPath, lines[0].trim());
  const rawGitDir = resolveMaybeRelative(wsPath, lines[1].trim());
  const gitCommonDir = normalizeFsPath(rawCommonDir);
  const gitDir = normalizeFsPath(rawGitDir);
  const gitCommonDirKey = toPathKey(gitCommonDir);
  const wsKey = toPathKey(wsPath);

  if (!gitCommonDir || !gitCommonDirKey || !gitDir || !wsKey) {
    return null;
  }

  return {
    wsPath,
    wsKey,
    gitCommonDir,
    gitCommonDirKey,
    gitDir,
    isInsideWorkTree: lines[2].trim() === 'true',
    isBareRepository: lines[3].trim() === 'true',
  };
}

async function resolveShowToplevelFallback(wsPath, runReadFn, timeoutMs) {
  const { result } = await runRevParseWithVersionFallback(
    wsPath,
    ['rev-parse', '--path-format=absolute', '--show-toplevel'],
    ['rev-parse', '--show-toplevel'],
    runReadFn,
    timeoutMs
  );
  if (result.exitCode !== 0) {
    return null;
  }
  const line = result.stdoutText.split(/\r?\n/).find((item) => item.trim().length > 0);
  if (!line) {
    return null;
  }
  return normalizeFsPath(resolveMaybeRelative(wsPath, line.trim()));
}

function selectLongestMatchingWorktree(wsPath, nonBareWorktrees) {
  let best = null;
  for (const worktree of nonBareWorktrees) {
    if (!worktree.pathKey) {
      continue;
    }
    if (isPathInside(worktree.path, wsPath, { resolveRealpath: false })) {
      if (!best || worktree.pathKey.length > best.pathKey.length) {
        best = worktree;
      }
    }
  }
  return best;
}

function extractRepoDisplayName(targetPath) {
  const baseName = path.posix.basename(targetPath);
  return baseName || targetPath;
}

function isExistingDirectory(fsPath) {
  try {
    return fs.statSync(fsPath).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 对宿主传入的 `workspaceUris` 执行两阶段 Repository 发现、按 `gitCommonDir` 去重归并，并匹配当前活跃 Worktree。
 * 忽略非 `file:` URI、非 Git 目录及未显式打开的嵌套 Submodule。
 *
 * @param {string[]} workspaceUris 宿主当前对话打开的工作区 URI 列表
 * @param {{ runGitRead?: typeof runGitRead, timeoutMs?: number }} [options] 执行与测试注入选项
 * @returns {Promise<Array<{ id: string, name: string, gitCommonDir: string, gitDir: string, worktreePath: string | null, isBare: boolean, branch: string | null, headOid: string | null, isDetached: boolean }>>} 发现并归并后的 Repository 列表
 */
export async function discoverRepositories(workspaceUris, options = {}) {
  if (!Array.isArray(workspaceUris) || workspaceUris.length === 0) {
    return [];
  }

  const runReadFn = options.runGitRead ?? runGitRead;
  const timeoutMs = options.timeoutMs;
  const repoGroups = new Map();

  for (const uri of workspaceUris) {
    const wsPath = normalizeWorkspaceUri(uri);
    if (!wsPath || !isExistingDirectory(wsPath)) {
      continue;
    }
    const probe = await probeWorkspaceGitRoot(wsPath, { runGitRead: runReadFn, timeoutMs });
    if (!probe) {
      continue;
    }
    let group = repoGroups.get(probe.gitCommonDirKey);
    if (!group) {
      group = {
        id: probe.gitCommonDirKey,
        gitCommonDir: probe.gitCommonDir,
        hits: [],
      };
      repoGroups.set(probe.gitCommonDirKey, group);
    }
    group.hits.push(probe);
  }

  const repositories = [];
  for (const group of repoGroups.values()) {
    const firstHit = group.hits[0];
    const worktreeResult = await runReadFn(['worktree', 'list', '--porcelain', '-z'], {
      cwd: firstHit.wsPath,
      allowNonZero: true,
      timeoutMs,
    });
    const worktrees = worktreeResult.exitCode === 0
      ? parseWorktreeListPorcelainZ(worktreeResult.stdout)
      : [];
    const nonBareWorktrees = worktrees.filter((item) => !item.isBare);

    let winningHit = null;
    let matchedWorktree = null;
    for (const hit of group.hits) {
      const candidate = selectLongestMatchingWorktree(hit.wsPath, nonBareWorktrees);
      if (candidate) {
        winningHit = hit;
        matchedWorktree = candidate;
        break;
      }
    }

    // Submodule 的 worktree list 指向 .git/modules/<name>，仅当 Workspace 根确实位于工作树内时于第二阶段补测 --show-toplevel
    if (!matchedWorktree) {
      for (const hit of group.hits) {
        if (!hit.isInsideWorkTree) {
          continue;
        }
        const toplevel = await resolveShowToplevelFallback(hit.wsPath, runReadFn, timeoutMs);
        if (toplevel && isPathInside(toplevel, hit.wsPath, { resolveRealpath: false })) {
          const fallbackMeta = worktrees[0] ?? null;
          winningHit = hit;
          matchedWorktree = {
            path: toplevel,
            pathKey: toPathKey(toplevel),
            head: fallbackMeta?.head ?? null,
            branch: fallbackMeta?.branch ?? null,
            isDetached: fallbackMeta?.isDetached ?? false,
          };
          break;
        }
      }
    }

    if (matchedWorktree && winningHit) {
      repositories.push({
        id: group.id,
        name: extractRepoDisplayName(matchedWorktree.path),
        gitCommonDir: group.gitCommonDir,
        gitDir: winningHit.gitDir,
        worktreePath: matchedWorktree.path,
        isBare: false,
        branch: matchedWorktree.isDetached ? null : matchedWorktree.branch,
        headOid: matchedWorktree.head,
        isDetached: matchedWorktree.isDetached,
      });
      continue;
    }

    const bareHit = group.hits.find((hit) => hit.isBareRepository);
    if (bareHit) {
      repositories.push({
        id: group.id,
        name: extractRepoDisplayName(group.gitCommonDir),
        gitCommonDir: group.gitCommonDir,
        gitDir: bareHit.gitDir,
        worktreePath: null,
        isBare: true,
        branch: null,
        headOid: null,
        isDetached: false,
      });
    }
  }

  return repositories;
}
