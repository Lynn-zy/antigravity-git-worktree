import fs from 'node:fs';
import path from 'node:path';
import { toPathKey } from './discovery.mjs';

export const METADATA_DEBOUNCE_MS = 200;
export const WORKTREE_DEBOUNCE_MS = 300;
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

    const nextKey = [
      toPathKey(repoTarget.gitCommonDir) ?? repoTarget.gitCommonDir,
      toPathKey(repoTarget.gitDir ?? repoTarget.gitCommonDir) ?? '',
      repoTarget.worktreePath ? (toPathKey(repoTarget.worktreePath) ?? repoTarget.worktreePath) : '',
      repoTarget.isBare ? 'bare' : 'wt',
    ].join('\0');

    if (nextKey === this.#targetKey) {
      if (forceRefresh) {
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

  #teardownAllWatchers() {
    if (this.#metadataTimer) {
      clearTimeout(this.#metadataTimer);
      this.#metadataTimer = null;
    }
    if (this.#worktreeTimer) {
      clearTimeout(this.#worktreeTimer);
      this.#worktreeTimer = null;
    }
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
          onClose?.();
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
        onClose?.();
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
          this.#scheduleMetadataChange();
        },
        () => {
          this.#recomputeActiveFlag();
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
        this.#scheduleMetadataChange();
      },
      () => {
        this.#recomputeActiveFlag();
      },
    );
    if (refsHandle) {
      this.#gitWatchers.push(refsHandle);
    }
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
        this.#recordWorktreeEvent();
      },
      () => {
        this.#worktreeWatcher = null;
        this.#recomputeActiveFlag();
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
    this.#scheduleWorktreeChange();
  }

  #scheduleMetadataChange() {
    if (this.#disposed) {
      return;
    }
    if (this.#metadataTimer) {
      clearTimeout(this.#metadataTimer);
    }
    this.#metadataTimer = setTimeout(() => {
      this.#metadataTimer = null;
      // 同一 git checkout 会先写工作区文件再更新 .git/HEAD；metadata 触发时合并已排队的 worktree 定时器，避免连续触发两次快照
      if (this.#worktreeTimer) {
        clearTimeout(this.#worktreeTimer);
        this.#worktreeTimer = null;
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
    if (this.#worktreeTimer) {
      clearTimeout(this.#worktreeTimer);
    }
    this.#worktreeTimer = setTimeout(() => {
      this.#worktreeTimer = null;
      if (!this.#disposed && !this.#watchState.degraded) {
        this.#onChange({ channel: 'worktree' });
      }
    }, this.#worktreeDebounceMs);
    this.#worktreeTimer.unref?.();
  }

  #triggerDegraded(reason) {
    if (this.#worktreeTimer) {
      clearTimeout(this.#worktreeTimer);
      this.#worktreeTimer = null;
    }
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
