import {
  createWorktreePathResolver,
  normalizeFsPath,
} from './discovery.mjs';
import {
  queryRemotes,
  queryWorktreeStatus,
} from './git-queries.mjs';
import {
  AppError,
  ERROR_CODES,
  assertValidGitArg,
  buildGitArgs,
  enqueueRepositoryAndWorktreeWrite,
  enqueueRepositoryWrite,
  enqueueWorktreeWrite,
  runGitNetwork,
  runGitRead,
  runGitWrite,
} from './git-runner.mjs';

const MAX_PATHS_PER_GIT_BATCH = 100;

function normalizeRelativeComparisonPath(relPath) {
  return String(relPath ?? '').replaceAll('\\', '/').replace(/\/+$/, '');
}

function assertValidWorktreePath(worktreePath) {
  const normalized = normalizeFsPath(worktreePath);
  if (!normalized) {
    throw new AppError(ERROR_CODES.INVALID_REQUEST, 'worktreePath must be a valid local directory path.');
  }
  return normalized;
}

function resolveCommonDir(worktreePath, gitCommonDir) {
  const normalized = normalizeFsPath(gitCommonDir ?? worktreePath);
  if (!normalized) {
    throw new AppError(ERROR_CODES.INVALID_REQUEST, 'gitCommonDir must be a valid directory path.');
  }
  return normalized;
}

function validateAndNormalizePaths(worktreePath, paths) {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new AppError(ERROR_CODES.INVALID_REQUEST, 'paths must be a non-empty array of relative file paths.');
  }
  const resolvePath = createWorktreePathResolver(worktreePath);
  const seen = new Set();
  const normalizedPaths = [];
  for (const rawPath of paths) {
    const resolved = resolvePath(rawPath);
    if (!seen.has(resolved.relativePath)) {
      seen.add(resolved.relativePath);
      normalizedPaths.push(resolved.relativePath);
    }
  }
  return normalizedPaths;
}

function chunkPaths(paths, batchSize = MAX_PATHS_PER_GIT_BATCH) {
  const chunks = [];
  for (let i = 0; i < paths.length; i += batchSize) {
    chunks.push(paths.slice(i, i + batchSize));
  }
  return chunks;
}

function extractWriteRunnerOptions(options) {
  return {
    env: options.env,
    timeoutMs: options.timeoutMs,
    lockRetryDelaysMs: options.lockRetryDelaysMs,
    sleepFn: options.sleepFn,
  };
}

function isPathTrackedAsUntrackedInStatus(statusResult, targetRelPath) {
  const unstaged = statusResult?.changes?.unstaged ?? [];
  const staged = statusResult?.changes?.staged ?? [];

  for (const entry of staged) {
    if (normalizeRelativeComparisonPath(entry.path) === targetRelPath) {
      return false;
    }
  }
  for (const entry of unstaged) {
    if (!entry.untracked && normalizeRelativeComparisonPath(entry.path) === targetRelPath) {
      return false;
    }
  }
  for (const entry of unstaged) {
    if (!entry.untracked) {
      continue;
    }
    const candidate = normalizeRelativeComparisonPath(entry.path);
    if (candidate === targetRelPath || targetRelPath.startsWith(`${candidate}/`)) {
      return true;
    }
  }
  return false;
}

async function isUntrackedByGitLsFiles(worktreePath, targetRelPath, runReadFn, timeoutMs) {
  const result = await runReadFn(
    buildGitArgs('ls-files', { flags: ['--others', '--exclude-standard', '-z'], paths: [targetRelPath] }),
    { cwd: worktreePath, timeoutMs },
  );
  return result.stdout.length > 0;
}

/**
 * 暂存单个/多个指定工作区文件（`git add -- <paths>`）或全部更改（`git add -A`）。
 * 在 Worktree 级串行写队列内执行并自动校验路径不出边界。
 *
 * @param {{
 *   worktreePath: string,
 *   gitCommonDir?: string,
 *   all?: boolean,
 *   paths?: string[],
 *   runGitWrite?: typeof runGitWrite,
 *   timeoutMs?: number,
 *   lockRetryDelaysMs?: number[],
 *   sleepFn?: (ms: number) => Promise<void>
 * }} params 暂存操作参数
 * @returns {Promise<{ stagedAll: boolean, paths: string[] }>} 已执行的暂存范围摘要
 */
