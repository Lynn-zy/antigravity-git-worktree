import {
  discoverRepositories,
  toPathKey,
} from './discovery.mjs';
import {
  commitChanges,
  discardChanges,
  fetchRepository,
  pullBranch,
  pushBranch,
  stageChanges,
  syncBranch,
  unstageChanges,
} from './git-mutations.mjs';
import {
  DEFAULT_GRAPH_LIMIT,
  discoverAndBuildSnapshotBase,
  queryCommitDetail,
  queryCommitStats,
  queryWorktreeStatus,
  withHeadInfo,
} from './git-queries.mjs';
import {
  AppError,
  ERROR_CODES,
  toAppError,
} from './git-runner.mjs';

export const API_ROUTES = Object.freeze([
  '/api/snapshot',
  '/api/status',
  '/api/commit/detail',
  '/api/commit/stats',
  '/api/events/wait',
  '/api/changes/stage',
  '/api/changes/unstage',
  '/api/changes/discard',
  '/api/commit',
  '/api/remote/fetch',
  '/api/remote/pull',
  '/api/remote/push',
  '/api/remote/sync',
  '/api/preferences',
]);

const SHA_PATTERN = /^[0-9a-f]{7,64}$/i;
const CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/;
const MAX_AUTHORIZED_REPOS = 64;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertPlainObject(value, label = 'Request body') {
  if (!isPlainObject(value)) {
    throw new AppError(ERROR_CODES.INVALID_REQUEST, `${label} must be a JSON object.`);
  }
  return value;
}

function assertOptionalBoolean(value, fieldName) {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw new AppError(ERROR_CODES.INVALID_REQUEST, `${fieldName} must be a boolean.`);
  }
  return value;
}

function assertOptionalNonEmptyString(value, fieldName) {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string' || value.trim().length === 0 || CONTROL_CHAR_PATTERN.test(value)) {
    throw new AppError(ERROR_CODES.INVALID_REQUEST, `${fieldName} must be a valid non-empty string.`);
  }
  return value;
}

function assertRequiredNonEmptyString(value, fieldName) {
  if (typeof value !== 'string' || value.trim().length === 0 || CONTROL_CHAR_PATTERN.test(value)) {
    throw new AppError(ERROR_CODES.INVALID_REQUEST, `${fieldName} must be a non-empty string.`);
  }
  return value;
}

function assertOptionalStringArray(value, fieldName) {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new AppError(ERROR_CODES.INVALID_REQUEST, `${fieldName} must be an array of strings.`);
  }
  for (const item of value) {
    if (typeof item !== 'string' || CONTROL_CHAR_PATTERN.test(item)) {
      throw new AppError(ERROR_CODES.INVALID_REQUEST, `${fieldName} contains invalid string entry.`);
    }
  }
  return value;
}

function assertRevision(value, fieldName) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new AppError(ERROR_CODES.INVALID_REQUEST, `${fieldName} must be a non-negative integer.`);
  }
  return value;
}

function assertWorkspaceUris(value) {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new AppError(ERROR_CODES.INVALID_REQUEST, 'workspaceUris must be an array of strings.');
  }
  const clean = [];
  for (const item of value) {
    if (typeof item !== 'string' || CONTROL_CHAR_PATTERN.test(item)) {
      throw new AppError(ERROR_CODES.INVALID_REQUEST, 'workspaceUris entries must be valid strings.');
    }
    clean.push(item);
  }
  return clean;
}

/**
 * 创建统一 API 路由调度器，负责全部 `POST /api/*` 端点入参白名单校验、
 * 多仓库上下文授权、Git 读写调用、`eventBus` 修订通知与错误 HTTP 状态映射。
 *
 * @param {{
 *   eventBus: import('./event-bus.mjs').EventBus,
 *   watcher: import('./watcher.mjs').RepositoryWatcher,
 *   preferencesStore: ReturnType<typeof import('./preferences.mjs').createPreferencesStore>,
 *   mockFixture: ReturnType<typeof import('./mock-fixture.mjs').createMockFixtureStore>,
 *   defaultWorkspaceUris?: string[],
 *   isStandalone?: boolean
 * }} deps 后端核心组件依赖
 * @returns {{
 *   dispatch: (pathname: string, rawBody: unknown, context?: { fixture?: string | null, signal?: AbortSignal }) => Promise<{ statusCode: number, body: { ok: boolean, data?: unknown, error?: object } }>
 * }} 路由分发控制器
 */
