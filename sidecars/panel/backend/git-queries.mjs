import { createHash } from 'node:crypto';
import fs from 'node:fs';
import {
  discoverRepositories,
  parseWorktreeListPorcelainZ,
  resolvePathInsideWorktree,
  toPathKey,
} from './discovery.mjs';
import {
  AppError,
  ERROR_CODES,
  buildGitArgs,
  runGitRead,
  splitNullTokens,
} from './git-runner.mjs';

export { parseWorktreeListPorcelainZ };

export const MAX_STATUS_ENTRIES = 2000;
export const DEFAULT_GRAPH_LIMIT = 150;
export const MAX_GRAPH_LIMIT = 2000;

const LOG_FORMAT = '%H%x1f%P%x1f%D%x1f%an%x1f%ae%x1f%at%x1f%s';
const SHA_PATTERN = /^[0-9a-f]{7,64}$/i;
const CO_AUTHOR_PATTERN = /^co-authored-by:\s*(.+?)\s*<([^<>]+)>\s*$/i;
const TRAILER_PATTERN = /^[A-Za-z][A-Za-z0-9-]+:\s+\S/;
const REF_TYPE_PRIORITY = Object.freeze({
  head: 0,
  branch: 1,
  remote: 2,
  tag: 3,
  other: 4,
});

function splitAfterSpaces(token, fieldCount) {
  const fields = [];
  let start = 0;
  for (let i = 0; i < fieldCount; i += 1) {
    const spaceIndex = token.indexOf(' ', start);
    if (spaceIndex === -1) {
      return null;
    }
    fields.push(token.slice(start, spaceIndex));
    start = spaceIndex + 1;
  }
  return { fields, tail: token.slice(start) };
}

function resolveChangeFileUri(worktreePath, relPath) {
  if (!worktreePath) {
    return null;
  }
  try {
    return resolvePathInsideWorktree(worktreePath, relPath).fileUri;
  } catch {
    return null;
  }
}

/**
 * 解析 `git status --porcelain=v2 --branch --show-stash -z` 的原始 NUL 分隔字节流。
 * 严格按重命名条目 `2` 为 `newPath` 在前、`origPath` 在后消费双 token，并将 `MM` 同时归入 `staged` 与 `unstaged`。
 *
 * @param {Buffer | Uint8Array | string} buffer Git status 原始 stdout 输出
 * @param {{ maxEntries?: number, worktreePath?: string | null }} [options] 解析上限与 fileUri 生成根路径
 * @returns {{ branchInfo: { headOid: string | null, branch: string | null, upstream: string | null, ahead: number, behind: number, isUnborn: boolean, isDetached: boolean, stashCount: number }, changes: { conflicted: Array<{ path: string, origPath: null, status: string, fileUri: string | null }>, staged: Array<{ path: string, origPath: string | null, status: string, fileUri: string | null }>, unstaged: Array<{ path: string, origPath: null, status: string, untracked: boolean, fileUri: string | null }>, totalEntries: number, truncated: boolean } }} 分支信息与变更列表
 */
