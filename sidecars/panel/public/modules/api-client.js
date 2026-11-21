/**
 * Antigravity Git Graph 面板前端 POST JSON API 客户端模块。
 * 所有后端业务接口统一走 POST JSON，并优先使用宿主 window.sidecar.fetch 附带 X-Sidecar-Token。
 */

import { translateApiError } from './i18n.js';

/**
 * 后端 API 请求错误封装，携带规范化错误码、HTTP 状态码与本地化错误描述。
 */
export class ApiClientError extends Error {
  /**
   * 构造 API 客户端错误实例。
   *
   * @param {{
   *   code?: string,
   *   message: string,
   *   detail?: string,
   *   status?: number,
   *   serverMessage?: string
   * }} options 错误上下文信息
   */
  constructor(options) {
    super(options.message);
    this.name = 'ApiClientError';
    this.code = options.code || 'GIT_ERROR';
    this.detail = options.detail || '';
    this.status = Number.isFinite(options.status) ? options.status : 0;
    this.serverMessage = options.serverMessage || '';
  }
}

const resolveDefaultTransport = () => {
  const win = typeof window !== 'undefined' ? window : globalThis;
  if (win?.sidecar && typeof win.sidecar.fetch === 'function') {
    return win.sidecar.fetch.bind(win.sidecar);
  }
  if (typeof win?.fetch === 'function') {
    return win.fetch.bind(win);
  }
  throw new ApiClientError({
    code: 'GIT_ERROR',
    message: 'Fetch transport is unavailable in the current environment.',
  });
};

const resolveApiPath = (pathname) => {
  try {
    const search = globalThis.location?.search ?? '';
    if (search && new URLSearchParams(search).get('fixture') === 'mock') {
      return `${pathname}?fixture=mock`;
    }
  } catch {
    // 忽略受限文档环境对 location.search 的访问异常
  }
  return pathname;
};

const safeParseJson = async (response) => {
  try {
    return await response.json();
  } catch {
    return null;
  }
};

/**
 * 创建绑定语言解析器与网络传输器的后端 API 客户端实例。
 *
 * @param {{
 *   getLocale?: () => string,
 *   transport?: (input: string, init?: RequestInit) => Promise<Response>
 * }} [options] 可选语言读取回调与自定义 fetch 传输器
 * @returns {{
 *   postJson: (pathname: string, body?: Record<string, unknown>, signal?: AbortSignal) => Promise<any>,
 *   fetchSnapshot: (params: Record<string, unknown>, signal?: AbortSignal) => Promise<any>,
 *   fetchCommitDetail: (params: { worktreePath: string, sha: string }, signal?: AbortSignal) => Promise<any>,
 *   waitEvents: (params: { workspaceKey: string, sinceRevision: number, timeoutMs?: number }, signal?: AbortSignal) => Promise<any>,
 *   stageChanges: (params: { worktreePath: string, all?: boolean, paths?: string[] }) => Promise<any>,
 *   unstageChanges: (params: { worktreePath: string, all?: boolean, paths?: string[] }) => Promise<any>,
 *   discardChanges: (params: { worktreePath: string, allTracked?: boolean, paths?: string[], untracked?: boolean }) => Promise<any>,
 *   commitChanges: (params: { worktreePath: string, message: string, autoStageAll?: boolean }) => Promise<any>,
 *   fetchRemotes: (params: { worktreePath: string }) => Promise<any>,
 *   pullBranch: (params: { worktreePath: string }) => Promise<any>,
 *   pushBranch: (params: { worktreePath: string, remote?: string }) => Promise<any>,
 *   savePreferences: (params: { locale?: string, graphScope?: string, splitRatio?: number }) => Promise<any>
 * }} API 客户端方法集合（发起网络请求存在 I/O 副作用）
 */
export const createApiClient = (options = {}) => {
  const getLocale = typeof options.getLocale === 'function' ? options.getLocale : () => 'en';

  const postJson = async (pathname, body = {}, signal) => {
    const transport = typeof options.transport === 'function'
      ? options.transport
      : resolveDefaultTransport();
    const requestUrl = resolveApiPath(pathname);

    let response;
    try {
      response = await transport(requestUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (err?.name === 'AbortError' || signal?.aborted) {
        throw err;
      }
      const locale = getLocale();
      throw new ApiClientError({
        code: 'GIT_ERROR',
        message: translateApiError({ message: err?.message }, locale),
        detail: typeof err?.message === 'string' ? err.message : '',
      });
    }

    const payload = await safeParseJson(response);
    if (!response.ok || !payload?.ok) {
      const locale = getLocale();
      const errorObj = payload?.error ?? {
        code: response.status === 401 ? 'INVALID_REQUEST' : 'GIT_ERROR',
        message: `HTTP ${response.status}`,
      };
      throw new ApiClientError({
        code: errorObj.code || 'GIT_ERROR',
        message: translateApiError(errorObj, locale),
        detail: typeof errorObj.detail === 'string' ? errorObj.detail : '',
        status: response.status,
        serverMessage: typeof errorObj.message === 'string' ? errorObj.message : '',
      });
    }

    return payload.data;
  };

  return {
    postJson,
    fetchSnapshot: (params, signal) => postJson('/api/snapshot', params, signal),
    fetchCommitDetail: (params, signal) => postJson('/api/commit/detail', params, signal),
    waitEvents: (params, signal) => postJson('/api/events/wait', params, signal),
    stageChanges: (params) => postJson('/api/changes/stage', params),
    unstageChanges: (params) => postJson('/api/changes/unstage', params),
    discardChanges: (params) => postJson('/api/changes/discard', params),
    commitChanges: (params) => postJson('/api/commit', params),
    fetchRemotes: (params) => postJson('/api/remote/fetch', params),
    pullBranch: (params) => postJson('/api/remote/pull', params),
    pushBranch: (params) => postJson('/api/remote/push', params),
    savePreferences: (params) => postJson('/api/preferences', params),
  };
};
