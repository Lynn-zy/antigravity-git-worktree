import { spawn } from 'node:child_process';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const ERROR_CODES = Object.freeze({
  INVALID_REQUEST: 'INVALID_REQUEST',
  OUT_OF_WORKTREE: 'OUT_OF_WORKTREE',
  NO_REPOSITORY: 'NO_REPOSITORY',
  CONFLICT_BLOCKED: 'CONFLICT_BLOCKED',
  EMPTY_COMMIT_MESSAGE: 'EMPTY_COMMIT_MESSAGE',
  NOTHING_TO_COMMIT: 'NOTHING_TO_COMMIT',
  GIT_LOCKED: 'GIT_LOCKED',
  GIT_TIMEOUT: 'GIT_TIMEOUT',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  NON_FAST_FORWARD: 'NON_FAST_FORWARD',
  NO_REMOTE: 'NO_REMOTE',
  GIT_ERROR: 'GIT_ERROR',
});

export const ERROR_HTTP_STATUS = Object.freeze({
  [ERROR_CODES.INVALID_REQUEST]: 400,
  [ERROR_CODES.EMPTY_COMMIT_MESSAGE]: 400,
  [ERROR_CODES.AUTH_REQUIRED]: 401,
  [ERROR_CODES.OUT_OF_WORKTREE]: 403,
  [ERROR_CODES.NO_REPOSITORY]: 409,
  [ERROR_CODES.CONFLICT_BLOCKED]: 409,
  [ERROR_CODES.NOTHING_TO_COMMIT]: 409,
  [ERROR_CODES.GIT_LOCKED]: 409,
  [ERROR_CODES.NON_FAST_FORWARD]: 409,
  [ERROR_CODES.NO_REMOTE]: 409,
  [ERROR_CODES.GIT_TIMEOUT]: 504,
  [ERROR_CODES.GIT_ERROR]: 500,
});

export const READ_TIMEOUT_MS = 10_000;
export const NETWORK_TIMEOUT_MS = 45_000;
export const READ_POOL_CONCURRENCY = 4;
export const LOCK_RETRY_DELAYS_MS = Object.freeze([80, 200, 400]);

export const GIT_LOCK_ERROR_PATTERN = /Unable to create '([^']*\.lock)': File exists\./i;

const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/;