export function parseStatusPorcelainV2Z(buffer, options = {}) {
  const {
    maxEntries = MAX_STATUS_ENTRIES,
    worktreePath = null,
  } = options;

  const tokens = splitNullTokens(buffer);
  const branchInfo = {
    headOid: null,
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    isUnborn: false,
    isDetached: false,
    stashCount: 0,
  };

  const conflicted = [];
  const staged = [];
  const unstaged = [];
  let totalEntries = 0;
  let truncated = false;

  const appendItem = (target, item) => {
    totalEntries += 1;
    if (totalEntries <= maxEntries) {
      target.push(item);
    } else {
      truncated = true;
    }
  };

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token) {
      continue;
    }

    if (token.startsWith('# ')) {
      if (token.startsWith('# branch.oid ')) {
        const oid = token.slice('# branch.oid '.length).trim();
        if (oid === '(initial)') {
          branchInfo.isUnborn = true;
          branchInfo.headOid = null;
        } else {
          branchInfo.isUnborn = false;
          branchInfo.headOid = oid || null;
        }
      } else if (token.startsWith('# branch.head ')) {
        const head = token.slice('# branch.head '.length).trim();
        if (head === '(detached)') {
          branchInfo.isDetached = true;
          branchInfo.branch = null;
        } else {
          branchInfo.isDetached = false;
          branchInfo.branch = head || null;
        }
      } else if (token.startsWith('# branch.upstream ')) {
        branchInfo.upstream = token.slice('# branch.upstream '.length).trim() || null;
      } else if (token.startsWith('# branch.ab ')) {
        const match = token.slice('# branch.ab '.length).match(/^\+(\d+)\s+-(\d+)/);
        if (match) {
          branchInfo.ahead = Number.parseInt(match[1], 10);
          branchInfo.behind = Number.parseInt(match[2], 10);
        }
      } else if (token.startsWith('# stash ')) {
        branchInfo.stashCount = Number.parseInt(token.slice('# stash '.length), 10) || 0;
      }
      continue;
    }

    if (token.startsWith('1 ')) {
      const parsed = splitAfterSpaces(token, 8);
      if (!parsed || parsed.fields[1].length < 2) {
        continue;
      }
      const [indexStatus, worktreeStatus] = parsed.fields[1];
      const filePath = parsed.tail;
      const fileUri = resolveChangeFileUri(worktreePath, filePath);
      if (indexStatus !== '.') {
        appendItem(staged, { path: filePath, origPath: null, status: indexStatus, fileUri });
      }
      if (worktreeStatus !== '.') {
        appendItem(unstaged, { path: filePath, origPath: null, status: worktreeStatus, untracked: false, fileUri });
      }
      continue;
    }

    if (token.startsWith('2 ')) {
      const parsed = splitAfterSpaces(token, 9);
      const origPath = tokens[i + 1] ?? null;
      i += 1;
      if (!parsed || parsed.fields[1].length < 2) {
        continue;
      }
      const [indexStatus, worktreeStatus] = parsed.fields[1];
      const newPath = parsed.tail;
      const fileUri = resolveChangeFileUri(worktreePath, newPath);
      if (indexStatus !== '.') {
        appendItem(staged, { path: newPath, origPath, status: indexStatus, fileUri });
      }
      if (worktreeStatus !== '.') {
        appendItem(unstaged, { path: newPath, origPath: null, status: worktreeStatus, untracked: false, fileUri });
      }
      continue;
    }

    if (token.startsWith('u ')) {
      const parsed = splitAfterSpaces(token, 10);
      if (!parsed) {
        continue;
      }
      const filePath = parsed.tail;
      appendItem(conflicted, {
        path: filePath,
        origPath: null,
        status: parsed.fields[1],
        fileUri: resolveChangeFileUri(worktreePath, filePath),
      });
      continue;
    }

    if (token.startsWith('? ')) {
      const filePath = token.slice(2);
      appendItem(unstaged, {
        path: filePath,
        origPath: null,
        status: 'U',
        untracked: true,
        fileUri: resolveChangeFileUri(worktreePath, filePath),
      });
    }
  }

  return {
    branchInfo,
    changes: {
      conflicted,
      staged,
      unstaged,
      totalEntries,
      truncated,
    },
  };
}