export async function stageChanges(params) {
  const worktreePath = assertValidWorktreePath(params?.worktreePath);
  const all = params?.all ?? false;
  const rawPaths = params?.paths;
  if (typeof all !== 'boolean') {
    throw new AppError(ERROR_CODES.INVALID_REQUEST, 'all must be a boolean.');
  }

  const runWriteFn = params?.runGitWrite ?? runGitWrite;
  const writeOpts = extractWriteRunnerOptions(params ?? {});

  if (all) {
    if (rawPaths !== undefined && (!Array.isArray(rawPaths) || rawPaths.length > 0)) {
      throw new AppError(ERROR_CODES.INVALID_REQUEST, 'Cannot provide non-empty paths when all is true.');
    }
    await runWriteFn(buildGitArgs('add', { flags: ['-A'] }), {
      cwd: worktreePath,
      worktreePath,
      lockMode: 'worktree',
      ...writeOpts,
    });
    return { stagedAll: true, paths: [] };
  }

  const validatedPaths = validateAndNormalizePaths(worktreePath, rawPaths);
  const batches = chunkPaths(validatedPaths);

  await enqueueWorktreeWrite(worktreePath, async () => {
    for (const batch of batches) {
      await runWriteFn(buildGitArgs('add', { paths: batch }), {
        cwd: worktreePath,
        lockMode: 'none',
        ...writeOpts,
      });
    }
  });

  return { stagedAll: false, paths: validatedPaths };
}

/**
 * 取消暂存单个/多个或全部已暂存文件。
 * 已有提交的仓库执行 `git restore --staged -- ...`；0 提交 unborn 仓库执行 `git rm --cached -r` 规避 HEAD 缺失错误。
 *
 * @param {{
 *   worktreePath: string,
 *   gitCommonDir?: string,
 *   isUnborn?: boolean,
 *   all?: boolean,
 *   paths?: string[],
 *   runGitWrite?: typeof runGitWrite,
 *   queryWorktreeStatus?: typeof queryWorktreeStatus,
 *   timeoutMs?: number,
 *   lockRetryDelaysMs?: number[],
 *   sleepFn?: (ms: number) => Promise<void>
 * }} params 取消暂存参数
 * @returns {Promise<{ unstagedAll: boolean, isUnborn: boolean, paths: string[] }>} 取消暂存执行结果
 */
export async function unstageChanges(params) {
  const worktreePath = assertValidWorktreePath(params?.worktreePath);
  const all = params?.all ?? false;
  const rawPaths = params?.paths;
  if (typeof all !== 'boolean') {
    throw new AppError(ERROR_CODES.INVALID_REQUEST, 'all must be a boolean.');
  }
  if (params?.isUnborn !== undefined && typeof params.isUnborn !== 'boolean') {
    throw new AppError(ERROR_CODES.INVALID_REQUEST, 'isUnborn must be a boolean when provided.');
  }

  const validatedPaths = all
    ? (() => {
        if (rawPaths !== undefined && (!Array.isArray(rawPaths) || rawPaths.length > 0)) {
          throw new AppError(ERROR_CODES.INVALID_REQUEST, 'Cannot provide non-empty paths when all is true.');
        }
        return [];
      })()
    : validateAndNormalizePaths(worktreePath, rawPaths);

  const runWriteFn = params?.runGitWrite ?? runGitWrite;
  const queryStatusFn = params?.queryWorktreeStatus ?? queryWorktreeStatus;
  const writeOpts = extractWriteRunnerOptions(params ?? {});

  let resolvedUnborn = params?.isUnborn;

  await enqueueWorktreeWrite(worktreePath, async () => {
    if (typeof resolvedUnborn !== 'boolean') {
      const status = await queryStatusFn(worktreePath, { timeoutMs: params?.timeoutMs });
      resolvedUnborn = Boolean(status.branchInfo?.isUnborn);
    }

    if (resolvedUnborn) {
      const targetBatches = all ? [['.']] : chunkPaths(validatedPaths);
      for (const batch of targetBatches) {
        await runWriteFn(
          buildGitArgs('rm', { flags: ['--cached', '-r', '--ignore-unmatch'], paths: batch }),
          {
            cwd: worktreePath,
            lockMode: 'none',
            ...writeOpts,
          },
        );
      }
      return;
    }

    const targetBatches = all ? [['.']] : chunkPaths(validatedPaths);
    for (const batch of targetBatches) {
      await runWriteFn(
        buildGitArgs('restore', { flags: ['--staged'], paths: batch }),
        {
          cwd: worktreePath,
          lockMode: 'none',
          ...writeOpts,
        },
      );
    }
  });

  return {
    unstagedAll: all,
    isUnborn: Boolean(resolvedUnborn),
    paths: validatedPaths,
  };
}