const AUTH_REQUIRED_PATTERNS = [
  /terminal prompts disabled/i,
  /Cannot prompt because user interactivity has been disabled/i,
  /could not read (?:Username|Password) for/i,
  /Authentication failed/i,
  /Permission denied \(publickey/i,
  /Host key verification failed/i,
  /Logon failed/i,
  /Invalid username or (?:password|token)/i,
  /bad credentials/i,
  /unable to access.*returned error:\s*401/i,
  /fatal:.*(?:401|403|unauthorized|forbidden)/i,
  /GIT_ASKPASS|SSH_ASKPASS|GCM_INTERACTIVE/i,
];

const NON_FAST_FORWARD_PATTERNS = [
  /Not possible to fast-forward/i,
  /non-fast-forward/i,
  /\[rejected\].*\(fetch first\)/i,
  /\[rejected\].*\(non-fast-forward\)/i,
  /Updates were rejected because the (?:remote contains work|tip of your current branch is behind)/i,
];

/**
 * 根据标准错误码查询对应的 HTTP 状态码。
 *
 * @param {string} code 错误码（来自 ERROR_CODES）
 * @returns {number} HTTP 状态码（400/401/403/409/504/500）
 */
export function getHttpStatusForErrorCode(code) {
  return ERROR_HTTP_STATUS[code] ?? 500;
}

/**
 * 统一后端应用错误类，携带标准错误码、HTTP 状态码与原始诊断细节。
 */
export class AppError extends Error {
  /**
   * 构造统一应用错误实例。
   *
   * @param {string} code 标准错误码（来自 ERROR_CODES）
   * @param {string} message 面向调用方/前端的错误描述
   * @param {{ detail?: unknown, statusCode?: number, cause?: unknown }} [options] 附加详情与底层原因
   */
  constructor(code, message, options = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.code = code || ERROR_CODES.GIT_ERROR;
    this.detail = options.detail == null ? '' : String(options.detail);
    this.statusCode = options.statusCode ?? getHttpStatusForErrorCode(this.code);
  }

  /**
   * 序列化为规格 5.1 统一错误响应载荷。
   *
   * @returns {{ ok: false, error: { code: string, message: string, detail: string } }} 响应对象
   */
  toJSON() {
    return {
      ok: false,
      error: {
        code: this.code,
        message: this.message,
        detail: this.detail,
      },
    };
  }
}

/**
 * 将任意捕获的异常归一化为 AppError 实例。
 *
 * @param {unknown} error 原始异常对象
 * @param {string} [fallbackMessage] 兜底错误消息
 * @returns {AppError} 归一化后的 AppError
 */
export function toAppError(error, fallbackMessage = 'Git operation failed.') {
  if (error instanceof AppError) {
    return error;
  }
  const message = error instanceof Error && error.message ? error.message : fallbackMessage;
  const detail = error instanceof Error ? (error.stack || error.message) : String(error ?? '');
  return new AppError(ERROR_CODES.GIT_ERROR, message, { detail, cause: error });
}

/**
 * 全局有界并发池，用于限制只读 Git 进程的最大并行数量。
 */
export class ConcurrencyPool {
  #maxConcurrency;
  #activeCount = 0;
  #waiters = [];

  /**
   * 创建有界并发池实例。
   *
   * @param {number} [maxConcurrency=READ_POOL_CONCURRENCY] 最大同时执行任务数
   */
  constructor(maxConcurrency = READ_POOL_CONCURRENCY) {
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
      throw new AppError(ERROR_CODES.INVALID_REQUEST, 'maxConcurrency must be a positive integer.');
    }
    this.#maxConcurrency = maxConcurrency;
  }

  /**
   * 当前正在执行的任务数量。
   *
   * @returns {number} 活跃任务数
   */
  get activeCount() {
    return this.#activeCount;
  }

  /**
   * 当前正在排队等待槽位的任务数量。
   *
   * @returns {number} 等待任务数
   */
  get pendingCount() {
    return this.#waiters.length;
  }

  /**
   * 在并发池限额内执行异步任务，槽位释放时直接移交给队首等待者。
   *
   * @template T
   * @param {() => Promise<T>} task 待执行的异步任务
   * @returns {Promise<T>} 任务执行结果
   */
  async run(task) {
    if (this.#activeCount < this.#maxConcurrency) {
      this.#activeCount += 1;
    } else {
      // 由释放方保持 #activeCount 不减并直接移交槽位，防止唤醒间隙被同步插入的任务超额抢占
      await new Promise((resolve) => this.#waiters.push(resolve));
    }

    try {
      return await task();
    } finally {
      const nextResolve = this.#waiters.shift();
      if (nextResolve) {
        nextResolve();
      } else {
        this.#activeCount -= 1;
      }
    }
  }
}

/**
 * 按键串行化的写任务队列，保证相同资源键的操作严格 FIFO 顺序执行且失败不阻塞后续任务。
 */
export class KeyedSerialQueue {
  #tails = new Map();

  /**
   * 当前仍存在排队或活跃任务的键数量。
   *
   * @returns {number} 队列键数量
   */
  get size() {
    return this.#tails.size;
  }

  /**
   * 将任务排入指定键对应的串行队列。
   *
   * @template T
   * @param {string} key 队列键
   * @param {() => Promise<T>} task 待执行的异步任务
   * @returns {Promise<T>} 任务返回值
   */
  async enqueue(key, task) {
    if (typeof key !== 'string' || key.length === 0) {
      throw new AppError(ERROR_CODES.INVALID_REQUEST, 'Queue key must be a non-empty string.');
    }
    const previous = this.#tails.get(key) ?? Promise.resolve();
    const current = previous.then(() => task());
    const settled = current.catch(() => {});
    this.#tails.set(key, settled);
    try {
      return await current;
    } finally {
      if (this.#tails.get(key) === settled) {
        this.#tails.delete(key);
      }
    }
  }
}

const readPool = new ConcurrencyPool(READ_POOL_CONCURRENCY);
const worktreeWriteQueue = new KeyedSerialQueue();
const repositoryWriteQueue = new KeyedSerialQueue();

/**
 * 将本地目录路径规范化为稳定的队列键，避免大小写或尾部斜杠差异导致锁分叉。
 *
 * @param {string} targetPath Worktree 或 Repository 目录路径
 * @returns {string} 规范化队列键
 */
export function normalizeQueueKey(targetPath) {
  if (typeof targetPath !== 'string' || targetPath.trim().length === 0 || targetPath.includes('\0')) {
    throw new AppError(ERROR_CODES.INVALID_REQUEST, 'Queue target path must be a non-empty valid string.');
  }
  const resolved = path.resolve(targetPath).replaceAll('\\', '/');
  const trimmed = resolved.length > 1 && !/^[A-Za-z]:\/$/.test(resolved)
    ? resolved.replace(/\/+$/, '')
    : resolved;
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
}

/**
 * 在 Worktree 级串行写队列中执行任务（适用于 stage/unstage/discard）。
 *
 * @template T
 * @param {string} worktreePath Worktree 根目录路径
 * @param {() => Promise<T>} task 异步写任务
 * @returns {Promise<T>} 任务返回值
 */
export function enqueueWorktreeWrite(worktreePath, task) {
  return worktreeWriteQueue.enqueue(normalizeQueueKey(worktreePath), task);
}

/**
 * 在 Repository 级串行写队列中执行任务（适用于 commit/fetch/pull/push）。
 *
 * @template T
 * @param {string} gitCommonDir Repository 公共 .git 目录路径
 * @param {() => Promise<T>} task 异步写任务
 * @returns {Promise<T>} 任务返回值
 */
export function enqueueRepositoryWrite(gitCommonDir, task) {
  return repositoryWriteQueue.enqueue(normalizeQueueKey(gitCommonDir), task);
}

/**
 * 同时持有 Repository 级与 Worktree 级双锁执行组合任务（供 commit autoStageAll 等复用）。
 * 严格固定按 Repository -> Worktree 顺序加锁，避免与单锁任务形成循环等待死锁。
 *
 * @template T
 * @param {string} gitCommonDir Repository 公共 .git 目录路径
 * @param {string} worktreePath Worktree 根目录路径
 * @param {() => Promise<T>} task 异步组合写任务
 * @returns {Promise<T>} 任务返回值
 */
export function enqueueRepositoryAndWorktreeWrite(gitCommonDir, worktreePath, task) {
  const repoKey = normalizeQueueKey(gitCommonDir);
  const worktreeKey = normalizeQueueKey(worktreePath);
  return repositoryWriteQueue.enqueue(repoKey, () => worktreeWriteQueue.enqueue(worktreeKey, task));
}

/**
 * 在全局只读并发池（上限 4）中调度任务执行。
 *
 * @template T
 * @param {() => Promise<T>} task 只读异步任务
 * @returns {Promise<T>} 任务返回值
 */
export function runInReadPool(task) {
  return readPool.run(task);
}

/**
 * 返回当前并发池与两级写队列的状态快照，用于诊断与测试。
 *
 * @returns {{ readActiveCount: number, readPendingCount: number, worktreeQueueCount: number, repositoryQueueCount: number }} 状态统计
 */
export function getSchedulerStats() {
  return {
    readActiveCount: readPool.activeCount,
    readPendingCount: readPool.pendingCount,
    worktreeQueueCount: worktreeWriteQueue.size,
    repositoryQueueCount: repositoryWriteQueue.size,
  };
}

/**
 * 校验传入 Git CLI 的参数不含空字节或非法控制字符。
 *
 * @param {string} value 待校验参数值
 * @param {string} [label='argument'] 参数名称描述
 * @returns {string} 校验通过的原字符串
 */
export function assertValidGitArg(value, label = 'argument') {
  if (typeof value !== 'string' || value.length === 0 || CONTROL_CHAR_PATTERN.test(value)) {
    throw new AppError(ERROR_CODES.INVALID_REQUEST, `Invalid git ${label}.`);
  }
  return value;
}

/**
 * 构建固定前置 Git 全局参数；只读命令额外附加 --no-optional-locks。
 *
 * @param {{ readOnly?: boolean }} [options] 配置项
 * @returns {string[]} 全局参数数组
 */
export function buildGitGlobalPrefix({ readOnly = true } = {}) {
  const prefix = [
    '-c',
    'core.quotepath=false',
    '-c',
    'i18n.logOutputEncoding=utf-8',
    '--no-pager',
  ];
  if (readOnly) {
    prefix.push('--no-optional-locks');
  }
  return prefix;
}

/**
 * 为参数列表追加 `--end-of-options` 及数据驱动的 ref/branch/remote/sha 参数。
 *
 * @param {string[]} args 已有命令参数数组
 * @param {string[]} [refs=[]] 引用或版本参数列表
 * @returns {string[]} 拼接后的新参数数组
 */
export function appendEndOfOptions(args, refs = []) {
  const result = [...args];
  if (!refs || refs.length === 0) {
    return result;
  }
  result.push('--end-of-options');
  for (const ref of refs) {
    result.push(assertValidGitArg(ref, 'ref'));
  }
  return result;
}

/**
 * 为参数列表追加 `--` 及路径参数，隔离以 `-` 开头的特殊文件名。
 *
 * @param {string[]} args 已有命令参数数组
 * @param {string[]} [paths=[]] 文件路径参数列表
 * @returns {string[]} 拼接后的新参数数组
 */
export function appendPathspecs(args, paths = []) {
  const result = [...args];
  if (!paths || paths.length === 0) {
    return result;
  }
  result.push('--');
  for (const filePath of paths) {
    result.push(assertValidGitArg(filePath, 'path'));
  }
  return result;
}

/**
 * 按统一参数隔离契约组装 Git 子命令参数：`[subcommand, ...flags, --end-of-options ...refs, -- ...paths]`。
 *
 * @param {string} subcommand Git 子命令名称
 * @param {{ flags?: string[], refs?: string[], paths?: string[] }} [options] 选项、引用与路径参数
 * @returns {string[]} 组装完成的参数列表
 */
export function buildGitArgs(subcommand, { flags = [], refs = [], paths = [] } = {}) {
  const validSubcommand = assertValidGitArg(subcommand, 'subcommand');
  const baseArgs = [validSubcommand];
  for (const flag of flags) {
    baseArgs.push(assertValidGitArg(flag, 'flag'));
  }
  const withRefs = appendEndOfOptions(baseArgs, refs);
  return appendPathspecs(withRefs, paths);
}

/**
 * 构建 Git 子进程环境变量，按需注入只读锁禁用或非交互网络凭据变量。
 *
 * @param {{ readOnly?: boolean, network?: boolean, env?: Record<string, string | undefined> }} [options] 环境选项
 * @returns {Record<string, string | undefined>} 合并后的环境变量对象
 */
export function buildGitEnv({ readOnly = false, network = false, env = {} } = {}) {
  const merged = { ...process.env, ...env };
  if (readOnly) {
    merged.GIT_OPTIONAL_LOCKS = '0';
  }
  if (network) {
    merged.GIT_TERMINAL_PROMPT = '0';
    merged.GCM_INTERACTIVE = 'never';
    merged.GIT_ASKPASS = '';
    merged.SSH_ASKPASS_REQUIRE = 'never';
    if (!merged.GIT_SSH_COMMAND) {
      merged.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes';
    }
  }
  return merged;
}

/**
 * 将 `-z` NUL 分隔的原始 Buffer 按字节 `0x00` 切分后再解码为 UTF-8 字符串数组。
 * 保留内部空串（供 `worktree list --porcelain -z` 识别记录分隔），不额外生成末尾空项。
 *
 * @param {Buffer | Uint8Array | string | null | undefined} input 原始 stdout 数据
 * @returns {string[]} 解码后的 token 数组
 */
export function splitNullTokens(input) {
  if (input == null) {
    return [];
  }
  const buffer = Buffer.isBuffer(input)
    ? input
    : input instanceof Uint8Array
      ? Buffer.from(input.buffer, input.byteOffset, input.byteLength)
      : Buffer.from(String(input), 'utf8');

  const tokens = [];
  let offset = 0;
  while (offset < buffer.length) {
    const nulIndex = buffer.indexOf(0x00, offset);
    if (nulIndex === -1) {
      tokens.push(buffer.subarray(offset).toString('utf8'));
      break;
    }
    tokens.push(buffer.subarray(offset, nulIndex).toString('utf8'));
    offset = nulIndex + 1;
  }
  return tokens;
}

/**
 * 判断 stderr 文本是否属于 Git 瞬时 `.lock: File exists` 锁冲突。
 *
 * @param {string} stderrText Git 错误输出文本
 * @returns {boolean} 是否命中锁冲突特征
 */
export function isGitLockError(stderrText) {
  return typeof stderrText === 'string' && GIT_LOCK_ERROR_PATTERN.test(stderrText);
}

/**
 * 从 stderr 文本中提取冲突 `.lock` 文件路径原文。
 *
 * @param {string} stderrText Git 错误输出文本
 * @returns {string | null} 锁文件路径或 null
 */
export function extractGitLockPath(stderrText) {
  if (typeof stderrText !== 'string') {
    return null;
  }
  const match = stderrText.match(GIT_LOCK_ERROR_PATTERN);
  return match ? match[1] : null;
}

/**
 * 判断非零退出是否为非交互模式下的远端鉴权失败。
 *
 * @param {number | null} exitCode Git 退出码
 * @param {string} stderrText Git 错误输出文本
 * @returns {boolean} 是否应映射为 AUTH_REQUIRED
 */
export function isAuthRequiredError(exitCode, stderrText) {
  if (exitCode !== 128 || typeof stderrText !== 'string') {
    return false;
  }
  return AUTH_REQUIRED_PATTERNS.some((pattern) => pattern.test(stderrText));
}

/**
 * 判断 stderr 文本是否表示远端分支分叉导致的非快进拒绝。
 *
 * @param {string} stderrText Git 错误输出文本
 * @returns {boolean} 是否为 NON_FAST_FORWARD 错误
 */
export function isNonFastForwardError(stderrText) {
  return typeof stderrText === 'string' && NON_FAST_FORWARD_PATTERNS.some((pattern) => pattern.test(stderrText));
}

function classifyGitFailure({ exitCode, stderrText, network }) {
  const detail = stderrText.trim();
  if (isGitLockError(stderrText)) {
    const lockPath = extractGitLockPath(stderrText);
    return new AppError(
      ERROR_CODES.GIT_LOCKED,
      'Git 索引或引用锁文件被占用，请确认没有其他 Git 进程正在运行后重试。',
      { detail: detail || lockPath || '' }
    );
  }
  if (network && isAuthRequiredError(exitCode, stderrText)) {
    return new AppError(
      ERROR_CODES.AUTH_REQUIRED,
      '非交互模式下远端鉴权失败，请在终端完成凭证登录后重试。',
      { detail }
    );
  }
  if (network && isNonFastForwardError(stderrText)) {
    return new AppError(
      ERROR_CODES.NON_FAST_FORWARD,
      '远程分支已领先或与本地分叉，无法快进拉取或推送，请在终端手动合并或变基。',
      { detail }
    );
  }
  return new AppError(
    ERROR_CODES.GIT_ERROR,
    detail || `Git exited with code ${exitCode}.`,
    { detail }
  );
}

function validateArgsArray(args) {
  if (!Array.isArray(args) || args.length === 0) {
    throw new AppError(ERROR_CODES.INVALID_REQUEST, 'Git args must be a non-empty array.');
  }
  for (const arg of args) {
    if (typeof arg !== 'string' || arg.includes('\0')) {
      throw new AppError(ERROR_CODES.INVALID_REQUEST, 'Git arguments must not contain NUL bytes.');
    }
  }
}

function spawnGitProcess(args, options = {}) {
  validateArgsArray(args);

  const {
    cwd,
    env,
    readOnly = true,
    network = false,
    timeoutMs = network ? NETWORK_TIMEOUT_MS : READ_TIMEOUT_MS,
    input = null,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    allowNonZero = false,
    allowExitCodes = [0],
    onStdout = null,
  } = options;

  if (cwd !== undefined && (typeof cwd !== 'string' || cwd.length === 0 || CONTROL_CHAR_PATTERN.test(cwd))) {
    throw new AppError(ERROR_CODES.INVALID_REQUEST, 'Invalid working directory for git execution.');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new AppError(ERROR_CODES.INVALID_REQUEST, 'timeoutMs must be a positive number.');
  }

  const fullArgs = [...buildGitGlobalPrefix({ readOnly }), ...args];
  const childEnv = buildGitEnv({ readOnly, network, env });
  const hasInput = input !== null && input !== undefined;

  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let overflowed = false;
    let stopped = false;
    let totalStdoutBytes = 0;
    let totalStderrBytes = 0;
    const stdoutChunks = [];
    const stderrChunks = [];
    let timeoutTimer = null;
    let forceKillTimer = null;

    const cleanupTimers = () => {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
        forceKillTimer = null;
      }
    };

    const settleOnce = (fn, value) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanupTimers();
      fn(value);
    };

    let child;
    try {
      child = spawn('git', fullArgs, {
        cwd,
        env: childEnv,
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: [hasInput ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      });
    } catch (spawnError) {
      settleOnce(reject, toAppError(spawnError, 'Failed to spawn git process.'));
      return;
    }

    const terminateChildTree = (onTerminated) => {
      let finished = false;
      const done = () => {
        if (finished) {
          return;
        }
        finished = true;
        child.stdout?.destroy();
        child.stderr?.destroy();
        onTerminated();
      };

      const safetyTimer = setTimeout(done, 1500);
      safetyTimer.unref?.();

      if (process.platform === 'win32' && child.pid) {
        // Windows 下 git 会拉起 git-remote-http 等子进程，需整棵进程树强杀以释放目录与锁句柄
        try {
          const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
            shell: false,
            windowsHide: true,
            stdio: 'ignore',
          });
          killer.once('close', () => {
            clearTimeout(safetyTimer);
            done();
          });
          killer.once('error', () => {
            try {
              child.kill('SIGKILL');
            } catch {
              // 忽略进程已退出错误
            }
            child.once('close', () => {
              clearTimeout(safetyTimer);
              done();
            });
          });
        } catch {
          try {
            child.kill('SIGKILL');
          } catch {
            // 忽略进程已退出错误
          }
          child.once('close', () => {
            clearTimeout(safetyTimer);
            done();
          });
        }
        return;
      }

      const targetPid = process.platform !== 'win32' && child.pid ? -child.pid : null;
      try {
        if (targetPid !== null) {
          process.kill(targetPid, 'SIGTERM');
        } else {
          child.kill('SIGTERM');
        }
      } catch {
        // 进程可能已退出
      }
      forceKillTimer = setTimeout(() => {
        try {
          if (targetPid !== null) {
            process.kill(targetPid, 'SIGKILL');
          } else {
            child.kill('SIGKILL');
          }
        } catch {
          // 忽略强制终止时的竞态退出错误
        }
      }, 200);
      forceKillTimer.unref?.();
      child.once('close', () => {
        clearTimeout(safetyTimer);
        done();
      });
    };

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminateChildTree(() => {
        settleOnce(
          reject,
          new AppError(
            ERROR_CODES.GIT_TIMEOUT,
            `Git command timed out after ${timeoutMs}ms.`,
            { detail: `git ${args.join(' ')} (timeout ${timeoutMs}ms)` }
          )
        );
      });
    }, timeoutMs);
    timeoutTimer.unref?.();

    child.stdout.on('data', (chunk) => {
      if (stopped) {
        return;
      }
      if (onStdout) {
        if (onStdout(chunk)) {
          stopped = true;
          terminateChildTree(() => {
            const stderr = Buffer.concat(stderrChunks);
            settleOnce(resolve, {
              exitCode: null,
              stdout: Buffer.alloc(0),
              stderr,
              stdoutText: '',
              stderrText: stderr.toString('utf8'),
            });
          });
        }
        return;
      }
      totalStdoutBytes += chunk.length;
      if (totalStdoutBytes > maxOutputBytes) {
        overflowed = true;
        terminateChildTree(() => {
          settleOnce(
            reject,
            new AppError(ERROR_CODES.GIT_ERROR, 'Git stdout exceeded maximum allowed buffer size.', {
              detail: `Exceeded ${maxOutputBytes} bytes`,
            })
          );
        });
        return;
      }
      stdoutChunks.push(chunk);
    });

    child.stderr.on('data', (chunk) => {
      totalStderrBytes += chunk.length;
      if (totalStderrBytes <= maxOutputBytes) {
        stderrChunks.push(chunk);
      }
    });

    if (hasInput && child.stdin) {
      child.stdin.on('error', () => {
        // Git 提前退出可能触发 EPIPE，交由 close 事件处理真实退出码与 stderr
      });
      child.stdin.end(Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8'));
    }

    child.once('error', (procError) => {
      settleOnce(
        reject,
        new AppError(ERROR_CODES.GIT_ERROR, procError.message || 'Failed to execute git.', {
          detail: procError.stack || procError.message,
          cause: procError,
        })
      );
    });

    child.once('close', (exitCode) => {
      if (settled || timedOut || overflowed || stopped) {
        return;
      }
      const stdout = Buffer.concat(stdoutChunks);
      const stderr = Buffer.concat(stderrChunks);
      const stderrText = stderr.toString('utf8');
      const stdoutText = stdout.toString('utf8');

      if (allowNonZero || allowExitCodes.includes(exitCode)) {
        settleOnce(resolve, { exitCode, stdout, stderr, stdoutText, stderrText });
        return;
      }
      settleOnce(reject, classifyGitFailure({ exitCode, stderrText, network }));
    });
  });
}