function parseSingleDecorateRef(rawToken) {
  const part = rawToken.trim();
  if (!part) {
    return null;
  }
  if (part === 'HEAD') {
    return { type: 'head', name: 'HEAD', fullRef: 'HEAD' };
  }
  if (part.startsWith('HEAD -> ')) {
    const fullRef = part.slice('HEAD -> '.length).trim();
    const name = fullRef.startsWith('refs/heads/') ? fullRef.slice('refs/heads/'.length) : fullRef;
    return { type: 'head', name, fullRef };
  }
  if (part.startsWith('tag: ')) {
    const fullRef = part.slice('tag: '.length).trim();
    const name = fullRef.startsWith('refs/tags/') ? fullRef.slice('refs/tags/'.length) : fullRef;
    return { type: 'tag', name, fullRef };
  }
  if (part.startsWith('refs/heads/')) {
    return { type: 'branch', name: part.slice('refs/heads/'.length), fullRef: part };
  }
  if (part.startsWith('refs/remotes/')) {
    return { type: 'remote', name: part.slice('refs/remotes/'.length), fullRef: part };
  }
  if (part.startsWith('refs/tags/')) {
    return { type: 'tag', name: part.slice('refs/tags/'.length), fullRef: part };
  }
  return { type: 'other', name: part, fullRef: part };
}

function parseDecorateRefs(decorateRaw) {
  if (!decorateRaw || !decorateRaw.trim()) {
    return [];
  }
  const refs = [];
  for (const part of decorateRaw.split(', ')) {
    const parsed = parseSingleDecorateRef(part);
    if (parsed) {
      refs.push(parsed);
    }
  }
  refs.sort((a, b) => (REF_TYPE_PRIORITY[a.type] ?? 4) - (REF_TYPE_PRIORITY[b.type] ?? 4));
  return refs;
}

/**
 * 解析 `git log ... --format=%H%x1f%P%x1f%D%x1f%an%x1f%ae%x1f%at%x1f%s -z` 的原始 NUL 分隔字节流。
 *
 * @param {Buffer | Uint8Array | string} buffer Git log 原始 stdout 输出
 * @returns {Array<{ sha: string, shortSha: string, parents: string[], refs: Array<{ type: string, name: string, fullRef: string }>, authorName: string, authorEmail: string, timestamp: number, subject: string }>} 解析后的提交记录数组
 */
export function parseLogRecordsZ(buffer) {
  const tokens = splitNullTokens(buffer);
  const commits = [];

  for (const token of tokens) {
    if (!token) {
      continue;
    }
    const fields = token.split('\x1f');
    if (fields.length < 7) {
      continue;
    }
    const sha = fields[0].trim();
    if (!sha) {
      continue;
    }
    const parentsRaw = fields[1];
    const decorateRaw = fields[2];
    const authorName = fields[3];
    const authorEmail = fields[4];
    const timestamp = Number.parseInt(fields[5], 10) || 0;
    const subject = fields.length > 7 ? fields.slice(6).join('\x1f') : fields[6];

    commits.push({
      sha,
      shortSha: sha.slice(0, 7),
      parents: parentsRaw ? parentsRaw.split(' ').filter(Boolean) : [],
      refs: parseDecorateRefs(decorateRaw),
      authorName,
      authorEmail,
      timestamp,
      subject,
    });
  }

  return commits;
}

/**
 * 解析 `git show -s --format=%B` 原始提交说明，拆分标题、正文与末尾 `Co-authored-by` 列表。
 *
 * @param {Buffer | Uint8Array | string} bufferOrText 原始提交消息输出
 * @returns {{ subject: string, body: string, coAuthors: Array<{ name: string, email: string }> }} 提交主题、正文及共同作者
 */