/**
 * 放弃工作区修改或永久删除单个未跟踪文件。
 * 严禁放弃合并冲突文件（`CONFLICT_BLOCKED`）；`allTracked: true` 仅还原已跟踪工作区文件绝不删未跟踪；
 * `MM` 双态文件走 `git restore --worktree` 保留暂存区内容；`untracked: true` 强制校验单文件并确为最新未跟踪文件后走 `git clean -f -- <path>`。
 *
 * @param {{
 *   worktreePath: string,
 *   gitCommonDir?: string,
 *   allTracked?: boolean,
 *   paths?: string[],
 *   untracked?: boolean,
 *   statusResult?: { branchInfo?: object, changes?: { conflicted?: Array<{ path: string }>, staged?: Array<{ path: string }>, unstaged?: Array<{ path: string, untracked?: boolean }> } },
 *   runGitWrite?: typeof runGitWrite,
 *   runGitRead?: typeof runGitRead,
 *   queryWorktreeStatus?: typeof queryWorktreeStatus,
 *   timeoutMs?: number,
 *   lockRetryDelaysMs?: number[],
 *   sleepFn?: (ms: number) => Promise<void>
 * }} params 放弃更改参数
 * @returns {Promise<{ allTracked: boolean, untracked: boolean, paths: string[] }>} 执行结果摘要
 */
