import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { API_ROUTES, createApiRouter } from './backend/api-router.mjs';
import { normalizeFsPath, toFileUri, toPathKey } from './backend/discovery.mjs';
import { createEventBus } from './backend/event-bus.mjs';
import { AppError, ERROR_CODES } from './backend/git-runner.mjs';
import { createMockFixtureStore } from './backend/mock-fixture.mjs';
import { createPreferencesStore } from './backend/preferences.mjs';
import { createRepositoryWatcher } from './backend/watcher.mjs';
import { loadSidecarSdk } from './sdk.mjs';

const INITIAL_CWD = process.cwd();
const PANEL_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(PANEL_DIR, 'public');
const REPO_ROOT_DIR = path.resolve(PANEL_DIR, '..', '..');

// 首步释放插件与仓库目录句柄，避免 Windows 下阻塞后续覆盖安装或工作树清理
try {
  process.chdir(os.tmpdir());
} catch {
  // 忽略特殊受限环境下的 chdir 失败
}

export const DEFAULT_STANDALONE_PORT = 17892;
export const MAX_API_BODY_BYTES = 1024 * 1024;
export const ALLOWED_HOST_PATTERN = /^(127\.0\.0\.1|localhost)(:\d+)?$/;
const APPLICATION_JSON_PATTERN = /^application\/json(?:\s*;|$)/i;

export const STATIC_WHITELIST = Object.freeze({
  '/': { file: 'index.html', contentType: 'text/html; charset=utf-8' },
  '/styles.css': { file: 'styles.css', contentType: 'text/css; charset=utf-8' },
  '/app.js': { file: 'app.js', contentType: 'text/javascript; charset=utf-8' },
  '/modules/api-client.js': { file: 'modules/api-client.js', contentType: 'text/javascript; charset=utf-8' },
  '/modules/theme.js': { file: 'modules/theme.js', contentType: 'text/javascript; charset=utf-8' },
  '/modules/i18n.js': { file: 'modules/i18n.js', contentType: 'text/javascript; charset=utf-8' },
  '/modules/graph-layout.js': { file: 'modules/graph-layout.js', contentType: 'text/javascript; charset=utf-8' },
  '/modules/popover.js': { file: 'modules/popover.js', contentType: 'text/javascript; charset=utf-8' },
  '/modules/changes-view.js': { file: 'modules/changes-view.js', contentType: 'text/javascript; charset=utf-8' },
  '/modules/graph-view.js': { file: 'modules/graph-view.js', contentType: 'text/javascript; charset=utf-8' },
});

const SECURITY_API_HEADERS = Object.freeze({
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
});

const API_ROUTE_SET = new Set(API_ROUTES);

function resolveStandaloneWorkspaceUris({ cliArgs = [], envPaths = process.env.AG_GIT_PATHS, initialCwd = INITIAL_CWD } = {}) {
  const candidates = [];
  for (const arg of cliArgs) {
    if (typeof arg === 'string' && arg.trim().length > 0 && !arg.startsWith('-')) {
      candidates.push(path.isAbsolute(arg) ? arg : path.resolve(initialCwd, arg));
    }
  }
  if (candidates.length === 0 && typeof envPaths === 'string' && envPaths.trim().length > 0) {
    for (const part of envPaths.split(path.delimiter)) {
      if (part.trim().length > 0) {
        candidates.push(path.isAbsolute(part) ? part : path.resolve(initialCwd, part));
      }
    }
  }
  if (candidates.length === 0) {
    if (fs.existsSync(path.join(REPO_ROOT_DIR, '.git'))) {
      candidates.push(REPO_ROOT_DIR);
    } else if (fs.existsSync(path.join(initialCwd, '.git'))) {
      candidates.push(initialCwd);
    }
  }

  const uris = [];
  for (const dirPath of candidates) {
    const normalized = normalizeFsPath(dirPath);
    if (normalized) {
      uris.push(toFileUri(normalized));
    }
  }
  return uris;
}

function resolveStandalonePort(rawPort) {
  if (rawPort === undefined || rawPort === null || rawPort === '') {
    return DEFAULT_STANDALONE_PORT;
  }
  const parsed = Number.parseInt(String(rawPort), 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    return DEFAULT_STANDALONE_PORT;
  }
  return parsed;
}