export function parseCommitMessageB(bufferOrText) {
  const rawText = Buffer.isBuffer(bufferOrText)
    ? bufferOrText.toString('utf8')
    : bufferOrText instanceof Uint8Array
      ? Buffer.from(bufferOrText.buffer, bufferOrText.byteOffset, bufferOrText.byteLength).toString('utf8')
      : String(bufferOrText ?? '');

  const lines = rawText.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n');
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }
  if (lines.length === 0) {
    return { subject: '', body: '', coAuthors: [] };
  }

  const subject = lines[0];
  const restLines = lines.slice(1);
  const coAuthorsReversed = [];
  const keptLinesReversed = [];
  let inTrailingSection = true;

  for (let i = restLines.length - 1; i >= 0; i -= 1) {
    const line = restLines[i];
    if (inTrailingSection) {
      const coAuthorMatch = line.match(CO_AUTHOR_PATTERN);
      if (coAuthorMatch) {
        coAuthorsReversed.push({
          name: coAuthorMatch[1].trim(),
          email: coAuthorMatch[2].trim(),
        });
        continue;
      }
      if (line.trim() === '' || TRAILER_PATTERN.test(line)) {
        keptLinesReversed.push(line);
        continue;
      }
      inTrailingSection = false;
    }
    keptLinesReversed.push(line);
  }

  const bodyLines = keptLinesReversed.reverse();
  while (bodyLines.length > 0 && bodyLines[0].trim() === '') {
    bodyLines.shift();
  }
  while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1].trim() === '') {
    bodyLines.pop();
  }

  return {
    subject,
    body: bodyLines.join('\n'),
    coAuthors: coAuthorsReversed.reverse(),
  };
}

/**
 * 解析 `git show --name-status -M -m --first-parent --format= -z` 的原始 NUL 分隔输出。
 * 与 `status -z` 不同，此处的 `R*`/`C*` 重命名复制项为 `origPath` 在前、`newPath` 在后。
 *
 * @param {Buffer | Uint8Array | string} buffer Git show name-status 原始输出
 * @returns {Array<{ status: string, path: string, origPath: string | null }>} 变更文件数组
 */
export function parseCommitNameStatusZ(buffer) {
  const tokens = splitNullTokens(buffer);
  const files = [];

  for (let i = 0; i < tokens.length; ) {
    const statusToken = tokens[i];
    if (!statusToken) {
      i += 1;
      continue;
    }
    const statusCode = statusToken[0];
    if (statusCode === 'R' || statusCode === 'C') {
      const origPath = tokens[i + 1] ?? null;
      const newPath = tokens[i + 2] ?? '';
      i += 3;
      if (newPath) {
        files.push({ status: statusCode, path: newPath, origPath });
      }
      continue;
    }

    const filePath = tokens[i + 1] ?? '';
    i += 2;
    if (filePath) {
      files.push({ status: statusCode, path: filePath, origPath: null });
    }
  }

  return files;
}

/**
 * 查询指定 Worktree 的当前工作区变更列表与分支上下游状态。
 *
 * @param {string} worktreePath Worktree 根目录路径
 * @param {{ maxEntries?: number, timeoutMs?: number, runGitRead?: typeof runGitRead }} [options] 查询选项
 * @returns {Promise<{ branchInfo: object, changes: object }>} 分支元数据与 Working Tree Changes
 */
export async function queryWorktreeStatus(worktreePath, options = {}) {
  const runReadFn = options.runGitRead ?? runGitRead;
  const args = buildGitArgs('status', {
    flags: ['--porcelain=v2', '--branch', '--show-stash', '-z'],
  });
  const result = await runReadFn(args, {
    cwd: worktreePath,
    timeoutMs: options.timeoutMs,
  });
  return parseStatusPorcelainV2Z(result.stdout, {
    maxEntries: options.maxEntries ?? MAX_STATUS_ENTRIES,
    worktreePath,
  });
}

function normalizeGraphOptions(options = {}) {
  const scope = options.scope ?? 'auto';
  if (scope !== 'auto' && scope !== 'all') {
    throw new AppError(ERROR_CODES.INVALID_REQUEST, `Invalid graph scope: ${scope}`);
  }
  const rawLimit = options.limit ?? DEFAULT_GRAPH_LIMIT;
  if (typeof rawLimit !== 'number' || !Number.isFinite(rawLimit) || rawLimit < 1) {
    throw new AppError(ERROR_CODES.INVALID_REQUEST, `Invalid graph limit: ${rawLimit}`);
  }
  const limit = Math.min(Math.trunc(rawLimit), MAX_GRAPH_LIMIT);
  return { scope, limit };
}

