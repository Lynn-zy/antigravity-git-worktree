import fs from 'node:fs';
import path from 'node:path';
import { toPathKey } from './discovery.mjs';

export const METADATA_DEBOUNCE_MS = 200;
export const WORKTREE_DEBOUNCE_MS = 300;
export const WORKTREE_MAX_WAIT_MS = 1000;
export const WORKTREE_RETRY_DELAY_MS = 500;
export const MAX_WORKTREE_ERROR_RETRIES = 3;
export const MAX_POOL_TARGETS = 8;
export const STORM_WINDOW_MS = 1000;
export const STORM_EVENT_LIMIT = 200;
export const STATUS_DEGRADE_LIMIT = 2000;

const WATCHED_GIT_ROOT_FILES = new Set([
  'HEAD',
  'packed-refs',
  'index',
  'worktrees',
  'MERGE_HEAD',
  'REBASE_HEAD',
  'CHERRY_PICK_HEAD',
]);

const IGNORED_GIT_FILES = new Set([
  'objects',
  'COMMIT_EDITMSG',
  'MERGE_MSG',
  'SQUASH_MSG',
  'logs',
]);

const IGNORED_WORKTREE_DIRS = new Set([
  '.git',
  'node_modules',
  '.next',
  'dist',
  'build',
  'target',
  '__pycache__',
]);

function buildWatcherTargetKey(repoTarget) {
  if (!repoTarget || !repoTarget.gitCommonDir) {
    return null;
  }
  return [
    toPathKey(repoTarget.gitCommonDir) ?? repoTarget.gitCommonDir,
    toPathKey(repoTarget.gitDir ?? repoTarget.gitCommonDir) ?? '',
    repoTarget.worktreePath ? (toPathKey(repoTarget.worktreePath) ?? repoTarget.worktreePath) : '',
    repoTarget.isBare ? 'bare' : 'wt',
  ].join('\0');
}

function closeWatcherHandle(handle) {
  if (!handle || handle.closed) {
    return;
  }
  handle.closed = true;
  try {
    handle.watcher?.close();
  } catch {
    // 忽略重复关闭或已卸载句柄抛出的异常
  }
}

function isIgnoredGitEventName(filename) {
  if (typeof filename !== 'string' || filename.length === 0) {
    return false;
  }
  const normalized = filename.replaceAll('\\', '/');
  const firstSegment = normalized.split('/')[0];
  if (IGNORED_GIT_FILES.has(firstSegment) || IGNORED_GIT_FILES.has(normalized)) {
    return true;
  }
  if (normalized.endsWith('.lock') || normalized.endsWith('.new')) {
    return true;
  }
  return false;
}

function isRelevantGitRootEvent(filename) {
  if (isIgnoredGitEventName(filename)) {
    return false;
  }
  if (typeof filename !== 'string' || filename.length === 0) {
    return true;
  }
  const normalized = filename.replaceAll('\\', '/');
  const firstSegment = normalized.split('/')[0];
  return WATCHED_GIT_ROOT_FILES.has(firstSegment);
}

function isIgnoredWorktreePath(filename) {
  if (typeof filename !== 'string' || filename.length === 0) {
    return false;
  }
  const segments = filename.replaceAll('\\', '/').split('/');
  for (const segment of segments) {
    const normalized = process.platform === 'win32' ? segment.toLowerCase() : segment;
    if (IGNORED_WORKTREE_DIRS.has(normalized)) {
      return true;
    }
  }
  return false;
}

/**
 * 仅面向当前活跃 `Repository` 与当前命中 `Worktree` 的局部文件系统监听器。
 * 内置 Windows `ReadDirectoryChangesW` 自毁守卫、元数据/工作区双通道防抖、
 * 1 秒 200 次事件风暴熔断与 2000 条变更预算降级，支持 `forceRefresh` 恢复。
 */
export class RepositoryWatcher {
  #watchFn;
  #existsFn;
  #statFn;
  #nowFn;
  #metadataDebounceMs;
  #worktreeDebounceMs;
  #worktreeMaxWaitMs;
  #worktreeRetryDelayMs;
  #maxWorktreeErrorRetries;
  #stormWindowMs;
  #stormEventLimit;
  #statusDegradeLimit;
  #onChange;
  #onDegraded;