async function runWithLockRetries(executor, options = {}) {
  const retryDelays = options.lockRetryDelaysMs ?? LOCK_RETRY_DELAYS_MS;
  const sleepFn = options.sleepFn ?? ((ms) => delay(ms));

  for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
    try {
      return await executor();
    } catch (error) {
      const isLockFailure = error instanceof AppError && error.code === ERROR_CODES.GIT_LOCKED;
      if (!isLockFailure || attempt >= retryDelays.length) {
        throw error;
      }
      await sleepFn(retryDelays[attempt]);
    }
  }
  throw new AppError(ERROR_CODES.GIT_ERROR, 'Unexpected retry loop termination.');
}

function runInConfiguredWriteQueue(options, task) {
  const lockMode = options.lockMode ?? 'worktree';
  if (lockMode === 'none') {
    return task();
  }
  if (lockMode === 'worktree') {
    const worktreeKey = options.worktreePath ?? options.cwd;
    return enqueueWorktreeWrite(worktreeKey, task);
  }
  if (lockMode === 'repository') {
    const repoKey = options.gitCommonDir ?? options.cwd;
    return enqueueRepositoryWrite(repoKey, task);
  }
  if (lockMode === 'both') {
    return enqueueRepositoryAndWorktreeWrite(options.gitCommonDir, options.worktreePath ?? options.cwd, task);
  }
  throw new AppError(ERROR_CODES.INVALID_REQUEST, `Unsupported lockMode: ${lockMode}`);
}