async function readStaticAsset(routePathname, publicDir = PUBLIC_DIR) {
  const meta = STATIC_WHITELIST[routePathname];
  if (!meta) {
    return null;
  }
  const filePath = path.join(publicDir, meta.file);
  try {
    const content = await fsPromises.readFile(filePath);
    return {
      status: 200,
      contentType: meta.contentType,
      body: content,
    };
  } catch {
    return {
      status: 404,
      contentType: 'text/plain; charset=utf-8',
      body: 'Not found',
    };
  }
}

/**
 * 构建 Standalone 模式下的 `/preload.js` 脚本响应内容。
 * 默认返回无宿主空桩；当查询参数携带 `?sdk=1` 时自动注入可控模拟 `window.sidecar` 桥接对象。
 *
 * @param {{ forceMockSdk?: boolean }} [options] 预加载脚本生成选项
 * @returns {string} UTF-8 JavaScript 源码文本
 */
export function buildStandalonePreloadScript({ forceMockSdk = false } = {}) {
  return `// Standalone preview preload bridge
(function () {
  var FORCE_SDK = ${forceMockSdk ? 'true' : 'false'};
  var params = new URLSearchParams(window.location.search || '');
  if (!FORCE_SDK && params.get('sdk') !== '1') {
    return;
  }

  var workspaceUris = [];
  var rawWorkspaces = params.get('workspaces');
  if (rawWorkspaces) {
    try {
      var parsed = JSON.parse(rawWorkspaces);
      if (Array.isArray(parsed)) {
        workspaceUris = parsed.filter(function (u) { return typeof u === 'string'; });
      }
    } catch (_err) {
      workspaceUris = rawWorkspaces.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    }
  }

  var listeners = new Set();
  var auxCalls = [];
  window.__mockSidecarCalls = auxCalls;

  window.addEventListener('message', function (event) {
    var msg = event && event.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'theme-change' && msg.payload && msg.payload.cssVariables) {
      var vars = msg.payload.cssVariables;
      Object.keys(vars).forEach(function (key) {
        document.documentElement.style.setProperty(key, vars[key]);
      });
      return;
    }
    if (msg.type === 'workspace-change' && msg.payload) {
      workspaceUris = Array.isArray(msg.payload.workspaceUris) ? msg.payload.workspaceUris.slice() : [];
      listeners.forEach(function (fn) {
        try { fn(workspaceUris.slice()); } catch (_err) {}
      });
    }
  });

  window.sidecar = {
    conversationId: params.get('conversationId') || 'standalone-mock-conversation',
    fetch: function (url, options) {
      var nextOpts = Object.assign({}, options || {});
      var headers = new Headers(nextOpts.headers || {});
      headers.set('Content-Type', 'application/json');
      nextOpts.headers = headers;
      return window.fetch(url, nextOpts);
    },
    getWorkspaceUris: function () {
      return Promise.resolve(workspaceUris.slice());
    },
    onWorkspaceChange: function (listener) {
      if (typeof listener !== 'function') return function () {};
      listeners.add(listener);
      queueMicrotask(function () {
        if (listeners.has(listener)) {
          listener(workspaceUris.slice());
        }
      });
      return function () { listeners.delete(listener); };
    },
    ui: {
      toggleAuxPane: function (request) {
        auxCalls.push({ type: 'toggleAuxPane', payload: request });
        if (window.parent && window.parent !== window) {
          window.parent.postMessage({ type: 'toggle-aux-pane', payload: request }, '*');
        }
      },
      toggleConversation: function (conversationId, options) {
        auxCalls.push({ type: 'toggleConversation', conversationId: conversationId, options: options });
        if (window.parent && window.parent !== window) {
          window.parent.postMessage({
            type: 'toggle-conversation',
            payload: Object.assign({ conversationId: conversationId }, options || {}),
          }, '*');
        }
      },
    },
    auth: {
      requestCredentialRefresh: function () {
        auxCalls.push({ type: 'requestCredentialRefresh' });
      },
    },
  };
})();
`;
}

function writeJsonResponse(res, statusCode, payload, extraHeaders = {}) {
  res.writeHead(statusCode, {
    ...SECURITY_API_HEADERS,
    ...extraHeaders,
  });
  res.end(JSON.stringify(payload));
}

