import {
  discoverRepositories,
  normalizeFsPath,
  toPathKey,
} from './discovery.mjs';
import {
  commitChanges,
  discardChanges,
  fetchRepository,
  pullBranch,
  pushBranch,
  stageChanges,
  unstageChanges,
} from './git-mutations.mjs';
import {
  DEFAULT_GRAPH_LIMIT,
  discoverAndBuildSnapshotBase,
  queryCommitDetail,
} from './git-queries.mjs';
import {
  AppError,
  ERROR_CODES,
  toAppError,
} from './git-runner.mjs';

export const API_ROUTES = Object.freeze([
  '/api/snapshot',
  '/api/commit/detail',
  '/api/events/wait',
  '/api/changes/stage',
  '/api/changes/unstage',
  '/api/changes/discard',
  '/api/commit',
  '/api/remote/fetch',
  '/api/remote/pull',
  '/api/remote/push',
  '/api/preferences',
]);

const SHA_PATTERN = /^[0-9a-f]{7,64}$/i;
const CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/;

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

  let currentWorkspaceKey = null;
  let currentActiveRepo = null;
  let lastWorkspaceUris = [...defaultWorkspaceUris];
  let lastDiscoveredSummaries = [];
  const authorizedById = new Map();
  const authorizedByWorktreeKey = new Map();
  const authorizedByCommonDirKey = new Map();

  const cacheRepoRecord = (repo) => {
    if (!repo || !repo.id) {
      return;
    }
    authorizedById.set(repo.id, repo);
    if (repo.worktreePath) {
      const wtKey = toPathKey(repo.worktreePath);
      if (wtKey) {
        authorizedByWorktreeKey.set(wtKey, repo);
      }
    }
    if (repo.gitCommonDir) {
      const commonKey = toPathKey(repo.gitCommonDir);
      if (commonKey) {
        authorizedByCommonDirKey.set(commonKey, repo);
      }
    }
  };

  const refreshAuthorizedDiscovery = async (uris) => {
    const discovered = await discoverRepositories(uris);
    authorizedById.clear();
    authorizedByWorktreeKey.clear();
    authorizedByCommonDirKey.clear();
    for (const repo of discovered) {
      cacheRepoRecord(repo);
    }
    return discovered;
  };

  const resolveAuthorizedRepo = async ({ worktreePath, repoId, allowBare = false }) => {
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

    // 多仓或直连调用时若命中已知摘要但缺少完整 gitCommonDir，则按最近工作区上下文补全探测
    const knownInSummaries = !matched && lastDiscoveredSummaries.some((item) => (
      (targetWtKey && item.worktreePath && toPathKey(item.worktreePath) === targetWtKey) ||
      (repoId && item.id === repoId)
    ));
    const shouldBootstrapFromDefault = !matched && authorizedById.size === 0 && lastWorkspaceUris.length > 0;

    if (knownInSummaries || shouldBootstrapFromDefault) {
      await refreshAuthorizedDiscovery(lastWorkspaceUris);
      if (targetWtKey) {
        matched = authorizedByWorktreeKey.get(targetWtKey) ?? null;
        if (!matched && allowBare) {
          matched = authorizedByCommonDirKey.get(targetWtKey) ?? null;
        }
      }
      if (!matched && repoId) {
        matched = authorizedById.get(repoId) ?? null;
      }
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
          forceRefresh,
        },
        preferences,
      );
      currentWorkspaceKey = mockSnapshot.workspaceKey;
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

    lastWorkspaceUris = [...effectiveUris];

    const snapshotBase = await discoverAndBuildSnapshotBase({
      workspaceUris: effectiveUris,
      selectedRepoId,
      graphScope,
      graphLimit,
    });

    authorizedById.clear();
    authorizedByWorktreeKey.clear();
    authorizedByCommonDirKey.clear();
    lastDiscoveredSummaries = snapshotBase.repositories;
    currentActiveRepo = snapshotBase.activeRepo;
    if (snapshotBase.activeRepo) {
      cacheRepoRecord(snapshotBase.activeRepo);
    }
    currentWorkspaceKey = snapshotBase.workspaceKey;

    if (snapshotBase.activeRepo) {
      watcher.setTarget(snapshotBase.activeRepo, { forceRefresh });
      watcher.applyStatusBudget(snapshotBase.changes);
    } else {
      watcher.setTarget(null);
    }

    const watchState = watcher.getWatchState();
    eventBus.setWatchDegraded(watchState.degraded);

    return {
      workspaceKey: snapshotBase.workspaceKey,
      revision: eventBus.revision,
      repositories: snapshotBase.repositories,
      activeRepo: snapshotBase.activeRepo,
      changes: snapshotBase.changes,
      graph: snapshotBase.graph,
      watchState,
      preferences,
    };
  };

  const handleCommitDetail = async (rawBody, context) => {
    const body = assertPlainObject(rawBody);
    const worktreePath = body.worktreePath == null ? null : assertRequiredNonEmptyString(body.worktreePath, 'worktreePath');
    const repoId = assertOptionalNonEmptyString(body.repoId, 'repoId');
    const sha = assertRequiredNonEmptyString(body.sha, 'sha');

    if (!SHA_PATTERN.test(sha)) {
      throw new AppError(ERROR_CODES.INVALID_REQUEST, 'sha must be a 7-64 character hexadecimal string.');
    }

    if (context?.fixture === 'mock') {
      return mockFixture.getCommitDetail({ worktreePath, repoId, sha });
    }

    const repo = await resolveAuthorizedRepo({ worktreePath, repoId, allowBare: true });
    const repoCwd = repo.isBare ? repo.gitCommonDir : repo.worktreePath;
    return queryCommitDetail(repoCwd, sha, {
      worktreePath: repo.worktreePath,
      isBare: repo.isBare,
    });
  };

  const handleEventsWait = async (rawBody, context) => {
    const body = assertPlainObject(rawBody);
    const workspaceKey = body.workspaceKey === undefined || body.workspaceKey === null
      ? null
      : assertRequiredNonEmptyString(body.workspaceKey, 'workspaceKey');

    const sinceRevision = body.sinceRevision;
    if (typeof sinceRevision !== 'number' || !Number.isInteger(sinceRevision) || sinceRevision < 0) {
      throw new AppError(ERROR_CODES.INVALID_REQUEST, 'sinceRevision must be a non-negative integer.');
    }

    let timeoutMs;
    if (body.timeoutMs !== undefined) {
      if (typeof body.timeoutMs !== 'number' || !Number.isFinite(body.timeoutMs)) {
        throw new AppError(ERROR_CODES.INVALID_REQUEST, 'timeoutMs must be a finite number.');
      }
      timeoutMs = body.timeoutMs;
    }

    if (workspaceKey && currentWorkspaceKey && workspaceKey !== currentWorkspaceKey) {
      return {
        revision: eventBus.revision,
        changed: true,
        watchDegraded: eventBus.watchDegraded,
      };
    }

    return eventBus.waitForEvent({
      sinceRevision,
      timeoutMs,
      signal: context?.signal,
    });
  };

  const handleStage = async (rawBody, context) => {
    const body = assertPlainObject(rawBody);
    const worktreePath = assertRequiredNonEmptyString(body.worktreePath, 'worktreePath');
    const all = assertOptionalBoolean(body.all, 'all') ?? false;
    const paths = assertOptionalStringArray(body.paths, 'paths');

    if (context?.fixture === 'mock') {
      return mockFixture.stage({ worktreePath, all, paths });
    }

    const repo = await resolveAuthorizedRepo({ worktreePath });
    await stageChanges({
      worktreePath: repo.worktreePath,
      gitCommonDir: repo.gitCommonDir,
      all,
      paths,
    });
    const { revision } = eventBus.bumpRevision({ watchDegraded: watcher.getWatchState().degraded });
    return { revision };
  };

  const handleUnstage = async (rawBody, context) => {
    const body = assertPlainObject(rawBody);
    const worktreePath = assertRequiredNonEmptyString(body.worktreePath, 'worktreePath');
    const all = assertOptionalBoolean(body.all, 'all') ?? false;
    const paths = assertOptionalStringArray(body.paths, 'paths');

    if (context?.fixture === 'mock') {
      return mockFixture.unstage({ worktreePath, all, paths });
    }

    const repo = await resolveAuthorizedRepo({ worktreePath });
    await unstageChanges({
      worktreePath: repo.worktreePath,
      gitCommonDir: repo.gitCommonDir,
      all,
      paths,
    });
    const { revision } = eventBus.bumpRevision({ watchDegraded: watcher.getWatchState().degraded });
    return { revision };
  };

  const handleDiscard = async (rawBody, context) => {
    const body = assertPlainObject(rawBody);
    const worktreePath = assertRequiredNonEmptyString(body.worktreePath, 'worktreePath');
    const allTracked = assertOptionalBoolean(body.allTracked, 'allTracked') ?? false;
    const untracked = assertOptionalBoolean(body.untracked, 'untracked') ?? false;
    const paths = assertOptionalStringArray(body.paths, 'paths');

    if (context?.fixture === 'mock') {
      return mockFixture.discard({ worktreePath, allTracked, paths, untracked });
    }

    const repo = await resolveAuthorizedRepo({ worktreePath });
    await discardChanges({
      worktreePath: repo.worktreePath,
      gitCommonDir: repo.gitCommonDir,
      allTracked,
      paths,
      untracked,
    });
    const { revision } = eventBus.bumpRevision({ watchDegraded: watcher.getWatchState().degraded });
    return { revision };
  };

  const handleCommit = async (rawBody, context) => {
    const body = assertPlainObject(rawBody);
    const worktreePath = assertRequiredNonEmptyString(body.worktreePath, 'worktreePath');
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

    const repo = await resolveAuthorizedRepo({ worktreePath });
    const result = await commitChanges({
      worktreePath: repo.worktreePath,
      gitCommonDir: repo.gitCommonDir,
      message: body.message,
      autoStageAll,
    });
    const { revision } = eventBus.bumpRevision({ watchDegraded: watcher.getWatchState().degraded });
    return {
      revision,
      sha: result.sha,
    };
  };

  const handleRemoteFetch = async (rawBody, context) => {
    const body = assertPlainObject(rawBody);
    const worktreePath = body.worktreePath == null ? null : assertRequiredNonEmptyString(body.worktreePath, 'worktreePath');
    const repoId = assertOptionalNonEmptyString(body.repoId, 'repoId');

    if (context?.fixture === 'mock') {
      return mockFixture.fetch({ worktreePath, repoId });
    }

    const repo = await resolveAuthorizedRepo({ worktreePath, repoId, allowBare: true });
    await fetchRepository({
      worktreePath: repo.worktreePath,
      gitCommonDir: repo.gitCommonDir,
    });
    const { revision } = eventBus.bumpRevision({ watchDegraded: watcher.getWatchState().degraded });
    return { revision };
  };

  const handleRemotePull = async (rawBody, context) => {
    const body = assertPlainObject(rawBody);
    const worktreePath = assertRequiredNonEmptyString(body.worktreePath, 'worktreePath');

    if (context?.fixture === 'mock') {
      return mockFixture.pull({ worktreePath });
    }

    const repo = await resolveAuthorizedRepo({ worktreePath });
    await pullBranch({
      worktreePath: repo.worktreePath,
      gitCommonDir: repo.gitCommonDir,
    });
    const { revision } = eventBus.bumpRevision({ watchDegraded: watcher.getWatchState().degraded });
    return { revision };
  };

  const handleRemotePush = async (rawBody, context) => {
    const body = assertPlainObject(rawBody);
    if (body.force || body.forceWithLease) {
      throw new AppError(ERROR_CODES.INVALID_REQUEST, 'V1 禁用 --force 与 --force-with-lease 强制推送。');
    }
    const worktreePath = assertRequiredNonEmptyString(body.worktreePath, 'worktreePath');
    const remote = assertOptionalNonEmptyString(body.remote, 'remote');

    if (context?.fixture === 'mock') {
      return mockFixture.push({ worktreePath, remote });
    }

    const repo = await resolveAuthorizedRepo({ worktreePath });
    await pushBranch({
      worktreePath: repo.worktreePath,
      gitCommonDir: repo.gitCommonDir,
      remote: remote ?? undefined,
    });
    const { revision } = eventBus.bumpRevision({ watchDegraded: watcher.getWatchState().degraded });
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
    ['/api/commit/detail', handleCommitDetail],
    ['/api/events/wait', handleEventsWait],
    ['/api/changes/stage', handleStage],
    ['/api/changes/unstage', handleUnstage],
    ['/api/changes/discard', handleDiscard],
    ['/api/commit', handleCommit],
    ['/api/remote/fetch', handleRemoteFetch],
    ['/api/remote/pull', handleRemotePull],
    ['/api/remote/push', handleRemotePush],
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
    getAuthorizedWorktreePath: (worktreePath) => normalizeFsPath(worktreePath),
  };
}