/**
 * 在全局只读并发池中安全执行只读 Git 命令。
 * 自动注入 `--no-optional-locks`、`GIT_OPTIONAL_LOCKS=0` 与 10s 默认硬超时。
 * 传入 `onStdout` 时 stdout 不再缓冲，按块交给回调消费；回调返回 true 时立即结束 git 进程树，
 * 结果中 `exitCode` 为 null、`stdout` 为空。
 *
 * @param {string[]} args 子命令及参数列表
 * @param {{ cwd?: string, env?: Record<string, string | undefined>, timeoutMs?: number, allowNonZero?: boolean, allowExitCodes?: number[], maxOutputBytes?: number, onStdout?: (chunk: Buffer) => boolean }} [options] 执行选项
 * @returns {Promise<{ exitCode: number | null, stdout: Buffer, stderr: Buffer, stdoutText: string, stderrText: string }>} 执行结果
 */
export function runGitRead(args, options = {}) {
  return runInReadPool(() =>
    spawnGitProcess(args, {
      ...options,
      readOnly: true,
      network: false,
      timeoutMs: options.timeoutMs ?? READ_TIMEOUT_MS,
    })
  );
}

/**
 * 在对应级别的串行写队列中执行本地写 Git 命令，并在遭遇 `.lock: File exists` 时按 80/200/400ms 退避重试最多 3 次。
 * 重试仍失败时抛出 `GIT_LOCKED`，绝不删除已有锁文件。
 *
 * @param {string[]} args 子命令及参数列表
 * @param {{ cwd: string, worktreePath?: string, gitCommonDir?: string, lockMode?: 'worktree' | 'repository' | 'both' | 'none', env?: Record<string, string | undefined>, timeoutMs?: number, input?: string | Buffer | null, lockRetryDelaysMs?: number[], sleepFn?: (ms: number) => Promise<void> }} options 执行与加锁选项
 * @returns {Promise<{ exitCode: number | null, stdout: Buffer, stderr: Buffer, stdoutText: string, stderrText: string }>} 执行结果
 */