function readJsonRequestBody(req, maxBytes = MAX_API_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let rejectedTooLarge = false;

    req.on('data', (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        rejectedTooLarge = true;
        chunks.length = 0;
        // 若流超大（>16 MiB）则及时强断防止内存压力；常规超限在流结束时稳定返回 413 JSON
        if (totalBytes > maxBytes * 16) {
          req.destroy();
          reject(
            new AppError(
              ERROR_CODES.INVALID_REQUEST,
              `Request body exceeds ${maxBytes} bytes limit.`,
              { statusCode: 413 },
            ),
          );
        }
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (rejectedTooLarge) {
        reject(
          new AppError(
            ERROR_CODES.INVALID_REQUEST,
            `Request body exceeds ${maxBytes} bytes limit.`,
            { statusCode: 413 },
          ),
        );
        return;
      }
      const rawText = Buffer.concat(chunks).toString('utf8');
      if (rawText.trim().length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(rawText));
      } catch (error) {
        reject(
          new AppError(
            ERROR_CODES.INVALID_REQUEST,
            'Request body must be valid UTF-8 JSON.',
            { detail: error instanceof Error ? error.message : String(error), statusCode: 400 },
          ),
        );
      }
    });

    req.on('error', (error) => {
      reject(
        new AppError(ERROR_CODES.INVALID_REQUEST, 'Failed to read request body.', {
          detail: error instanceof Error ? error.message : String(error),
          statusCode: 400,
        }),
      );
    });
  });
}

function resolveFixtureFlag(req, url, host, envFixture) {
  if (url.searchParams.get('fixture') === 'mock') {
    return 'mock';
  }
  const referer = req.headers.referer;
  if (typeof referer === 'string' && referer.length > 0 && host) {
    try {
      const refUrl = new URL(referer);
      if (refUrl.origin === `http://${host}` && refUrl.searchParams.get('fixture') === 'mock') {
        return 'mock';
      }
    } catch {
      // 忽略无效 Referer 头
    }
  }
  if (envFixture === 'mock') {
    return 'mock';
  }
  return null;
}

function createCoreRuntime(options = {}) {
  const eventBus = createEventBus(options.eventBusOptions);
  const preferencesStore = createPreferencesStore({
    filePath: options.preferencesPath,
  });
  const watcher = createRepositoryWatcher({
    ...options.watcherOptions,
    onChange: () => {
      eventBus.bumpRevision({ watchDegraded: watcher.getWatchState().degraded });
    },
    onDegraded: () => {
      eventBus.notifyWatchDegraded();
    },
  });
  const mockFixture = createMockFixtureStore({ eventBus });

  const router = createApiRouter({
    eventBus,
    watcher,
    preferencesStore,
    mockFixture,
    defaultWorkspaceUris: options.defaultWorkspaceUris ?? [],
    isStandalone: Boolean(options.isStandalone),
  });

  return {
    eventBus,
    preferencesStore,
    watcher,
    mockFixture,
    router,
    close: () => {
      watcher.close();
      eventBus.dispose();
    },
  };
}

/**
 * 启动 Antigravity Official `SidecarApp` 模式服务。
 * 严格按静态资源白名单逐个注册显式 `Content-Type` 的 `Response` 实例，全部 `/api/*` 使用 `'POST'`。
 *
 * @param {{
 *   loadSdk?: typeof loadSidecarSdk,
 *   preferencesPath?: string,
 *   publicDir?: string,
 *   fixture?: string | null,
 *   watcherOptions?: object,
 *   eventBusOptions?: object
 * }} [options] 启动与测试注入配置
 * @returns {Promise<{ mode: 'sidecar', app: object, server: http.Server, runtime: object, close: () => Promise<void> }>} 服务控制器
 */