export async function discardChanges(params) {
  const worktreePath = assertValidWorktreePath(params?.worktreePath);
  const allTracked = params?.allTracked ?? false;
  const untracked = params?.untracked ?? false;
  const rawPaths = params?.paths;

  if (typeof allTracked !== 'boolean' || typeof untracked !== 'boolean') {
    throw new AppError(ERROR_CODES.INVALID_REQUEST, 'allTracked and untracked must be booleans.');
  }
  if (allTracked && untracked) {
    throw new AppError(ERROR_CODES.INVALID_REQUEST, 'allTracked and untracked cannot both be true.');
  }

  let validatedPaths = [];
  if (allTracked) {
    if (rawPaths !== undefined && (!Array.isArray(rawPaths) || rawPaths.length > 0)) {
      throw new AppError(ERROR_CODES.INVALID_REQUEST, 'Cannot provide non-empty paths when allTracked is true.');
    }
  } else if (untracked) {
    if (!Array.isArray(rawPaths) || rawPaths.length !== 1) {
      throw new AppError(ERROR_CODES.INVALID_REQUEST, 'Deleting an untracked file requires paths with length === 1.');
    }
    validatedPaths = validateAndNormalizePaths(worktreePath, rawPaths);
  } else {
    validatedPaths = validateAndNormalizePaths(worktreePath, rawPaths);
  }

  const runWriteFn = params?.runGitWrite ?? runGitWrite;
  const runReadFn = params?.runGitRead ?? runGitRead;
  const queryStatusFn = params?.queryWorktreeStatus ?? queryWorktreeStatus;
  const writeOpts = extractWriteRunnerOptions(params ?? {});

  await enqueueWorktreeWrite(worktreePath, async () => {
    // 删未跟踪文件必须基于锁内最新真实状态校验，防止错删已被暂存或已跟踪的文件
    const latestStatus = (untracked || !params?.statusResult)
      ? await queryStatusFn(worktreePath, { timeoutMs: params?.timeoutMs })
      : params.statusResult;

    const conflictedSet = new Set(
      (latestStatus?.changes?.conflicted ?? []).map((item) => normalizeRelativeComparisonPath(item.path)),
    );

    if (untracked) {
      const targetRelPath = validatedPaths[0];
      if (conflictedSet.has(targetRelPath)) {
        throw new AppError(
          ERROR_CODES.CONFLICT_BLOCKED,
          `文件 "${targetRelPath}" 正处于合并冲突状态，禁止直接删除。`,
        );
      }

      const matchedInStatus = isPathTrackedAsUntrackedInStatus(latestStatus, targetRelPath);
      const confirmedByLsFiles = !matchedInStatus && latestStatus?.changes?.truncated
        ? await isUntrackedByGitLsFiles(worktreePath, targetRelPath, runReadFn, params?.timeoutMs)
        : false;

      if (!matchedInStatus && !confirmedByLsFiles) {
        throw new AppError(
          ERROR_CODES.INVALID_REQUEST,
          `Target "${targetRelPath}" is not an untracked file in the current working tree.`,
        );
      }

      await runWriteFn(
        buildGitArgs('clean', { flags: ['-f'], paths: [targetRelPath] }),
        {
          cwd: worktreePath,
          lockMode: 'none',
          ...writeOpts,
        },
      );
      return;
    }

    if (allTracked) {
      if (conflictedSet.size > 0) {
        throw new AppError(
          ERROR_CODES.CONFLICT_BLOCKED,
          '工作区存在未解决合并冲突，禁止批量放弃更改。',
        );
      }
      const hasTrackedUnstaged = (latestStatus?.changes?.unstaged ?? []).some((item) => !item.untracked);
      if (!hasTrackedUnstaged) {
        return;
      }
      await runWriteFn(
        buildGitArgs('restore', { flags: ['--worktree'], paths: ['.'] }),
        {
          cwd: worktreePath,
          lockMode: 'none',
          ...writeOpts,
        },
      );
      return;
    }

    for (const relPath of validatedPaths) {
      if (conflictedSet.has(relPath)) {
        throw new AppError(
          ERROR_CODES.CONFLICT_BLOCKED,
          `文件 "${relPath}" 正处于合并冲突状态，禁止放弃更改，请先解决冲突。`,
        );
      }
      const onlyUntracked = (latestStatus?.changes?.unstaged ?? []).some(
        (item) => item.untracked && normalizeRelativeComparisonPath(item.path) === relPath,
      ) && !(latestStatus?.changes?.staged ?? []).some(
        (item) => normalizeRelativeComparisonPath(item.path) === relPath,
      );
      if (onlyUntracked) {
        throw new AppError(
          ERROR_CODES.INVALID_REQUEST,
          `Path "${relPath}" is untracked; pass untracked: true to delete a single untracked file.`,
        );
      }
    }

    for (const batch of chunkPaths(validatedPaths)) {
      await runWriteFn(
        buildGitArgs('restore', { flags: ['--worktree'], paths: batch }),
        {
          cwd: worktreePath,
          lockMode: 'none',
          ...writeOpts,
        },
      );
    }
  });

  return {
    allTracked,
    untracked,
    paths: validatedPaths,
  };
}

/**
 * 提交已暂存更改（或 `autoStageAll: true` 时在同一仓库+工作树双锁下先 `git add -A` 再提交）。
 * 通过 `stdin` 传递 UTF-8 说明给 `git commit -F -`，并在冲突存在、说明为空或无待提交内容时精准抛错。
 *
 * @param {{
 *   worktreePath: string,
 *   gitCommonDir?: string,
 *   message: string,
 *   autoStageAll?: boolean,
 *   statusResult?: { branchInfo?: object, changes?: { conflicted?: Array<object>, staged?: Array<object>, unstaged?: Array<object> } },
 *   runGitWrite?: typeof runGitWrite,
 *   runGitRead?: typeof runGitRead,
 *   queryWorktreeStatus?: typeof queryWorktreeStatus,
 *   timeoutMs?: number,
 *   lockRetryDelaysMs?: number[],
 *   sleepFn?: (ms: number) => Promise<void>
 * }} params 提交操作参数
 * @returns {Promise<{ sha: string | null }>} 最新提交的完整 SHA（若无法读取则为 null）
 */