/**
 * 查询 Repository 的 Commit Graph 分页列表（多拉 1 条判断 hasMore，limit >= 2000 标记 reachedSoftLimit）。
 * 对 0 提交 unborn 仓库安全返回空列表而不报错。
 *
 * @param {string} repoPath Repository 或 Worktree 目录路径
 * @param {{ scope?: 'auto' | 'all', limit?: number, isUnborn?: boolean, upstream?: string | null, timeoutMs?: number, runGitRead?: typeof runGitRead }} [options] 图谱查询参数
 * @returns {Promise<{ scope: 'auto' | 'all', limit: number, hasMore: boolean, reachedSoftLimit: boolean, commits: Array<object> }>} Commit Graph 分页结果
 */
export async function queryCommitGraph(repoPath, options = {}) {
  const { scope, limit } = normalizeGraphOptions(options);
  const isUnborn = Boolean(options.isUnborn);
  const upstream = options.upstream ?? null;
  const runReadFn = options.runGitRead ?? runGitRead;

  if (scope === 'auto' && isUnborn) {
    return {
      scope,
      limit,
      hasMore: false,
      reachedSoftLimit: false,
      commits: [],
    };
  }

  const baseFlags = [
    '--topo-order',
    '--decorate=full',
    '-z',
    '-n',
    String(limit + 1),
    `--format=${LOG_FORMAT}`,
  ];

  let result;
  if (scope === 'all') {
    const args = buildGitArgs('log', {
      flags: ['--exclude=refs/stash', '--all', ...baseFlags],
    });
    result = await runReadFn(args, {
      cwd: repoPath,
      allowNonZero: isUnborn,
      timeoutMs: options.timeoutMs,
    });
    if (result.exitCode !== 0) {
      return {
        scope,
        limit,
        hasMore: false,
        reachedSoftLimit: false,
        commits: [],
      };
    }
  } else {
    const refs = upstream ? ['HEAD', upstream] : ['HEAD'];
    const args = buildGitArgs('log', { flags: baseFlags, refs });
    try {
      result = await runReadFn(args, {
        cwd: repoPath,
        timeoutMs: options.timeoutMs,
      });
    } catch (error) {
      // 当远端跟踪分支配置存在但本地尚无对应跟踪引用时，退回仅查询 HEAD 避免整个快照失败
      const isMissingUpstreamRef =
        upstream &&
        error instanceof AppError &&
        error.code === ERROR_CODES.GIT_ERROR &&
        /unknown revision|bad revision|ambiguous argument/i.test(error.detail);
      if (!isMissingUpstreamRef) {
        throw error;
      }
      const fallbackArgs = buildGitArgs('log', { flags: baseFlags, refs: ['HEAD'] });
      result = await runReadFn(fallbackArgs, {
        cwd: repoPath,
        timeoutMs: options.timeoutMs,
      });
    }
  }

  const rawCommits = parseLogRecordsZ(result.stdout);
  const hasMore = rawCommits.length > limit;
  const commits = hasMore ? rawCommits.slice(0, limit) : rawCommits;

  return {
    scope,
    limit,
    hasMore,
    reachedSoftLimit: limit >= MAX_GRAPH_LIMIT,
    commits,
  };
}

/**
 * 查询单个提交的详情正文、`Co-authored-by` 列表及改动文件清单，并校验文件是否仍存在于当前 Worktree。
 *
 * @param {string} repoPath Repository 或 Worktree 目录路径
 * @param {string} sha 提交 SHA（7-64 位十六进制）
 * @param {{ worktreePath?: string | null, isBare?: boolean, timeoutMs?: number, runGitRead?: typeof runGitRead }} [options] 查询选项
 * @returns {Promise<{ sha: string, subject: string, body: string, coAuthors: Array<{ name: string, email: string }>, files: Array<{ status: string, path: string, origPath: string | null, existsInWorktree: boolean, fileUri: string | null }> }>} 提交详情对象
 */
