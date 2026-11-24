export const MIN_WAIT_TIMEOUT_MS = 1000;
export const MAX_WAIT_TIMEOUT_MS = 20_000;
export const DEFAULT_WAIT_TIMEOUT_MS = 20_000;
export const MAX_EVENT_WAITERS = 8;
const MAX_TRACKED_SCOPES = 64;

/**
 * 内存变更事件总线，维护单调递增 `revision`、按工作区作用域隔离的变更版本并协调挂起式长轮询请求。
 * 支持最多 8 个并发等待者，超限提前唤醒最旧者返回 `changed: false`，避免内存与连接泄漏。
 */
export class EventBus {
  #revision = 1;
  #globalBroadcastRevision = 1;
  #watchDegraded = false;
  #scopeRevisions = new Map();
  #scopeDegraded = new Map();
  #waiters = [];
  #minTimeoutMs;
  #maxTimeoutMs;
  #maxWaiters;
  #disposed = false;

  /**
   * 创建事件总线实例。
   *
   * @param {{ initialRevision?: number, minTimeoutMs?: number, maxTimeoutMs?: number, maxWaiters?: number }} [options] 初始化与限流配置
   */
  constructor(options = {}) {
    this.#revision = Number.isInteger(options.initialRevision) && options.initialRevision >= 0
      ? options.initialRevision
      : 1;
    this.#globalBroadcastRevision = this.#revision;
    this.#minTimeoutMs = options.minTimeoutMs ?? MIN_WAIT_TIMEOUT_MS;
    this.#maxTimeoutMs = options.maxTimeoutMs ?? MAX_WAIT_TIMEOUT_MS;
    this.#maxWaiters = options.maxWaiters ?? MAX_EVENT_WAITERS;
  }

  /**
   * 获取当前全局内存修订版本号。
   *
   * @returns {number} 单调递增版本号
   */
  get revision() {
    return this.#revision;
  }

  /**
   * 获取当前全局文件监听降级态。
   *
   * @returns {boolean} 是否降级
   */
  get watchDegraded() {
    return this.#watchDegraded;
  }

  /**
   * 获取当前挂起中的长轮询等待者数量。
   *
   * @returns {number} 挂起请求数
   */
  get pendingCount() {
    return this.#waiters.length;
  }