export function runGitWrite(args, options = {}) {
  return runInConfiguredWriteQueue(options, () =>
    runWithLockRetries(
      () =>
        spawnGitProcess(args, {
          ...options,
          readOnly: false,
          network: false,
          timeoutMs: options.timeoutMs ?? READ_TIMEOUT_MS,
        }),
      options
    )
  );
}

/**
 * 在 Repository 级串行队列中执行远程网络 Git 命令（fetch/pull/push）。
 * 强制注入非交互凭据环境变量与 45s 默认硬超时，自动识别 AUTH_REQUIRED 与 NON_FAST_FORWARD 并支持锁冲突重试。
 *
 * @param {string[]} args 子命令及参数列表
 * @param {{ cwd: string, gitCommonDir?: string, worktreePath?: string, lockMode?: 'repository' | 'both' | 'none', env?: Record<string, string | undefined>, timeoutMs?: number, lockRetryDelaysMs?: number[], sleepFn?: (ms: number) => Promise<void> }} options 执行选项
 * @returns {Promise<{ exitCode: number | null, stdout: Buffer, stderr: Buffer, stdoutText: string, stderrText: string }>} 执行结果
 */
export function runGitNetwork(args, options = {}) {
  const networkOptions = {
    lockMode: 'repository',
    ...options,
  };
  return runInConfiguredWriteQueue(networkOptions, () =>
    runWithLockRetries(
      () =>
        spawnGitProcess(args, {
          ...networkOptions,
          readOnly: false,
          network: true,
          timeoutMs: networkOptions.timeoutMs ?? NETWORK_TIMEOUT_MS,
        }),
      networkOptions
    )
  );
}