export async function queryCommitDetail(repoPath, sha, options = {}) {
  if (typeof sha !== 'string' || !SHA_PATTERN.test(sha)) {
    throw new AppError(ERROR_CODES.INVALID_REQUEST, 'Invalid commit SHA.');
  }

  const runReadFn = options.runGitRead ?? runGitRead;
  const effectiveWorktreePath = options.isBare ? null : (options.worktreePath ?? repoPath);

  const messageArgs = buildGitArgs('show', {
    flags: ['-s', '--format=%B'],
    refs: [sha],
  });
  const nameStatusArgs = buildGitArgs('show', {
    flags: ['--name-status', '-M', '-m', '--first-parent', '--format=', '-z'],
    refs: [sha],
  });

  const [messageResult, filesResult] = await Promise.all([
    runReadFn(messageArgs, { cwd: repoPath, timeoutMs: options.timeoutMs }),
    runReadFn(nameStatusArgs, { cwd: repoPath, timeoutMs: options.timeoutMs }),
  ]);

  const { subject, body, coAuthors } = parseCommitMessageB(messageResult.stdout);
  const rawFiles = parseCommitNameStatusZ(filesResult.stdout);

  const files = rawFiles.map((entry) => {
    if (!effectiveWorktreePath) {
      return {
        ...entry,
        existsInWorktree: false,
        fileUri: null,
      };
    }
    try {
      const resolved = resolvePathInsideWorktree(effectiveWorktreePath, entry.path);
      const existsInWorktree = fs.existsSync(resolved.fullPath);
      return {
        ...entry,
        existsInWorktree,
        fileUri: existsInWorktree ? resolved.fileUri : null,
      };
    } catch {
      return {
        ...entry,
        existsInWorktree: false,
        fileUri: null,
      };
    }
  });

  return {
    sha,
    subject,
    body,
    coAuthors,
    files,
  };
}

/**
 * 查询 Repository 已配置的远端名称列表。
 *
 * @param {string} repoPath Repository 或 Worktree 目录路径
 * @param {{ timeoutMs?: number, runGitRead?: typeof runGitRead }} [options] 查询选项
 * @returns {Promise<string[]>} 远端名称数组
 */