  /**
   * 获取指定工作区作用域（或全局）的有效修订版本号。
   *
   * @param {string | null | undefined} [scopeKey] 可选工作区标识（`workspaceKey`）
   * @returns {number} 有效修订版本号
   */
  getRevision(scopeKey) {
    if (typeof scopeKey === 'string' && scopeKey.length > 0) {
      return Math.max(this.#globalBroadcastRevision, this.#scopeRevisions.get(scopeKey) ?? 0);
    }
    return this.#revision;
  }

  /**
   * 获取指定工作区作用域（或全局）的监听降级状态。
   *
   * @param {string | null | undefined} [scopeKey] 可选工作区标识（`workspaceKey`）
   * @returns {boolean} 是否处于降级态
   */
  isWatchDegraded(scopeKey) {
    if (typeof scopeKey === 'string' && scopeKey.length > 0 && this.#scopeDegraded.has(scopeKey)) {
      return Boolean(this.#scopeDegraded.get(scopeKey));
    }
    return this.#watchDegraded;
  }

  /**
   * 更新监听降级状态标记（仅更新标记而不主动递增版本号时使用）。
   *
   * @param {boolean} degraded 是否处于降级态
   * @param {string | null | undefined} [scopeKey] 可选工作区标识；传入时仅更新对应作用域
   * @returns {void}
   */
  setWatchDegraded(degraded, scopeKey) {
    const flag = Boolean(degraded);
    if (typeof scopeKey === 'string' && scopeKey.length > 0) {
      this.#setScopeDegraded(scopeKey, flag);
      return;
    }
    this.#watchDegraded = flag;
  }

  /**
   * 递增内存 `revision` 并立即唤醒匹配作用域（或全局）的挂起长轮询等待者。
   *
   * @param {{ watchDegraded?: boolean, scopeKeys?: string[] | null }} [options] 可选降级状态与受影响工作区集合
   * @returns {{ revision: number, watchDegraded: boolean }} 更新后的版本号与降级状态
   */
  bumpRevision(options = {}) {
    const validScopeKeys = Array.isArray(options.scopeKeys)
      ? options.scopeKeys.filter((item) => typeof item === 'string' && item.length > 0)
      : [];

    this.#revision += 1;

    if (validScopeKeys.length > 0) {
      const scopeSet = new Set(validScopeKeys);
      for (const key of scopeSet) {
        this.#setScopeRevision(key, this.#revision);
        if (options.watchDegraded !== undefined) {
          this.#setScopeDegraded(key, Boolean(options.watchDegraded));
        }
      }
      const resolvedDegraded = options.watchDegraded !== undefined
        ? Boolean(options.watchDegraded)
        : this.#watchDegraded;
      this.#flushMatchingWaiters(
        (waiter) => waiter.scopeKey === null || scopeSet.has(waiter.scopeKey),
        (waiter) => ({
          revision: this.#revision,
          changed: true,
          watchDegraded: this.isWatchDegraded(waiter.scopeKey),
        }),
      );
      return {
        revision: this.#revision,
        watchDegraded: resolvedDegraded,
      };
    }

    this.#globalBroadcastRevision = this.#revision;
    if (options.watchDegraded !== undefined) {
      this.#watchDegraded = Boolean(options.watchDegraded);
      this.#scopeDegraded.clear();
    }
    this.#flushAllWaiters({
      revision: this.#revision,
      changed: true,
      watchDegraded: this.#watchDegraded,
    });
    return {
      revision: this.#revision,
      watchDegraded: this.#watchDegraded,
    };
  }

  /**
   * 同步标记监听状态切换为降级态并立即递增版本号唤醒受影响客户端展示提示。
   *
   * @param {{ scopeKeys?: string[] | null }} [options] 可选受影响工作区集合
   * @returns {{ revision: number, watchDegraded: boolean }} 更新后的版本信息
   */
  notifyWatchDegraded(options = {}) {
    return this.bumpRevision({
      watchDegraded: true,
      scopeKeys: options?.scopeKeys,
    });
  }

  /**
   * 钳制长轮询超时参数至安全区间 `[1000, 20000]` 毫秒。
   *
   * @param {number | undefined} rawTimeoutMs 客户端传入的超时毫秒数
   * @returns {number} 钳制后的合法毫秒数
   */
  clampTimeoutMs(rawTimeoutMs) {
    if (typeof rawTimeoutMs !== 'number' || !Number.isFinite(rawTimeoutMs)) {
      return Math.min(this.#maxTimeoutMs, Math.max(this.#minTimeoutMs, DEFAULT_WAIT_TIMEOUT_MS));
    }
    return Math.min(this.#maxTimeoutMs, Math.max(this.#minTimeoutMs, Math.trunc(rawTimeoutMs)));
  }

  /**
   * 挂起等待仓库变化或直到超时。
   * 若目标作用域有效版本号大于 `sinceRevision`，则立即返回 `changed: true`。
   *
   * @param {{ sinceRevision: number, timeoutMs?: number, signal?: AbortSignal, scopeKey?: string | null }} options 等待参数
   * @returns {Promise<{ revision: number, changed: boolean, watchDegraded: boolean }>} 等待结果
   */
  waitForEvent(options) {
    const sinceRevision = options?.sinceRevision ?? 0;
    const clampedTimeoutMs = this.clampTimeoutMs(options?.timeoutMs);
    const scopeKey = typeof options?.scopeKey === 'string' && options.scopeKey.length > 0
      ? options.scopeKey
      : null;

    const currentRev = this.getRevision(scopeKey);
    const currentDegraded = this.isWatchDegraded(scopeKey);

    if (this.#disposed) {
      return Promise.resolve({
        revision: currentRev,
        changed: false,
        watchDegraded: currentDegraded,
      });
    }

    if (currentRev > sinceRevision) {
      return Promise.resolve({
        revision: currentRev,
        changed: true,
        watchDegraded: currentDegraded,
      });
    }

    if (options?.signal?.aborted) {
      return Promise.resolve({
        revision: currentRev,
        changed: false,
        watchDegraded: currentDegraded,
      });
    }

    return new Promise((resolve) => {
      const waiter = {
        scopeKey,
        resolved: false,
        timer: null,
        onAbort: null,
        finish: (result) => {
          if (waiter.resolved) {
            return;
          }
          waiter.resolved = true;
          if (waiter.timer) {
            clearTimeout(waiter.timer);
            waiter.timer = null;
          }
          if (waiter.onAbort && options?.signal) {
            options.signal.removeEventListener('abort', waiter.onAbort);
            waiter.onAbort = null;
          }
          const idx = this.#waiters.indexOf(waiter);
          if (idx !== -1) {
            this.#waiters.splice(idx, 1);
          }
          resolve(result);
        },
      };

      // 超出并发等待上限时唤醒最旧等待者，防止浏览器重试或异常连接泄漏内存
      while (this.#waiters.length >= this.#maxWaiters) {
        const oldest = this.#waiters.shift();
        oldest?.finish({
          revision: this.getRevision(oldest.scopeKey),
          changed: false,
          watchDegraded: this.isWatchDegraded(oldest.scopeKey),
        });
      }

      waiter.timer = setTimeout(() => {
        waiter.finish({
          revision: this.getRevision(scopeKey),
          changed: false,
          watchDegraded: this.isWatchDegraded(scopeKey),
        });
      }, clampedTimeoutMs);
      waiter.timer.unref?.();

      if (options?.signal) {
        waiter.onAbort = () => {
          waiter.finish({
            revision: this.getRevision(scopeKey),
            changed: false,
            watchDegraded: this.isWatchDegraded(scopeKey),
          });
        };
        options.signal.addEventListener('abort', waiter.onAbort, { once: true });
      }

      this.#waiters.push(waiter);
    });
  }

  /**
   * 释放全部挂起中的等待者与定时器（用于服务优雅退出）。
   *
   * @returns {void}
   */
  dispose() {
    this.#disposed = true;
    this.#flushAllWaiters({
      revision: this.#revision,
      changed: false,
      watchDegraded: this.#watchDegraded,
    });
  }

  #setScopeRevision(scopeKey, revision) {
    if (this.#scopeRevisions.has(scopeKey)) {
      this.#scopeRevisions.delete(scopeKey);
    }
    this.#scopeRevisions.set(scopeKey, revision);
    while (this.#scopeRevisions.size > MAX_TRACKED_SCOPES) {
      const oldestKey = this.#scopeRevisions.keys().next().value;
      if (oldestKey === undefined) break;
      this.#scopeRevisions.delete(oldestKey);
      this.#scopeDegraded.delete(oldestKey);
    }
  }

  #setScopeDegraded(scopeKey, degraded) {
    if (this.#scopeDegraded.has(scopeKey)) {
      this.#scopeDegraded.delete(scopeKey);
    }
    this.#scopeDegraded.set(scopeKey, degraded);
    while (this.#scopeDegraded.size > MAX_TRACKED_SCOPES) {
      const oldestKey = this.#scopeDegraded.keys().next().value;
      if (oldestKey === undefined) break;
      this.#scopeDegraded.delete(oldestKey);
    }
  }

  #flushMatchingWaiters(predicate, buildPayload) {
    const matched = this.#waiters.filter(predicate);
    for (const waiter of matched) {
      waiter.finish(buildPayload(waiter));
    }
  }

  #flushAllWaiters(payload) {
    const waiters = this.#waiters.splice(0, this.#waiters.length);
    for (const waiter of waiters) {
      waiter.finish(payload);
    }
  }
}

/**
 * 创建新的 EventBus 实例。
 *
 * @param {{ initialRevision?: number, minTimeoutMs?: number, maxTimeoutMs?: number, maxWaiters?: number }} [options] 配置项
 * @returns {EventBus} 事件总线实例
 */
export function createEventBus(options = {}) {
  return new EventBus(options);
}
