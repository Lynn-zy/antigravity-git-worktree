export const MIN_WAIT_TIMEOUT_MS = 1000;
export const MAX_WAIT_TIMEOUT_MS = 20_000;
export const DEFAULT_WAIT_TIMEOUT_MS = 20_000;
export const MAX_EVENT_WAITERS = 8;
const MAX_TRACKED_SCOPES = 64;

/**
 * 内存变更事件总线，维护单调递增 `revision`、按工作区作用域隔离的变更版本并协调挂起式长轮询请求。
 * 每次变更带刷新级别：`status` 只影响工作区变更列表与分支状态，`full` 还影响提交图谱与远端。
 * 支持最多 8 个并发等待者，超限提前唤醒最旧者返回 `refresh: 'none'`，避免内存与连接泄漏。
 */
export class EventBus {
  #revision = 1;
  #latestFullRevision = 1;
  #globalBroadcastRevision = 1;
  #globalFullBroadcastRevision = 1;
  #scopeRevisions = new Map();
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
    this.#latestFullRevision = this.#revision;
    this.#globalBroadcastRevision = this.#revision;
    this.#globalFullBroadcastRevision = this.#revision;
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
    if (isScopeKey(scopeKey)) {
      return Math.max(this.#globalBroadcastRevision, this.#scopeRevisions.get(scopeKey)?.revision ?? 0);
    }
    return this.#revision;
  }

  /**
   * 计算客户端从 `sinceRevision` 之后需要做哪一级刷新：没有新变更为 `none`，
   * 新变更全部是 `status` 级为 `status`，其中有任意一次 `full` 级变更为 `full`。
   *
   * @param {string | null | undefined} scopeKey 可选工作区标识（`workspaceKey`）
   * @param {number} sinceRevision 客户端已同步到的版本号
   * @returns {'none' | 'status' | 'full'} 需要的刷新级别
   */
  pendingRefresh(scopeKey, sinceRevision) {
    if (this.getRevision(scopeKey) <= sinceRevision) {
      return 'none';
    }
    return this.#getFullRevision(scopeKey) > sinceRevision ? 'full' : 'status';
  }

  /**
   * 递增内存 `revision` 并立即唤醒匹配作用域（或全局）的挂起长轮询等待者。
   *
   * @param {{ scopeKeys?: string[] | null, refresh?: 'status' | 'full' }} [options] 受影响工作区集合（省略时全局广播）与刷新级别（默认 `full`）
   * @returns {{ revision: number }} 更新后的版本号
   */
  bumpRevision(options = {}) {
    const isFull = (options.refresh ?? 'full') === 'full';
    const validScopeKeys = Array.isArray(options.scopeKeys)
      ? options.scopeKeys.filter(isScopeKey)
      : [];

    this.#revision += 1;
    if (isFull) {
      this.#latestFullRevision = this.#revision;
    }

    if (validScopeKeys.length > 0) {
      const scopeSet = new Set(validScopeKeys);
      for (const key of scopeSet) {
        this.#recordScopeRevision(key, isFull);
      }
      this.#flushWaiters((waiter) => waiter.scopeKey === null || scopeSet.has(waiter.scopeKey));
    } else {
      this.#globalBroadcastRevision = this.#revision;
      if (isFull) {
        this.#globalFullBroadcastRevision = this.#revision;
      }
      this.#flushWaiters(() => true);
    }
    return { revision: this.#revision };
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
   * 若目标作用域在 `sinceRevision` 之后已有变更，则立即返回对应刷新级别。
   *
   * @param {{ sinceRevision: number, timeoutMs?: number, signal?: AbortSignal, scopeKey?: string | null }} options 等待参数
   * @returns {Promise<{ revision: number, refresh: 'none' | 'status' | 'full' }>} 等待结果
   */
  waitForEvent(options) {
    const sinceRevision = options?.sinceRevision ?? 0;
    const clampedTimeoutMs = this.clampTimeoutMs(options?.timeoutMs);
    const scopeKey = isScopeKey(options?.scopeKey) ? options.scopeKey : null;

    if (this.#disposed) {
      return Promise.resolve({ revision: this.getRevision(scopeKey), refresh: 'none' });
    }

    const immediate = this.#resultFor(scopeKey, sinceRevision);
    if (immediate.refresh !== 'none' || options?.signal?.aborted) {
      return Promise.resolve(immediate);
    }

    return new Promise((resolve) => {
      const waiter = {
        scopeKey,
        sinceRevision,
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
        oldest?.finish(this.#resultFor(oldest.scopeKey, oldest.sinceRevision));
      }

      waiter.timer = setTimeout(() => {
        waiter.finish(this.#resultFor(scopeKey, sinceRevision));
      }, clampedTimeoutMs);
      waiter.timer.unref?.();

      if (options?.signal) {
        waiter.onAbort = () => {
          waiter.finish(this.#resultFor(scopeKey, sinceRevision));
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
    const waiters = this.#waiters.splice(0, this.#waiters.length);
    for (const waiter of waiters) {
      waiter.finish({ revision: this.getRevision(waiter.scopeKey), refresh: 'none' });
    }
  }

  #getFullRevision(scopeKey) {
    if (isScopeKey(scopeKey)) {
      return Math.max(this.#globalFullBroadcastRevision, this.#scopeRevisions.get(scopeKey)?.fullRevision ?? 0);
    }
    return this.#latestFullRevision;
  }

  #resultFor(scopeKey, sinceRevision) {
    return {
      revision: this.getRevision(scopeKey),
      refresh: this.pendingRefresh(scopeKey, sinceRevision),
    };
  }

  #recordScopeRevision(scopeKey, isFull) {
    const previous = this.#scopeRevisions.get(scopeKey);
    this.#scopeRevisions.delete(scopeKey);
    this.#scopeRevisions.set(scopeKey, {
      revision: this.#revision,
      fullRevision: isFull ? this.#revision : (previous?.fullRevision ?? 0),
    });
    while (this.#scopeRevisions.size > MAX_TRACKED_SCOPES) {
      const oldestKey = this.#scopeRevisions.keys().next().value;
      if (oldestKey === undefined) break;
      this.#scopeRevisions.delete(oldestKey);
    }
  }

  #flushWaiters(predicate) {
    const matched = this.#waiters.filter(predicate);
    for (const waiter of matched) {
      waiter.finish(this.#resultFor(waiter.scopeKey, waiter.sinceRevision));
    }
  }
}

function isScopeKey(value) {
  return typeof value === 'string' && value.length > 0;
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