export async function queryRemotes(repoPath, options = {}) {
  const runReadFn = options.runGitRead ?? runGitRead;
  const result = await runReadFn(['remote'], {
    cwd: repoPath,
    timeoutMs: options.timeoutMs,
  });
  return result.stdoutText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function queryBareHeadMetadata(repoDir, runReadFn, timeoutMs) {
  const [symResult, revResult] = await Promise.all([
    runReadFn(['symbolic-ref', '--short', '-q', 'HEAD'], {
      cwd: repoDir,
      allowNonZero: true,
      timeoutMs,
    }),
    runReadFn(['rev-parse', '--verify', '-q', 'HEAD'], {
      cwd: repoDir,
      allowNonZero: true,
      timeoutMs,
    }),
  ]);

  const branch = symResult.exitCode === 0 ? symResult.stdoutText.trim() || null : null;
  const headOid = revResult.exitCode === 0 ? revResult.stdoutText.trim() || null : null;
  const isUnborn = !headOid;
  const isDetached = !isUnborn && !branch;

  return {
    headOid,
    branch,
    upstream: null,
    ahead: 0,
    behind: 0,
    isUnborn,
    isDetached,
  };
}

function buildWorkspaceKey(activeRepo) {
  if (!activeRepo) {
    return null;
  }
  const worktreeKey = activeRepo.worktreePath ? (toPathKey(activeRepo.worktreePath) ?? '') : '';
  return createHash('sha256')
    .update(`${activeRepo.id}\0${worktreeKey}`)
    .digest('hex');
}

/**
 * 根据宿主 `workspaceUris` 发现 Repository 集合，并为当前选中仓库构建完整基础快照（供 M2 `/api/snapshot` 组装）。
 *
 * @param {{ workspaceUris?: string[], selectedRepoId?: string | null, graphScope?: 'auto' | 'all', graphLimit?: number, maxStatusEntries?: number, timeoutMs?: number, runGitRead?: typeof runGitRead }} [params] 快照请求参数
 * @returns {Promise<{ workspaceKey: string | null, repositories: Array<{ id: string, name: string, worktreePath: string | null, branch: string | null, isBare: boolean }>, activeRepo: object | null, changes: object, graph: object }>} 基础快照数据
 */
export async function discoverAndBuildSnapshotBase(params = {}) {
  const {
    workspaceUris = [],
    selectedRepoId = null,
    graphScope = 'auto',
    graphLimit = DEFAULT_GRAPH_LIMIT,
    maxStatusEntries = MAX_STATUS_ENTRIES,
    timeoutMs,
    runGitRead: customRunRead,
  } = params;

  const { scope, limit } = normalizeGraphOptions({ scope: graphScope, limit: graphLimit });
  const runReadFn = customRunRead ?? runGitRead;

  const discovered = await discoverRepositories(workspaceUris, {
    timeoutMs,
    runGitRead: runReadFn,
  });

  if (discovered.length === 0) {
    return {
      workspaceKey: null,
      repositories: [],
      activeRepo: null,
      changes: {
        conflicted: [],
        staged: [],
        unstaged: [],
        totalEntries: 0,
        truncated: false,
      },
      graph: {
        scope,
        limit,
        hasMore: false,
        reachedSoftLimit: false,
        commits: [],
      },
    };
  }

  const activeDiscovery =
    (selectedRepoId ? discovered.find((repo) => repo.id === selectedRepoId) : null) ??
    discovered[0];

  const repoCwd = activeDiscovery.isBare ? activeDiscovery.gitCommonDir : activeDiscovery.worktreePath;

  let branchMeta;
  let changes;
  let remotes;

  if (activeDiscovery.isBare) {
    const [bareHead, repoRemotes] = await Promise.all([
      queryBareHeadMetadata(repoCwd, runReadFn, timeoutMs),
      queryRemotes(repoCwd, { timeoutMs, runGitRead: runReadFn }),
    ]);
    branchMeta = bareHead;
    remotes = repoRemotes;
    changes = {
      conflicted: [],
      staged: [],
      unstaged: [],
      totalEntries: 0,
      truncated: false,
    };
  } else {
    const [statusResult, repoRemotes] = await Promise.all([
      queryWorktreeStatus(activeDiscovery.worktreePath, {
        maxEntries: maxStatusEntries,
        timeoutMs,
        runGitRead: runReadFn,
      }),
      queryRemotes(repoCwd, { timeoutMs, runGitRead: runReadFn }),
    ]);
    branchMeta = statusResult.branchInfo;
    changes = statusResult.changes;
    remotes = repoRemotes;
  }

  const graph = await queryCommitGraph(repoCwd, {
    scope,
    limit,
    isUnborn: branchMeta.isUnborn,
    upstream: branchMeta.upstream,
    timeoutMs,
    runGitRead: runReadFn,
  });

  const activeRepo = {
    id: activeDiscovery.id,
    name: activeDiscovery.name,
    gitCommonDir: activeDiscovery.gitCommonDir,
    gitDir: activeDiscovery.gitDir,
    worktreePath: activeDiscovery.worktreePath,
    isBare: activeDiscovery.isBare,
    isUnborn: branchMeta.isUnborn,
    isDetached: branchMeta.isDetached,
    headOid: branchMeta.headOid,
    branch: branchMeta.branch,
    upstream: branchMeta.upstream,
    ahead: branchMeta.ahead,
    behind: branchMeta.behind,
    remotes,
  };

  const repositories = discovered.map((repo) => ({
    id: repo.id,
    name: repo.name,
    worktreePath: repo.worktreePath,
    branch: repo.id === activeRepo.id ? activeRepo.branch : repo.branch,
    isBare: repo.isBare,
  }));

  return {
    workspaceKey: buildWorkspaceKey(activeRepo),
    repositories,
    activeRepo,
    changes,
    graph,
  };
}