export function createApiRouter(deps) {
  const {
    eventBus,
    watcher,
    preferencesStore,
    mockFixture,
    defaultWorkspaceUris = [],
    isStandalone = false,
  } = deps;

  let currentActiveRepo = null;
  let lastWorkspaceUris = [...defaultWorkspaceUris];
  let lastDiscoveredSummaries = [];
  let snapshotSeq = 0;
  const knownWorkspaces = new Map();
  const authorizedEntries = new Map();
  const authorizedById = new Map();
  const authorizedByWorktreeKey = new Map();
  const authorizedByCommonDirKey = new Map();

  const recordWorkspaceSession = (workspaceKey, repoTarget) => {
    if (!workspaceKey) {
      return;
    }
    if (knownWorkspaces.has(workspaceKey)) {
      knownWorkspaces.delete(workspaceKey);
    }
    knownWorkspaces.set(workspaceKey, {
      repoTarget: repoTarget ?? null,
      gitCommonDirKey: repoTarget?.gitCommonDir ? toPathKey(repoTarget.gitCommonDir) : null,
      worktreeKey: repoTarget?.worktreePath ? toPathKey(repoTarget.worktreePath) : null,
    });
    while (knownWorkspaces.size > MAX_AUTHORIZED_REPOS) {
      const oldestKey = knownWorkspaces.keys().next().value;
      if (oldestKey === undefined) break;
      knownWorkspaces.delete(oldestKey);
    }
  };

  const resolveAffectedWorkspaceKeys = (info) => {
    const target = info?.target;
    if (!target?.gitCommonDir || knownWorkspaces.size === 0) {
      return [];
    }
    const targetCommonKey = toPathKey(target.gitCommonDir);
    const targetWtKey = target.worktreePath ? toPathKey(target.worktreePath) : null;
    if (!targetCommonKey) {
      return [];
    }
    const matchRepositoryWide = info?.channel === 'metadata' || Boolean(target.isBare);
    const affected = [];
    for (const [workspaceKey, session] of knownWorkspaces.entries()) {
      if (session.gitCommonDirKey !== targetCommonKey) {
        continue;
      }
      if (matchRepositoryWide || session.worktreeKey === targetWtKey) {
        affected.push(workspaceKey);
      }
    }
    return affected;
  };

  const bumpRepoRevision = (repo, { repositoryWide = false } = {}) => {
    const scopeKeys = resolveAffectedWorkspaceKeys({
      channel: repositoryWide ? 'metadata' : 'worktree',
      target: repo,
    });
    return eventBus.bumpRevision({
      scopeKeys: scopeKeys.length > 0 ? scopeKeys : undefined,
      refresh: repositoryWide ? 'full' : 'status',
    });
  };

  const evictOldestAuthorizedEntry = () => {
    const oldestKey = authorizedEntries.keys().next().value;
    if (oldestKey === undefined) {
      return;
    }
    const entry = authorizedEntries.get(oldestKey);
    authorizedEntries.delete(oldestKey);
    if (!entry) {
      return;
    }
    if (entry.wtKey && authorizedByWorktreeKey.get(entry.wtKey) === entry.repo) {
      authorizedByWorktreeKey.delete(entry.wtKey);
    }
    if (entry.commonKey && authorizedByCommonDirKey.get(entry.commonKey) === entry.repo) {
      authorizedByCommonDirKey.delete(entry.commonKey);
    }
    if (entry.repo.id && authorizedById.get(entry.repo.id) === entry.repo) {
      authorizedById.delete(entry.repo.id);
    }
  };

  const cacheRepoRecord = (repo) => {
    if (!repo || !repo.id) {
      return;
    }
    const wtKey = repo.worktreePath ? toPathKey(repo.worktreePath) : null;
    const commonKey = repo.gitCommonDir ? toPathKey(repo.gitCommonDir) : null;
    // 以工作树路径键区分同一 Repository 下的多个 Worktree，避免多会话共享 Sidecar 时互相覆盖
    const entryKey = wtKey ? `wt:${wtKey}` : `repo:${commonKey ?? repo.id}`;

    if (authorizedEntries.has(entryKey)) {
      authorizedEntries.delete(entryKey);
    }
    authorizedEntries.set(entryKey, { repo, wtKey, commonKey });
    authorizedById.set(repo.id, repo);
    if (wtKey) {
      authorizedByWorktreeKey.set(wtKey, repo);
    }
    if (commonKey) {
      authorizedByCommonDirKey.set(commonKey, repo);
    }
    while (authorizedEntries.size > MAX_AUTHORIZED_REPOS) {
      evictOldestAuthorizedEntry();
    }
  };

  const cacheDiscoveredRepos = (repos) => {
    if (!Array.isArray(repos)) {
      return;
    }
    for (const repo of repos) {
      cacheRepoRecord(repo);
    }
  };

  const refreshAuthorizedDiscovery = async (uris) => {
    if (!Array.isArray(uris) || uris.length === 0) {
      return [];
    }
    const discovered = await discoverRepositories(uris);
    cacheDiscoveredRepos(discovered);
    return discovered;
  };

  const lookupAuthorizedRepo = (targetWtKey, repoId, allowBare) => {
    let matched = null;
    if (targetWtKey) {
      matched = authorizedByWorktreeKey.get(targetWtKey) ?? null;
      if (!matched && allowBare) {
        matched = authorizedByCommonDirKey.get(targetWtKey) ?? null;
      }
    }
    if (!matched && repoId) {
      matched = authorizedById.get(repoId) ?? null;
    }
    return matched;
  };

  const resolveAuthorizedRepo = async ({ worktreePath, repoId, workspaceUris, allowBare = false }) => {
    if (!worktreePath && !repoId) {
      if (allowBare && currentActiveRepo?.isBare) {
        return currentActiveRepo;
      }
      throw new AppError(ERROR_CODES.INVALID_REQUEST, 'worktreePath or repoId is required.');
    }

    const targetWtKey = worktreePath ? toPathKey(worktreePath) : null;
    if (worktreePath && !targetWtKey) {
      throw new AppError(ERROR_CODES.INVALID_REQUEST, 'Invalid worktreePath.');
    }

    let matched = lookupAuthorizedRepo(targetWtKey, repoId, allowBare);

    if (!matched && Array.isArray(workspaceUris) && workspaceUris.length > 0) {
      // Sidecar 重启或缓存淘汰后，基于调用方当前会话工作区 URI 按需重新验证并补录授权
      await refreshAuthorizedDiscovery(workspaceUris);
      matched = lookupAuthorizedRepo(targetWtKey, repoId, allowBare);
    }

    // 多仓或直连调用时若命中已知摘要或冷启动尚无缓存，则按最近工作区上下文补全探测
    const knownInSummaries = !matched && lastDiscoveredSummaries.some((item) => (
      (targetWtKey && item.worktreePath && toPathKey(item.worktreePath) === targetWtKey) ||
      (repoId && item.id === repoId)
    ));
    const shouldBootstrapFromDefault = !matched && authorizedEntries.size === 0 && lastWorkspaceUris.length > 0;

    if (knownInSummaries || shouldBootstrapFromDefault) {
      await refreshAuthorizedDiscovery(lastWorkspaceUris);
      matched = lookupAuthorizedRepo(targetWtKey, repoId, allowBare);
    }

    if (!matched) {
      throw new AppError(
        ERROR_CODES.NO_REPOSITORY,
        '目标仓库或工作树不在当前已发现的 Workspace 范围内。',
      );
    }

    if (matched.isBare && !allowBare) {
      throw new AppError(
        ERROR_CODES.NO_REPOSITORY,
        '裸仓库（bare）不支持工作区修改或分支推送拉取操作。',
      );
    }

    return matched;
  };

  const handleSnapshot = async (rawBody, context) => {
    const body = assertPlainObject(rawBody);
    const providedUris = assertWorkspaceUris(body.workspaceUris);
    const selectedRepoId = assertOptionalNonEmptyString(body.selectedRepoId, 'selectedRepoId');
    const forceRefresh = assertOptionalBoolean(body.forceRefresh, 'forceRefresh') ?? false;

    if (body.graphScope !== undefined && body.graphScope !== 'auto' && body.graphScope !== 'all') {
      throw new AppError(ERROR_CODES.INVALID_REQUEST, `Invalid graphScope: ${String(body.graphScope)}`);
    }
    if (body.graphLimit !== undefined && (typeof body.graphLimit !== 'number' || !Number.isFinite(body.graphLimit) || body.graphLimit < 1)) {
      throw new AppError(ERROR_CODES.INVALID_REQUEST, 'graphLimit must be a positive number.');
    }

    const preferences = await preferencesStore.load();
    const graphScope = body.graphScope ?? preferences.graphScope ?? 'auto';
    const graphLimit = body.graphLimit ?? DEFAULT_GRAPH_LIMIT;

    if (context?.fixture === 'mock') {
      const mockSnapshot = mockFixture.getSnapshot(
        {
          selectedRepoId,
          graphScope,
          graphLimit,
        },
        preferences,
      );
      recordWorkspaceSession(mockSnapshot.workspaceKey, null);
      return mockSnapshot;
    }

    let effectiveUris;
    if (providedUris === undefined) {
      effectiveUris = [...defaultWorkspaceUris];
    } else if (providedUris.length === 0 && isStandalone) {
      effectiveUris = [...defaultWorkspaceUris];
    } else {
      effectiveUris = providedUris;
    }

    snapshotSeq += 1;
    const reqSeq = snapshotSeq;

    // 在启动只读 Git 查询前锁定基准 revision，并在发现目标仓库后、执行 git status 前立即挂载 watcher，
    // 防止冷启动/切仓期间 git status 与 watcher 挂载之间的盲区漏掉文件变更。
    const snapshotStartRevision = eventBus.revision;
    const snapshotBase = await discoverAndBuildSnapshotBase({
      workspaceUris: effectiveUris,
      selectedRepoId,
      graphScope,
      graphLimit,
      onActiveRepoDiscovered: (activeDiscovery, discoveredRepos) => {
        cacheDiscoveredRepos(discoveredRepos);
        if (activeDiscovery || reqSeq === snapshotSeq) {
          watcher.setTarget(activeDiscovery, { forceRefresh });
        }
      },
    });

    if (snapshotBase.activeRepo) {
      cacheRepoRecord(snapshotBase.activeRepo);
      recordWorkspaceSession(snapshotBase.workspaceKey, snapshotBase.activeRepo);
      watcher.applyStatusBudget(snapshotBase.changes, snapshotBase.activeRepo);
    }

    // 仅最新快照更新默认回退上下文，避免并发乱序覆盖
    if (reqSeq === snapshotSeq) {
      lastWorkspaceUris = [...effectiveUris];
      lastDiscoveredSummaries = snapshotBase.repositories;
      currentActiveRepo = snapshotBase.activeRepo;
    }

    const watchState = snapshotBase.activeRepo
      ? watcher.getWatchState(snapshotBase.activeRepo)
      : { active: false, degraded: false, reason: null };

    const scopedRevision = snapshotBase.workspaceKey
      ? eventBus.getRevision(snapshotBase.workspaceKey)
      : eventBus.revision;
    const changedDuringQuery = scopedRevision > snapshotStartRevision;
    const snapshotRevision = changedDuringQuery ? snapshotStartRevision : scopedRevision;

    return {
      workspaceKey: snapshotBase.workspaceKey,
      revision: snapshotRevision,
      repositories: snapshotBase.repositories,
      activeRepo: snapshotBase.activeRepo,
      changes: snapshotBase.changes,
      graph: snapshotBase.graph,
      watchState,
      preferences,
    };
  };

  // 工作区文件变化只需刷新上区：沿用上次快照记录的仓库，只跑 git status，不再重跑仓库发现、log 与 remote
  const handleStatus = async (rawBody) => {
    const body = assertPlainObject(rawBody);
    const workspaceKey = assertRequiredNonEmptyString(body.workspaceKey, 'workspaceKey');
    const sinceRevision = assertRevision(body.sinceRevision, 'sinceRevision');
    const repo = knownWorkspaces.get(workspaceKey)?.repoTarget;
    if (!repo?.worktreePath) {
      throw new AppError(ERROR_CODES.NO_REPOSITORY, '工作区会话已失效，需要重新加载完整快照。');
    }

    // 版本号在 git status 之前锁定，之后到达的变更由下一轮长轮询补上；
    // 若客户端还有未处理的 full 级变更，则不推进版本号，让下一轮长轮询立即返回 full。
    const revision = eventBus.pendingRefresh(workspaceKey, sinceRevision) === 'full'
      ? sinceRevision
      : eventBus.getRevision(workspaceKey);
    watcher.setTarget(repo);
    const { branchInfo, changes } = await queryWorktreeStatus(repo.worktreePath);
    const watchState = watcher.applyStatusBudget(changes, repo);
    return {
      workspaceKey,
      revision,
      activeRepo: withHeadInfo(repo, branchInfo),
      changes,
      watchState,
    };
  };

  const parseCommitRequest = (rawBody) => {
    const body = assertPlainObject(rawBody);
    const worktreePath = body.worktreePath == null ? null : assertRequiredNonEmptyString(body.worktreePath, 'worktreePath');
    const repoId = assertOptionalNonEmptyString(body.repoId, 'repoId');
    const workspaceUris = assertWorkspaceUris(body.workspaceUris);
    const sha = assertRequiredNonEmptyString(body.sha, 'sha');
    const parentSha = assertOptionalNonEmptyString(body.parentSha, 'parentSha');

    if (!SHA_PATTERN.test(sha) || (parentSha && !SHA_PATTERN.test(parentSha))) {
      throw new AppError(ERROR_CODES.INVALID_REQUEST, 'sha and parentSha must be 7-64 character hexadecimal strings.');
    }
    return { worktreePath, repoId, workspaceUris, sha, parentSha };
  };

  const handleCommitDetail = async (rawBody, context) => {
    const { worktreePath, repoId, workspaceUris, sha, parentSha } = parseCommitRequest(rawBody);
    if (context?.fixture === 'mock') {
      return mockFixture.getCommitDetail({ worktreePath, repoId, sha, parentSha });
    }

    const repo = await resolveAuthorizedRepo({ worktreePath, repoId, workspaceUris, allowBare: true });
    const repoCwd = repo.isBare ? repo.gitCommonDir : repo.worktreePath;
    return queryCommitDetail(repoCwd, sha, {
      parentSha,
      worktreePath: repo.worktreePath,
      isBare: repo.isBare,
    });
  };

  const handleCommitStats = async (rawBody, context) => {
    const { worktreePath, repoId, workspaceUris, sha } = parseCommitRequest(rawBody);
    if (context?.fixture === 'mock') {
      return mockFixture.getCommitStats({ worktreePath, repoId, sha });
    }

    const repo = await resolveAuthorizedRepo({ worktreePath, repoId, workspaceUris, allowBare: true });
    return queryCommitStats(repo.isBare ? repo.gitCommonDir : repo.worktreePath, sha);
  };

  const handleEventsWait = async (rawBody, context) => {
    const body = assertPlainObject(rawBody);
    const workspaceKey = body.workspaceKey === undefined || body.workspaceKey === null
      ? null
      : assertRequiredNonEmptyString(body.workspaceKey, 'workspaceKey');

    const sinceRevision = assertRevision(body.sinceRevision, 'sinceRevision');

    let timeoutMs;
    if (body.timeoutMs !== undefined) {
      if (typeof body.timeoutMs !== 'number' || !Number.isFinite(body.timeoutMs)) {
        throw new AppError(ERROR_CODES.INVALID_REQUEST, 'timeoutMs must be a finite number.');
      }
      timeoutMs = body.timeoutMs;
    }

    // Sidecar 重启、监听目标已被 LRU 淘汰或客户端版本号高于内存版本时立即唤醒重拉快照，
    // 确保已挂载前端面板自动恢复监听与授权上下文；多会话活跃期间通过 workspaceKey 隔离互不干扰。
    const session = workspaceKey ? knownWorkspaces.get(workspaceKey) : null;
    const watcherEvicted = Boolean(
      session?.repoTarget &&
      typeof watcher.touchTarget === 'function' &&
      !watcher.touchTarget(session.repoTarget),
    );
    if ((workspaceKey && !session) || watcherEvicted || sinceRevision > eventBus.revision) {
      return {
        revision: eventBus.getRevision(workspaceKey),
        refresh: 'full',
      };
    }

    return eventBus.waitForEvent({
      sinceRevision,
      timeoutMs,
      signal: context?.signal,
      scopeKey: workspaceKey,
    });
  };

  const handleStage = async (rawBody, context) => {
    const body = assertPlainObject(rawBody);
    const worktreePath = assertRequiredNonEmptyString(body.worktreePath, 'worktreePath');
    const workspaceUris = assertWorkspaceUris(body.workspaceUris);
    const all = assertOptionalBoolean(body.all, 'all') ?? false;
    const paths = assertOptionalStringArray(body.paths, 'paths');

    if (context?.fixture === 'mock') {
      return mockFixture.stage({ worktreePath, all, paths });
    }

    const repo = await resolveAuthorizedRepo({ worktreePath, workspaceUris });
    await stageChanges({
      worktreePath: repo.worktreePath,
      gitCommonDir: repo.gitCommonDir,
      all,
      paths,
    });
    const { revision } = bumpRepoRevision(repo, { repositoryWide: false });
    return { revision };
  };

  const handleUnstage = async (rawBody, context) => {
    const body = assertPlainObject(rawBody);
    const worktreePath = assertRequiredNonEmptyString(body.worktreePath, 'worktreePath');
    const workspaceUris = assertWorkspaceUris(body.workspaceUris);
    const all = assertOptionalBoolean(body.all, 'all') ?? false;
    const paths = assertOptionalStringArray(body.paths, 'paths');

    if (context?.fixture === 'mock') {
      return mockFixture.unstage({ worktreePath, all, paths });
    }

    const repo = await resolveAuthorizedRepo({ worktreePath, workspaceUris });
    await unstageChanges({
      worktreePath: repo.worktreePath,
      gitCommonDir: repo.gitCommonDir,
      all,
      paths,
    });
    const { revision } = bumpRepoRevision(repo, { repositoryWide: false });
    return { revision };
  };

  const handleDiscard = async (rawBody, context) => {
    const body = assertPlainObject(rawBody);
    const worktreePath = assertRequiredNonEmptyString(body.worktreePath, 'worktreePath');
    const workspaceUris = assertWorkspaceUris(body.workspaceUris);
    const allTracked = assertOptionalBoolean(body.allTracked, 'allTracked') ?? false;
    const untracked = assertOptionalBoolean(body.untracked, 'untracked') ?? false;
    const paths = assertOptionalStringArray(body.paths, 'paths');

    if (context?.fixture === 'mock') {
      return mockFixture.discard({ worktreePath, allTracked, paths, untracked });
    }

    const repo = await resolveAuthorizedRepo({ worktreePath, workspaceUris });
    await discardChanges({
      worktreePath: repo.worktreePath,
      gitCommonDir: repo.gitCommonDir,
      allTracked,
      paths,
      untracked,
    });
    const { revision } = bumpRepoRevision(repo, { repositoryWide: false });
    return { revision };
  };

  const handleCommit = async (rawBody, context) => {
    const body = assertPlainObject(rawBody);
    const worktreePath = assertRequiredNonEmptyString(body.worktreePath, 'worktreePath');
    const workspaceUris = assertWorkspaceUris(body.workspaceUris);
    if (typeof body.message !== 'string') {
      throw new AppError(ERROR_CODES.INVALID_REQUEST, 'message must be a string.');
    }
    const autoStageAll = assertOptionalBoolean(body.autoStageAll, 'autoStageAll') ?? false;

    if (context?.fixture === 'mock') {
      return mockFixture.commit({
        worktreePath,
        message: body.message,
        autoStageAll,
      });
    }

    if (body.message.trim().length === 0) {
      throw new AppError(ERROR_CODES.EMPTY_COMMIT_MESSAGE, '提交说明不能为空。');
    }

    const repo = await resolveAuthorizedRepo({ worktreePath, workspaceUris });
    const result = await commitChanges({
      worktreePath: repo.worktreePath,
      gitCommonDir: repo.gitCommonDir,
      message: body.message,
      autoStageAll,
    });
    const { revision } = bumpRepoRevision(repo, { repositoryWide: true });
    return {
      revision,
      sha: result.sha,
    };
  };

  const handleRemoteFetch = async (rawBody, context) => {
    const body = assertPlainObject(rawBody);
    const worktreePath = body.worktreePath == null ? null : assertRequiredNonEmptyString(body.worktreePath, 'worktreePath');
    const repoId = assertOptionalNonEmptyString(body.repoId, 'repoId');
    const workspaceUris = assertWorkspaceUris(body.workspaceUris);

    if (context?.fixture === 'mock') {
      return mockFixture.fetch({ worktreePath, repoId });
    }

    const repo = await resolveAuthorizedRepo({ worktreePath, repoId, workspaceUris, allowBare: true });
    await fetchRepository({
      worktreePath: repo.worktreePath,
      gitCommonDir: repo.gitCommonDir,
    });
    const { revision } = bumpRepoRevision(repo, { repositoryWide: true });
    return { revision };
  };

  const handleRemotePull = async (rawBody, context) => {
    const body = assertPlainObject(rawBody);
    const worktreePath = assertRequiredNonEmptyString(body.worktreePath, 'worktreePath');
    const workspaceUris = assertWorkspaceUris(body.workspaceUris);

    if (context?.fixture === 'mock') {
      return mockFixture.pull({ worktreePath });
    }

    const repo = await resolveAuthorizedRepo({ worktreePath, workspaceUris });
    await pullBranch({
      worktreePath: repo.worktreePath,
      gitCommonDir: repo.gitCommonDir,
    });
    const { revision } = bumpRepoRevision(repo, { repositoryWide: true });
    return { revision };
  };

  const handleRemotePush = async (rawBody, context) => {
    const body = assertPlainObject(rawBody);
    if (body.force || body.forceWithLease) {
      throw new AppError(ERROR_CODES.INVALID_REQUEST, 'V1 禁用 --force 与 --force-with-lease 强制推送。');
    }
    const worktreePath = assertRequiredNonEmptyString(body.worktreePath, 'worktreePath');
    const remote = assertOptionalNonEmptyString(body.remote, 'remote');
    const workspaceUris = assertWorkspaceUris(body.workspaceUris);

    if (context?.fixture === 'mock') {
      return mockFixture.push({ worktreePath, remote });
    }

    const repo = await resolveAuthorizedRepo({ worktreePath, workspaceUris });
    await pushBranch({
      worktreePath: repo.worktreePath,
      gitCommonDir: repo.gitCommonDir,
      remote: remote ?? undefined,
    });
    const { revision } = bumpRepoRevision(repo, { repositoryWide: true });
    return { revision };
  };

  const handleRemoteSync = async (rawBody, context) => {
    const body = assertPlainObject(rawBody);
    const worktreePath = assertRequiredNonEmptyString(body.worktreePath, 'worktreePath');
    const workspaceUris = assertWorkspaceUris(body.workspaceUris);

    if (context?.fixture === 'mock') {
      return mockFixture.sync({ worktreePath });
    }

    const repo = await resolveAuthorizedRepo({ worktreePath, workspaceUris });
    await syncBranch({
      worktreePath: repo.worktreePath,
      gitCommonDir: repo.gitCommonDir,
    });
    const { revision } = bumpRepoRevision(repo, { repositoryWide: true });
    return { revision };
  };

  const handlePreferences = async (rawBody) => {
    const body = assertPlainObject(rawBody);
    const allowedPatch = {};
    if (body.locale !== undefined) {
      allowedPatch.locale = body.locale;
    }
    if (body.graphScope !== undefined) {
      allowedPatch.graphScope = body.graphScope;
    }
    if (body.splitRatio !== undefined) {
      allowedPatch.splitRatio = body.splitRatio;
    }
    return preferencesStore.update(allowedPatch);
  };

  const routeMap = new Map([
    ['/api/snapshot', handleSnapshot],
    ['/api/status', handleStatus],
    ['/api/commit/detail', handleCommitDetail],
    ['/api/commit/stats', handleCommitStats],
    ['/api/events/wait', handleEventsWait],
    ['/api/changes/stage', handleStage],
    ['/api/changes/unstage', handleUnstage],
    ['/api/changes/discard', handleDiscard],
    ['/api/commit', handleCommit],
    ['/api/remote/fetch', handleRemoteFetch],
    ['/api/remote/pull', handleRemotePull],
    ['/api/remote/push', handleRemotePush],
    ['/api/remote/sync', handleRemoteSync],
    ['/api/preferences', handlePreferences],
  ]);

  const dispatch = async (pathname, rawBody, context = {}) => {
    const handler = routeMap.get(pathname);
    if (!handler) {
      const notFound = new AppError(ERROR_CODES.INVALID_REQUEST, `Unknown API route: ${pathname}`, {
        statusCode: 404,
      });
      return { statusCode: 404, body: notFound.toJSON() };
    }

    try {
      const data = await handler(rawBody, context);
      return {
        statusCode: 200,
        body: { ok: true, data },
      };
    } catch (error) {
      const appError = toAppError(error);
      return {
        statusCode: appError.statusCode,
        body: appError.toJSON(),
      };
    }
  };

  return {
    dispatch,
    resolveAffectedWorkspaceKeys,
  };
}