export async function commitChanges(params) {
  const worktreePath = assertValidWorktreePath(params?.worktreePath);
  const gitCommonDir = resolveCommonDir(worktreePath, params?.gitCommonDir);
  const message = params?.message;
  const autoStageAll = params?.autoStageAll ?? false;

  if (typeof message !== 'string') {
    throw new AppError(ERROR_CODES.INVALID_REQUEST, 'Commit message must be a string.');
  }
  if (message.trim().length === 0) {
    throw new AppError(ERROR_CODES.EMPTY_COMMIT_MESSAGE, '提交说明不能为空。');
  }
  if (typeof autoStageAll !== 'boolean') {
    throw new AppError(ERROR_CODES.INVALID_REQUEST, 'autoStageAll must be a boolean.');
  }

  const runWriteFn = params?.runGitWrite ?? runGitWrite;
  const runReadFn = params?.runGitRead ?? runGitRead;
  const queryStatusFn = params?.queryWorktreeStatus ?? queryWorktreeStatus;
  const writeOpts = extractWriteRunnerOptions(params ?? {});

  const runWithAppropriateLock = (task) => (
    autoStageAll
      ? enqueueRepositoryAndWorktreeWrite(gitCommonDir, worktreePath, task)
      : enqueueRepositoryWrite(gitCommonDir, task)
  );

  let createdSha = null;

  await runWithAppropriateLock(async () => {
    const latestStatus = params?.statusResult
      ?? await queryStatusFn(worktreePath, { timeoutMs: params?.timeoutMs });

    const conflictedCount = latestStatus?.changes?.conflicted?.length ?? 0;
    if (conflictedCount > 0) {
      throw new AppError(
        ERROR_CODES.CONFLICT_BLOCKED,
        '工作区存在未解决合并冲突，请先解决冲突后再提交。',
      );
    }

    const stagedCount = latestStatus?.changes?.staged?.length ?? 0;
    const unstagedCount = latestStatus?.changes?.unstaged?.length ?? 0;

    if (autoStageAll) {
      if (stagedCount === 0 && unstagedCount === 0) {
        throw new AppError(ERROR_CODES.NOTHING_TO_COMMIT, '工作区与暂存区均无待提交更改。');
      }
      await runWriteFn(buildGitArgs('add', { flags: ['-A'] }), {
        cwd: worktreePath,
        lockMode: 'none',
        ...writeOpts,
      });
    } else if (stagedCount === 0) {
      throw new AppError(ERROR_CODES.NOTHING_TO_COMMIT, '暂存区为空，没有可提交的更改。');
    }

    await runWriteFn(buildGitArgs('commit', { flags: ['-F', '-'] }), {
      cwd: worktreePath,
      lockMode: 'none',
      input: message,
      ...writeOpts,
    });

    try {
      const revResult = await runReadFn(['rev-parse', 'HEAD'], {
        cwd: worktreePath,
        allowNonZero: true,
        timeoutMs: params?.timeoutMs,
      });
      if (revResult.exitCode === 0) {
        createdSha = revResult.stdoutText.trim() || null;
      }
    } catch {
      createdSha = null;
    }
  });

  return { sha: createdSha };
}

/**
 * 执行仓库级远端提取与分支修剪（`git fetch --all --prune`），兼容 bare 仓库。
 *
 * @param {{
 *   worktreePath?: string | null,
 *   gitCommonDir: string,
 *   runGitNetwork?: typeof runGitNetwork,
 *   queryRemotes?: typeof queryRemotes,
 *   timeoutMs?: number,
 *   lockRetryDelaysMs?: number[],
 *   sleepFn?: (ms: number) => Promise<void>
 * }} params 提取操作参数
 * @returns {Promise<{ remotes: string[] }>} 已提取的远端列表
 */