  #target = null;
  #targetKey = null;
  #gitWatchers = [];
  #worktreesDirWatcher = null;
  #worktreeWatcher = null;
  #metadataTimer = null;
  #worktreeTimer = null;
  #gitRetryTimer = null;
  #gitRetryCount = 0;
  #worktreeRetryTimer = null;
  #worktreePendingSince = null;
  #worktreeRetryCount = 0;
  #eventSeq = 0;
  #lastMetadataEventSeq = 0;
  #lastWorktreeEventSeq = 0;
  #recentWorktreeEvents = [];
  #watchState = {
    active: false,
    degraded: false,
    reason: null,
  };
  #stats = {
    rawCallbackCount: 0,
    effectiveEventCount: 0,
    selfDestructCount: 0,
  };
  #disposed = false;

  /**
   * 创建仓库文件监听控制器。
   *
   * @param {{
   *   onChange?: (info: { channel: 'metadata' | 'worktree' }) => void,
   *   onDegraded?: (watchState: { active: false, degraded: true, reason: string }) => void,
   *   metadataDebounceMs?: number,
   *   worktreeDebounceMs?: number,
   *   worktreeMaxWaitMs?: number,
   *   worktreeRetryDelayMs?: number,
   *   maxWorktreeErrorRetries?: number,
   *   stormWindowMs?: number,
   *   stormEventLimit?: number,
   *   statusDegradeLimit?: number,
   *   watchFn?: typeof fs.watch,
   *   existsFn?: typeof fs.existsSync,
   *   statFn?: typeof fs.statSync,
   *   nowFn?: () => number
   * }} [options] 回调、防抖阈值与测试注入依赖
   */
  constructor(options = {}) {
    this.#onChange = options.onChange ?? (() => {});
    this.#onDegraded = options.onDegraded ?? (() => {});
    this.#metadataDebounceMs = options.metadataDebounceMs ?? METADATA_DEBOUNCE_MS;
    this.#worktreeDebounceMs = options.worktreeDebounceMs ?? WORKTREE_DEBOUNCE_MS;
    this.#worktreeMaxWaitMs = options.worktreeMaxWaitMs ?? Math.max(this.#worktreeDebounceMs, WORKTREE_MAX_WAIT_MS);
    this.#worktreeRetryDelayMs = options.worktreeRetryDelayMs ?? WORKTREE_RETRY_DELAY_MS;
    this.#maxWorktreeErrorRetries = options.maxWorktreeErrorRetries ?? MAX_WORKTREE_ERROR_RETRIES;
    this.#stormWindowMs = options.stormWindowMs ?? STORM_WINDOW_MS;
    this.#stormEventLimit = options.stormEventLimit ?? STORM_EVENT_LIMIT;
    this.#statusDegradeLimit = options.statusDegradeLimit ?? STATUS_DEGRADE_LIMIT;
    this.#watchFn = options.watchFn ?? fs.watch;
    this.#existsFn = options.existsFn ?? fs.existsSync;
    this.#statFn = options.statFn ?? fs.statSync;
    this.#nowFn = options.nowFn ?? Date.now;
  }

  /**
   * 获取当前监听状态摘要。
   *
   * @returns {{ active: boolean, degraded: boolean, reason: string | null }} 监听状态对象
   */
  getWatchState() {
    return { ...this.#watchState };
  }

  /**
   * 获取当前监听句柄与回调诊断统计（供测试与调试观测）。
   *
   * @returns {{ rawCallbackCount: number, effectiveEventCount: number, selfDestructCount: number, activeHandleCount: number }} 统计快照
   */
  getStats() {
    const activeGitHandles = this.#gitWatchers.filter((item) => !item.closed).length;
    const activeWorktreesDir = this.#worktreesDirWatcher && !this.#worktreesDirWatcher.closed ? 1 : 0;
    const activeWorktree = this.#worktreeWatcher && !this.#worktreeWatcher.closed ? 1 : 0;
    return {
      ...this.#stats,
      activeHandleCount: activeGitHandles + activeWorktreesDir + activeWorktree,
    };
  }

  /**
   * 切换或刷新当前监听的活跃仓库与工作树目标。
   * 目标变化时立即关闭旧监听句柄；`forceRefresh: true` 时重置降级态并尝试恢复工作区监听。
   *
   * @param {{ id?: string, gitCommonDir: string, gitDir: string, worktreePath: string | null, isBare?: boolean } | null} repoTarget 活跃仓库描述或 null
   * @param {{ forceRefresh?: boolean }} [options] 刷新控制选项
   * @returns {{ active: boolean, degraded: boolean, reason: string | null }} 更新后的监听状态
   */
  setTarget(repoTarget, options = {}) {
    if (this.#disposed) {
      return this.getWatchState();
    }

    const forceRefresh = Boolean(options.forceRefresh);
    if (!repoTarget || !repoTarget.gitCommonDir) {
      this.#teardownAllWatchers();
      this.#target = null;
      this.#targetKey = null;
      this.#recentWorktreeEvents = [];
      this.#watchState = { active: false, degraded: false, reason: null };
      return this.getWatchState();
    }

    const nextKey = buildWatcherTargetKey(repoTarget);

    if (nextKey === this.#targetKey) {
      if (forceRefresh) {
        this.#clearGitRetryTimer();
        this.#gitRetryCount = 0;
        this.#clearWorktreeRetryTimer();
        this.#worktreeRetryCount = 0;
        this.#recentWorktreeEvents = [];
        this.#watchState = { active: false, degraded: false, reason: null };
        this.#ensureWorktreeWatcher();
      }
      // 若 .git 监听句柄因临时 EPERM/重命名异常全部关闭，且目录仍存在，自动补挂避免元数据监听失活
      const hasOpenGitWatcher = this.#gitWatchers.some((item) => !item.closed);
      if (!hasOpenGitWatcher && this.#existsFn(this.#target.gitCommonDir)) {
        this.#gitWatchers = [];
        this.#mountGitWatchers();
      }
      if (!this.#watchState.degraded) {
        this.#ensureWorktreesDirWatcher();
        // 非降级状态下若工作区监听句柄曾因瞬时错误关闭，自动补挂恢复文件同步
        this.#ensureWorktreeWatcher();
        this.#recomputeActiveFlag();
      }
      return this.getWatchState();
    }

    this.#teardownAllWatchers();
    this.#target = {
      gitCommonDir: repoTarget.gitCommonDir,
      gitDir: repoTarget.gitDir ?? repoTarget.gitCommonDir,
      worktreePath: repoTarget.isBare ? null : (repoTarget.worktreePath ?? null),
      isBare: Boolean(repoTarget.isBare),
    };
    this.#targetKey = nextKey;
    this.#gitRetryCount = 0;
    this.#worktreeRetryCount = 0;
    this.#recentWorktreeEvents = [];
    this.#watchState = { active: false, degraded: false, reason: null };

    this.#mountGitWatchers();
    this.#ensureWorktreesDirWatcher();
    this.#ensureWorktreeWatcher();
    this.#recomputeActiveFlag();

    return this.getWatchState();
  }

  /**
   * 根据最新 `status` 变更总数判断是否触发 2000 条预算降级。
   * 当 `truncated` 为 true 或 `totalEntries > 2000` 时立即暂停工作区监听并通知降级。
   *
   * @param {{ totalEntries?: number, truncated?: boolean } | null | undefined} changes 快照中的变更统计
   * @returns {{ active: boolean, degraded: boolean, reason: string | null }} 最新监听状态
   */
  applyStatusBudget(changes) {
    if (!this.#target || !this.#target.worktreePath) {
      return this.getWatchState();
    }
    const totalEntries = Number(changes?.totalEntries ?? 0);
    const exceedsBudget = Boolean(changes?.truncated) || totalEntries > this.#statusDegradeLimit;
    if (exceedsBudget) {
      this.#triggerDegraded('too_many_changes');
    }
    return this.getWatchState();
  }

  /**
   * 外部显式触发风暴或预算降级（供集成测试与内部熔断统一复用）。
   *
   * @param {string} [reason='watch_storm'] 降级原因标识
   * @returns {void}
   */
  degrade(reason = 'watch_storm') {
    this.#triggerDegraded(reason);
  }

  /**
   * 彻底释放所有 `fs.watch` 句柄和防抖定时器，进程退出或不再使用时必须调用。
   *
   * @returns {void}
   */
  close() {
    this.#disposed = true;
    this.#teardownAllWatchers();
    this.#target = null;
    this.#targetKey = null;
    this.#recentWorktreeEvents = [];
    this.#watchState = { active: false, degraded: false, reason: null };
  }

  #clearGitRetryTimer() {
    if (this.#gitRetryTimer) {
      clearTimeout(this.#gitRetryTimer);
      this.#gitRetryTimer = null;
    }
  }

  #clearWorktreeRetryTimer() {
    if (this.#worktreeRetryTimer) {
      clearTimeout(this.#worktreeRetryTimer);
      this.#worktreeRetryTimer = null;
    }
  }

  #teardownAllWatchers() {
    if (this.#metadataTimer) {
      clearTimeout(this.#metadataTimer);
      this.#metadataTimer = null;
    }
    if (this.#worktreeTimer) {
      clearTimeout(this.#worktreeTimer);
      this.#worktreeTimer = null;
    }
    this.#worktreePendingSince = null;
    this.#clearGitRetryTimer();
    this.#clearWorktreeRetryTimer();
    for (const handle of this.#gitWatchers) {
      closeWatcherHandle(handle);
    }
    this.#gitWatchers = [];
    closeWatcherHandle(this.#worktreesDirWatcher);
    this.#worktreesDirWatcher = null;
    closeWatcherHandle(this.#worktreeWatcher);
    this.#worktreeWatcher = null;
  }

  #mountSafeWatcher(watchedDir, watchOptions, onEvent, onClose) {
    if (this.#disposed || !watchedDir || !this.#existsFn(watchedDir)) {
      return null;
    }
    const handle = { watcher: null, closed: false };
    try {
      const watcher = this.#watchFn(watchedDir, watchOptions, (eventType, filename) => {
        if (!this.#existsFn(watchedDir) || (typeof filename === 'string' && filename.startsWith('\\\\?\\'))) {
          this.#stats.rawCallbackCount += 1;
          this.#stats.selfDestructCount += 1;
          closeWatcherHandle(handle);
          onClose?.('self_destruct');
          return;
        }
        this.#stats.rawCallbackCount += 1;
        if (handle.closed || this.#disposed) {
          return;
        }
        onEvent(eventType, filename);
      });
      handle.watcher = watcher;
      watcher.on?.('error', () => {
        closeWatcherHandle(handle);
        onClose?.('error');
      });
      return handle;
    } catch {
      handle.closed = true;
      return null;
    }
  }

  #mountGitWatchers() {
    if (!this.#target) {
      return;
    }
    const { gitCommonDir, gitDir } = this.#target;
    const seenGitRoots = new Set();
    const mountRootAndRefs = (dir, isCommonRoot) => {
      const key = toPathKey(dir) ?? dir;
      if (seenGitRoots.has(key)) {
        return;
      }
      seenGitRoots.add(key);

      const rootHandle = this.#mountSafeWatcher(
        dir,
        { recursive: false },
        (_eventType, filename) => {
          if (!isRelevantGitRootEvent(filename)) {
            return;
          }
          if (isCommonRoot && (!filename || filename.toLowerCase() === 'worktrees')) {
            this.#syncWorktreesDirWatcher();
          }
          this.#gitRetryCount = 0;
          this.#scheduleMetadataChange();
        },
        (closeReason) => {
          this.#recomputeActiveFlag();
          if (closeReason === 'error') {
            this.#scheduleGitRemount();
          }
        },
      );
      if (rootHandle) {
        this.#gitWatchers.push(rootHandle);
      }
    };

    mountRootAndRefs(gitCommonDir, true);
    if (gitDir && (toPathKey(gitDir) ?? gitDir) !== (toPathKey(gitCommonDir) ?? gitCommonDir)) {
      mountRootAndRefs(gitDir, false);
    }

    const refsDir = path.join(gitCommonDir, 'refs');
    const refsHandle = this.#mountSafeWatcher(
      refsDir,
      { recursive: true },
      (_eventType, filename) => {
        if (isIgnoredGitEventName(filename)) {
          return;
        }
        this.#gitRetryCount = 0;
        this.#scheduleMetadataChange();
      },
      (closeReason) => {
        this.#recomputeActiveFlag();
        if (closeReason === 'error') {
          this.#scheduleGitRemount();
        }
      },
    );
    if (refsHandle) {
      this.#gitWatchers.push(refsHandle);
    }
  }

  #scheduleGitRemount() {
    if (
      this.#disposed ||
      this.#gitRetryTimer ||
      !this.#target?.gitCommonDir ||
      !this.#existsFn(this.#target.gitCommonDir) ||
      this.#gitRetryCount >= this.#maxWorktreeErrorRetries
    ) {
      return;
    }
    const expectedTargetKey = this.#targetKey;
    this.#gitRetryCount += 1;
    this.#gitRetryTimer = setTimeout(() => {
      this.#gitRetryTimer = null;
      if (this.#disposed || this.#targetKey !== expectedTargetKey || !this.#target?.gitCommonDir) {
        return;
      }
      if (!this.#existsFn(this.#target.gitCommonDir)) {
        this.#recomputeActiveFlag();
        return;
      }
      for (const handle of this.#gitWatchers) {
        closeWatcherHandle(handle);
      }
      this.#gitWatchers = [];
      this.#mountGitWatchers();
      this.#recomputeActiveFlag();
      if (this.#gitWatchers.some((item) => !item.closed)) {
        this.#scheduleMetadataChange();
      } else {
        this.#scheduleGitRemount();
      }
    }, this.#worktreeRetryDelayMs);
    this.#gitRetryTimer.unref?.();
  }

  #syncWorktreesDirWatcher() {
    if (!this.#target) {
      return;
    }
    const worktreesDir = path.join(this.#target.gitCommonDir, 'worktrees');
    if (!this.#existsFn(worktreesDir)) {
      if (this.#worktreesDirWatcher) {
        closeWatcherHandle(this.#worktreesDirWatcher);
        this.#worktreesDirWatcher = null;
      }
      return;
    }
    if (this.#worktreesDirWatcher && !this.#worktreesDirWatcher.closed) {
      return;
    }
    this.#worktreesDirWatcher = this.#mountSafeWatcher(
      worktreesDir,
      { recursive: true },
      (_eventType, filename) => {
        if (isIgnoredGitEventName(filename)) {
          return;
        }
        this.#scheduleMetadataChange();
      },
      () => {
        this.#worktreesDirWatcher = null;
      },
    );
  }

  #ensureWorktreesDirWatcher() {
    this.#syncWorktreesDirWatcher();
  }

  #scheduleWorktreeRemount() {
    if (
      this.#disposed ||
      this.#watchState.degraded ||
      this.#worktreeRetryTimer ||
      !this.#target?.worktreePath ||
      !this.#existsFn(this.#target.worktreePath)
    ) {
      return;
    }
    if (this.#worktreeRetryCount >= this.#maxWorktreeErrorRetries) {
      this.#triggerDegraded('watch_error');
      return;
    }
    const expectedTargetKey = this.#targetKey;
    this.#worktreeRetryCount += 1;
    this.#worktreeRetryTimer = setTimeout(() => {
      this.#worktreeRetryTimer = null;
      if (this.#disposed || this.#watchState.degraded || this.#targetKey !== expectedTargetKey) {
        return;
      }
      if (!this.#target?.worktreePath || !this.#existsFn(this.#target.worktreePath)) {
        this.#recomputeActiveFlag();
        return;
      }
      this.#ensureWorktreeWatcher();
      this.#recomputeActiveFlag();
      if (this.#worktreeWatcher && !this.#worktreeWatcher.closed) {
        // 补挂成功后主动触发一次工作区同步，补齐监听中断窗口内的文件变动
        this.#eventSeq += 1;
        this.#lastWorktreeEventSeq = this.#eventSeq;
        this.#scheduleWorktreeChange();
      } else {
        this.#scheduleWorktreeRemount();
      }
    }, this.#worktreeRetryDelayMs);
    this.#worktreeRetryTimer.unref?.();
  }

  #ensureWorktreeWatcher() {
    if (!this.#target || !this.#target.worktreePath || this.#watchState.degraded) {
      return;
    }
    if (this.#worktreeWatcher && !this.#worktreeWatcher.closed) {
      return;
    }
    const wtDir = this.#target.worktreePath;
    this.#worktreeWatcher = this.#mountSafeWatcher(
      wtDir,
      { recursive: true },
      (eventType, filename) => {
        if (isIgnoredWorktreePath(filename)) {
          return;
        }
        if (this.#isDirectoryOnlyChange(wtDir, eventType, filename)) {
          return;
        }
        this.#worktreeRetryCount = 0;
        this.#recordWorktreeEvent();
      },
      (closeReason) => {
        this.#worktreeWatcher = null;
        this.#recomputeActiveFlag();
        if (closeReason === 'error') {
          this.#scheduleWorktreeRemount();
        }
      },
    );
  }

  #isDirectoryOnlyChange(wtDir, eventType, filename) {
    // Windows NTFS 在 git status 扫描刚切出的目录时会触发目录级 change（非 rename），过滤后可消除二次自激快照
    if (eventType !== 'change' || typeof filename !== 'string' || filename.length === 0) {
      return false;
    }
    try {
      return Boolean(this.#statFn(path.join(wtDir, filename))?.isDirectory?.());
    } catch {
      return false;
    }
  }

  #recordWorktreeEvent() {
    if (this.#watchState.degraded || this.#disposed) {
      return;
    }
    this.#stats.effectiveEventCount += 1;
    const now = this.#nowFn();
    const cutoff = now - this.#stormWindowMs;
    this.#recentWorktreeEvents.push(now);
    while (this.#recentWorktreeEvents.length > 0 && this.#recentWorktreeEvents[0] < cutoff) {
      this.#recentWorktreeEvents.shift();
    }
    if (this.#recentWorktreeEvents.length > this.#stormEventLimit) {
      this.#triggerDegraded('watch_storm');
      return;
    }
    this.#eventSeq += 1;
    this.#lastWorktreeEventSeq = this.#eventSeq;
    this.#scheduleWorktreeChange();
  }

  #scheduleMetadataChange() {
    if (this.#disposed) {
      return;
    }
    this.#eventSeq += 1;
    this.#lastMetadataEventSeq = this.#eventSeq;
    if (this.#metadataTimer) {
      clearTimeout(this.#metadataTimer);
    }
    this.#metadataTimer = setTimeout(() => {
      this.#metadataTimer = null;
      // 同一 git checkout 会先写工作区文件再更新 .git/HEAD；仅当工作区事件早于元数据事件时合并定时器，
      // 避免吞掉晚于元数据事件到达的工作区文件改动。
      if (this.#worktreeTimer && this.#lastWorktreeEventSeq < this.#lastMetadataEventSeq) {
        clearTimeout(this.#worktreeTimer);
        this.#worktreeTimer = null;
        this.#worktreePendingSince = null;
      }
      if (!this.#disposed) {
        this.#onChange({ channel: 'metadata' });
      }
    }, this.#metadataDebounceMs);
    this.#metadataTimer.unref?.();
  }

  #scheduleWorktreeChange() {
    if (this.#disposed || this.#watchState.degraded) {
      return;
    }
    const now = this.#nowFn();
    if (this.#worktreePendingSince === null) {
      this.#worktreePendingSince = now;
    }
    const remainingMaxWait = Math.max(0, (this.#worktreePendingSince + this.#worktreeMaxWaitMs) - now);
    const delayMs = Math.min(this.#worktreeDebounceMs, remainingMaxWait);
    if (this.#worktreeTimer) {
      clearTimeout(this.#worktreeTimer);
    }
    this.#worktreeTimer = setTimeout(() => {
      this.#worktreeTimer = null;
      this.#worktreePendingSince = null;
      if (!this.#disposed && !this.#watchState.degraded) {
        this.#onChange({ channel: 'worktree' });
      }
    }, delayMs);
    this.#worktreeTimer.unref?.();
  }

  #triggerDegraded(reason) {
    if (this.#worktreeTimer) {
      clearTimeout(this.#worktreeTimer);
      this.#worktreeTimer = null;
    }
    this.#worktreePendingSince = null;
    this.#clearWorktreeRetryTimer();
    closeWatcherHandle(this.#worktreeWatcher);
    this.#worktreeWatcher = null;
    this.#recentWorktreeEvents = [];

    const alreadyDegradedSameReason =
      this.#watchState.degraded && this.#watchState.reason === reason;
    this.#watchState = {
      active: false,
      degraded: true,
      reason,
    };
    if (!alreadyDegradedSameReason) {
      this.#onDegraded(this.getWatchState());
    }
  }

  #recomputeActiveFlag() {
    if (this.#watchState.degraded) {
      this.#watchState.active = false;
      return;
    }
    if (!this.#target) {
      this.#watchState.active = false;
      return;
    }
    const hasGit = this.#gitWatchers.some((item) => !item.closed);
    const hasWorktree = Boolean(this.#worktreeWatcher && !this.#worktreeWatcher.closed);
    this.#watchState.active = this.#target.isBare ? hasGit : (hasGit || hasWorktree);
  }
}

