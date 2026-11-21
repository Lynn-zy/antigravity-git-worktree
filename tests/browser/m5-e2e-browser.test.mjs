import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { toFileUri } from '../../sidecars/panel/backend/discovery.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '..', '..');
const MAIN_MJS_PATH = path.join(REPO_ROOT, 'sidecars', 'panel', 'main.mjs');

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * 查找本机可用的 Microsoft Edge 或 Chrome 浏览器可执行文件路径。
 * 找不到任何可用浏览器时直接抛出错误，绝不静默跳过测试。
 *
 * @returns {string} 浏览器可执行文件绝对路径或命令名
 */
const findBrowserExecutable = () => {
  const envOverride = process.env.AG_BROWSER_PATH?.trim();
  if (envOverride) {
    if (fs.existsSync(envOverride)) {
      return envOverride;
    }
    throw new Error(`AG_BROWSER_PATH points to a non-existent binary: ${envOverride}`);
  }

  const candidates = [];
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ?? '';
    const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    candidates.push(
      path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    );
    for (const cmd of ['msedge', 'chrome']) {
      try {
        const found = execFileSync('where.exe', [cmd], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true,
        });
        for (const line of found.split(/\r?\n/)) {
          if (line.trim()) {
            candidates.push(line.trim());
          }
        }
      } catch {
        // 忽略 PATH 未命中的命令
      }
    }
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    );
  } else {
    candidates.push(
      '/usr/bin/microsoft-edge',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
    );
    for (const cmd of ['microsoft-edge', 'google-chrome', 'chromium', 'chromium-browser']) {
      try {
        const found = execFileSync('which', [cmd], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        if (found.trim()) {
          candidates.push(found.trim());
        }
      } catch {
        // 忽略 PATH 未命中的命令
      }
    }
  }

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    'Headless browser E2E tests require Microsoft Edge (msedge.exe) or Google Chrome, but no browser binary was found. Set AG_BROWSER_PATH to specify one.',
  );
};

/**
 * 同步或异步执行真实 Git CLI 命令（禁用交互式提示与壳解释器）。
 *
 * @param {string[]} args Git 子命令与参数列表
 * @param {string} cwd 执行目录
 * @param {Record<string, string>} [extraEnv={}] 追加环境变量
 * @returns {Promise<string>} 标准输出去首尾空白字符串
 */
const execGit = (args, cwd, extraEnv = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'never',
        ...extraEnv,
      },
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      const outText = Buffer.concat(stdout).toString('utf8');
      const errText = Buffer.concat(stderr).toString('utf8');
      if (code !== 0) {
        reject(new Error(`git ${args.join(' ')} failed (${code}) in ${cwd}: ${errText}`));
        return;
      }
      resolve(outText.trim());
    });
  });

const initConfiguredRepo = async (repoDir, branch = 'main', author = { name: 'Lynn', email: 'lynn@example.com' }) => {
  fs.mkdirSync(repoDir, { recursive: true });
  await execGit(['init', '-b', branch], repoDir);
  await execGit(['config', 'user.name', author.name], repoDir);
  await execGit(['config', 'user.email', author.email], repoDir);
  await execGit(['config', 'core.autocrlf', 'false'], repoDir);
  await execGit(['config', 'core.quotepath', 'false'], repoDir);
};

const writeRepoFile = (repoDir, relPath, content) => {
  const fullPath = path.join(repoDir, ...relPath.split('/'));
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf8');
  return fullPath;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 启动 Standalone `sidecars/panel/main.mjs` 子进程，使用随机端口与隔离偏好目录。
 *
 * @param {{
 *   workspacePaths: string[],
 *   preferencesDir: string,
 *   env?: Record<string, string>
 * }} options 启动选项
 * @returns {Promise<{ url: string, port: number, child: import('node:child_process').ChildProcess, close: () => Promise<void> }>} 服务控制器
 */
const spawnPanelServer = async ({ workspacePaths, preferencesDir, env = {} }) => {
  fs.mkdirSync(preferencesDir, { recursive: true });
  const child = spawn(process.execPath, [MAIN_MJS_PATH], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      AG_GIT_PORT: '0',
      AG_GIT_PATHS: workspacePaths.join(path.delimiter),
      ANTIGRAVITY_EXECUTABLE_DATA_DIR: preferencesDir,
      ...env,
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const url = await new Promise((resolve, reject) => {
    let logs = '';
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for Standalone server startup. Logs:\n${logs}`));
    }, 10_000);

    const handleChunk = (chunk) => {
      logs += chunk.toString('utf8');
      const match = logs.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    };

    child.stdout.on('data', handleChunk);
    child.stderr.on('data', handleChunk);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Standalone server exited early with code ${code}. Logs:\n${logs}`));
    });
  });

  const port = Number.parseInt(new URL(url).port, 10);

  const close = async () => {
    if (child.exitCode !== null || child.killed) {
      return;
    }
    const exitPromise = new Promise((resolve) => {
      child.once('exit', resolve);
    });
    child.kill('SIGTERM');
    const settled = await Promise.race([
      exitPromise.then(() => true),
      sleep(3000).then(() => false),
    ]);
    if (!settled && child.exitCode === null) {
      child.kill('SIGKILL');
      await Promise.race([exitPromise, sleep(1500)]);
    }
  };

  return { url, port, child, close };
};

/**
 * 基于 Node v22 原生 WebSocket 驱动无头 Edge/Chrome CDP 会话（零外部依赖）。
 *
 * @param {{ width?: number, height?: number }} [options] 初始窗口尺寸
 * @returns {Promise<{
 *   newPage: (opts?: { width?: number, height?: number }) => Promise<object>,
 *   close: () => Promise<void>
 * }>} 无头浏览器控制器
 */