export async function fetchRepository(params) {
  const gitCommonDir = resolveCommonDir(params?.worktreePath ?? params?.gitCommonDir, params?.gitCommonDir);
  const cwd = params?.worktreePath ? assertValidWorktreePath(params.worktreePath) : gitCommonDir;

  const runNetworkFn = params?.runGitNetwork ?? runGitNetwork;
  const queryRemotesFn = params?.queryRemotes ?? queryRemotes;
  const writeOpts = extractWriteRunnerOptions(params ?? {});

  let remotes = [];
  await enqueueRepositoryWrite(gitCommonDir, async () => {
    remotes = await queryRemotesFn(cwd, { timeoutMs: params?.timeoutMs });
    if (remotes.length === 0) {
      throw new AppError(ERROR_CODES.NO_REMOTE, '当前仓库未配置任何远端，无法执行提取（Fetch）。');
    }
    await runNetworkFn(buildGitArgs('fetch', { flags: ['--all', '--prune'] }), {
      cwd,
      lockMode: 'none',
      ...writeOpts,
    });
  });

  return { remotes };
}

/**
 * 在 Repository 级串行写队列内快进拉取上游更改（`git pull --ff-only`）。
 * 前置校验非 unborn、非 detached、存在远端且已配置 upstream，分支分叉时自动映射为 `NON_FAST_FORWARD`。
 *
 * @param {{
 *   worktreePath: string,
 *   gitCommonDir?: string,
 *   runGitNetwork?: typeof runGitNetwork,
 *   queryWorktreeStatus?: typeof queryWorktreeStatus,
 *   queryRemotes?: typeof queryRemotes,
 *   timeoutMs?: number,
 *   lockRetryDelaysMs?: number[],
 *   sleepFn?: (ms: number) => Promise<void>
 * }} params 拉取操作参数
 * @returns {Promise<{ upstream: string }>} 本次拉取对应的上游引用名
 */
export async function pullBranch(params) {
  const worktreePath = assertValidWorktreePath(params?.worktreePath);
  const gitCommonDir = resolveCommonDir(worktreePath, params?.gitCommonDir);

  const runNetworkFn = params?.runGitNetwork ?? runGitNetwork;
  const queryStatusFn = params?.queryWorktreeStatus ?? queryWorktreeStatus;
  const queryRemotesFn = params?.queryRemotes ?? queryRemotes;
  const writeOpts = extractWriteRunnerOptions(params ?? {});

  let upstream = '';
  await enqueueRepositoryWrite(gitCommonDir, async () => {
    const [statusResult, remotes] = await Promise.all([
      queryStatusFn(worktreePath, { timeoutMs: params?.timeoutMs }),
      queryRemotesFn(worktreePath, { timeoutMs: params?.timeoutMs }),
    ]);

    if (remotes.length === 0) {
      throw new AppError(ERROR_CODES.NO_REMOTE, '当前仓库未配置任何远端，无法执行拉取（Pull）。');
    }
    if ((statusResult.changes?.conflicted?.length ?? 0) > 0) {
      throw new AppError(ERROR_CODES.CONFLICT_BLOCKED, '工作区存在未解决合并冲突，禁止执行拉取。');
    }
    if (statusResult.branchInfo.isUnborn) {
      throw new AppError(ERROR_CODES.INVALID_REQUEST, '当前分支尚无提交记录，无法执行拉取。');
    }
    if (statusResult.branchInfo.isDetached) {
      throw new AppError(ERROR_CODES.INVALID_REQUEST, '当前处于游离 HEAD 状态，无法直接拉取分支。');
    }
    if (!statusResult.branchInfo.upstream) {
      throw new AppError(ERROR_CODES.INVALID_REQUEST, '当前分支尚未关联上游跟踪分支，无法快进拉取。');
    }

    upstream = statusResult.branchInfo.upstream;
    await runNetworkFn(buildGitArgs('pull', { flags: ['--ff-only'] }), {
      cwd: worktreePath,
      lockMode: 'none',
      ...writeOpts,
    });
  });

  return { upstream };
}