/**
 * 创建新的 RepositoryWatcher 实例。
 *
 * @param {ConstructorParameters<typeof RepositoryWatcher>[0]} [options] 监听配置
 * @returns {RepositoryWatcher} 文件监听实例
 */
export function createRepositoryWatcher(options = {}) {
  return new RepositoryWatcher(options);
}

/**
 * 面向多会话共享 Sidecar 场景的有界 LRU 多仓库监听池。
 * 每个活跃 `{ gitCommonDir, gitDir, worktreePath, isBare }` 独立维护 `RepositoryWatcher`，
 * 避免后台对话或空工作区快照拆毁当前对话的文件监听，超出上限时自动淘汰最久未活跃目标。
 */
export class RepositoryWatcherPool {
  #watcherOptions;
  #onChange;
  #onDegraded;
  #maxTargets;
  #entries = new Map();
  #lastTargetKey = null;
  #disposed = false;

  /**
   * 创建多目标文件监听池。
   *
   * @param {ConstructorParameters<typeof RepositoryWatcher>[0] & {
   *   maxTargets?: number,
   *   onChange?: (info: { channel: 'metadata' | 'worktree', target: object, watchState: { active: boolean, degraded: boolean, reason: string | null } }) => void,
   *   onDegraded?: (watchState: { active: false, degraded: true, reason: string }, info: { channel: 'degraded', target: object, watchState: { active: false, degraded: true, reason: string } }) => void
   * }} [options] 监听与容量配置
   */
  constructor(options = {}) {
    const { maxTargets, onChange, onDegraded, ...watcherOptions } = options;
    this.#watcherOptions = watcherOptions;
    this.#onChange = onChange ?? (() => {});
    this.#onDegraded = onDegraded ?? (() => {});
    this.#maxTargets = Number.isInteger(maxTargets) && maxTargets >= 1 ? maxTargets : MAX_POOL_TARGETS;
  }