export async function startSidecarServer(options = {}) {
  const sdkLoader = options.loadSdk ?? loadSidecarSdk;
  const { SidecarApp, Response: SdkResponse } = await sdkLoader();
  const publicDir = options.publicDir ?? PUBLIC_DIR;
  const runtime = createCoreRuntime({
    preferencesPath: options.preferencesPath,
    defaultWorkspaceUris: [],
    isStandalone: false,
    watcherOptions: options.watcherOptions,
    eventBusOptions: options.eventBusOptions,
  });

  const app = new SidecarApp();

  for (const routePathname of Object.keys(STATIC_WHITELIST)) {
    app.page(routePathname, async () => {
      const asset = await readStaticAsset(routePathname, publicDir);
      return new SdkResponse(asset.body, {
        status: asset.status,
        contentType: asset.contentType,
        headers: { 'X-Content-Type-Options': 'nosniff' },
      });
    });
  }

  for (const apiRoute of API_ROUTES) {
    app.api(apiRoute, async (data) => {
      const activeFixture = options.fixture ?? (process.env.AG_GIT_FIXTURE === 'mock' ? 'mock' : null);
      const result = await runtime.router.dispatch(apiRoute, data, { fixture: activeFixture });
      return new SdkResponse(JSON.stringify(result.body), {
        status: result.statusCode,
        contentType: 'application/json; charset=utf-8',
        headers: {
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    }, 'POST');
  }

  const server = await app.run();

  const close = async () => {
    runtime.close();
    server?.closeAllConnections?.();
    await app.close();
  };

  return {
    mode: 'sidecar',
    app,
    server,
    runtime,
    close,
  };
}

/**
 * 启动脱离宿主的 Standalone 本地 HTTP 服务（固定绑定 `127.0.0.1`）。
 * 强制校验 `Host` 白名单、`/api/*` 同源 `Origin === http://${host}`、`application/json` 与 `1 MiB` Body 上限，
 * 提供 `GET /preload.js`（支持 `?sdk=1`）与 `?fixture=mock` 离线演示。
 *
 * @param {{
 *   port?: number,
 *   workspacePaths?: string[],
 *   defaultWorkspaceUris?: string[],
 *   preferencesPath?: string,
 *   publicDir?: string,
 *   fixture?: string | null,
 *   watcherOptions?: object,
 *   eventBusOptions?: object
 * }} [options] Standalone 启动配置
 * @returns {Promise<{ mode: 'standalone', port: number, url: string, server: http.Server, runtime: object, close: () => Promise<void> }>} 服务控制器
 */
export async function startStandaloneServer(options = {}) {
  const port = resolveStandalonePort(options.port ?? process.env.AG_GIT_PORT);
  const publicDir = options.publicDir ?? PUBLIC_DIR;
  const defaultWorkspaceUris = options.defaultWorkspaceUris ?? resolveStandaloneWorkspaceUris({
    cliArgs: options.workspacePaths ?? [],
  });

  const runtime = createCoreRuntime({
    preferencesPath: options.preferencesPath,
    defaultWorkspaceUris,
    isStandalone: true,
    watcherOptions: options.watcherOptions,
    eventBusOptions: options.eventBusOptions,
  });

  const server = http.createServer(async (req, res) => {
    const host = req.headers.host;
    if (typeof host !== 'string' || !ALLOWED_HOST_PATTERN.test(host)) {
      const err = new AppError(ERROR_CODES.INVALID_REQUEST, 'Forbidden Host header.', { statusCode: 403 });
      writeJsonResponse(res, 403, err.toJSON());
      return;
    }

    let url;
    try {
      url = new URL(req.url || '/', `http://${host}`);
    } catch {
      const err = new AppError(ERROR_CODES.INVALID_REQUEST, 'Malformed request URL.', { statusCode: 400 });
      writeJsonResponse(res, 400, err.toJSON());
      return;
    }

    if (url.pathname === '/preload.js') {
      if (req.method !== 'GET') {
        writeJsonResponse(
          res,
          405,
          new AppError(ERROR_CODES.INVALID_REQUEST, 'Method Not Allowed.', { statusCode: 405 }).toJSON(),
          { Allow: 'GET' },
        );
        return;
      }
      const forceMockSdk = url.searchParams.get('sdk') === '1';
      const script = buildStandalonePreloadScript({ forceMockSdk });
      res.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(script);
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      if (!API_ROUTE_SET.has(url.pathname)) {
        writeJsonResponse(
          res,
          404,
          new AppError(ERROR_CODES.INVALID_REQUEST, `API route not found: ${url.pathname}`, { statusCode: 404 }).toJSON(),
        );
        return;
      }

      if (req.method !== 'POST') {
        writeJsonResponse(
          res,
          405,
          new AppError(ERROR_CODES.INVALID_REQUEST, 'API endpoints only accept POST.', { statusCode: 405 }).toJSON(),
          { Allow: 'POST' },
        );
        return;
      }

      const origin = req.headers.origin;
      if (origin !== `http://${host}`) {
        writeJsonResponse(
          res,
          403,
          new AppError(ERROR_CODES.INVALID_REQUEST, 'Forbidden cross-origin or missing Origin header.', { statusCode: 403 }).toJSON(),
        );
        return;
      }

      const contentType = req.headers['content-type'];
      if (typeof contentType !== 'string' || !APPLICATION_JSON_PATTERN.test(contentType)) {
        writeJsonResponse(
          res,
          400,
          new AppError(ERROR_CODES.INVALID_REQUEST, 'Content-Type must start with application/json.', { statusCode: 400 }).toJSON(),
        );
        return;
      }

      let parsedBody;
      try {
        parsedBody = await readJsonRequestBody(req, MAX_API_BODY_BYTES);
      } catch (bodyError) {
        const appError = bodyError instanceof AppError
          ? bodyError
          : new AppError(ERROR_CODES.INVALID_REQUEST, 'Invalid request payload.', { statusCode: 400 });
        writeJsonResponse(res, appError.statusCode, appError.toJSON());
        return;
      }

      const abortController = new AbortController();
      const onReqClose = () => {
        if (!res.writableEnded) {
          abortController.abort();
        }
      };
      req.once('close', onReqClose);

      try {
        const activeFixture = options.fixture ?? resolveFixtureFlag(req, url, host, process.env.AG_GIT_FIXTURE);
        const result = await runtime.router.dispatch(url.pathname, parsedBody, {
          fixture: activeFixture,
          signal: abortController.signal,
        });
        if (!res.writableEnded) {
          writeJsonResponse(res, result.statusCode, result.body);
        }
      } finally {
        req.removeListener('close', onReqClose);
      }
      return;
    }

    if (req.method === 'GET' && Object.prototype.hasOwnProperty.call(STATIC_WHITELIST, url.pathname)) {
      const asset = await readStaticAsset(url.pathname, publicDir);
      res.writeHead(asset.status, {
        'Content-Type': asset.contentType,
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(asset.body);
      return;
    }

    res.writeHead(404, {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end('Not found');
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const boundPort = server.address().port;
  const close = () => new Promise((resolve) => {
    runtime.close();
    server.closeAllConnections?.();
    server.close(() => resolve());
  });

  return {
    mode: 'standalone',
    port: boundPort,
    url: `http://127.0.0.1:${boundPort}`,
    server,
    runtime,
    close,
  };
}

/**
 * 根据环境变量自动选择启动 Sidecar 或 Standalone 模式并绑定信号优雅退出。
 *
 * @param {string[]} [cliArgs=process.argv.slice(2)] CLI 位置参数列表
 * @returns {Promise<ReturnType<typeof startSidecarServer> | ReturnType<typeof startStandaloneServer>>} 启动后的服务控制器
 */
export async function bootPanelServer(cliArgs = process.argv.slice(2)) {
  const isSidecar = Boolean(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT);
  const instance = isSidecar
    ? await startSidecarServer()
    : await startStandaloneServer({
        defaultWorkspaceUris: resolveStandaloneWorkspaceUris({ cliArgs }),
      });

  if (!isSidecar) {
    console.log(`[antigravity-git-worktree] Standalone server listening at ${instance.url}`);
  }

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    try {
      await instance.close();
    } finally {
      process.exit(0);
    }
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  return instance;
}

function isDirectEntryInvocation() {
  const entryArg = process.argv[1];
  if (!entryArg) {
    return false;
  }
  const entryKey = toPathKey(path.resolve(INITIAL_CWD, entryArg));
  const selfKey = toPathKey(fileURLToPath(import.meta.url));
  return Boolean(entryKey && selfKey && entryKey === selfKey);
}

if (isDirectEntryInvocation()) {
  bootPanelServer().catch((error) => {
    console.error('[antigravity-git-worktree] Fatal startup error:', error);
    process.exit(1);
  });
}