/**
 * 推送本地提交至远端（存在上游执行 `git push`；无上游发布分支执行 `git push -u --end-of-options <remote> <branch>`）。
 * 严禁使用 `--force` 与 `--force-with-lease`。
 *
 * @param {{
 *   worktreePath: string,
 *   gitCommonDir?: string,
 *   remote?: string,
 *   force?: boolean,
 *   forceWithLease?: boolean,
 *   runGitNetwork?: typeof runGitNetwork,
 *   queryWorktreeStatus?: typeof queryWorktreeStatus,
 *   queryRemotes?: typeof queryRemotes,
 *   timeoutMs?: number,
 *   lockRetryDelaysMs?: number[],
 *   sleepFn?: (ms: number) => Promise<void>
 * }} params 推送操作参数
 * @returns {Promise<{ published: boolean, branch: string, remote: string | null }>} 推送模式与目标摘要
 */
export async function pushBranch(params) {
  if (params?.force || params?.forceWithLease) {
    throw new AppError(ERROR_CODES.INVALID_REQUEST, 'V1 禁用 --force 与 --force-with-lease 强制推送。');
  }

  const worktreePath = assertValidWorktreePath(params?.worktreePath);
  const gitCommonDir = resolveCommonDir(worktreePath, params?.gitCommonDir);

  if (params?.remote !== undefined && params.remote !== null) {
    if (typeof params.remote !== 'string' || params.remote.trim().length === 0) {
      throw new AppError(ERROR_CODES.INVALID_REQUEST, 'remote must be a non-empty string when provided.');
    }
    assertValidGitArg(params.remote, 'remote');
    if (params.remote.startsWith('-')) {
      throw new AppError(ERROR_CODES.INVALID_REQUEST, 'Invalid remote name.');
    }
  }

  const runNetworkFn = params?.runGitNetwork ?? runGitNetwork;
  const queryStatusFn = params?.queryWorktreeStatus ?? queryWorktreeStatus;
  const queryRemotesFn = params?.queryRemotes ?? queryRemotes;
  const writeOpts = extractWriteRunnerOptions(params ?? {});

  let published = false;
  let branchName = '';
  let targetRemote = null;

  await enqueueRepositoryWrite(gitCommonDir, async () => {
    const [statusResult, remotes] = await Promise.all([
      queryStatusFn(worktreePath, { timeoutMs: params?.timeoutMs }),
      queryRemotesFn(worktreePath, { timeoutMs: params?.timeoutMs }),
    ]);

    if (remotes.length === 0) {
      throw new AppError(ERROR_CODES.NO_REMOTE, '当前仓库未配置任何远端，无法执行推送（Push）。');
    }
    if (statusResult.branchInfo.isUnborn) {
      throw new AppError(ERROR_CODES.INVALID_REQUEST, '当前分支尚无提交记录，无法执行推送。');
    }
    if (statusResult.branchInfo.isDetached || !statusResult.branchInfo.branch) {
      throw new AppError(ERROR_CODES.INVALID_REQUEST, '当前处于游离 HEAD 状态，无法直接推送。');
    }

    branchName = statusResult.branchInfo.branch;

    if (statusResult.branchInfo.upstream) {
      published = false;
      targetRemote = statusResult.branchInfo.upstream.split('/')[0] ?? null;
      await runNetworkFn(['push'], {
        cwd: worktreePath,
        lockMode: 'none',
        ...writeOpts,
      });
      return;
    }

    const remote = params?.remote;
    if (!remote) {
      throw new AppError(ERROR_CODES.INVALID_REQUEST, '发布分支时必须指定目标远端 remote。');
    }
    if (!remotes.includes(remote)) {
      throw new AppError(ERROR_CODES.NO_REMOTE, `远端 "${remote}" 不存在。`);
    }

    published = true;
    targetRemote = remote;
    await runNetworkFn(
      buildGitArgs('push', { flags: ['-u'], refs: [remote, branchName] }),
      {
        cwd: worktreePath,
        lockMode: 'none',
        ...writeOpts,
      },
    );
  });

  return {
    published,
    branch: branchName,
    remote: targetRemote,
  };
}