const launchHeadlessBrowser = async ({ width = 440, height = 760 } = {}) => {
  const executablePath = findBrowserExecutable();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-gw-cdp-profile-'));

  const browserProc = spawn(
    executablePath,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-default-apps',
      '--lang=zh-CN',
      `--window-size=${width},${height}`,
      'about:blank',
    ],
    {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  const browserWsUrl = await new Promise((resolve, reject) => {
    let stderrBuf = '';
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for browser CDP WebSocket. stderr:\n${stderrBuf}`));
    }, 15_000);

    browserProc.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString('utf8');
      const match = stderrBuf.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    browserProc.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Browser process exited early (${code}). stderr:\n${stderrBuf}`));
    });
  });

  const ws = new WebSocket(browserWsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', (err) => reject(err?.error ?? new Error('CDP WebSocket connection error')), { once: true });
  });

  let nextCommandId = 1;
  const pendingCommands = new Map();
  const eventListeners = new Set();

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(String(event.data));
    if (typeof msg.id === 'number') {
      const pending = pendingCommands.get(msg.id);
      if (pending) {
        pendingCommands.delete(msg.id);
        if (msg.error) {
          pending.reject(new Error(`CDP ${pending.method} failed: ${msg.error.message}`));
        } else {
          pending.resolve(msg.result);
        }
      }
      return;
    }
    for (const listener of eventListeners) {
      listener(msg);
    }
  });

  const send = (method, params = {}, sessionId = undefined) => {
    const id = nextCommandId++;
    const payload = { id, method, params };
    if (sessionId) {
      payload.sessionId = sessionId;
    }
    return new Promise((resolve, reject) => {
      pendingCommands.set(id, { resolve, reject, method });
      ws.send(JSON.stringify(payload));
    });
  };

  const newPage = async ({ width: pageWidth = width, height: pageHeight = height } = {}) => {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId: mainSessionId } = await send('Target.attachToTarget', {
      targetId,
      flatten: true,
    });

    const consoleErrors = [];
    const pageErrors = [];
    const trackedSessions = new Set([mainSessionId]);
    const attachedFrames = [];

    const onEvent = async (msg) => {
      if (msg.method === 'Target.attachedToTarget' && msg.sessionId === mainSessionId) {
        const childSessionId = msg.params?.sessionId;
        const targetInfo = msg.params?.targetInfo;
        if (childSessionId) {
          trackedSessions.add(childSessionId);
          attachedFrames.push({ sessionId: childSessionId, targetInfo });
          void Promise.all([
            send('Runtime.enable', {}, childSessionId),
            send('Log.enable', {}, childSessionId),
          ]).catch(() => {});
        }
        return;
      }

      if (msg.sessionId && !trackedSessions.has(msg.sessionId)) {
        return;
      }

      if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
        const text = (msg.params.args ?? [])
          .map((arg) => arg.value ?? arg.description ?? '[object]')
          .join(' ');
        consoleErrors.push(text);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const details = msg.params?.exceptionDetails;
        const message = details?.exception?.description || details?.text || 'Uncaught page exception';
        pageErrors.push(message);
      } else if (msg.method === 'Log.entryAdded' && msg.params?.entry?.level === 'error') {
        const entry = msg.params.entry;
        const isFaviconNoise = entry.source === 'network' && typeof entry.url === 'string' && entry.url.endsWith('/favicon.ico');
        if (!isFaviconNoise) {
          consoleErrors.push(`[Log:${entry.source}] ${entry.text} (${entry.url || ''})`);
        }
      }
    };

    eventListeners.add(onEvent);

    await send('Page.enable', {}, mainSessionId);
    await send('Runtime.enable', {}, mainSessionId);
    await send('Log.enable', {}, mainSessionId);
    await send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    }, mainSessionId);
    await send('Emulation.setDeviceMetricsOverride', {
      width: pageWidth,
      height: pageHeight,
      deviceScaleFactor: 1,
      mobile: false,
    }, mainSessionId);

    const evaluate = async (expression, { sessionId = mainSessionId, awaitPromise = true } = {}) => {
      const response = await send(
        'Runtime.evaluate',
        {
          expression,
          returnByValue: true,
          awaitPromise,
        },
        sessionId,
      );
      if (response.exceptionDetails) {
        const msg = response.exceptionDetails.exception?.description
          || response.exceptionDetails.text
          || 'Runtime.evaluate exception';
        throw new Error(msg);
      }
      return response.result?.value;
    };

    const waitFor = async (predicateExpr, {
      timeoutMs = 10_000,
      intervalMs = 60,
      sessionId = mainSessionId,
      description = predicateExpr,
    } = {}) => {
      const deadline = Date.now() + timeoutMs;
      let lastError = null;
      while (Date.now() < deadline) {
        try {
          const ok = await evaluate(predicateExpr, { sessionId });
          if (ok) {
            return ok;
          }
        } catch (err) {
          lastError = err;
        }
        await sleep(intervalMs);
      }
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for: ${description}${lastError ? ` (last error: ${lastError.message})` : ''}`,
      );
    };

    const navigate = async (url) => {
      const loaded = new Promise((resolve) => {
        const listener = (msg) => {
          if (msg.sessionId === mainSessionId && msg.method === 'Page.loadEventFired') {
            eventListeners.delete(listener);
            resolve();
          }
        };
        eventListeners.add(listener);
      });
      await send('Page.navigate', { url }, mainSessionId);
      await Promise.race([loaded, sleep(6000)]);
    };

    const setViewport = async (nextWidth, nextHeight) => {
      await send('Emulation.setDeviceMetricsOverride', {
        width: nextWidth,
        height: nextHeight,
        deviceScaleFactor: 1,
        mobile: false,
      }, mainSessionId);
      await evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
    };

    const getCenterPoint = async (selector, { index = 0, sessionId = mainSessionId, timeoutMs = 3000 } = {}) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const point = await evaluate(
          `(() => {
            const matches = document.querySelectorAll(${JSON.stringify(selector)});
            const el = matches[${index}];
            if (!el) return null;
            const hoverContainer = el.closest('.gw-file-row, .gw-commit-row');
            if (hoverContainer && hoverContainer !== el && typeof hoverContainer.focus === 'function') {
              hoverContainer.focus({ preventScroll: true });
            }
            el.scrollIntoView({ block: 'center', inline: 'nearest' });
            const rect = el.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return null;
            return {
              x: rect.left + rect.width / 2,
              y: rect.top + rect.height / 2,
              left: rect.left,
              top: rect.top,
              width: rect.width,
              height: rect.height,
            };
          })()`,
          { sessionId },
        );
        if (point) {
          return point;
        }
        await sleep(50);
      }
      throw new Error(`Element not found or has zero bounding box: ${selector}[${index}]`);
    };

    const moveMouse = async (x, y, buttons = 0) => {
      // 按住左键拖动时必须同时声明 button，否则 Chromium 不会把后续 pointermove 视为按下态派发
      await send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x,
        y,
        button: buttons === 1 ? 'left' : 'none',
        buttons,
        pointerType: 'mouse',
      }, mainSessionId);
    };

    const hoverSelector = async (selector, { index = 0, sessionId = mainSessionId } = {}) => {
      const pt = await getCenterPoint(selector, { index, sessionId });
      await moveMouse(pt.x, pt.y);
      return pt;
    };

    const clickSelector = async (selector, { index = 0, sessionId = mainSessionId } = {}) => {
      const pt = await getCenterPoint(selector, { index, sessionId });
      await moveMouse(pt.x, pt.y);
      await send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: pt.x,
        y: pt.y,
        button: 'left',
        clickCount: 1,
        buttons: 1,
        pointerType: 'mouse',
      }, mainSessionId);
      await send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: pt.x,
        y: pt.y,
        button: 'left',
        clickCount: 1,
        buttons: 0,
        pointerType: 'mouse',
      }, mainSessionId);
      return pt;
    };

    const dragBy = async (selector, deltaX, deltaY, { steps, sessionId = mainSessionId } = {}) => {
      const effectiveSteps = steps ?? Math.max(24, Math.ceil(Math.hypot(deltaX, deltaY) / 2));
      const pt = await getCenterPoint(selector, { sessionId });
      await moveMouse(pt.x, pt.y);
      await send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: pt.x,
        y: pt.y,
        button: 'left',
        clickCount: 1,
        buttons: 1,
        pointerType: 'mouse',
      }, mainSessionId);
      for (let i = 1; i <= effectiveSteps; i += 1) {
        await moveMouse(pt.x + (deltaX * i) / effectiveSteps, pt.y + (deltaY * i) / effectiveSteps, 1);
      }
      await send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: pt.x + deltaX,
        y: pt.y + deltaY,
        button: 'left',
        clickCount: 1,
        buttons: 0,
        pointerType: 'mouse',
      }, mainSessionId);
    };

    const pressKey = async (key, code, virtualKeyCode, modifiers = 0) => {
      await send('Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        key,
        code,
        windowsVirtualKeyCode: virtualKeyCode,
        nativeVirtualKeyCode: virtualKeyCode,
        modifiers,
      }, mainSessionId);
      await send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key,
        code,
        windowsVirtualKeyCode: virtualKeyCode,
        nativeVirtualKeyCode: virtualKeyCode,
        modifiers,
      }, mainSessionId);
    };

    const insertText = async (text) => {
      await send('Input.insertText', { text }, mainSessionId);
    };

    const captureScreenshot = async (outPath) => {
      const { data } = await send('Page.captureScreenshot', { format: 'png' }, mainSessionId);
      const buffer = Buffer.from(data, 'base64');
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, buffer);
      assert.equal(buffer.subarray(0, 8).equals(PNG_MAGIC), true, `Invalid PNG captured at ${outPath}`);
      return outPath;
    };

    const waitForIframeSession = async (urlPrefix = 'about:srcdoc') => {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const hit = attachedFrames.find((item) => item.targetInfo?.url === urlPrefix);
        if (hit) {
          return hit.sessionId;
        }
        await sleep(50);
      }
      throw new Error(`Timed out waiting for CDP auto-attach on iframe (${urlPrefix})`);
    };

    const closePage = async () => {
      eventListeners.delete(onEvent);
      await send('Target.closeTarget', { targetId }).catch(() => {});
    };

    return {
      mainSessionId,
      navigate,
      setViewport,
      evaluate,
      waitFor,
      hoverSelector,
      clickSelector,
      dragBy,
      pressKey,
      insertText,
      captureScreenshot,
      waitForIframeSession,
      getErrors: () => ({
        consoleErrors: [...consoleErrors],
        pageErrors: [...pageErrors],
      }),
      close: closePage,
    };
  };

  const close = async () => {
    try {
      await send('Browser.close');
    } catch {
      // 忽略关闭阶段连接中断
    }
    try {
      ws.close();
    } catch {
      // 忽略连接关闭异常
    }
    const exited = await Promise.race([
      new Promise((resolve) => {
        if (browserProc.exitCode !== null) resolve(true);
        else browserProc.once('exit', () => resolve(true));
      }),
      sleep(2500).then(() => false),
    ]);
    if (!exited && browserProc.exitCode === null) {
      if (process.platform === 'win32' && browserProc.pid) {
        try {
          execFileSync('taskkill', ['/PID', String(browserProc.pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
          });
        } catch {
          browserProc.kill('SIGKILL');
        }
      } else {
        browserProc.kill('SIGKILL');
      }
    }
    fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
  };

  return { newPage, close };
};

/**
 * 在临时目录构造带上游 Bare 远端、Merge 分叉（含中文作者与路径、已删历史文件）、多 ref 标签（+N）、
 * 独立分支、`MM` 双态、未暂存与未跟踪文件的真实双仓库（`repoA` + `repoB`）及纯单仓对照（`singleRepo`）。
 */
const setupRealGitFixtures = async (rootDir) => {
  const remoteA = path.join(rootDir, 'remoteA.git');
  const repoA = path.join(rootDir, 'repoA');
  const repoB = path.join(rootDir, 'repoB');
  const singleRepo = path.join(rootDir, 'single-repo');
  const nonGitDir = path.join(rootDir, 'plain-dir');
  fs.mkdirSync(nonGitDir, { recursive: true });

  fs.mkdirSync(remoteA, { recursive: true });
  await execGit(['init', '--bare', '-b', 'main'], remoteA);

  await initConfiguredRepo(repoA, 'main', { name: '林开发', email: 'lin@example.com' });
  await execGit(['remote', 'add', 'origin', remoteA], repoA);

  // 基础提交序列（用于构造足够高度，确保中部节点位于视口中央）
  writeRepoFile(repoA, 'README.md', '# Repo A\ninitial\n');
  writeRepoFile(repoA, 'src/core.js', 'export const version = 1;\n');
  writeRepoFile(repoA, 'src/mm-双态.txt', 'v1\n');
  writeRepoFile(repoA, 'legacy/已删除文件.txt', 'to be removed on feature branch\n');
  await execGit(['add', '-A'], repoA);
  await execGit(['commit', '-m', 'chore: initialize repoA'], repoA);
  const c0Sha = await execGit(['rev-parse', 'HEAD'], repoA);

  for (let i = 1; i <= 7; i += 1) {
    writeRepoFile(repoA, `notes/log-${i}.txt`, `entry ${i}\n`);
    await execGit(['add', '--', `notes/log-${i}.txt`], repoA);
    await execGit(['commit', '-m', `docs: add historical note ${i}`], repoA);
  }

  writeRepoFile(repoA, 'docs/guide.md', '# Guide v1\n');
  await execGit(['add', '--', 'docs/guide.md'], repoA);
  await execGit(['commit', '-m', 'docs: add guide base'], repoA);

  // 未合并侧分支：用于验证「自动 / 全部」作用域切换差异
  await execGit(['checkout', '-b', 'side/实验分支', c0Sha], repoA);
  writeRepoFile(repoA, 'experiment.txt', 'only visible in all scope\n');
  await execGit(['add', '--', 'experiment.txt'], repoA);
  await execGit(['commit', '-m', 'feat: 仅全部视图可见实验提交'], repoA);

  // 从 main 分叉出中文特性分支并删除 legacy/已删除文件.txt
  await execGit(['checkout', 'main'], repoA);
  await execGit(['checkout', '-b', 'feat/中文特性'], repoA);
  writeRepoFile(repoA, 'docs/guide.md', '# Guide v2\n');
  writeRepoFile(repoA, '目录/中文文件.txt', '中文内容\n');
  await execGit(['rm', '--', 'legacy/已删除文件.txt'], repoA);
  await execGit(['add', '--', 'docs/guide.md', '目录/中文文件.txt'], repoA);
  await execGit(
    ['commit', '-m', 'feat: 新增中文目录并清理历史文件'],
    repoA,
    {
      GIT_AUTHOR_NAME: '张协作',
      GIT_AUTHOR_EMAIL: 'zhang@example.com',
      GIT_COMMITTER_NAME: '张协作',
      GIT_COMMITTER_EMAIL: 'zhang@example.com',
    },
  );
  const featSha = await execGit(['rev-parse', 'HEAD'], repoA);

  // main 继续前进后执行 --no-ff Merge，产生双父提交并使 merge diff 包含已删历史文件
  await execGit(['checkout', 'main'], repoA);
  writeRepoFile(repoA, 'src/core.js', 'export const version = 2;\n');
  await execGit(['add', '--', 'src/core.js'], repoA);
  await execGit(['commit', '-m', 'refactor: bump core version'], repoA);

  await execGit(
    ['merge', '--no-ff', 'feat/中文特性', '-m', 'merge: 合并 feat/中文特性 到 main\n\nCo-authored-by: 张协作 <zhang@example.com>'],
    repoA,
  );
  const mergeSha = await execGit(['rev-parse', 'HEAD'], repoA);

  // 在 Merge 提交之上再加一条提交并挂载 > 3 个 ref 标签验证 +N 折叠，随后推到上游 Bare 远端
  writeRepoFile(repoA, 'CHANGELOG.md', '## v1.0.0\n');
  await execGit(['add', '--', 'CHANGELOG.md'], repoA);
  await execGit(['commit', '-m', 'release: tag multi-ref baseline'], repoA);
  const taggedSha = await execGit(['rev-parse', 'HEAD'], repoA);

  await execGit(['tag', 'v1.0.0', taggedSha], repoA);
  await execGit(['tag', 'v1.0.1', taggedSha], repoA);
  await execGit(['tag', 'v1.0.2', taggedSha], repoA);
  await execGit(['tag', 'v1.0.3', taggedSha], repoA);
  await execGit(['push', '-u', 'origin', 'main', '--tags'], repoA);

  // 制造工作区变更：MM 双态 + unstaged 修改 + untracked 文件
  writeRepoFile(repoA, 'src/mm-双态.txt', 'v2-staged\n');
  await execGit(['add', '--', 'src/mm-双态.txt'], repoA);
  writeRepoFile(repoA, 'src/mm-双态.txt', 'v3-unstaged\n');
  writeRepoFile(repoA, 'README.md', '# Repo A\nunstaged modification\n');
  const untrackedPath = writeRepoFile(repoA, 'temp-未跟踪.txt', 'untracked temp file\n');

  // 初始化第二个仓库 repoB
  await initConfiguredRepo(repoB, 'develop', { name: 'Bob', email: 'bob@example.com' });
  writeRepoFile(repoB, 'app.mjs', 'console.log("repoB");\n');
  await execGit(['add', '-A'], repoB);
  await execGit(['commit', '-m', 'feat(repoB): 第二个仓库初始提交'], repoB);
  writeRepoFile(repoB, 'app.mjs', 'console.log("repoB dirty");\n');

  // 初始化纯单仓夹具 singleRepo
  await initConfiguredRepo(singleRepo, 'main', { name: 'Solo', email: 'solo@example.com' });
  writeRepoFile(singleRepo, 'index.txt', 'solo\n');
  await execGit(['add', '-A'], singleRepo);
  await execGit(['commit', '-m', 'chore: single repo commit'], singleRepo);

  return {
    remoteA,
    repoA,
    repoB,
    singleRepo,
    nonGitDir,
    featSha,
    mergeSha,
    taggedSha,
    untrackedPath,
  };
};

test('M5 端到端浏览器回归（场景 A：真实多仓/Merge/Bare 推拉/双区折叠拖拽/悬浮详情卡/搜索/语言切换/护栏/保焦）', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'm5-e2e-scene-a-'));
  const browser = await launchHeadlessBrowser({ width: 460, height: 760 });
  const fixtures = await setupRealGitFixtures(tempRoot);

  const multiServer = await spawnPanelServer({
    workspacePaths: [fixtures.repoA, fixtures.repoB],
    preferencesDir: path.join(tempRoot, 'prefs-multi'),
  });
  const singleServer = await spawnPanelServer({
    workspacePaths: [fixtures.singleRepo],
    preferencesDir: path.join(tempRoot, 'prefs-single'),
  });

  t.after(async () => {
    await multiServer.close();
    await singleServer.close();
    await browser.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  // 1) 纯单仓夹具验证 [data-testid="repo-bar"] 隐藏
  const singlePage = await browser.newPage({ width: 420, height: 680 });
  await singlePage.navigate(singleServer.url);
  await singlePage.waitFor(
    '!document.getElementById("dual-pane")?.classList.contains("hidden") && document.querySelectorAll("[data-testid=commit-row]").length === 1',
    { description: 'single-repo initial render' },
  );
  const singleRepoBarHidden = await singlePage.evaluate(`(() => {
    const bar = document.querySelector('[data-testid="repo-bar"]');
    return Boolean(bar && bar.classList.contains('hidden') && bar.getBoundingClientRect().height === 0);
  })()`);
  assert.equal(singleRepoBarHidden, true, '单仓场景下 repo-bar 必须隐藏且零高度占位');
  const singleErrors = singlePage.getErrors();
  assert.deepEqual(singleErrors.consoleErrors, []);
  assert.deepEqual(singleErrors.pageErrors, []);
  await singlePage.close();

  // 2) 多仓真实端到端测试（repoA + repoB）
  const page = await browser.newPage({ width: 460, height: 760 });
  await page.navigate(multiServer.url);
  await page.waitFor(
    '!document.getElementById("dual-pane")?.classList.contains("hidden") && document.querySelectorAll("[data-testid=commit-row]").length >= 10',
    { description: 'multi-repo initial render' },
  );

  // 确保起始为中文环境
  const initialLang = await page.evaluate('document.documentElement.lang');
  if (initialLang !== 'zh-CN') {
    await page.clickSelector('[data-testid="graph-more-btn"]');
    await page.clickSelector('[data-testid="graph-menu-switch-language"]');
    await page.waitFor('document.documentElement.lang === "zh-CN"', { description: 'switch to zh-CN' });
  }

  // 验证多仓切换条可见，并在 repoA / repoB 间真实切换
  const multiRepoState = await page.evaluate(`(() => {
    const bar = document.querySelector('[data-testid="repo-bar"]');
    const select = document.querySelector('[data-testid="repo-select"]');
    const options = [...select.querySelectorAll('option')].map((o) => ({ value: o.value, text: o.textContent }));
    return {
      barVisible: Boolean(bar && !bar.classList.contains('hidden') && bar.getBoundingClientRect().height > 0),
      options,
      selected: select.value,
    };
  })()`);
  assert.equal(multiRepoState.barVisible, true);
  assert.equal(multiRepoState.options.length, 2);
  assert.ok(multiRepoState.options[0].text.includes('repoA'));
  assert.ok(multiRepoState.options[1].text.includes('repoB'));

  const repoBOptionValue = multiRepoState.options[1].value;
  const repoAOptionValue = multiRepoState.options[0].value;
  await page.evaluate(`(() => {
    const sel = document.querySelector('[data-testid="repo-select"]');
    sel.value = ${JSON.stringify(repoBOptionValue)};
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await page.waitFor(
    'document.body.innerText.includes("第二个仓库初始提交")',
    { description: 'switch to repoB' },
  );

  await page.evaluate(`(() => {
    const sel = document.querySelector('[data-testid="repo-select"]');
    sel.value = ${JSON.stringify(repoAOptionValue)};
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await page.waitFor(
    'document.body.innerText.includes("tag multi-ref baseline")',
    { description: 'switch back to repoA' },
  );

  // 验证超过 3 个 ref 标签折叠出 +N pill
  const moreRefPillText = await page.evaluate(`(() => {
    const row = document.querySelector('[data-testid="commit-row"][data-commit-sha="${fixtures.taggedSha}"]');
    return row?.querySelector('.gw-ref-pill.is-more')?.textContent ?? '';
  })()`);
  assert.match(moreRefPillText, /^\+\d+$/, '超过 3 个 ref 标签应折叠显示 +N');

  // 验证双区分隔条可拖拽、上下折叠切换正常
  const beforeDrag = await page.evaluate(`(() => ({
    changesH: document.querySelector('[data-testid="section-changes"]').getBoundingClientRect().height,
    graphH: document.querySelector('[data-testid="section-graph"]').getBoundingClientRect().height,
    valuenow: Number(document.querySelector('[data-testid="pane-sash"]').getAttribute('aria-valuenow')),
  }))()`);
  await page.dragBy('[data-testid="pane-sash"]', 0, 72);
  const afterDragDown = await page.evaluate(`(() => ({
    changesH: document.querySelector('[data-testid="section-changes"]').getBoundingClientRect().height,
    graphH: document.querySelector('[data-testid="section-graph"]').getBoundingClientRect().height,
    valuenow: Number(document.querySelector('[data-testid="pane-sash"]').getAttribute('aria-valuenow')),
  }))()`);
  assert.ok(afterDragDown.changesH > beforeDrag.changesH + 20, '向下拖拽分隔条应增大上区高度');
  assert.ok(afterDragDown.graphH < beforeDrag.graphH - 20, '向下拖拽分隔条应减小下区高度');
  assert.ok(afterDragDown.valuenow > beforeDrag.valuenow);

  // 拖回偏上位置，确保后续中部行详情卡在视口内有充足空间向下弹出
  await page.dragBy('[data-testid="pane-sash"]', 0, -110);

  // 测试上下区折叠与恢复
  await page.clickSelector('[data-testid="changes-collapse-btn"]');
  const changesCollapsedState = await page.evaluate(`(() => ({
    changesCollapsed: document.querySelector('[data-testid="section-changes"]').classList.contains('is-collapsed'),
    sashHidden: document.querySelector('[data-testid="pane-sash"]').classList.contains('hidden'),
    graphSole: document.querySelector('[data-testid="section-graph"]').classList.contains('is-expanded-sole'),
  }))()`);
  assert.deepEqual(changesCollapsedState, { changesCollapsed: true, sashHidden: true, graphSole: true });
  await page.clickSelector('[data-testid="changes-collapse-btn"]');

  await page.clickSelector('[data-testid="graph-collapse-btn"]');
  const graphCollapsedState = await page.evaluate(`(() => ({
    graphCollapsed: document.querySelector('[data-testid="section-graph"]').classList.contains('is-collapsed'),
    sashHidden: document.querySelector('[data-testid="pane-sash"]').classList.contains('hidden'),
    changesSole: document.querySelector('[data-testid="section-changes"]').classList.contains('is-expanded-sole'),
  }))()`);
  assert.deepEqual(graphCollapsedState, { graphCollapsed: true, sashHidden: true, changesSole: true });
  await page.clickSelector('[data-testid="graph-collapse-btn"]');
  await page.waitFor('!document.querySelector("[data-testid=pane-sash]").classList.contains("hidden")', {
    description: 'restore both panes',
  });

  // 验证 Standalone 点击更改文件显示提示 Toast
  await page.clickSelector('[data-testid="change-file-unstaged"][data-file-path="README.md"]');
  await page.waitFor(
    'document.querySelector("[data-testid=toast-info]")?.textContent?.includes("Antigravity 桌面端辅助栏")',
    { description: 'standalone file preview toast' },
  );

  // 验证 MM 双态文件存在于 staged 和 unstaged，放弃未暂存保留暂存区
  const mmBefore = await page.evaluate(`(() => ({
    inStaged: Boolean(document.querySelector('[data-testid="change-file-staged"][data-file-path="src/mm-双态.txt"]')),
    inUnstaged: Boolean(document.querySelector('[data-testid="change-file-unstaged"][data-file-path="src/mm-双态.txt"]')),
  }))()`);
  assert.deepEqual(mmBefore, { inStaged: true, inUnstaged: true });

  await page.hoverSelector('[data-testid="change-file-unstaged"][data-file-path="src/mm-双态.txt"]');
  await page.clickSelector('[data-testid="change-file-unstaged"][data-file-path="src/mm-双态.txt"] [data-testid="file-discard-btn"]');
  await page.waitFor('!document.querySelector("[data-testid=modal-overlay]").classList.contains("hidden")', {
    description: 'discard MM unstaged confirm modal',
  });
  await page.clickSelector('[data-testid="modal-confirm-btn"]');
  await page.waitFor(
    '!document.querySelector(\'[data-testid="change-file-unstaged"][data-file-path="src/mm-双态.txt"]\')',
    { description: 'MM unstaged entry removed after discard' },
  );
  assert.equal(
    fs.readFileSync(path.join(fixtures.repoA, 'src', 'mm-双态.txt'), 'utf8'),
    'v2-staged\n',
    '放弃 MM 未暂存修改时必须保留暂存区内容 v2-staged',
  );
  assert.equal(
    await page.evaluate('Boolean(document.querySelector(\'[data-testid="change-file-staged"][data-file-path="src/mm-双态.txt"]\'))'),
    true,
  );

  // 验证未跟踪文件删除弹出危险确认：取消后文件仍在，确认后从磁盘移除
  await page.hoverSelector('[data-testid="change-file-unstaged"][data-file-path="temp-未跟踪.txt"]');
  await page.clickSelector('[data-testid="change-file-unstaged"][data-file-path="temp-未跟踪.txt"] [data-testid="file-delete-untracked-btn"]');
  await page.waitFor('document.querySelector("[data-testid=modal-dialog]").classList.contains("is-danger")', {
    description: 'danger modal for untracked file delete',
  });
  await page.clickSelector('[data-testid="modal-cancel-btn"]');
  await page.waitFor('document.querySelector("[data-testid=modal-overlay]").classList.contains("hidden")', {
    description: 'danger modal closed on cancel',
  });
  assert.equal(fs.existsSync(fixtures.untrackedPath), true, '取消危险确认后未跟踪文件必须仍在磁盘上');

  await page.hoverSelector('[data-testid="change-file-unstaged"][data-file-path="temp-未跟踪.txt"]');
  await page.clickSelector('[data-testid="change-file-unstaged"][data-file-path="temp-未跟踪.txt"] [data-testid="file-delete-untracked-btn"]');
  await page.waitFor('document.querySelector("[data-testid=modal-dialog]").classList.contains("is-danger")', {
    description: 'danger modal reopened',
  });
  await page.clickSelector('[data-testid="modal-confirm-btn"]');
  await page.waitFor(
    '!document.querySelector(\'[data-testid="change-file-unstaged"][data-file-path="temp-未跟踪.txt"]\')',
    { description: 'untracked file removed from UI' },
  );
  assert.equal(fs.existsSync(fixtures.untrackedPath), false, '确认后未跟踪文件必须真实从磁盘移除');

  // 取消暂存 src/mm-双态.txt 使仓库进入「仅有未暂存更改」状态，随后测试空说明校验 -> 自动暂存提交 -> 推送更改 1↑
  await page.hoverSelector('[data-testid="change-file-staged"][data-file-path="src/mm-双态.txt"]');
  await page.clickSelector('[data-testid="change-file-staged"][data-file-path="src/mm-双态.txt"] [data-testid="file-unstage-btn"]');
  await page.waitFor('!document.querySelector("[data-testid=changes-group-staged]")', {
    description: 'staged group emptied',
  });

  // 空说明点击主按钮：触发校验提示并自动聚焦 textarea
  await page.clickSelector('[data-testid="commit-primary-btn"]');
  const emptyValidation = await page.evaluate(`(() => {
    const input = document.querySelector('[data-testid="commit-message-input"]');
    const msg = document.querySelector('[data-testid="commit-validation-msg"]');
    return {
      hasErrorClass: input.classList.contains('has-error'),
      msgVisible: !msg.classList.contains('hidden'),
      focused: document.activeElement === input,
    };
  })()`);
  assert.deepEqual(emptyValidation, { hasErrorClass: true, msgVisible: true, focused: true });

  // 填写说明后点击提交 -> 弹「自动暂存全部」模态框 -> 确认写入 Git 提交 -> 主按钮切换为「推送更改 1↑」
  await page.insertText('feat: 浏览器端到端自动暂存提交');
  await page.clickSelector('[data-testid="commit-primary-btn"]');
  await page.waitFor(
    '!document.querySelector("[data-testid=modal-overlay]").classList.contains("hidden") && !document.querySelector("[data-testid=modal-dialog]").classList.contains("is-danger")',
    { description: 'autoStageAll confirm modal' },
  );
  await page.clickSelector('[data-testid="modal-confirm-btn"]');

  await page.waitFor(
    'document.querySelector("[data-testid=changes-clean-empty]") && document.querySelector("[data-testid=commit-primary-btn]").dataset.actionState === "push"',
    { description: 'post-commit clean state and Push 1 button' },
  );
  const pushBtnText = await page.evaluate('document.querySelector("[data-testid=commit-primary-btn]").textContent');
  assert.equal(pushBtnText, '推送更改 1↑');
  assert.equal(await execGit(['log', '-1', '--pretty=%s'], fixtures.repoA), 'feat: 浏览器端到端自动暂存提交');

  // 点击推送更改 1↑ -> 真实推到 Bare 远端并恢复干净禁用态
  await page.clickSelector('[data-testid="commit-primary-btn"]');
  await page.waitFor(
    'document.querySelector("[data-testid=commit-primary-btn]").dataset.actionState === "clean-disabled"',
    { description: 'post-push clean-disabled state' },
  );
  const localHead = await execGit(['rev-parse', 'HEAD'], fixtures.repoA);
  const remoteMain = await execGit(['rev-parse', 'refs/heads/main'], fixtures.remoteA);
  assert.equal(localHead, remoteMain, '点击推送后 Bare 远端 refs/heads/main 必须同步到最新提交');

  // 点击含 Merge 分支的提交行展开文件清单：真实显示文件、历史已删文件不可点击、SVG 穿行竖线连续
  await page.clickSelector(`[data-testid="commit-row"][data-commit-sha="${fixtures.mergeSha}"]`);
  await page.waitFor(
    `document.querySelectorAll('[data-testid="commit-files"][data-commit-sha="${fixtures.mergeSha}"] [data-testid="commit-file-row"]').length >= 3`,
    { description: 'expand merge commit files' },
  );
  const mergeExpandCheck = await page.evaluate(`(() => {
    const filesWrap = document.querySelector('[data-testid="commit-files"][data-commit-sha="${fixtures.mergeSha}"]');
    const fileRows = [...filesWrap.querySelectorAll('[data-testid="commit-file-row"]')];
    const deletedRow = fileRows.find((r) => r.dataset.filePath === 'legacy/已删除文件.txt');
    const existingRow = fileRows.find((r) => r.dataset.filePath === '目录/中文文件.txt');
    const lineCountsPerRow = fileRows.map((row) => {
      const lines = [...row.querySelectorAll('svg.gw-graph-svg line')];
      const continuous = lines.every((ln) => ln.getAttribute('y1') === '0' && ln.getAttribute('y2') === '22' && ln.getAttribute('x1') === ln.getAttribute('x2'));
      return { count: lines.length, continuous };
    });
    return {
      filePaths: fileRows.map((r) => r.dataset.filePath),
      deletedDisabled: Boolean(deletedRow?.disabled && deletedRow.classList.contains('is-missing') && deletedRow.getAttribute('aria-disabled') === 'true'),
      existingEnabled: Boolean(existingRow && !existingRow.disabled),
      lineCountsPerRow,
    };
  })()`);
  assert.ok(mergeExpandCheck.filePaths.includes('legacy/已删除文件.txt'));
  assert.ok(mergeExpandCheck.filePaths.includes('目录/中文文件.txt'));
  assert.equal(mergeExpandCheck.deletedDisabled, true, '历史已删文件必须禁用且置灰');
  assert.equal(mergeExpandCheck.existingEnabled, true, '现存提交文件必须可点击');
  for (const rowSvg of mergeExpandCheck.lineCountsPerRow) {
    assert.ok(rowSvg.count >= 2, 'Merge 分支展开行处 SVG 拓扑列应保留多条穿行竖线');
    assert.equal(rowSvg.continuous, true, '展开行穿行竖线必须从 y=0 贯穿至 y=22 无断口');
  }

  // 点击第 1、2 条提交详情按钮向上弹出且不溢出视口；点击中部提交详情按钮向下弹出
  const checkCommitPopoverPlacement = async (rowIndex, expectedPlacement) => {
    await page.hoverSelector('[data-testid="commit-row"]', { index: rowIndex });
    await page.waitFor(
      `(() => {
        const rows = document.querySelectorAll('[data-testid="commit-row"]');
        const btn = rows[${rowIndex}]?.querySelector('[data-testid="commit-detail-btn"]');
        return Boolean(btn && btn.getBoundingClientRect().width > 0);
      })()`,
      { description: `hover detail button visible on row ${rowIndex}` },
    );
    await page.clickSelector(`[data-testid="commit-row"]:nth-of-type(${rowIndex + 1}) [data-testid="commit-detail-btn"]`).catch(async () => {
      const pt = await page.evaluate(`(() => {
        const rows = document.querySelectorAll('[data-testid="commit-row"]');
        const btn = rows[${rowIndex}].querySelector('[data-testid="commit-detail-btn"]');
        const r = btn.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`);
      await page.hoverSelector('[data-testid="commit-row"]', { index: rowIndex });
      await page.evaluate(`(() => {
        const rows = document.querySelectorAll('[data-testid="commit-row"]');
        rows[${rowIndex}].querySelector('[data-testid="commit-detail-btn"]').click();
      })()`);
      return pt;
    });
    await page.waitFor(
      '(() => { const p = document.querySelector("[data-testid=commit-popover]"); return Boolean(p && !p.classList.contains("hidden") && !p.textContent.includes("正在加载")); })()',
      { description: `popover opened and loaded for row ${rowIndex}` },
    );
    const placementInfo = await page.evaluate(`(() => {
      const p = document.querySelector('[data-testid="commit-popover"]');
      const r = p.getBoundingClientRect();
      return {
        placement: p.dataset.placement,
        withinViewport: r.top >= -0.5 && r.left >= -0.5 && r.right <= window.innerWidth + 0.5 && r.bottom <= window.innerHeight + 0.5,
      };
    })()`);
    assert.equal(placementInfo.placement, expectedPlacement, `第 ${rowIndex + 1} 条提交详情卡方向应为 ${expectedPlacement}`);
    assert.equal(placementInfo.withinViewport, true, `第 ${rowIndex + 1} 条提交详情卡不得溢出视口`);
    await page.clickSelector('[data-testid="popover-close-btn"]');
    await page.waitFor('document.querySelector("[data-testid=commit-popover]").classList.contains("hidden")', {
      description: 'close popover',
    });
  };

  // 先折叠 Merge 文件列表以免第 3+ 行位置下移，测第 1/2 条向上、中部第 9 条向下
  await page.clickSelector('[data-testid="graph-more-btn"]');
  await page.clickSelector('[data-testid="graph-menu-collapse-all"]');
  await page.waitFor('document.querySelectorAll("[data-testid=commit-files]").length === 0', {
    description: 'collapse all expanded commits',
  });

  await checkCommitPopoverPlacement(0, 'above');
  await checkCommitPopoverPlacement(1, 'above');
  await checkCommitPopoverPlacement(8, 'below');

  // 再展开 Merge 验证 ⋯ 菜单三项：搜索过滤、折叠全部、中英语言切换
  await page.clickSelector(`[data-testid="commit-row"][data-commit-sha="${fixtures.mergeSha}"]`);
  await page.waitFor('document.querySelectorAll("[data-testid=commit-files]").length === 1', {
    description: 're-expand merge commit before collapse-all check',
  });
  await page.clickSelector('[data-testid="graph-more-btn"]');
  await page.clickSelector('[data-testid="graph-menu-collapse-all"]');
  await page.waitFor('document.querySelectorAll("[data-testid=commit-files]").length === 0', {
    description: '⋯ menu collapse-all works',
  });

  // 自动 / 全部切换（验证侧分支 side/实验分支 显隐）
  const autoCount = await page.evaluate('document.querySelectorAll("[data-testid=commit-row]").length');
  assert.equal(await page.evaluate('document.body.innerText.includes("仅全部视图可见实验提交")'), false);
  await page.clickSelector('[data-testid="graph-scope-btn"]');
  await page.waitFor('document.body.innerText.includes("仅全部视图可见实验提交")', {
    description: 'all scope reveals side branch commit',
  });
  const allCount = await page.evaluate('document.querySelectorAll("[data-testid=commit-row]").length');
  assert.ok(allCount > autoCount);
  await page.clickSelector('[data-testid="graph-scope-btn"]');
  await page.waitFor('!document.body.innerText.includes("仅全部视图可见实验提交")', {
    description: 'auto scope hides side branch commit',
  });

  // 本地搜索过滤
  await page.clickSelector('[data-testid="graph-more-btn"]');
  await page.clickSelector('[data-testid="graph-menu-toggle-search"]');
  await page.waitFor('!document.getElementById("graph-search-bar").classList.contains("hidden")', {
    description: 'search bar visible',
  });
  await page.clickSelector('[data-testid="graph-search-input"]');
  await page.insertText('张协作');
  await page.waitFor('document.querySelectorAll("[data-testid=commit-row]").length === 1', {
    description: 'search filters by Chinese author name',
  });
  await page.clickSelector('[data-testid="graph-search-clear"]');
  await page.waitFor(`document.querySelectorAll("[data-testid=commit-row]").length === ${autoCount}`, {
    description: 'search clear restores all commits',
  });

  // 中英语言切换
  await page.clickSelector('[data-testid="graph-more-btn"]');
  await page.clickSelector('[data-testid="graph-menu-switch-language"]');
  await page.waitFor('document.documentElement.lang === "en"', { description: 'switch to English' });
  const enLabels = await page.evaluate(`({
    changesTitle: document.getElementById('changes-section-title').textContent,
    graphTitle: document.getElementById('graph-section-title').textContent,
    scopeText: document.querySelector('[data-testid="graph-scope-btn"]').textContent,
  })`);
  assert.deepEqual(enLabels, { changesTitle: 'Source Control', graphTitle: 'Graph', scopeText: 'Auto' });

  await page.clickSelector('[data-testid="graph-more-btn"]');
  await page.clickSelector('[data-testid="graph-menu-switch-language"]');
  await page.waitFor('document.documentElement.lang === "zh-CN"', { description: 'switch back to zh-CN' });

  // 验证重渲染与主题切换前后 commit-message-input 草稿与焦点及 :focus-visible 保持正常
  writeRepoFile(fixtures.repoA, 'README.md', '# Repo A\nfocus test edit\n');
  await page.waitFor(
    'Boolean(document.querySelector(\'[data-testid="change-file-unstaged"][data-file-path="README.md"]\'))',
    { description: 'fs.watch picks up disk change' },
  );

  await page.clickSelector('[data-testid="commit-message-input"]');
  await page.insertText('wip: 重渲染保焦草稿');
  await page.evaluate('document.documentElement.style.setProperty("--background", "#18181a")');
  await page.waitFor('document.documentElement.dataset.theme === "dark"', {
    description: 'theme switched to dark',
  });
  // 再次修改磁盘文件触发后台重渲染
  writeRepoFile(fixtures.repoA, 'src/core.js', 'export const version = 3;\n');
  await page.waitFor(
    'Boolean(document.querySelector(\'[data-testid="change-file-unstaged"][data-file-path="src/core.js"]\'))',
    { description: 'background re-render with core.js change' },
  );
  const inputFocusPreserved = await page.evaluate(`(() => {
    const input = document.querySelector('[data-testid="commit-message-input"]');
    return {
      activeIsInput: document.activeElement === input,
      draftValue: input.value,
      theme: document.documentElement.dataset.theme,
    };
  })()`);
  assert.deepEqual(inputFocusPreserved, {
    activeIsInput: true,
    draftValue: 'wip: 重渲染保焦草稿',
    theme: 'dark',
  });

  // 通过键盘 Tab 键进入 :focus-visible 并验证主题切换与局部重渲染后 :focus-visible 焦点状态不异常
  for (let step = 0; step < 6; step += 1) {
    await page.pressKey('Tab', 'Tab', 9);
    const hitRow = await page.evaluate(
      'document.activeElement?.dataset?.focusId === "file:unstaged:README.md" && document.activeElement.matches(":focus-visible")',
    );
    if (hitRow) break;
  }
  const keyboardFocusBefore = await page.evaluate(`(() => ({
    focusId: document.activeElement?.dataset?.focusId ?? null,
    focusVisible: Boolean(document.activeElement?.matches?.(':focus-visible')),
  }))()`);
  assert.equal(keyboardFocusBefore.focusId, 'file:unstaged:README.md');
  assert.equal(keyboardFocusBefore.focusVisible, true);

  await page.evaluate('document.documentElement.style.setProperty("--background", "#f7f7f8")');
  await page.waitFor('document.documentElement.dataset.theme === "light"', {
    description: 'theme switched back to light',
  });

  // 在 file:unstaged:README.md 保持 :focus-visible 状态下修改磁盘文件，触发 groupsEl 局部重渲染并校验焦点恢复
  writeRepoFile(fixtures.repoA, 'CHANGELOG.md', '## v1.0.1\n');
  await page.waitFor(
    'Boolean(document.querySelector(\'[data-testid="change-file-unstaged"][data-file-path="CHANGELOG.md"]\'))',
    { description: 'groupsEl partial re-render after file edit' },
  );
  const focusAfterRerender = await page.evaluate(`(() => ({
    focusId: document.activeElement?.dataset?.focusId ?? null,
    focusVisible: Boolean(document.activeElement?.matches?.(':focus-visible')),
    notBody: document.activeElement !== document.body && document.activeElement !== null,
  }))()`);
  assert.equal(focusAfterRerender.notBody, true);
  assert.equal(focusAfterRerender.focusId, 'file:unstaged:README.md');
  assert.equal(focusAfterRerender.focusVisible, true);

  const sceneAErrors = page.getErrors();
  assert.deepEqual(sceneAErrors.consoleErrors, [], `Scenario A had console errors: ${sceneAErrors.consoleErrors.join('; ')}`);
  assert.deepEqual(sceneAErrors.pageErrors, [], `Scenario A had page errors: ${sceneAErrors.pageErrors.join('; ')}`);
  await page.close();
});

test('M5 端到端浏览器回归（场景 B：Opaque srcdoc iframe + theme-change / workspace-change + 320–560px 窄幅与双主题截图）', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'm5-e2e-scene-b-'));
  const customScreenshotDir = process.env.AG_E2E_SCREENSHOT_DIR?.trim();
  const screenshotDir = customScreenshotDir || path.join(tempRoot, 'screenshots');

  const fixtures = await setupRealGitFixtures(tempRoot);
  const backendServer = await spawnPanelServer({
    workspacePaths: [fixtures.repoA],
    preferencesDir: path.join(tempRoot, 'prefs-iframe'),
  });

  // 构建宿主页代理服务器：提供父页 <iframe sandbox="allow-scripts" srcdoc="...">（含 <base href="...">），
  // 并将 opaque origin ('null') 对静态 ESM 模块与 /api/* 的请求代理到真实 main.mjs 服务。
  let hostProxyUrl = '';
  const hostProxyServer = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url || '/', hostProxyUrl || 'http://127.0.0.1');

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }

    if (reqUrl.pathname === '/host.html') {
      const rawHtml = await (await fetch(`${backendServer.url}/`)).text();
      const srcdocHtml = rawHtml
        .replace('<head>', `<head>\n  <base href="${hostProxyUrl}/" />`)
        .replace('/preload.js', '/preload.js?sdk=1');
      const escapedSrcdoc = srcdocHtml
        .replaceAll('&', '&amp;')
        .replaceAll('"', '&quot;');

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <title>Antigravity Auxiliary Pane Sandbox Host</title>
  <style>
    html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; }
    iframe { display: block; width: 100%; height: 100vh; border: 0; }
  </style>
</head>
<body>
  <iframe id="sidecar-frame" sandbox="allow-scripts" srcdoc="${escapedSrcdoc}"></iframe>
</body>
</html>`);
      return;
    }

    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const bodyBuffer = Buffer.concat(chunks);

    // 浏览器中止长轮询时同步中止上游请求，避免代理在后端关闭后抛出未处理的 fetch 异常
    const upstreamAbort = new AbortController();
    res.once('close', () => {
      if (!res.writableEnded) upstreamAbort.abort();
    });

    let upstreamRes;
    let payloadBuf;
    try {
      upstreamRes = await fetch(`${backendServer.url}${reqUrl.pathname}${reqUrl.search}`, {
        method: req.method,
        headers: {
          Origin: backendServer.url,
          ...(req.headers['content-type'] ? { 'Content-Type': String(req.headers['content-type']) } : {}),
        },
        body: req.method === 'POST' ? bodyBuffer : undefined,
        signal: upstreamAbort.signal,
      });
      payloadBuf = Buffer.from(await upstreamRes.arrayBuffer());
    } catch {
      if (!res.headersSent && !res.destroyed) {
        res.writeHead(502, { 'Access-Control-Allow-Origin': '*' });
        res.end();
      }
      return;
    }
    if (res.destroyed) {
      return;
    }
    res.writeHead(upstreamRes.status, {
      'Content-Type': upstreamRes.headers.get('content-type') || 'application/octet-stream',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Cache-Control': upstreamRes.headers.get('cache-control') || 'no-store',
    });
    res.end(payloadBuf);
  });

  await new Promise((resolve) => {
    hostProxyServer.listen(0, '127.0.0.1', () => resolve());
  });
  hostProxyUrl = `http://127.0.0.1:${hostProxyServer.address().port}`;

  const browser = await launchHeadlessBrowser({ width: 420, height: 760 });

  t.after(async () => {
    await browser.close();
    hostProxyServer.closeAllConnections?.();
    await new Promise((resolve) => hostProxyServer.close(() => resolve()));
    await backendServer.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const page = await browser.newPage({ width: 420, height: 760 });
  await page.navigate(`${hostProxyUrl}/host.html`);
  const iframeSessionId = await page.waitForIframeSession('about:srcdoc');

  // 确认真实处于 opaque origin (sandbox="allow-scripts" 无 allow-same-origin) 与模拟 SDK 就绪
  await page.waitFor(
    '!document.getElementById("dual-pane")?.classList.contains("hidden") && document.querySelectorAll("[data-testid=commit-row]").length >= 10',
    { sessionId: iframeSessionId, description: 'opaque iframe initial render' },
  );

  const sandboxMeta = await page.evaluate(
    `(() => {
      let localStorageBlocked = false;
      try {
        window.localStorage.setItem('probe', '1');
      } catch (_err) {
        localStorageBlocked = true;
      }
      return {
        origin: window.origin,
        href: window.location.href,
        hasSidecar: typeof window.sidecar === 'object',
        localStorageBlocked,
      };
    })()`,
    { sessionId: iframeSessionId },
  );
  assert.deepEqual(sandboxMeta, {
    origin: 'null',
    href: 'about:srcdoc',
    hasSidecar: true,
    localStorageBlocked: true,
  });

  // 通过 postMessage 测试 theme-change 切换到暗色主题（含低对比度 --error 验证 WCAG 4.5:1 校正）并截图
  await page.evaluate(`(() => {
    const frame = document.getElementById('sidecar-frame');
    frame.contentWindow.postMessage({
      type: 'theme-change',
      payload: {
        cssVariables: {
          '--background': '#18181a',
          '--card': '#202024',
          '--secondary': '#2a2a2f',
          '--muted': '#232328',
          '--accent': '#2f3136',
          '--foreground': '#e4e4e7',
          '--muted-foreground': '#a1a1aa',
          '--placeholder': '#71717a',
          '--border': 'rgba(228, 228, 231, 0.14)',
          '--primary': '#3794ff',
          '--primary-foreground': '#ffffff',
          '--error': '#882222',
          '--ring': 'rgba(55, 148, 255, 0.72)',
          '--font-family': '"Segoe UI"',
          '--editor-font-family': '"Cascadia Mono"'
        }
      }
    }, '*');
  })()`);
  await page.waitFor(
    'document.documentElement.dataset.theme === "dark" && getComputedStyle(document.documentElement).colorScheme === "dark"',
    { sessionId: iframeSessionId, description: 'theme-change dark sync' },
  );
  // 展开 Merge 提交并固定第 2 行悬浮详情卡，保存暗色截图 1
  await page.evaluate(
    `document.querySelector('[data-testid="commit-row"][data-commit-sha="${fixtures.mergeSha}"]').click()`,
    { sessionId: iframeSessionId },
  );
  await page.waitFor(
    'document.querySelectorAll("[data-testid=commit-file-row]").length >= 3',
    { sessionId: iframeSessionId, description: 'expand merge commit in iframe for screenshot' },
  );
  const darkScreenshotPath = path.join(screenshotDir, 'm5-dark-aux-pane.png');
  await page.captureScreenshot(darkScreenshotPath);

  // 通过 postMessage 测试 theme-change 切换到亮色主题并打开悬浮详情卡保存亮色截图 2
  await page.evaluate(`(() => {
    const frame = document.getElementById('sidecar-frame');
    frame.contentWindow.postMessage({
      type: 'theme-change',
      payload: {
        cssVariables: {
          '--background': '#f7f7f8',
          '--card': '#ffffff',
          '--secondary': '#e6e7e9',
          '--muted': '#eff0f1',
          '--accent': '#e4e7ec',
          '--foreground': '#1d1f21',
          '--muted-foreground': '#5d676f',
          '--placeholder': '#8c959d',
          '--border': 'rgba(29, 31, 33, 0.12)',
          '--primary': '#0969da',
          '--primary-foreground': '#ffffff',
          '--error': '#cf222e',
          '--ring': 'rgba(9, 105, 218, 0.72)'
        }
      }
    }, '*');
  })()`);
  await page.waitFor(
    'document.documentElement.dataset.theme === "light" && getComputedStyle(document.documentElement).colorScheme === "light"',
    { sessionId: iframeSessionId, description: 'theme-change light sync' },
  );
  await page.evaluate(
    'document.querySelectorAll("[data-testid=commit-row]")[1].querySelector("[data-testid=commit-detail-btn]").click()',
    { sessionId: iframeSessionId },
  );
  await page.waitFor(
    '!document.querySelector("[data-testid=commit-popover]").classList.contains("hidden") && !document.querySelector("[data-testid=commit-popover]").textContent.includes("正在加载")',
    { sessionId: iframeSessionId, description: 'popover visible in light theme' },
  );
  const lightScreenshotPath = path.join(screenshotDir, 'm5-light-popover.png');
  await page.captureScreenshot(lightScreenshotPath);
  await page.evaluate(
    'document.querySelector("[data-testid=popover-close-btn]")?.click()',
    { sessionId: iframeSessionId },
  );

  // 通过 postMessage 测试 workspace-change 动态切换：单仓 repoB -> 非 Git 空态 -> 双仓 (repoA + repoB)
  await page.evaluate(`(() => {
    const frame = document.getElementById('sidecar-frame');
    frame.contentWindow.postMessage({
      type: 'workspace-change',
      payload: { workspaceUris: [${JSON.stringify(toFileUri(fixtures.repoB))}] }
    }, '*');
  })()`);
  await page.waitFor(
    'document.body.innerText.includes("第二个仓库初始提交") && document.querySelector("[data-testid=repo-bar]").classList.contains("hidden")',
    { sessionId: iframeSessionId, description: 'workspace-change to repoB' },
  );

  await page.evaluate(`(() => {
    const frame = document.getElementById('sidecar-frame');
    frame.contentWindow.postMessage({
      type: 'workspace-change',
      payload: { workspaceUris: [${JSON.stringify(toFileUri(fixtures.nonGitDir))}] }
    }, '*');
  })()`);
  await page.waitFor(
    '!document.getElementById("empty-state").classList.contains("hidden") && document.getElementById("dual-pane").classList.contains("hidden")',
    { sessionId: iframeSessionId, description: 'workspace-change to non-git empty state' },
  );

  await page.evaluate(`(() => {
    const frame = document.getElementById('sidecar-frame');
    frame.contentWindow.postMessage({
      type: 'workspace-change',
      payload: { workspaceUris: [${JSON.stringify(toFileUri(fixtures.repoA))}, ${JSON.stringify(toFileUri(fixtures.repoB))}] }
    }, '*');
  })()`);
  await page.waitFor(
    '!document.querySelector("[data-testid=repo-bar]").classList.contains("hidden") && document.querySelectorAll("[data-testid=repo-select] option").length === 2',
    { sessionId: iframeSessionId, description: 'workspace-change to multi-repo' },
  );

  // 依次在 320px、360px、420px、560px 宽度下验证零横向溢出与主要元素边界无越界
  for (const width of [320, 360, 420, 560]) {
    await page.setViewport(width, 720);
    await page.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))', {
      sessionId: iframeSessionId,
    });
    const layoutMetrics = await page.evaluate(
      `(() => {
        const docEl = document.documentElement;
        const appPane = document.getElementById('app');
        const selectors = [
          '[data-testid="repo-bar"]',
          '[data-testid="changes-section-header"]',
          '[data-testid="commit-message-input"]',
          '[data-testid="commit-primary-btn"]',
          '[data-testid="graph-section-header"]',
          '[data-testid="graph-toolbar-actions"]',
          '[data-testid="change-file-unstaged"]',
          '[data-testid="commit-row"]',
        ];
        const outOfBounds = [];
        for (const sel of selectors) {
          for (const el of document.querySelectorAll(sel)) {
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) continue;
            if (rect.left < -0.5 || rect.right > window.innerWidth + 0.5) {
              outOfBounds.push({ sel, left: rect.left, right: rect.right, innerWidth: window.innerWidth });
            }
          }
        }
        const branchMeta = document.getElementById('repo-branch-meta');
        return {
          docScrollWidth: docEl.scrollWidth,
          docClientWidth: docEl.clientWidth,
          bodyScrollWidth: document.body.scrollWidth,
          bodyClientWidth: document.body.clientWidth,
          paneScrollWidth: appPane.scrollWidth,
          paneClientWidth: appPane.clientWidth,
          outOfBounds,
          branchMetaDisplay: branchMeta ? getComputedStyle(branchMeta).display : null,
        };
      })()`,
      { sessionId: iframeSessionId },
    );

    assert.ok(
      layoutMetrics.docScrollWidth <= layoutMetrics.docClientWidth,
      `${width}px 宽度下 documentElement 横向溢出: ${layoutMetrics.docScrollWidth} > ${layoutMetrics.docClientWidth}`,
    );
    assert.ok(
      layoutMetrics.bodyScrollWidth <= layoutMetrics.bodyClientWidth,
      `${width}px 宽度下 body 横向溢出: ${layoutMetrics.bodyScrollWidth} > ${layoutMetrics.bodyClientWidth}`,
    );
    assert.ok(
      layoutMetrics.paneScrollWidth <= layoutMetrics.paneClientWidth,
      `${width}px 宽度下 #app 横向溢出: ${layoutMetrics.paneScrollWidth} > ${layoutMetrics.paneClientWidth}`,
    );
    assert.deepEqual(layoutMetrics.outOfBounds, [], `${width}px 宽度下主要元素边界越界`);
    if (width === 320) {
      assert.equal(layoutMetrics.branchMetaDisplay, 'none', '320px 窄幅容器查询应隐藏次要分支元数据');
    }
  }

  assert.equal(fs.existsSync(darkScreenshotPath), true);
  assert.equal(fs.existsSync(lightScreenshotPath), true);

  const sceneBErrors = page.getErrors();
  assert.deepEqual(sceneBErrors.consoleErrors, [], `Scenario B had console errors: ${sceneBErrors.consoleErrors.join('; ')}`);
  assert.deepEqual(sceneBErrors.pageErrors, [], `Scenario B had page errors: ${sceneBErrors.pageErrors.join('; ')}`);
  await page.close();
});
