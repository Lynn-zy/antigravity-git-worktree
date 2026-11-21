export const MIN_WAIT_TIMEOUT_MS = 1000;
export const MAX_WAIT_TIMEOUT_MS = 20_000;
export const DEFAULT_WAIT_TIMEOUT_MS = 20_000;
export const MAX_EVENT_WAITERS = 8;

/**
 * 内存变更事件总线，维护单调递增 `revision` 并协调挂起式长轮询请求（替代流式 SSE）。
 * 支持最多 8 个并发等待者，超限提前唤醒最旧者返回 `changed: false`，避免内存与连接泄漏。
 */
export class EventBus {
  #revision = 1;
  #watchDegraded = false;
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
    this.#minTimeoutMs = options.minTimeoutMs ?? MIN_WAIT_TIMEOUT_MS;
    this.#maxTimeoutMs = options.maxTimeoutMs ?? MAX_WAIT_TIMEOUT_MS;
    this.#maxWaiters = options.maxWaiters ?? MAX_EVENT_WAITERS;
  }

  /**
   * 获取当前内存修订版本号。
   *
   * @returns {number} 单调递增版本号
   */
  get revision() {
    return this.#revision;
  }

  /**
   * 获取当前是否处于文件监听降级态。
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
   * 更新监听降级状态标记（仅更新标记而不主动递增版本号时使用）。
   *
   * @param {boolean} degraded 是否处于降级态
   * @returns {void}
   */
  setWatchDegraded(degraded) {
    this.#watchDegraded = Boolean(degraded);
  }

  /**
   * 递增内存 `revision` 并立即唤醒全部挂起中的长轮询等待者。
   *
   * @param {{ watchDegraded?: boolean }} [options] 可选同步更新的监听降级状态
   * @returns {{ revision: number, watchDegraded: boolean }} 更新后的当前版本号与降级状态
   */
  bumpRevision(options = {}) {
    if (options.watchDegraded !== undefined) {
      this.#watchDegraded = Boolean(options.watchDegraded);
    }
    this.#revision += 1;
    const payload = {
      revision: this.#revision,
      changed: true,
      watchDegraded: this.#watchDegraded,
    };
    this.#flushAllWaiters(payload);
    return {
      revision: this.#revision,
      watchDegraded: this.#watchDegraded,
    };
  }

  /**
   * 同步标记监听状态切换为降级态并立即递增版本号唤醒客户端展示提示。
   *
   * @returns {{ revision: number, watchDegraded: boolean }} 更新后的版本信息
   */
  notifyWatchDegraded() {
    return this.bumpRevision({ watchDegraded: true });
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
   * 若当前 `revision > sinceRevision` 或刚发生状态跳变，则立即返回 `changed: true`。
   *
   * @param {{ sinceRevision: number, timeoutMs?: number, signal?: AbortSignal }} options 等待参数
   * @returns {Promise<{ revision: number, changed: boolean, watchDegraded: boolean }>} 等待结果
   */
  waitForEvent(options) {
    const sinceRevision = options?.sinceRevision ?? 0;
    const clampedTimeoutMs = this.clampTimeoutMs(options?.timeoutMs);

    if (this.#disposed) {
      return Promise.resolve({
        revision: this.#revision,
        changed: false,
        watchDegraded: this.#watchDegraded,
      });
    }

    if (this.#revision > sinceRevision) {
      return Promise.resolve({
        revision: this.#revision,
        changed: true,
        watchDegraded: this.#watchDegraded,
      });
    }

    if (options?.signal?.aborted) {
      return Promise.resolve({
        revision: this.#revision,
        changed: false,
        watchDegraded: this.#watchDegraded,
      });
    }

    return new Promise((resolve) => {
      const waiter = {
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
          revision: this.#revision,
          changed: false,
          watchDegraded: this.#watchDegraded,
        });
      }

      waiter.timer = setTimeout(() => {
        waiter.finish({
          revision: this.#revision,
          changed: false,
          watchDegraded: this.#watchDegraded,
        });
      }, clampedTimeoutMs);
      waiter.timer.unref?.();

      if (options?.signal) {
        waiter.onAbort = () => {
          waiter.finish({
            revision: this.#revision,
            changed: false,
            watchDegraded: this.#watchDegraded,
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