  /**
   * 获取当前池内维护的监听目标数量。
   *
   * @returns {number} 活跃目标数
   */
  get size() {
    return this.#entries.size;
  }

  /**
   * 注册或刷新目标仓库/工作树的监听句柄；传入空目标时不拆毁其他会话的活跃监听。
   *
   * @param {{ id?: string, gitCommonDir: string, gitDir?: string, worktreePath?: string | null, isBare?: boolean } | null} repoTarget 活跃仓库描述或 null
   * @param {{ forceRefresh?: boolean }} [options] 刷新控制选项
   * @returns {{ active: boolean, degraded: boolean, reason: string | null }} 目标监听状态
   */
  setTarget(repoTarget, options = {}) {
    if (this.#disposed) {
      return { active: false, degraded: false, reason: null };
    }
    const targetKey = buildWatcherTargetKey(repoTarget);
    if (!targetKey) {
      return { active: false, degraded: false, reason: null };
    }

    const normalizedTarget = {
      id: repoTarget.id ?? null,
      gitCommonDir: repoTarget.gitCommonDir,
      gitDir: repoTarget.gitDir ?? repoTarget.gitCommonDir,
      worktreePath: repoTarget.isBare ? null : (repoTarget.worktreePath ?? null),
      isBare: Boolean(repoTarget.isBare),
    };

    let entry = this.#entries.get(targetKey);
    if (entry) {
      this.#entries.delete(targetKey);
      entry.target = normalizedTarget;
    } else {
      const targetRef = { current: normalizedTarget };
      const watcher = new RepositoryWatcher({
        ...this.#watcherOptions,
        onChange: (info) => {
          this.#onChange({
            ...info,
            target: targetRef.current,
            watchState: watcher.getWatchState(),
          });
        },
        onDegraded: (watchState) => {
          this.#onDegraded(watchState, {
            channel: 'degraded',
            target: targetRef.current,
            watchState,
          });
        },
      });
      entry = { watcher, targetRef, target: normalizedTarget };
    }

    entry.targetRef.current = normalizedTarget;
    this.#entries.set(targetKey, entry);
    this.#lastTargetKey = targetKey;

    while (this.#entries.size > this.#maxTargets) {
      const oldestKey = this.#entries.keys().next().value;
      if (oldestKey === undefined || oldestKey === targetKey) {
        break;
      }
      const oldest = this.#entries.get(oldestKey);
      this.#entries.delete(oldestKey);
      oldest?.watcher.close();
    }

    return entry.watcher.setTarget(normalizedTarget, options);
  }

  /**
   * 刷新指定监听目标在 LRU 池中的活跃顺序，避免长轮询活跃会话被后台淘汰。
   *
   * @param {{ gitCommonDir: string, gitDir?: string, worktreePath?: string | null, isBare?: boolean } | null | undefined} repoTarget 仓库目标
   * @returns {boolean} 是否命中池内监听
   */
  touchTarget(repoTarget) {
    const targetKey = buildWatcherTargetKey(repoTarget);
    if (!targetKey) {
      return false;
    }
    const entry = this.#entries.get(targetKey);
    if (!entry) {
      return false;
    }
    this.#entries.delete(targetKey);
    this.#entries.set(targetKey, entry);
    return true;
  }

  /**
   * 获取指定目标（省略时取最近操作目标）的监听状态摘要。
   *
   * @param {{ gitCommonDir: string, gitDir?: string, worktreePath?: string | null, isBare?: boolean } | null} [repoTarget] 可选仓库目标
   * @returns {{ active: boolean, degraded: boolean, reason: string | null }} 监听状态对象
   */
  getWatchState(repoTarget) {
    const entry = this.#resolveEntry(repoTarget);
    return entry ? entry.watcher.getWatchState() : { active: false, degraded: false, reason: null };
  }

  /**
   * 对指定目标（省略时取最近操作目标）应用变更条目数预算检查。
   *
   * @param {{ totalEntries?: number, truncated?: boolean } | null | undefined} changes 快照中的变更统计
   * @param {{ gitCommonDir: string, gitDir?: string, worktreePath?: string | null, isBare?: boolean } | null} [repoTarget] 可选仓库目标
   * @returns {{ active: boolean, degraded: boolean, reason: string | null }} 最新监听状态
   */
  applyStatusBudget(changes, repoTarget) {
    const entry = this.#resolveEntry(repoTarget);
    return entry ? entry.watcher.applyStatusBudget(changes) : { active: false, degraded: false, reason: null };
  }

  /**
   * 显式触发指定目标（省略时取最近操作目标）的风暴或预算降级。
   *
   * @param {string} [reason='watch_storm'] 降级原因标识
   * @param {{ gitCommonDir: string, gitDir?: string, worktreePath?: string | null, isBare?: boolean } | null} [repoTarget] 可选仓库目标
   * @returns {void}
   */
  degrade(reason = 'watch_storm', repoTarget) {
    const entry = this.#resolveEntry(repoTarget);
    entry?.watcher.degrade(reason);
  }

  /**
   * 汇总池内所有监听器的句柄与回调统计。
   *
   * @returns {{ rawCallbackCount: number, effectiveEventCount: number, selfDestructCount: number, activeHandleCount: number, targetCount: number }} 汇总统计
   */
  getStats() {
    const totals = {
      rawCallbackCount: 0,
      effectiveEventCount: 0,
      selfDestructCount: 0,
      activeHandleCount: 0,
      targetCount: this.#entries.size,
    };
    for (const entry of this.#entries.values()) {
      const s = entry.watcher.getStats();
      totals.rawCallbackCount += s.rawCallbackCount;
      totals.effectiveEventCount += s.effectiveEventCount;
      totals.selfDestructCount += s.selfDestructCount;
      totals.activeHandleCount += s.activeHandleCount;
    }
    return totals;
  }

  /**
   * 关闭池内全部监听器并释放资源。
   *
   * @returns {void}
   */
  close() {
    this.#disposed = true;
    for (const entry of this.#entries.values()) {
      entry.watcher.close();
    }
    this.#entries.clear();
    this.#lastTargetKey = null;
  }

  #resolveEntry(repoTarget) {
    if (repoTarget !== undefined) {
      const key = buildWatcherTargetKey(repoTarget);
      return key ? (this.#entries.get(key) ?? null) : null;
    }
    return this.#lastTargetKey ? (this.#entries.get(this.#lastTargetKey) ?? null) : null;
  }
}

/**
 * 创建多目标共享 Sidecar 文件监听池实例。
 *
 * @param {ConstructorParameters<typeof RepositoryWatcherPool>[0]} [options] 监听池配置
 * @returns {RepositoryWatcherPool} 文件监听池实例
 */
export function createWatcherPool(options = {}) {
  return new RepositoryWatcherPool(options);
}
