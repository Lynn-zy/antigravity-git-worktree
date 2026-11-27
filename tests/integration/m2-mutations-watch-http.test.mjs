import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  normalizeFsPath,
  toFileUri,
} from '../../sidecars/panel/backend/discovery.mjs';
import {
  createEventBus,
} from '../../sidecars/panel/backend/event-bus.mjs';
import {
  AppError,
  ERROR_CODES,
} from '../../sidecars/panel/backend/git-runner.mjs';
import {
  createPreferencesStore,
  resolvePreferencesPath,
} from '../../sidecars/panel/backend/preferences.mjs';
import {
  createRepositoryWatcher,
  createWatcherPool,
} from '../../sidecars/panel/backend/watcher.mjs';
import {
  API_ROUTES,
  createApiRouter,
} from '../../sidecars/panel/backend/api-router.mjs';
import {
  createMockFixtureStore,
} from '../../sidecars/panel/backend/mock-fixture.mjs';
import {
  STATIC_WHITELIST,
  startSidecarServer,
  startStandaloneServer,
} from '../../sidecars/panel/main.mjs';
import {
  loadSidecarSdk,
} from '../../sidecars/panel/sdk.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '..', '..');
const MAIN_MJS_PATH = path.join(REPO_ROOT, 'sidecars', 'panel', 'main.mjs');

function execGit(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
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
        reject(new Error(`git ${args.join(' ')} failed (${code}): ${errText}`));
        return;
      }
      resolve(outText.trim());
    });
  });
}

async function initConfiguredRepo(repoDir, branch = 'main') {
  fs.mkdirSync(repoDir, { recursive: true });
  await execGit(['init', '-b', branch], repoDir);
  await execGit(['config', 'user.name', 'Test User'], repoDir);
  await execGit(['config', 'user.email', 'test@example.com'], repoDir);
  await execGit(['config', 'core.autocrlf', 'false'], repoDir);
}

async function postApi(baseUrl, pathname, payload, extraHeaders = {}) {
  const url = new URL(pathname, baseUrl);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Origin: url.origin,
      'Content-Type': 'application/json; charset=utf-8',
      ...extraHeaders,
    },
    body: JSON.stringify(payload),
  });
  const json = await response.json();
  return { response, json };
}

function sendRawHttpRequest({ port, method, reqPath, headers = {}, body = '' }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: reqPath,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            text: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.once('error', reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

test('sdk.mjs 动态导入与 createRequire 回退，以及 preferences.mjs 原子写入与校验', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm2-sdk-prefs-'));
  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const fakeSdkFile = path.join(tempDir, 'fake-sidecar-sdk.mjs');
  fs.writeFileSync(
    fakeSdkFile,
    'export class Response {}\nexport class SidecarApp { constructor() {} }\n',
    'utf8',
  );

  let esmAttempted = false;
  const loaded = await loadSidecarSdk({
    importFn: async (specifier) => {
      if (specifier === 'sidecar_sdk') {
        esmAttempted = true;
        throw new Error('Cannot find package sidecar_sdk in ESM');
      }
      return import(specifier);
    },
    resolveFn: () => fakeSdkFile,
  });
  assert.equal(esmAttempted, true);
  assert.equal(typeof loaded.SidecarApp, 'function');
  assert.equal(typeof loaded.Response, 'function');

  const originalDataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  try {
    process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR = tempDir;
    assert.equal(resolvePreferencesPath(), path.join(tempDir, 'prefs.json'));
  } finally {
    if (originalDataDir === undefined) {
      delete process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
    } else {
      process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR = originalDataDir;
    }
  }

  const prefsPath = path.join(tempDir, 'sub', 'prefs.json');
  const prefsStore = createPreferencesStore({ filePath: prefsPath });
  assert.deepEqual(await prefsStore.load(), {
    locale: 'auto',
    graphScope: 'auto',
    splitRatio: 0.42,
  });

  const updated = await prefsStore.update({ locale: 'zh-CN', splitRatio: 0.99 });
  assert.deepEqual(updated, {
    locale: 'zh-CN',
    graphScope: 'auto',
    splitRatio: 0.85,
  });

  const partialUpdate = await prefsStore.update({ graphScope: 'all', splitRatio: 0.05 });
  assert.deepEqual(partialUpdate, {
    locale: 'zh-CN',
    graphScope: 'all',
    splitRatio: 0.15,
  });

  const remainingFiles = fs.readdirSync(path.dirname(prefsPath));
  assert.deepEqual(remainingFiles, ['prefs.json']);

  await assert.rejects(
    () => prefsStore.update({ locale: 'fr-FR' }),
    (err) => err instanceof AppError && err.code === ERROR_CODES.INVALID_REQUEST && err.statusCode === 400,
  );
  await assert.rejects(
    () => prefsStore.update({ splitRatio: '0.5' }),
    (err) => err instanceof AppError && err.code === ERROR_CODES.INVALID_REQUEST && err.statusCode === 400,
  );
});

test('event-bus.mjs 支持超时钳制、最多 8 个等待者唤醒最旧者及版本变更即时返回', async (t) => {
  const bus = createEventBus({ initialRevision: 5 });
  t.after(() => bus.dispose());

  assert.equal(bus.clampTimeoutMs(10), 1000);
  assert.equal(bus.clampTimeoutMs(99_999), 20_000);
  assert.equal(bus.clampTimeoutMs(5000), 5000);

  const immediate = await bus.waitForEvent({ sinceRevision: 4, timeoutMs: 5000 });
  assert.deepEqual(immediate, { revision: 5, refresh: 'full' });

  const waiters = [];
  for (let i = 0; i < 8; i += 1) {
    waiters.push(bus.waitForEvent({ sinceRevision: 5, timeoutMs: 20_000 }));
  }
  assert.equal(bus.pendingCount, 8);

  // 第 9 个等待者进入时，应立即唤醒第 1 个（最旧者）并返回 refresh: 'none'
  const ninth = bus.waitForEvent({ sinceRevision: 5, timeoutMs: 20_000 });
  const evictedResult = await waiters[0];
  assert.deepEqual(evictedResult, { revision: 5, refresh: 'none' });
  assert.equal(bus.pendingCount, 8);

  const bumped = bus.bumpRevision();
  assert.equal(bumped.revision, 6);

  const settledRest = await Promise.all([...waiters.slice(1), ninth]);
  assert.equal(settledRest.length, 8);
  for (const item of settledRest) {
    assert.deepEqual(item, { revision: 6, refresh: 'full' });
  }
  assert.equal(bus.pendingCount, 0);
});

test('event-bus.mjs 按刷新级别汇总：只有 status 级变更返回 status，期间混入任意 full 级变更返回 full，且按工作区隔离', async (t) => {
  const bus = createEventBus({ initialRevision: 1 });
  t.after(() => bus.dispose());

  const statusWait = bus.waitForEvent({ sinceRevision: 1, scopeKey: 'ws-a', timeoutMs: 5000 });
  bus.bumpRevision({ scopeKeys: ['ws-a'], refresh: 'status' });
  assert.deepEqual(await statusWait, { revision: 2, refresh: 'status' });

  bus.bumpRevision({ scopeKeys: ['ws-a'], refresh: 'status' });
  bus.bumpRevision({ scopeKeys: ['ws-a'], refresh: 'full' });
  bus.bumpRevision({ scopeKeys: ['ws-a'], refresh: 'status' });
  assert.deepEqual(await bus.waitForEvent({ sinceRevision: 2, scopeKey: 'ws-a' }), { revision: 5, refresh: 'full' });
  assert.deepEqual(await bus.waitForEvent({ sinceRevision: 4, scopeKey: 'ws-a' }), { revision: 5, refresh: 'status' });
  assert.equal(bus.pendingRefresh('ws-a', 5), 'none');

  bus.bumpRevision({ scopeKeys: ['ws-b'], refresh: 'full' });
  assert.equal(bus.pendingRefresh('ws-a', 5), 'none', '其他工作区的变更不得唤醒 ws-a');
  assert.equal(bus.pendingRefresh('ws-b', 5), 'full');

  bus.bumpRevision();
  assert.equal(bus.pendingRefresh('ws-a', 5), 'full', '不带作用域的广播默认按 full 处理');
});

test('集成测试：全套 POST /api/* 写操作、unborn rm --cached、MM 保暂存、单未跟踪删除、OUT_OF_WORKTREE 与冲突阻断', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm2-int-api-'));
  const prefsPath = path.join(root, 'prefs.json');
  const nonGitDir = path.join(root, 'plain-folder');
  const outsideFile = path.join(root, 'outside-secret.txt');
  const unbornRepo = path.join(root, 'unborn-repo');
  const secondRepo = path.join(root, 'second-repo');
  fs.mkdirSync(nonGitDir, { recursive: true });
  fs.writeFileSync(outsideFile, 'top-secret\n');

  await initConfiguredRepo(unbornRepo, 'main');
  await initConfiguredRepo(secondRepo, 'main');
  fs.writeFileSync(path.join(secondRepo, 'doc.md'), '# hello\n');
  await execGit(['add', '--', 'doc.md'], secondRepo);
  await execGit(['commit', '-m', 'second repo init'], secondRepo);

  const server = await startStandaloneServer({
    port: 0,
    preferencesPath: prefsPath,
    defaultWorkspaceUris: [],
  });
  t.after(async () => {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  // 1) 无仓工作区仅包含非 Git 目录时返回空仓库列表
  const emptySnapRes = await postApi(server.url, '/api/snapshot', {
    workspaceUris: [toFileUri(nonGitDir)],
  });
  assert.equal(emptySnapRes.response.status, 200);
  assert.equal(emptySnapRes.json.ok, true);
  assert.deepEqual(emptySnapRes.json.data.repositories, []);
  assert.equal(emptySnapRes.json.data.activeRepo, null);

  // 2) 多仓发现与非 Git 忽略、unborn 仓 stage 与 unstage (git rm --cached -r)
  fs.mkdirSync(path.join(unbornRepo, '中文 目录'), { recursive: true });
  fs.writeFileSync(path.join(unbornRepo, '中文 目录', '新 文件.txt'), 'draft-1\n');
  fs.writeFileSync(path.join(unbornRepo, '-weird.txt'), 'dash-file\n');

  const multiSnap = await postApi(server.url, '/api/snapshot', {
    workspaceUris: [toFileUri(nonGitDir), toFileUri(unbornRepo), toFileUri(secondRepo)],
  });
  assert.equal(multiSnap.response.status, 200);
  assert.equal(multiSnap.json.data.repositories.length, 2);
  assert.equal(multiSnap.json.data.activeRepo.worktreePath, normalizeFsPath(unbornRepo));
  assert.equal(multiSnap.json.data.activeRepo.isUnborn, true);
  assert.deepEqual(multiSnap.json.data.graph.commits, []);

  // OUT_OF_WORKTREE 拒绝（..、绝对路径与 symlink 逃逸）
  const linkDir = path.join(unbornRepo, 'escape-link');
  fs.symlinkSync(path.dirname(outsideFile), linkDir, process.platform === 'win32' ? 'junction' : 'dir');
  for (const badPath of ['../outside-secret.txt', outsideFile, 'escape-link/outside-secret.txt']) {
    const res = await postApi(server.url, '/api/changes/stage', {
      worktreePath: unbornRepo,
      paths: [badPath],
    });
    assert.equal(res.response.status, 403);
    assert.equal(res.json.ok, false);
    assert.equal(res.json.error.code, ERROR_CODES.OUT_OF_WORKTREE);
  }
  fs.rmSync(linkDir, { recursive: true, force: true });

  // 暂存中文路径与 -weird.txt
  const stageRes = await postApi(server.url, '/api/changes/stage', {
    worktreePath: unbornRepo,
    paths: ['中文 目录/新 文件.txt', '-weird.txt'],
  });
  assert.equal(stageRes.response.status, 200);
  assert.equal(stageRes.json.ok, true);

  let snapAfterStage = await postApi(server.url, '/api/snapshot', {
    workspaceUris: [toFileUri(unbornRepo), toFileUri(secondRepo)],
  });
  assert.equal(snapAfterStage.json.data.changes.staged.length, 2);

  // unborn 单文件与全部取消暂存（验证不报 HEAD 缺失错误）
  const unstageSingle = await postApi(server.url, '/api/changes/unstage', {
    worktreePath: unbornRepo,
    paths: ['-weird.txt'],
  });
  assert.equal(unstageSingle.response.status, 200);
  const unstageAll = await postApi(server.url, '/api/changes/unstage', {
    worktreePath: unbornRepo,
    all: true,
  });
  assert.equal(unstageAll.response.status, 200);

  snapAfterStage = await postApi(server.url, '/api/snapshot', {
    workspaceUris: [toFileUri(unbornRepo), toFileUri(secondRepo)],
  });
  assert.equal(snapAfterStage.json.data.changes.staged.length, 0);
  assert.equal(snapAfterStage.json.data.changes.unstaged.length, 2);

  // 空说明与空暂存区阻断
  const emptyMsgRes = await postApi(server.url, '/api/commit', {
    worktreePath: unbornRepo,
    message: '   \n  ',
    autoStageAll: false,
  });
  assert.equal(emptyMsgRes.response.status, 400);
  assert.equal(emptyMsgRes.json.error.code, ERROR_CODES.EMPTY_COMMIT_MESSAGE);

  const nothingToCommitRes = await postApi(server.url, '/api/commit', {
    worktreePath: unbornRepo,
    message: 'chore: should fail without staged',
    autoStageAll: false,
  });
  assert.equal(nothingToCommitRes.response.status, 409);
  assert.equal(nothingToCommitRes.json.error.code, ERROR_CODES.NOTHING_TO_COMMIT);

  // autoStageAll: true 完成 unborn 首次提交
  const firstCommitRes = await postApi(server.url, '/api/commit', {
    worktreePath: unbornRepo,
    message: 'feat: initial commit\n\nCo-authored-by: Pair <pair@example.com>',
    autoStageAll: true,
  });
  assert.equal(firstCommitRes.response.status, 200);
  assert.match(firstCommitRes.json.data.sha, /^[0-9a-f]{40}$/i);

  // 3) commit/detail 验证 & NO_REPOSITORY 拒绝未授权目录
  const detailRes = await postApi(server.url, '/api/commit/detail', {
    worktreePath: unbornRepo,
    sha: firstCommitRes.json.data.sha,
  });
  assert.equal(detailRes.response.status, 200);
  assert.equal(detailRes.json.data.subject, 'feat: initial commit');
  assert.deepEqual(detailRes.json.data.coAuthors, [{ name: 'Pair', email: 'pair@example.com' }]);
  assert.equal(detailRes.json.data.files.length, 2);
  const statsRes = await postApi(server.url, '/api/commit/stats', {
    worktreePath: unbornRepo,
    sha: firstCommitRes.json.data.sha,
  });
  assert.equal(statsRes.response.status, 200);
  // 根提交与空树比较：两个文件各新增 1 行
  assert.deepEqual(statsRes.json.data, { files: 2, insertions: 2, deletions: 0 });

  const badShaRes = await postApi(server.url, '/api/commit/detail', {
    worktreePath: unbornRepo,
    sha: 'not-a-sha!',
  });
  assert.equal(badShaRes.response.status, 400);
  assert.equal(badShaRes.json.error.code, ERROR_CODES.INVALID_REQUEST);

  const unauthRepoRes = await postApi(server.url, '/api/commit/detail', {
    worktreePath: root,
    sha: firstCommitRes.json.data.sha,
  });
  assert.equal(unauthRepoRes.response.status, 409);
  assert.equal(unauthRepoRes.json.error.code, ERROR_CODES.NO_REPOSITORY);

  // 4) discard：MM 双态保留暂存区内容、allTracked 不删未跟踪、untracked 单文件删除及校验
  const mmPath = path.join(unbornRepo, '中文 目录', '新 文件.txt');
  const weirdPath = path.join(unbornRepo, '-weird.txt');
  const untrackedKeepPath = path.join(unbornRepo, 'keep-me.txt');
  const untrackedDropPath = path.join(unbornRepo, 'drop-me.txt');

  fs.writeFileSync(mmPath, 'staged-v2\n');
  await postApi(server.url, '/api/changes/stage', {
    worktreePath: unbornRepo,
    paths: ['中文 目录/新 文件.txt'],
  });
  fs.writeFileSync(mmPath, 'unstaged-v3\n');
  fs.writeFileSync(weirdPath, 'modified-dash\n');
  fs.writeFileSync(untrackedKeepPath, 'keep\n');
  fs.writeFileSync(untrackedDropPath, 'drop\n');

  // 单文件放弃 MM 未暂存修改，工作区应恢复为 staged-v2 且暂存区仍在
  const discardMmRes = await postApi(server.url, '/api/changes/discard', {
    worktreePath: unbornRepo,
    paths: ['中文 目录/新 文件.txt'],
  });
  assert.equal(discardMmRes.response.status, 200);
  assert.equal(fs.readFileSync(mmPath, 'utf8'), 'staged-v2\n');

  const snapAfterMmDiscard = await postApi(server.url, '/api/snapshot', {
    workspaceUris: [toFileUri(unbornRepo)],
  });
  assert.equal(snapAfterMmDiscard.json.data.changes.staged.length, 1);
  assert.equal(snapAfterMmDiscard.json.data.changes.staged[0].path, '中文 目录/新 文件.txt');

  // allTracked: true 还原 -weird.txt，绝不删除 keep-me.txt 和 drop-me.txt
  const discardAllTrackedRes = await postApi(server.url, '/api/changes/discard', {
    worktreePath: unbornRepo,
    allTracked: true,
  });
  assert.equal(discardAllTrackedRes.response.status, 200);
  assert.equal(fs.readFileSync(weirdPath, 'utf8'), 'dash-file\n');
  assert.equal(fs.existsSync(untrackedKeepPath), true);
  assert.equal(fs.existsSync(untrackedDropPath), true);

  // untracked: true 传 2 个路径或传已跟踪文件必须拒绝
  const multiUntrackedRes = await postApi(server.url, '/api/changes/discard', {
    worktreePath: unbornRepo,
    untracked: true,
    paths: ['keep-me.txt', 'drop-me.txt'],
  });
  assert.equal(multiUntrackedRes.response.status, 400);

  const trackedAsUntrackedRes = await postApi(server.url, '/api/changes/discard', {
    worktreePath: unbornRepo,
    untracked: true,
    paths: ['-weird.txt'],
  });
  assert.equal(trackedAsUntrackedRes.response.status, 400);

  const dropUntrackedRes = await postApi(server.url, '/api/changes/discard', {
    worktreePath: unbornRepo,
    untracked: true,
    paths: ['drop-me.txt'],
  });
  assert.equal(dropUntrackedRes.response.status, 200);
  assert.equal(fs.existsSync(untrackedDropPath), false);
  assert.equal(fs.existsSync(untrackedKeepPath), true);

  // 清理并提交 MM 暂存内容
  fs.rmSync(untrackedKeepPath, { force: true });
  const commitStagedRes = await postApi(server.url, '/api/commit', {
    worktreePath: unbornRepo,
    message: 'chore: commit staged v2',
  });
  assert.equal(commitStagedRes.response.status, 200);

  // 5) 合并冲突阻断（CONFLICT_BLOCKED）
  await execGit(['checkout', '-b', 'conflict-branch'], unbornRepo);
  fs.writeFileSync(weirdPath, 'branch-side\n');
  await execGit(['add', '--', '-weird.txt'], unbornRepo);
  await execGit(['commit', '-m', 'branch edit'], unbornRepo);

  await execGit(['checkout', 'main'], unbornRepo);
  fs.writeFileSync(weirdPath, 'main-side\n');
  await execGit(['add', '--', '-weird.txt'], unbornRepo);
  await execGit(['commit', '-m', 'main edit'], unbornRepo);

  await assert.rejects(() => execGit(['merge', 'conflict-branch'], unbornRepo));

  const conflictCommitRes = await postApi(server.url, '/api/commit', {
    worktreePath: unbornRepo,
    message: 'should block on conflict',
    autoStageAll: true,
  });
  assert.equal(conflictCommitRes.response.status, 409);
  assert.equal(conflictCommitRes.json.error.code, ERROR_CODES.CONFLICT_BLOCKED);

  const conflictDiscardRes = await postApi(server.url, '/api/changes/discard', {
    worktreePath: unbornRepo,
    paths: ['-weird.txt'],
  });
  assert.equal(conflictDiscardRes.response.status, 409);
  assert.equal(conflictDiscardRes.json.error.code, ERROR_CODES.CONFLICT_BLOCKED);

  const conflictDiscardAllRes = await postApi(server.url, '/api/changes/discard', {
    worktreePath: unbornRepo,
    allTracked: true,
  });
  assert.equal(conflictDiscardAllRes.response.status, 409);
  assert.equal(conflictDiscardAllRes.json.error.code, ERROR_CODES.CONFLICT_BLOCKED);

  // 6) POST /api/preferences 端点更新并反映到下一次快照
  const prefsRes = await postApi(server.url, '/api/preferences', {
    locale: 'en',
    graphScope: 'all',
    splitRatio: 0.55,
  });
  assert.equal(prefsRes.response.status, 200);
  assert.deepEqual(prefsRes.json.data, {
    locale: 'en',
    graphScope: 'all',
    splitRatio: 0.55,
  });

  const switchedSnap = await postApi(server.url, '/api/snapshot', {
    workspaceUris: [toFileUri(unbornRepo), toFileUri(secondRepo)],
    selectedRepoId: multiSnap.json.data.repositories[1].id,
  });
  assert.equal(switchedSnap.json.data.activeRepo.worktreePath, normalizeFsPath(secondRepo));
  assert.deepEqual(switchedSnap.json.data.preferences, {
    locale: 'en',
    graphScope: 'all',
    splitRatio: 0.55,
  });
  assert.equal(switchedSnap.json.data.graph.scope, 'all');
});

test('集成测试：fetch / pull / push 远程同步、禁 force、无远端 NO_REMOTE 与分叉 NON_FAST_FORWARD', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm2-int-remote-'));
  const remoteBare = path.join(root, 'remote.git');
  const localNoRemote = path.join(root, 'no-remote');
  const cloneA = path.join(root, 'clone-a');
  const cloneB = path.join(root, 'clone-b');

  await execGit(['init', '--bare', '-b', 'main', remoteBare], root);
  await initConfiguredRepo(localNoRemote, 'main');
  fs.writeFileSync(path.join(localNoRemote, 'init.txt'), '0\n');
  await execGit(['add', '--', 'init.txt'], localNoRemote);
  await execGit(['commit', '-m', 'init'], localNoRemote);

  await execGit(['clone', remoteBare, cloneA], root);
  await execGit(['config', 'user.name', 'User A'], cloneA);
  await execGit(['config', 'user.email', 'a@example.com'], cloneA);
  await execGit(['checkout', '-b', 'main'], cloneA).catch(() => {});
  fs.writeFileSync(path.join(cloneA, 'base.txt'), 'base\n');
  await execGit(['add', '--', 'base.txt'], cloneA);
  await execGit(['commit', '-m', 'base commit'], cloneA);
  await execGit(['push', '-u', 'origin', 'main'], cloneA);

  await execGit(['clone', '-b', 'main', remoteBare, cloneB], root);
  await execGit(['config', 'user.name', 'User B'], cloneB);
  await execGit(['config', 'user.email', 'b@example.com'], cloneB);

  const server = await startStandaloneServer({
    port: 0,
    preferencesPath: path.join(root, 'prefs.json'),
  });
  t.after(async () => {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  // 1) 无远端仓拦截 NO_REMOTE
  await postApi(server.url, '/api/snapshot', { workspaceUris: [toFileUri(localNoRemote)] });
  for (const endpoint of ['/api/remote/fetch', '/api/remote/pull', '/api/remote/push']) {
    const res = await postApi(server.url, endpoint, { worktreePath: localNoRemote, remote: 'origin' });
    assert.equal(res.response.status, 409, `${endpoint} should return 409 NO_REMOTE`);
    assert.equal(res.json.error.code, ERROR_CODES.NO_REMOTE);
  }

  // 2) cloneA 发布无上游分支 (git push -u --end-of-options origin feat/pub) 与禁用 force
  await execGit(['checkout', '-b', 'feat/pub'], cloneA);
  fs.writeFileSync(path.join(cloneA, 'feat.txt'), 'feat\n');
  await execGit(['add', '--', 'feat.txt'], cloneA);
  await execGit(['commit', '-m', 'feat commit'], cloneA);

  await postApi(server.url, '/api/snapshot', { workspaceUris: [toFileUri(cloneA)] });

  const forceRejected = await postApi(server.url, '/api/remote/push', {
    worktreePath: cloneA,
    remote: 'origin',
    force: true,
  });
  assert.equal(forceRejected.response.status, 400);

  const forceLeaseRejected = await postApi(server.url, '/api/remote/push', {
    worktreePath: cloneA,
    remote: 'origin',
    forceWithLease: true,
  });
  assert.equal(forceLeaseRejected.response.status, 400);

  const publishRes = await postApi(server.url, '/api/remote/push', {
    worktreePath: cloneA,
    remote: 'origin',
  });
  assert.equal(publishRes.response.status, 200);

  const snapAfterPublish = await postApi(server.url, '/api/snapshot', { workspaceUris: [toFileUri(cloneA)] });
  assert.equal(snapAfterPublish.json.data.activeRepo.upstream, 'origin/feat/pub');

  // 3) 切回 main，cloneB 推送新提交，cloneA fetch + fast-forward pull
  await execGit(['checkout', 'main'], cloneA);
  fs.writeFileSync(path.join(cloneB, 'remote-new.txt'), 'from B\n');
  await execGit(['add', '--', 'remote-new.txt'], cloneB);
  await execGit(['commit', '-m', 'B advance 1'], cloneB);
  await execGit(['push'], cloneB);

  const fetchRes = await postApi(server.url, '/api/remote/fetch', { worktreePath: cloneA });
  assert.equal(fetchRes.response.status, 200);
  const pullFfRes = await postApi(server.url, '/api/remote/pull', { worktreePath: cloneA });
  assert.equal(pullFfRes.response.status, 200);
  assert.equal(fs.existsSync(path.join(cloneA, 'remote-new.txt')), true);

  // 4) cloneB 再推而 cloneA 本地分叉 -> NON_FAST_FORWARD
  fs.writeFileSync(path.join(cloneB, 'remote-div.txt'), 'B div\n');
  await execGit(['add', '--', 'remote-div.txt'], cloneB);
  await execGit(['commit', '-m', 'B diverge'], cloneB);
  await execGit(['push'], cloneB);

  fs.writeFileSync(path.join(cloneA, 'local-div.txt'), 'A div\n');
  await execGit(['add', '--', 'local-div.txt'], cloneA);
  await execGit(['commit', '-m', 'A diverge'], cloneA);

  const pullDivergedRes = await postApi(server.url, '/api/remote/pull', { worktreePath: cloneA });
  assert.equal(pullDivergedRes.response.status, 409);
  assert.equal(pullDivergedRes.json.error.code, ERROR_CODES.NON_FAST_FORWARD);

  // 5) bare 仓库支持 /api/snapshot、/api/commit/detail 与 /api/commit/stats（worktreePath: null）、/api/remote/fetch（有/无 remote）
  const bareMirror = path.join(root, 'bare-mirror.git');
  await execGit(['clone', '--bare', cloneB, bareMirror], root);
  const bareSnap = await postApi(server.url, '/api/snapshot', { workspaceUris: [toFileUri(bareMirror)] });
  assert.equal(bareSnap.response.status, 200);
  assert.equal(bareSnap.json.data.activeRepo.isBare, true);
  assert.equal(bareSnap.json.data.activeRepo.worktreePath, null);
  const bareHeadSha = bareSnap.json.data.graph.commits[0].sha;

  const bareDetail = await postApi(server.url, '/api/commit/detail', {
    worktreePath: null,
    sha: bareHeadSha,
  });
  assert.equal(bareDetail.response.status, 200);
  assert.equal(bareDetail.json.data.sha, bareHeadSha);
  assert.equal(bareDetail.json.data.files[0].existsInWorktree, false);
  const bareStats = await postApi(server.url, '/api/commit/stats', {
    worktreePath: null,
    sha: bareHeadSha,
  });
  assert.equal(bareStats.response.status, 200);
  assert.equal(bareStats.json.data.files, bareDetail.json.data.files.length);

  const bareFetch = await postApi(server.url, '/api/remote/fetch', { worktreePath: null });
  assert.equal(bareFetch.response.status, 200);
});

test('集成测试：同步更改先快进拉取再推送、分叉时不动仓库，存储库摘要带各仓库同步状态，合并基与按比较基列出改动文件', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm2-int-sync-'));
  const remoteBare = path.join(root, 'remote.git');
  const cloneA = path.join(root, 'clone-a');
  const cloneB = path.join(root, 'clone-b');
  const commitFile = async (repoDir, name, message) => {
    fs.writeFileSync(path.join(repoDir, name), `${message}\n`);
    await execGit(['add', '--', name], repoDir);
    await execGit(['commit', '-m', message], repoDir);
    return execGit(['rev-parse', 'HEAD'], repoDir);
  };
  const bothUris = [toFileUri(cloneA), toFileUri(cloneB)];
  const summaryOf = (snapshot, repoDir) => snapshot.json.data.repositories.find((repo) => path.resolve(repo.worktreePath) === path.resolve(repoDir));

  await execGit(['init', '--bare', '-b', 'main', remoteBare], root);
  await initConfiguredRepo(cloneA, 'main');
  await execGit(['remote', 'add', 'origin', remoteBare], cloneA);
  const baseSha = await commitFile(cloneA, 'base.txt', 'base');
  await execGit(['push', '-u', 'origin', 'main'], cloneA);
  await execGit(['clone', '-b', 'main', remoteBare, cloneB], root);
  await execGit(['config', 'user.name', 'User B'], cloneB);
  await execGit(['config', 'user.email', 'b@example.com'], cloneB);

  const server = await startStandaloneServer({
    port: 0,
    preferencesPath: path.join(root, 'prefs.json'),
  });
  t.after(async () => {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  // 1) A 只领先：快照给出合并基，仓库摘要只带存储库行显示的分支信息；按合并基列出传出的改动；同步只推送
  const aheadSha = await commitFile(cloneA, 'local.txt', 'A ahead');
  const snapAhead = await postApi(server.url, '/api/snapshot', { workspaceUris: bothUris });
  assert.equal(snapAhead.response.status, 200);
  assert.deepEqual([snapAhead.json.data.activeRepo.ahead, snapAhead.json.data.activeRepo.behind], [1, 0]);
  assert.equal(snapAhead.json.data.graph.mergeBase, baseSha);
  const summaryB = summaryOf(snapAhead, cloneB);
  assert.deepEqual([summaryB.name, summaryB.branch, summaryB.isDetached, summaryB.isBare], ['clone-b', 'main', false, false]);
  assert.equal('ahead' in summaryB, false, '非当前仓库不监听，摘要不带会过时的同步状态');

  const outgoing = await postApi(server.url, '/api/commit/detail', { worktreePath: cloneA, sha: aheadSha, parentSha: baseSha });
  assert.equal(outgoing.response.status, 200);
  assert.deepEqual(outgoing.json.data.files.map((file) => [file.status, file.path]), [['A', 'local.txt']]);

  const syncAhead = await postApi(server.url, '/api/remote/sync', { worktreePath: cloneA });
  assert.equal(syncAhead.response.status, 200);
  assert.equal(await execGit(['rev-parse', 'main'], remoteBare), aheadSha, '只领先时同步把本地提交推到远端');

  // 2) B 提取后只落后：合并基是 B 的 HEAD；同步只快进拉取
  await execGit(['fetch'], cloneB);
  const snapB = await postApi(server.url, '/api/snapshot', { workspaceUris: [toFileUri(cloneB)] });
  assert.equal(snapB.json.data.graph.mergeBase, baseSha);
  const syncBehind = await postApi(server.url, '/api/remote/sync', { worktreePath: cloneB });
  assert.equal(syncBehind.response.status, 200);
  assert.equal(await execGit(['rev-parse', 'HEAD'], cloneB), aheadSha);

  // 3) 分叉：快进拉取失败返回 NON_FAST_FORWARD，本地既不合并也不推送；拉取前的提取仍更新了远端跟踪分支
  const remoteSha = await commitFile(cloneB, 'remote.txt', 'B advance');
  await execGit(['push'], cloneB);
  const divergedSha = await commitFile(cloneA, 'diverge.txt', 'A diverge');
  const syncDiverged = await postApi(server.url, '/api/remote/sync', { worktreePath: cloneA });
  assert.equal(syncDiverged.response.status, 409);
  assert.equal(syncDiverged.json.error.code, ERROR_CODES.NON_FAST_FORWARD);
  assert.equal(await execGit(['rev-parse', 'HEAD'], cloneA), divergedSha, '分叉时本地不合并也不变基');
  assert.equal(await execGit(['rev-parse', 'main'], remoteBare), remoteSha, '分叉时不推送');

  const snapDiverged = await postApi(server.url, '/api/snapshot', { workspaceUris: [toFileUri(cloneA)] });
  assert.deepEqual([snapDiverged.json.data.activeRepo.ahead, snapDiverged.json.data.activeRepo.behind], [1, 1]);
  assert.equal(snapDiverged.json.data.graph.mergeBase, aheadSha);
  const incoming = await postApi(server.url, '/api/commit/detail', { worktreePath: cloneA, sha: remoteSha, parentSha: aheadSha });
  assert.deepEqual(incoming.json.data.files.map((file) => [file.status, file.path]), [['A', 'remote.txt']]);

  const badParent = await postApi(server.url, '/api/commit/detail', { worktreePath: cloneA, sha: remoteSha, parentSha: '--output=x' });
  assert.equal(badParent.response.status, 400, 'parentSha 必须是十六进制 SHA');
});

test('集成测试：文件修改返回 status 级刷新并由 /api/status 只刷新变更列表、外部提交返回 full、高频写入不降级、变更过多自动恢复、删除目录触发自毁守卫', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm2-int-watch-'));
  const repoDir = path.join(root, 'watch-repo');
  await initConfiguredRepo(repoDir, 'main');
  fs.writeFileSync(path.join(repoDir, 'app.txt'), 'v1\n');
  await execGit(['add', '--', 'app.txt'], repoDir);
  await execGit(['commit', '-m', 'init watch repo'], repoDir);

  const server = await startStandaloneServer({
    port: 0,
    preferencesPath: path.join(root, 'prefs.json'),
  });
  t.after(async () => {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  // 1) 工作区文件修改通过 fs.watch 即时唤醒 POST /api/events/wait，且只需 status 级刷新
  const initialSnap = await postApi(server.url, '/api/snapshot', {
    workspaceUris: [toFileUri(repoDir)],
  });
  assert.equal(initialSnap.json.data.watchState.active, true);
  assert.equal(initialSnap.json.data.watchState.degraded, false);
  const workspaceKey = initialSnap.json.data.workspaceKey;
  const baseRevision = initialSnap.json.data.revision;

  const waitPromise = postApi(server.url, '/api/events/wait', {
    workspaceKey,
    sinceRevision: baseRevision,
    timeoutMs: 10_000,
  });

  setTimeout(() => {
    fs.writeFileSync(path.join(repoDir, 'app.txt'), 'v2-changed\n');
  }, 80);

  const waitRes = await waitPromise;
  assert.equal(waitRes.response.status, 200);
  assert.equal(waitRes.json.data.refresh, 'status');
  assert.ok(waitRes.json.data.revision > baseRevision);

  // /api/status 只返回上区数据：变更列表、HEAD 信息与监听状态
  const statusRes = await postApi(server.url, '/api/status', { workspaceKey, sinceRevision: baseRevision });
  assert.equal(statusRes.response.status, 200);
  assert.deepEqual(statusRes.json.data.changes.unstaged.map((item) => item.path), ['app.txt']);
  assert.equal(statusRes.json.data.changes.truncated, false);
  assert.equal(statusRes.json.data.activeRepo.id, initialSnap.json.data.activeRepo.id);
  assert.equal(statusRes.json.data.activeRepo.branch, 'main');
  assert.equal(statusRes.json.data.activeRepo.headOid, initialSnap.json.data.activeRepo.headOid);
  assert.deepEqual(statusRes.json.data.watchState, { active: true, degraded: false, reason: null });
  assert.equal(statusRes.json.data.graph, undefined, '/api/status 不得重跑提交图谱');
  assert.ok(statusRes.json.data.revision >= waitRes.json.data.revision);
  const statusRevision = statusRes.json.data.revision;

  // 外部终端提交改动的是 .git 元数据，需要完整快照
  const commitWait = postApi(server.url, '/api/events/wait', {
    workspaceKey,
    sinceRevision: statusRevision,
    timeoutMs: 10_000,
  });
  await execGit(['commit', '-am', 'external commit'], repoDir);
  const commitWaitRes = await commitWait;
  assert.equal(commitWaitRes.json.data.refresh, 'full');

  // 还有未处理的 full 级变更时，/api/status 不推进版本号，下一轮长轮询仍会要求完整快照
  const staleStatus = await postApi(server.url, '/api/status', { workspaceKey, sinceRevision: statusRevision });
  assert.equal(staleStatus.json.data.revision, statusRevision);
  const afterStaleWait = await postApi(server.url, '/api/events/wait', {
    workspaceKey,
    sinceRevision: staleStatus.json.data.revision,
    timeoutMs: 1000,
  });
  assert.equal(afterStaleWait.json.data.refresh, 'full');

  const unknownStatus = await postApi(server.url, '/api/status', { workspaceKey: 'unknown-key', sinceRevision: 0 });
  assert.equal(unknownStatus.response.status, 409);
  assert.equal(unknownStatus.json.error.code, ERROR_CODES.NO_REPOSITORY);

  // 终端只改 .git/config（例如 git remote add）也要触发完整快照，刷新 remotes 与上游
  const beforeRemoteSnap = (await postApi(server.url, '/api/snapshot', {
    workspaceUris: [toFileUri(repoDir)],
  })).json.data;
  assert.deepEqual(beforeRemoteSnap.activeRepo.remotes, []);
  const remoteWait = postApi(server.url, '/api/events/wait', {
    workspaceKey,
    sinceRevision: beforeRemoteSnap.revision,
    timeoutMs: 10_000,
  });
  await execGit(['remote', 'add', 'origin', 'https://example.invalid/watch-repo.git'], repoDir);
  assert.equal((await remoteWait).json.data.refresh, 'full');
  const afterRemoteSnap = (await postApi(server.url, '/api/snapshot', {
    workspaceUris: [toFileUri(repoDir)],
  })).json.data;
  assert.deepEqual(afterRemoteSnap.activeRepo.remotes, ['origin']);

  // 1.5) 客户端提前中止 /api/events/wait 时，res.once('close') 立即释放 eventBus 等待者不泄漏
  const latestRevSnap = await postApi(server.url, '/api/snapshot', {
    workspaceUris: [toFileUri(repoDir)],
  });
  const abortController = new AbortController();
  const abortedWaitFetch = fetch(`${server.url}/api/events/wait`, {
    method: 'POST',
    headers: {
      Origin: server.url,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      workspaceKey: latestRevSnap.json.data.workspaceKey,
      sinceRevision: latestRevSnap.json.data.revision,
      timeoutMs: 10_000,
    }),
    signal: abortController.signal,
  });

  for (let i = 0; i < 40 && server.runtime.eventBus.pendingCount === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(server.runtime.eventBus.pendingCount, 1);

  abortController.abort();
  await assert.rejects(abortedWaitFetch, (err) => err?.name === 'AbortError');
  for (let i = 0; i < 40 && server.runtime.eventBus.pendingCount > 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(server.runtime.eventBus.pendingCount, 0);

  // 2) 高频写入只推迟刷新，不暂停监听；变更过多时监听照常但刷新放慢，回落后恢复正常节奏
  const worktreeTarget = {
    gitCommonDir: path.join(repoDir, '.git'),
    gitDir: path.join(repoDir, '.git'),
    worktreePath: repoDir,
    isBare: false,
  };
  let fakeEmit = null;
  let degradeNotifications = 0;
  const emittedChannels = [];
  const fakeWatcher = createRepositoryWatcher({
    worktreeDebounceMs: 20,
    worktreeMaxWaitMs: 40,
    tooManyChangesRefreshMs: 300,
    existsFn: () => true,
    watchFn: (dir, _opts, listener) => {
      if (normalizeFsPath(dir) === normalizeFsPath(repoDir)) {
        fakeEmit = listener;
      }
      return { close() {}, on() {} };
    },
    onChange: (info) => emittedChannels.push(info.channel),
    onDegraded: () => {
      degradeNotifications += 1;
    },
  });
  fakeWatcher.setTarget(worktreeTarget);
  assert.ok(fakeEmit);
  for (let i = 0; i < 1000; i += 1) {
    fakeEmit('change', `src/file-${i}.js`);
  }
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.deepEqual(fakeWatcher.getWatchState(), { active: true, degraded: false, reason: null });
  assert.deepEqual(emittedChannels, ['worktree'], '1000 次事件应合并为一次工作区刷新');

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  fakeWatcher.applyStatusBudget({ truncated: true });
  fakeWatcher.applyStatusBudget({ truncated: true });
  assert.deepEqual(fakeWatcher.getWatchState(), { active: true, degraded: true, reason: 'too_many_changes' });
  assert.equal(degradeNotifications, 0, 'status 结果触发的降级随响应返回，不另发通知');
  fakeEmit('change', 'src/deleted-outside-git-1.js');
  await sleep(100);
  fakeEmit('change', 'src/deleted-outside-git-2.js');
  await sleep(80);
  assert.deepEqual(emittedChannels, ['worktree'], '距上次 status 不满间隔时不刷新');
  await sleep(250);
  assert.deepEqual(emittedChannels, ['worktree', 'worktree'], '间隔满后两次事件合并为一次刷新，在 Git 之外删掉文件也能被发现');

  fakeWatcher.applyStatusBudget({ truncated: true });
  await sleep(400);
  assert.equal(emittedChannels.length, 2, '变更过多期间没有文件变化时不触发刷新');

  // 间隔已满后持续写入：已排期的刷新不被后续事件推迟；刷新之后、status 跑完之前到达的事件也不会立刻再排一次
  const beforeBurst = emittedChannels.length;
  const ticker = setInterval(() => fakeEmit('change', 'src/build-output.js'), 5);
  await sleep(150);
  clearInterval(ticker);
  assert.equal(emittedChannels.length, beforeBurst + 1, '持续写入时只刷新一次，下一次要等满间隔');

  fakeWatcher.applyStatusBudget({ truncated: true });
  fakeEmit('change', 'src/pending-before-recovery.js');
  const beforeRecovery = emittedChannels.length;
  fakeWatcher.applyStatusBudget({ truncated: false });
  assert.deepEqual(fakeWatcher.getWatchState(), { active: true, degraded: false, reason: null });
  await sleep(80);
  assert.equal(emittedChannels.length, beforeRecovery + 1, '恢复后已排期的刷新不再等满间隔');
  fakeWatcher.close();

  // 变更过多且间隔已满时持续写入：事件间隔稳定小于防抖，已排期的刷新仍按时触发，不被后续事件推迟。
  // 用假时钟让「间隔已满」成立，计时器仍是真实的
  let fakeNow = 0;
  let burstEmit = null;
  const burstRefreshes = [];
  const burstWatcher = createRepositoryWatcher({
    worktreeDebounceMs: 100,
    tooManyChangesRefreshMs: 1000,
    nowFn: () => fakeNow,
    existsFn: () => true,
    watchFn: (dir, _opts, listener) => {
      if (normalizeFsPath(dir) === normalizeFsPath(repoDir)) {
        burstEmit = listener;
      }
      return { close() {}, on() {} };
    },
    onChange: (info) => burstRefreshes.push(info.channel),
  });
  burstWatcher.setTarget(worktreeTarget);
  burstWatcher.applyStatusBudget({ truncated: true });
  fakeNow = 10_000;
  const burstTicker = setInterval(() => burstEmit('change', 'out/build.log'), 20);
  await sleep(300);
  const refreshesDuringBurst = burstRefreshes.length;
  clearInterval(burstTicker);
  burstWatcher.close();
  assert.equal(refreshesDuringBurst, 1, '持续写入时已排期的刷新照常触发，不被后续事件推迟');

  // 真实服务器：变更过多后，下一次 status 已回落到上限内时监听自动恢复，无需手动刷新
  const snapBeforeDegrade = (await postApi(server.url, '/api/snapshot', {
    workspaceUris: [toFileUri(repoDir)],
  })).json.data;
  server.runtime.watcher.applyStatusBudget({ truncated: true }, snapBeforeDegrade.activeRepo);
  assert.equal(server.runtime.watcher.getWatchState(snapBeforeDegrade.activeRepo).degraded, true);

  const recoveredStatus = await postApi(server.url, '/api/status', {
    workspaceKey: snapBeforeDegrade.workspaceKey,
    sinceRevision: snapBeforeDegrade.revision,
  });
  assert.deepEqual(recoveredStatus.json.data.watchState, { active: true, degraded: false, reason: null });

  // forceRefresh 仍可手动清除降级（例如监听出错后）
  server.runtime.watcher.applyStatusBudget({ truncated: true }, snapBeforeDegrade.activeRepo);
  const forcedSnap = await postApi(server.url, '/api/snapshot', {
    workspaceUris: [toFileUri(repoDir)],
    forceRefresh: true,
  });
  assert.deepEqual(forcedSnap.json.data.watchState, { active: true, degraded: false, reason: null });

  // 3) 删除被监听工作目录，验证自毁守卫拦截 Windows \\?\ 死循环且回调 < 30 次并迅速结束
  const disposableDir = path.join(root, 'disposable-wt');
  fs.mkdirSync(path.join(disposableDir, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(disposableDir, 'nested', 'temp.txt'), 'bye\n');

  const guardWatcher = createRepositoryWatcher();
  guardWatcher.setTarget({
    gitCommonDir: path.join(repoDir, '.git'),
    gitDir: path.join(repoDir, '.git'),
    worktreePath: disposableDir,
    isBare: false,
  });

  const rmStartedAt = Date.now();
  fs.rmSync(disposableDir, { recursive: true, force: true });
  await new Promise((resolve) => setTimeout(resolve, 150));
  const rmElapsed = Date.now() - rmStartedAt;

  const stats = guardWatcher.getStats();
  assert.ok(
    stats.rawCallbackCount < 30,
    `Expected <30 callbacks on watched directory removal, got ${stats.rawCallbackCount}`,
  );
  assert.equal(guardWatcher.getWatchState().degraded, false);
  assert.ok(rmElapsed < 1500, `Expected rapid self-destruct settlement, took ${rmElapsed}ms`);
  guardWatcher.close();
});

test('集成测试：Standalone 安全边界、GET /preload.js、?fixture=mock 流转、Sidecar 分支与 CLI 进程释放 cwd', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm2-int-http-'));
  const prefsPath = path.join(root, 'prefs.json');

  const server = await startStandaloneServer({
    port: 0,
    preferencesPath: prefsPath,
  });
  t.after(async () => {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const { port } = server;
  const validHost = `127.0.0.1:${port}`;
  const validOrigin = `http://${validHost}`;

  // 1) 非法 Host 403
  const badHost = await sendRawHttpRequest({
    port,
    method: 'GET',
    reqPath: '/preload.js',
    headers: { Host: 'evil.example.com:8080' },
  });
  assert.equal(badHost.statusCode, 403);

  // 2) 跨站 Origin 与缺失 Origin 403
  const badOrigin = await sendRawHttpRequest({
    port,
    method: 'POST',
    reqPath: '/api/snapshot',
    headers: {
      Host: validHost,
      Origin: 'http://evil.example.com',
      'Content-Type': 'application/json',
      'Content-Length': '2',
    },
    body: '{}',
  });
  assert.equal(badOrigin.statusCode, 403);
  assert.equal(badOrigin.headers['cache-control'], 'no-store');
  assert.equal(badOrigin.headers['x-content-type-options'], 'nosniff');

  const missingOrigin = await sendRawHttpRequest({
    port,
    method: 'POST',
    reqPath: '/api/snapshot',
    headers: {
      Host: validHost,
      'Content-Type': 'application/json',
      'Content-Length': '2',
    },
    body: '{}',
  });
  assert.equal(missingOrigin.statusCode, 403);

  // 3) 非 JSON Content-Type / 损坏 JSON 400
  const badContentType = await sendRawHttpRequest({
    port,
    method: 'POST',
    reqPath: '/api/snapshot',
    headers: {
      Host: validHost,
      Origin: validOrigin,
      'Content-Type': 'text/plain',
      'Content-Length': '2',
    },
    body: '{}',
  });
  assert.equal(badContentType.statusCode, 400);

  const badJson = await sendRawHttpRequest({
    port,
    method: 'POST',
    reqPath: '/api/snapshot',
    headers: {
      Host: validHost,
      Origin: validOrigin,
      'Content-Type': 'application/json',
      'Content-Length': '11',
    },
    body: '{bad-json!!',
  });
  assert.equal(badJson.statusCode, 400);

  // 4) 超 1 MiB Body 413
  const oversizeBody = JSON.stringify({ pad: 'a'.repeat(1024 * 1024 + 64) });
  const oversizeRes = await fetch(`${server.url}/api/snapshot`, {
    method: 'POST',
    headers: {
      Origin: validOrigin,
      'Content-Type': 'application/json',
    },
    body: oversizeBody,
  });
  assert.equal(oversizeRes.status, 413);
  assert.equal(oversizeRes.headers.get('cache-control'), 'no-store');

  // 5) GET /api/snapshot 返回 405；GET /preload.js 返回 200 text/javascript; charset=utf-8
  const getApiRes = await fetch(`${server.url}/api/snapshot`);
  assert.equal(getApiRes.status, 405);
  assert.equal(getApiRes.headers.get('cache-control'), 'no-store');

  const preloadPlain = await fetch(`${server.url}/preload.js`);
  assert.equal(preloadPlain.status, 200);
  assert.equal(preloadPlain.headers.get('content-type'), 'text/javascript; charset=utf-8');

  const preloadSdk = await fetch(`${server.url}/preload.js?sdk=1`);
  assert.equal(preloadSdk.status, 200);
  const preloadSdkText = await preloadSdk.text();
  assert.match(preloadSdkText, /window\.sidecar/);
  assert.match(preloadSdkText, /FORCE_SDK = true/);

  const bundledAppRes = await fetch(`${server.url}/app.js`);
  assert.equal(bundledAppRes.status, 200);
  assert.equal(bundledAppRes.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal(bundledAppRes.headers.get('cache-control'), 'no-store');
  const bundledAppText = await bundledAppRes.text();
  assert.doesNotMatch(bundledAppText, /^\s*(?:import|export)\b/m);

  const rawModuleRes = await fetch(`${server.url}/modules/i18n.js`);
  assert.equal(rawModuleRes.status, 404);

  // 文件类型图标只按单层 *.svg 文件名提供，编码后的路径穿越、非 SVG 与不存在的文件一律 404
  const iconRes = await fetch(`${server.url}/file-icons/file_type_js.svg`);
  assert.equal(iconRes.status, 200);
  assert.equal(iconRes.headers.get('content-type'), 'image/svg+xml');
  assert.match(await iconRes.text(), /<svg\b/);
  for (const badName of ['%2e%2e%2fmain.mjs', '..%2F..%2Fmain.mjs', 'LICENSE', 'missing_icon.svg']) {
    const badRes = await fetch(`${server.url}/file-icons/${badName}`);
    assert.equal(badRes.status, 404, `/file-icons/${badName} must be 404`);
  }

  // 6) ?fixture=mock 完整提交流转（多分支 Merge、中文路径、MM、未跟踪、领先上游）
  const mockSnap = await postApi(server.url, '/api/snapshot?fixture=mock', {});
  assert.equal(mockSnap.response.status, 200);
  assert.equal(mockSnap.response.headers.get('cache-control'), 'no-store');
  assert.equal(mockSnap.response.headers.get('x-content-type-options'), 'nosniff');

  const mockData = mockSnap.json.data;
  assert.ok(mockData.graph.commits.some((c) => c.parents.length === 2), 'Mock must include merge commit');
  assert.ok(mockData.changes.staged.some((c) => c.path.includes('中文')), 'Mock must include Chinese path');
  assert.ok(
    mockData.changes.staged.some((s) => mockData.changes.unstaged.some((u) => u.path === s.path && !u.untracked)),
    'Mock must include MM dual-status file',
  );
  assert.ok(mockData.changes.unstaged.some((u) => u.untracked), 'Mock must include untracked file');
  assert.ok(mockData.activeRepo.ahead > 0, 'Mock must include ahead count');

  const mockWt = mockData.activeRepo.worktreePath;
  const beforeRev = mockData.revision;

  const mockStage = await postApi(server.url, '/api/changes/stage?fixture=mock', {
    worktreePath: mockWt,
    all: true,
  });
  assert.equal(mockStage.response.status, 200);
  assert.ok(mockStage.json.data.revision > beforeRev);

  const mockCommit = await postApi(server.url, '/api/commit?fixture=mock', {
    worktreePath: mockWt,
    message: 'feat: mock commit flow',
  });
  assert.equal(mockCommit.response.status, 200);
  assert.match(mockCommit.json.data.sha, /^[0-9a-f]{40}$/i);

  const mockPush = await postApi(server.url, '/api/remote/push?fixture=mock', {
    worktreePath: mockWt,
  });
  assert.equal(mockPush.response.status, 200);

  const mockSnapAfter = await postApi(server.url, '/api/snapshot?fixture=mock', {});
  assert.equal(mockSnapAfter.json.data.activeRepo.ahead, 0);
  assert.equal(mockSnapAfter.json.data.graph.commits[0].sha, mockCommit.json.data.sha);

  // 7) Sidecar 模式注册校验（显式 Content-Type Response、classic 脚本 HTML 与全 POST /api/*）
  const registeredPages = new Map();
  const registeredApis = new Map();
  class FakeResponse {
    constructor(body, opts = {}) {
      this.body = body;
      this.contentType = opts.contentType;
      this.status = opts.status;
      this.headers = opts.headers;
    }
  }
  class FakeSidecarApp {
    page(routePath, handler) {
      registeredPages.set(routePath, handler);
    }
    api(routePath, handler, method = 'POST') {
      registeredApis.set(routePath, { handler, method });
    }
    async run() {
      return { closeAllConnections() {} };
    }
    async close() {}
  }

  const sidecarInstance = await startSidecarServer({
    loadSdk: async () => ({ SidecarApp: FakeSidecarApp, Response: FakeResponse }),
    preferencesPath: path.join(root, 'sidecar-prefs.json'),
  });
  t.after(() => sidecarInstance.close());

  for (const staticRoute of Object.keys(STATIC_WHITELIST)) {
    assert.equal(registeredPages.has(staticRoute), true, `Missing Sidecar page route: ${staticRoute}`);
    const pageResp = await registeredPages.get(staticRoute)();
    assert.ok(pageResp instanceof FakeResponse);
    assert.equal(pageResp.status, 200);
    assert.equal(pageResp.contentType, STATIC_WHITELIST[staticRoute].contentType);
    assert.equal(pageResp.headers['Cache-Control'], 'no-store');
    assert.equal(pageResp.headers['X-Content-Type-Options'], 'nosniff');
    if (staticRoute === '/') {
      const htmlText = String(pageResp.body);
      assert.doesNotMatch(htmlText, /type=["']module["']/i);
      assert.match(htmlText, /<script src="\/preload\.js"><\/script>/);
      assert.match(htmlText, /<script defer src="\/app\.js\?v=[a-f0-9]{12}"><\/script>/);
    }
  }
  const iconPage = registeredPages.get('/file-icons/file_type_js.svg');
  assert.ok(iconPage, 'Sidecar mode must register file icon page routes');
  const iconResp = await iconPage();
  assert.equal(iconResp.status, 200);
  assert.equal(iconResp.contentType, 'image/svg+xml');
  assert.equal(registeredPages.has('/file-icons/LICENSE'), false);
  for (const apiRoute of API_ROUTES) {
    const entry = registeredApis.get(apiRoute);
    assert.ok(entry, `Missing Sidecar API route: ${apiRoute}`);
    assert.equal(entry.method, 'POST');
  }
  const sidecarApiResp = await registeredApis.get('/api/commit').handler({
    worktreePath: root,
    message: '',
  });
  assert.ok(sidecarApiResp instanceof FakeResponse);
  assert.equal(sidecarApiResp.status, 400);
  assert.equal(sidecarApiResp.headers['Cache-Control'], 'no-store');
  assert.equal(JSON.parse(sidecarApiResp.body).error.code, ERROR_CODES.EMPTY_COMMIT_MESSAGE);

  // 8) 子进程 CLI 启动 main.mjs 验证首步释放 cwd（Windows 下运行期间可直接重命名原启动目录）与优雅退出
  const launchCwd = path.join(root, 'launch-cwd');
  const launchCwdRenamed = path.join(root, 'launch-cwd-renamed');
  fs.mkdirSync(launchCwd, { recursive: true });
  const childRepo = path.join(root, 'cli-repo');
  await initConfiguredRepo(childRepo, 'main');

  const child = spawn(process.execPath, [MAIN_MJS_PATH, childRepo], {
    cwd: launchCwd,
    env: {
      ...process.env,
      AG_GIT_PORT: '0',
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const listenUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for CLI server startup: ${buf}`)), 8000);
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const match = buf.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    });
    child.stderr.on('data', (chunk) => {
      buf += chunk.toString('utf8');
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`CLI child exited early (${code}): ${buf}`));
    });
  });

  t.after(() => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
    }
  });

  // 子进程仍在运行时重命名其初始 cwd，直接实证 Windows 目录句柄已释放到 os.tmpdir()
  fs.renameSync(launchCwd, launchCwdRenamed);
  assert.equal(fs.existsSync(launchCwdRenamed), true);

  const cliSnap = await postApi(listenUrl, '/api/snapshot', {});
  assert.equal(cliSnap.response.status, 200);
  assert.equal(cliSnap.json.data.activeRepo.worktreePath, normalizeFsPath(childRepo));

  const exitPromise = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  child.kill('SIGTERM');
  const exitResult = await exitPromise;
  assert.ok(exitResult.code === 0 || exitResult.signal === 'SIGTERM');
});

test('集成测试：切分支防吞事件、watcher 合并与目录噪声过滤、SidecarApp 长轮询中止不泄漏', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm2-int-checkout-sync-'));
  const repoDir = path.join(root, 'repo');
  await initConfiguredRepo(repoDir, 'main');
  fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'src', 'index.js'), 'export const v = 1;\n');
  await execGit(['add', '.'], repoDir);
  await execGit(['commit', '-m', 'init main'], repoDir);
  await execGit(['checkout', '-b', 'feat-sync'], repoDir);
  fs.writeFileSync(path.join(repoDir, 'src', 'index.js'), 'export const v = 2;\n');
  await execGit(['add', '.'], repoDir);
  await execGit(['commit', '-m', 'feat commit'], repoDir);
  await execGit(['checkout', 'main'], repoDir);

  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  // 1) 快照查询期间发生 revision 递增（模拟连续切分支）时，快照不得用查询结束后的新 revision 覆盖，
  //    必须保留查询前版本号以便后续 /api/events/wait 0ms 立即唤醒拉取最新分支。
  const server = await startStandaloneServer({
    port: 0,
    preferencesPath: path.join(root, 'prefs-race.json'),
  });
  t.after(() => server.close());

  const repoUri = toFileUri(repoDir);
  const s0 = (await postApi(server.url, '/api/snapshot', { workspaceUris: [repoUri] })).json.data;
  const revBefore = s0.revision;

  const snapPromise = postApi(server.url, '/api/snapshot', { workspaceUris: [repoUri] });
  // 在快照执行 Git 读命令期间模拟外部切分支触发事件总线递增
  setTimeout(() => {
    server.runtime.eventBus.bumpRevision();
  }, 15);
  const s1 = (await snapPromise).json.data;
  assert.equal(
    s1.revision,
    revBefore,
    '快照返回的版本号应取查询开始前的基准值，避免吞掉查询期间发生的分支切换或文件变更事件',
  );
  assert.ok(server.runtime.eventBus.revision > s1.revision);

  const tWait = performance.now();
  const wakeRes = (await postApi(server.url, '/api/events/wait', {
    workspaceKey: s1.workspaceKey,
    sinceRevision: s1.revision,
    timeoutMs: 3000,
  })).json.data;
  assert.equal(wakeRes.refresh, 'full');
  assert.ok(performance.now() - tWait < 500, '被查询窗口错过的变更应在下一次 events/wait 中立即唤醒');

  // 2) watcher 合并同一 checkout 的 metadata + worktree 双通道，并忽略目录级 change 元数据噪声
  const emittedChannels = [];
  let gitEmit = null;
  let wtEmit = null;
  const normalizedGitDir = normalizeFsPath(path.join(repoDir, '.git'));
  const normalizedWtDir = normalizeFsPath(repoDir);
  const coalescingWatcher = createRepositoryWatcher({
    metadataDebounceMs: 40,
    worktreeDebounceMs: 90,
    existsFn: () => true,
    statFn: (targetPath) => ({
      isDirectory: () => normalizeFsPath(targetPath, { resolveRealpath: false })?.endsWith('/src') ?? false,
    }),
    watchFn: (dir, _opts, listener) => {
      const key = normalizeFsPath(dir);
      if (key === normalizedGitDir) gitEmit = listener;
      if (key === normalizedWtDir) wtEmit = listener;
      return { close() {}, on() {} };
    },
    onChange: (info) => emittedChannels.push(info.channel),
  });
  t.after(() => coalescingWatcher.close());

  coalescingWatcher.setTarget({
    gitCommonDir: path.join(repoDir, '.git'),
    gitDir: path.join(repoDir, '.git'),
    worktreePath: repoDir,
    isBare: false,
  });

  // 同一 git checkout 先触发工作区变更，再更新 .git/HEAD：应合并为 1 次 metadata 通知而非连续触发 2 次快照
  wtEmit('change', 'src/index.js');
  gitEmit('rename', 'HEAD');
  await new Promise((resolve) => setTimeout(resolve, 160));
  assert.deepEqual(emittedChannels, ['metadata'], '同一次切分支应合并 pending worktree 定时器，仅触发 1 次刷新');

  // Windows 下 git status 扫描目录引发的目录级 change 噪声不应触发误刷新，但目录 rename 与文件 change 仍须正常触发
  emittedChannels.length = 0;
  wtEmit('change', 'src');
  await new Promise((resolve) => setTimeout(resolve, 140));
  assert.deepEqual(emittedChannels, [], '目录级 change 元数据噪声不得触发重复快照');

  wtEmit('rename', 'src');
  await new Promise((resolve) => setTimeout(resolve, 140));
  assert.deepEqual(emittedChannels, ['worktree'], '目录 rename 变更仍应正常触发刷新');

  // 3) SidecarApp 模式下客户端中止 /api/events/wait（如切对话重载 iframe）必须立即释放 eventBus 等待者
  class HttpFakeResponse {
    constructor(body, opts = {}) {
      this.body = body;
      this.contentType = opts.contentType;
      this.status = opts.status;
      this.headers = opts.headers;
    }
  }
  class HttpFakeSidecarApp {
    #apis = new Map();
    #server = null;
    page() {}
    api(routePath, handler, method = 'POST') {
      this.#apis.set(`${method}:${routePath}`, handler);
    }
    async run() {
      this.#server = http.createServer((req, res) => {
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        const handler = this.#apis.get(`${req.method}:${url.pathname}`);
        if (!handler) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        let raw = '';
        req.on('data', (chunk) => { raw += chunk; });
        req.on('end', async () => {
          const result = await handler(raw ? JSON.parse(raw) : {});
          res.writeHead(result.status || 200, { 'Content-Type': result.contentType, ...result.headers });
          res.end(result.body);
        });
      });
      await new Promise((resolve) => this.#server.listen(0, '127.0.0.1', resolve));
      return this.#server;
    }
    async close() {
      await new Promise((resolve) => (this.#server ? this.#server.close(() => resolve()) : resolve()));
    }
  }

  const sidecarInstance = await startSidecarServer({
    loadSdk: async () => ({ SidecarApp: HttpFakeSidecarApp, Response: HttpFakeResponse }),
    preferencesPath: path.join(root, 'prefs-sidecar-abort.json'),
  });
  t.after(() => sidecarInstance.close());

  const sidecarBaseUrl = `http://127.0.0.1:${sidecarInstance.server.address().port}`;
  const sidecarSnapRes = await fetch(`${sidecarBaseUrl}/api/snapshot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceUris: [repoUri] }),
  });
  const sidecarSnap = (await sidecarSnapRes.json()).data;

  for (let i = 0; i < 3; i += 1) {
    const ac = new AbortController();
    const pendingFetch = fetch(`${sidecarBaseUrl}/api/events/wait`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspaceKey: sidecarSnap.workspaceKey,
        sinceRevision: sidecarSnap.revision,
        timeoutMs: 20_000,
      }),
      signal: ac.signal,
    });
    for (let j = 0; j < 40 && sidecarInstance.runtime.eventBus.pendingCount === 0; j += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(sidecarInstance.runtime.eventBus.pendingCount, 1);
    ac.abort();
    await assert.rejects(pendingFetch, (err) => err?.name === 'AbortError');
    for (let j = 0; j < 40 && sidecarInstance.runtime.eventBus.pendingCount > 0; j += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(sidecarInstance.runtime.eventBus.pendingCount, 0, 'SidecarApp 模式中止长轮询后不得泄漏等待者');
  }

  // 4) 模拟真实 SidecarApp 以 async/await 读取请求体时，AbortSignal 仍必须透传至 eventBus
  class AsyncBodyFakeSidecarApp {
    #apis = new Map();
    #server = null;
    page() {}
    api(routePath, handler, method = 'POST') {
      this.#apis.set(`${method}:${routePath}`, handler);
    }
    async run() {
      this.#server = http.createServer(async (req, res) => {
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        const handler = this.#apis.get(`${req.method}:${url.pathname}`);
        if (!handler) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        const raw = await new Promise((resolve) => {
          let buf = '';
          req.on('data', (chunk) => { buf += chunk; });
          req.on('end', () => resolve(buf));
        });
        const result = await handler(raw ? JSON.parse(raw) : {});
        if (!res.writableEnded) {
          res.writeHead(result.status || 200, { 'Content-Type': result.contentType, ...result.headers });
          res.end(result.body);
        }
      });
      await new Promise((resolve) => this.#server.listen(0, '127.0.0.1', resolve));
      return this.#server;
    }
    async close() {
      await new Promise((resolve) => (this.#server ? this.#server.close(() => resolve()) : resolve()));
    }
  }

  const asyncSidecar = await startSidecarServer({
    loadSdk: async () => ({ SidecarApp: AsyncBodyFakeSidecarApp, Response: HttpFakeResponse }),
    preferencesPath: path.join(root, 'prefs-sidecar-async-abort.json'),
  });
  t.after(() => asyncSidecar.close());

  const asyncSidecarUrl = `http://127.0.0.1:${asyncSidecar.server.address().port}`;
  const asyncSnap = (await (await fetch(`${asyncSidecarUrl}/api/snapshot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceUris: [repoUri] }),
  })).json()).data;

  const asyncAc = new AbortController();
  const asyncWaitPromise = fetch(`${asyncSidecarUrl}/api/events/wait`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workspaceKey: asyncSnap.workspaceKey,
      sinceRevision: asyncSnap.revision,
      timeoutMs: 20_000,
    }),
    signal: asyncAc.signal,
  });
  for (let j = 0; j < 40 && asyncSidecar.runtime.eventBus.pendingCount === 0; j += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(asyncSidecar.runtime.eventBus.pendingCount, 1);
  asyncAc.abort();
  await assert.rejects(asyncWaitPromise, (err) => err?.name === 'AbortError');
  for (let j = 0; j < 40 && asyncSidecar.runtime.eventBus.pendingCount > 0; j += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(asyncSidecar.runtime.eventBus.pendingCount, 0, 'async/await 读 body 的 SidecarApp 同样不得泄漏长轮询等待者');
});

test('集成测试：工作区监听瞬时错误自动重挂与降级、连续写入 maxWait 防饿死、后到工作区事件不被元数据合并吞掉', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm2-int-watch-resilience-'));
  const repoDir = path.join(root, 'repo');
  await initConfiguredRepo(repoDir, 'main');
  fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'src', 'app.js'), 'export const a = 1;\n');
  await execGit(['add', '.'], repoDir);
  await execGit(['commit', '-m', 'init'], repoDir);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const normGit = normalizeFsPath(path.join(repoDir, '.git'));
  const normWt = normalizeFsPath(repoDir);

  // 1) worktree watcher 触发 error 后自动延迟重挂并主动补发一次 worktree 刷新；同目标非强制 setTarget 也应补挂
  let wtMountCount = 0;
  let latestWtErrorHandler = null;
  const recoveredChannels = [];
  const degradedStates = [];
  const resilientWatcher = createRepositoryWatcher({
    worktreeDebounceMs: 30,
    worktreeRetryDelayMs: 40,
    maxWorktreeErrorRetries: 2,
    existsFn: () => true,
    statFn: () => ({ isDirectory: () => false }),
    watchFn: (dir, _opts, _listener) => {
      const key = normalizeFsPath(dir);
      const handlers = {};
      if (key === normWt) {
        wtMountCount += 1;
        if (wtMountCount === 3 || wtMountCount === 4) {
          throw new Error('simulated persistent EPERM');
        }
      }
      return {
        close() {},
        on(evt, fn) {
          handlers[evt] = fn;
          if (key === normWt && evt === 'error') {
            latestWtErrorHandler = fn;
          }
        },
      };
    },
    onChange: (info) => recoveredChannels.push(info.channel),
    onDegraded: (state) => degradedStates.push(state),
  });
  t.after(() => resilientWatcher.close());

  const target = {
    gitCommonDir: path.join(repoDir, '.git'),
    gitDir: path.join(repoDir, '.git'),
    worktreePath: repoDir,
    isBare: false,
  };
  resilientWatcher.setTarget(target);
  assert.equal(wtMountCount, 1);

  // 触发首次瞬时 error：应在 40ms 后自动重挂（wtMountCount -> 2）并补发一次 worktree 同步
  latestWtErrorHandler(new Error('transient EPERM'));
  await new Promise((resolve) => setTimeout(resolve, 140));
  assert.equal(wtMountCount, 2, '工作区监听瞬时错误后应自动重挂');
  assert.deepEqual(recoveredChannels, ['worktree'], '重挂成功后应补发一次工作区同步');
  assert.equal(resilientWatcher.getWatchState().degraded, false);

  // 再次错误且连续重挂均抛出异常：重试耗尽后应显式降级为 watch_error 而非静默失活
  latestWtErrorHandler(new Error('persistent EPERM'));
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(resilientWatcher.getWatchState().degraded, true);
  assert.equal(resilientWatcher.getWatchState().reason, 'watch_error');
  assert.equal(degradedStates.at(-1)?.reason, 'watch_error');

  // 监听出错只由手动刷新清除：被截断的 status 不能把它改写成「变更过多」，也不借机重新挂载
  const mountsBeforeTruncatedStatus = wtMountCount;
  resilientWatcher.applyStatusBudget({ truncated: true });
  assert.equal(resilientWatcher.getWatchState().reason, 'watch_error', '被截断的 status 不能掩盖监听出错');
  assert.equal(wtMountCount, mountsBeforeTruncatedStatus, '监听出错期间 status 结果不触发重新挂载');

  // 2) 非降级状态下若 worktree watcher 意外关闭，同目标 setTarget({ forceRefresh: false }) 必须补挂
  let manualHealMounts = 0;
  let manualHealError = null;
  const healWatcher = createRepositoryWatcher({
    worktreeRetryDelayMs: 60_000,
    existsFn: () => true,
    statFn: () => ({ isDirectory: () => false }),
    watchFn: (dir) => {
      const key = normalizeFsPath(dir);
      if (key === normWt) manualHealMounts += 1;
      return {
        close() {},
        on(evt, fn) {
          if (key === normWt && evt === 'error') manualHealError = fn;
        },
      };
    },
  });
  t.after(() => healWatcher.close());
  healWatcher.setTarget(target);
  assert.equal(manualHealMounts, 1);
  manualHealError(new Error('transient error'));
  healWatcher.setTarget(target, { forceRefresh: false });
  assert.equal(manualHealMounts, 2, '同目标非强制 setTarget 也应补挂失活的工作区监听');

  // 3) 持续写入间隔小于 worktreeDebounceMs 时，worktreeMaxWaitMs 必须保证周期性刷出不饿死
  let streamWtEmit = null;
  const streamEvents = [];
  const maxWaitWatcher = createRepositoryWatcher({
    worktreeDebounceMs: 80,
    worktreeMaxWaitMs: 140,
    existsFn: () => true,
    statFn: () => ({ isDirectory: () => false }),
    watchFn: (dir, _opts, listener) => {
      if (normalizeFsPath(dir) === normWt) streamWtEmit = listener;
      return { close() {}, on() {} };
    },
    onChange: (info) => streamEvents.push(info.channel),
  });
  t.after(() => maxWaitWatcher.close());
  maxWaitWatcher.setTarget(target);

  for (let i = 0; i < 6; i += 1) {
    streamWtEmit('change', 'src/app.js');
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  assert.ok(streamEvents.length >= 1, '连续高频写入期间达到 worktreeMaxWaitMs 后必须刷出变更通知，不得无限饿死');

  // 4) 晚于 .git 元数据事件到达的工作区文件变动，不得被 metadataTimer 合并清除
  let orderGitEmit = null;
  let orderWtEmit = null;
  const orderChannels = [];
  const orderWatcher = createRepositoryWatcher({
    metadataDebounceMs: 40,
    worktreeDebounceMs: 90,
    existsFn: () => true,
    statFn: () => ({ isDirectory: () => false }),
    watchFn: (dir, _opts, listener) => {
      const key = normalizeFsPath(dir);
      if (key === normGit) orderGitEmit = listener;
      if (key === normWt) orderWtEmit = listener;
      return { close() {}, on() {} };
    },
    onChange: (info) => orderChannels.push(info.channel),
  });
  t.after(() => orderWatcher.close());
  orderWatcher.setTarget(target);

  orderGitEmit('change', 'index');
  orderWtEmit('change', 'src/app.js');
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.deepEqual(orderChannels, ['metadata', 'worktree'], '晚于元数据事件到达的工作区改动不得被 metadata 定时器吞掉');
});

test('集成测试：多会话共享 Sidecar、同仓多 Worktree 与 Sidecar 重启后提交推送不误报 NO_REPOSITORY', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-m2-multitab-restart-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const remoteDir = path.join(root, 'remote.git');
  const repoA = path.join(root, 'repo-a');
  const repoAWt = path.join(root, 'repo-a-wt');
  const repoB = path.join(root, 'repo-b');
  const prefsPath = path.join(root, 'prefs.json');

  await execGit(['init', '--bare', remoteDir], root);
  await initConfiguredRepo(repoA, 'main');
  fs.writeFileSync(path.join(repoA, 'a.txt'), 'v1\n');
  await execGit(['add', '-A'], repoA);
  await execGit(['commit', '-m', 'init a'], repoA);
  await execGit(['remote', 'add', 'origin', remoteDir], repoA);
  await execGit(['push', '-u', 'origin', 'main'], repoA);
  await execGit(['worktree', 'add', '-b', 'feat-wt', repoAWt], repoA);

  await initConfiguredRepo(repoB, 'main');
  fs.writeFileSync(path.join(repoB, 'b.txt'), 'b1\n');
  await execGit(['add', '-A'], repoB);
  await execGit(['commit', '-m', 'init b'], repoB);

  const createTestRouter = () => {
    const eventBus = createEventBus({ minTimeoutMs: 100 });
    const watcher = createRepositoryWatcher({
      onChange: () => eventBus.bumpRevision(),
    });
    const preferencesStore = createPreferencesStore({ filePath: prefsPath });
    const mockFixture = createMockFixtureStore({ eventBus });
    const router = createApiRouter({
      eventBus,
      watcher,
      preferencesStore,
      mockFixture,
      defaultWorkspaceUris: [],
      isStandalone: false,
    });
    return {
      router,
      eventBus,
      close: () => {
        watcher.close();
        eventBus.dispose();
      },
    };
  };

  // 1) 会话 A 提交后，会话 B 触发不同仓库或空工作区快照，不得清空会话 A 授权；且两会话长轮询不互踩风暴
  const inst1 = createTestRouter();
  t.after(() => inst1.close());

  const snapA = await inst1.router.dispatch('/api/snapshot', { workspaceUris: [toFileUri(repoA)] });
  assert.equal(snapA.statusCode, 200);
  const wtA = snapA.body.data.activeRepo.worktreePath;
  const keyA = snapA.body.data.workspaceKey;

  fs.writeFileSync(path.join(repoA, 'a.txt'), 'v2\n');
  const commitA = await inst1.router.dispatch('/api/commit', {
    worktreePath: wtA,
    message: 'feat: commit before peer snapshot',
    autoStageAll: true,
  });
  assert.equal(commitA.statusCode, 200);

  const snapB = await inst1.router.dispatch('/api/snapshot', { workspaceUris: [toFileUri(repoB)] });
  assert.equal(snapB.statusCode, 200);
  const snapEmpty = await inst1.router.dispatch('/api/snapshot', { workspaceUris: [] });
  assert.equal(snapEmpty.statusCode, 200);

  // 会话 A 推送必须成功，且其长轮询不会因为 currentWorkspaceKey 不同而立即误报需要刷新
  const pushA = await inst1.router.dispatch('/api/remote/push', { worktreePath: wtA });
  assert.equal(pushA.statusCode, 200);
  assert.equal(pushA.body.ok, true);

  const snapB2 = await inst1.router.dispatch('/api/snapshot', { workspaceUris: [toFileUri(repoB)] });
  assert.equal(snapB2.statusCode, 200);
  const waitA = await inst1.router.dispatch('/api/events/wait', {
    workspaceKey: keyA,
    sinceRevision: inst1.eventBus.revision,
    timeoutMs: 120,
  });
  assert.equal(waitA.statusCode, 200);
  assert.equal(waitA.body.data.refresh, 'none', '多会话 workspaceKey 不同不得互相唤醒');

  // 2) 同一 Repository 的两个 Worktree（主工作树与链接工作树）应共存授权，互不覆盖
  const snapWt = await inst1.router.dispatch('/api/snapshot', { workspaceUris: [toFileUri(repoAWt)] });
  assert.equal(snapWt.statusCode, 200);
  const wtLinked = snapWt.body.data.activeRepo.worktreePath;
  assert.notEqual(wtLinked, wtA);

  fs.writeFileSync(path.join(repoA, 'a.txt'), 'v3\n');
  const stageMainAfterLinked = await inst1.router.dispatch('/api/changes/stage', {
    worktreePath: wtA,
    all: true,
  });
  assert.equal(stageMainAfterLinked.statusCode, 200);
  const commitMainAfterLinked = await inst1.router.dispatch('/api/commit', {
    worktreePath: wtA,
    message: 'feat: commit on main while linked wt active',
    autoStageAll: false,
  });
  assert.equal(commitMainAfterLinked.statusCode, 200);

  // 3) 模拟 Sidecar 进程重启（空内存缓存、currentWorkspaceKey=null、revision 重置为 1）
  const inst2 = createTestRouter();
  t.after(() => inst2.close());

  const restartWait = await inst2.router.dispatch('/api/events/wait', {
    workspaceKey: keyA,
    sinceRevision: 8,
    timeoutMs: 1000,
  });
  assert.equal(restartWait.statusCode, 200);
  assert.equal(restartWait.body.data.refresh, 'full', 'Sidecar 重启后应立即唤醒已挂载前端重新同步完整快照');

  // 即使尚未重新拉取 snapshot，写接口携带 workspaceUris 也应按需校验并推送成功
  const pushAfterRestart = await inst2.router.dispatch('/api/remote/push', {
    worktreePath: wtA,
    workspaceUris: [toFileUri(repoA)],
  });
  assert.equal(pushAfterRestart.statusCode, 200);
  assert.equal(pushAfterRestart.body.ok, true);

  // 安全边界不可退化：传入合法 workspaceUris 但 worktreePath 指向范围外目录，仍必须拒绝 NO_REPOSITORY
  const outOfScopePush = await inst2.router.dispatch('/api/remote/push', {
    worktreePath: root,
    workspaceUris: [toFileUri(repoA)],
  });
  assert.equal(outOfScopePush.statusCode, 409);
  assert.equal(outOfScopePush.body.error.code, ERROR_CODES.NO_REPOSITORY);
});

test('集成测试：多会话共享 Sidecar 并发监听不互拆、外部 git commit 精准唤醒对应会话且 .git 监听错误自动重挂', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-m2-watch-pool-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const repoA = path.join(root, 'repo-a');
  const repoAWt = path.join(root, 'repo-a-wt');
  const repoB = path.join(root, 'repo-b');
  await initConfiguredRepo(repoA, 'main');
  fs.writeFileSync(path.join(repoA, 'a.txt'), 'v1\n');
  await execGit(['add', '-A'], repoA);
  await execGit(['commit', '-m', 'init a'], repoA);
  await execGit(['worktree', 'add', '-b', 'wt-branch', repoAWt], repoA);

  await initConfiguredRepo(repoB, 'main');
  fs.writeFileSync(path.join(repoB, 'b.txt'), 'b1\n');
  await execGit(['add', '-A'], repoB);
  await execGit(['commit', '-m', 'init b'], repoB);

  // 1) 真实多会话 HTTP 服务器：会话 A/B 及空工作区并发快照后，外部终端提交 repoA 必须实时唤醒 A（及同仓 linked worktree），且不误唤醒 B
  const server = await startStandaloneServer({
    port: 0,
    defaultWorkspaceUris: [],
    preferencesPath: path.join(root, 'prefs.json'),
    watcherOptions: {
      metadataDebounceMs: 60,
      worktreeDebounceMs: 80,
    },
    eventBusOptions: {
      minTimeoutMs: 100,
    },
  });
  t.after(() => server.close());

  const snapA = (await postApi(server.url, '/api/snapshot', { workspaceUris: [toFileUri(repoA)] })).json.data;
  const snapAWt = (await postApi(server.url, '/api/snapshot', { workspaceUris: [toFileUri(repoAWt)] })).json.data;
  const snapB = (await postApi(server.url, '/api/snapshot', { workspaceUris: [toFileUri(repoB)] })).json.data;
  // 空工作区或非 Git 目录快照不得拆毁已挂载仓库的监听
  await postApi(server.url, '/api/snapshot', { workspaceUris: [] });
  await postApi(server.url, '/api/snapshot', { workspaceUris: [toFileUri(root)] });
  assert.equal(server.runtime.watcher.size, 3);

  const waitA = postApi(server.url, '/api/events/wait', {
    workspaceKey: snapA.workspaceKey,
    sinceRevision: snapA.revision,
    timeoutMs: 3000,
  });
  const waitAWt = postApi(server.url, '/api/events/wait', {
    workspaceKey: snapAWt.workspaceKey,
    sinceRevision: snapAWt.revision,
    timeoutMs: 3000,
  });
  const waitB = postApi(server.url, '/api/events/wait', {
    workspaceKey: snapB.workspaceKey,
    sinceRevision: snapB.revision,
    timeoutMs: 400,
  });

  // 模拟外部终端对 repoA 执行 reset + add + commit（不经过面板 API）
  fs.writeFileSync(path.join(repoA, 'a.txt'), 'v2\n');
  await execGit(['add', 'a.txt'], repoA);
  await execGit(['commit', '-m', 'external commit in repoA'], repoA);

  const [resA, resAWt, resB] = await Promise.all([waitA, waitAWt, waitB]);
  // 会话 A 先改了工作区文件再提交，先到的可能是 status 级或 full 级事件，只要被唤醒即可
  assert.notEqual(resA.json.data.refresh, 'none', '其他会话快照后，外部终端提交 repoA 仍必须即时唤醒会话 A');
  assert.equal(resAWt.json.data.refresh, 'full', '同一 Repository 的 metadata 变更应以 full 级唤醒关联 Worktree');
  assert.equal(resB.json.data.refresh, 'none', 'repoA 的外部提交不得误唤醒无关会话 B');

  // 2) 监听池超出 maxTargets 淘汰旧目标时，被淘汰会话下一次 /api/events/wait 应立即返回 full 触发重建
  const smallEventBus = createEventBus({ minTimeoutMs: 100 });
  let smallRouter = null;
  const smallPool = createWatcherPool({
    maxTargets: 1,
    onChange: (info) => {
      const scopeKeys = smallRouter?.resolveAffectedWorkspaceKeys(info) ?? [];
      smallEventBus.bumpRevision({
        scopeKeys: scopeKeys.length > 0 ? scopeKeys : undefined,
        refresh: info.channel === 'worktree' ? 'status' : 'full',
      });
    },
  });
  smallRouter = createApiRouter({
    eventBus: smallEventBus,
    watcher: smallPool,
    preferencesStore: createPreferencesStore({ filePath: path.join(root, 'prefs-small.json') }),
    mockFixture: createMockFixtureStore({ eventBus: smallEventBus }),
    defaultWorkspaceUris: [],
    isStandalone: false,
  });
  t.after(() => {
    smallPool.close();
    smallEventBus.dispose();
  });

  const sSmallA = (await smallRouter.dispatch('/api/snapshot', { workspaceUris: [toFileUri(repoA)] })).body.data;
  await smallRouter.dispatch('/api/snapshot', { workspaceUris: [toFileUri(repoB)] });
  assert.equal(smallPool.size, 1);
  const evictedWait = (await smallRouter.dispatch('/api/events/wait', {
    workspaceKey: sSmallA.workspaceKey,
    sinceRevision: sSmallA.revision,
    timeoutMs: 1000,
  })).body.data;
  assert.equal(evictedWait.refresh, 'full', '被 LRU 淘汰监听的会话轮询时应立即唤醒重拉完整快照并重建监听');

  // 3) .git 元数据监听遭遇瞬时 error 后自动延迟重挂并补发一次 metadata 变更
  let gitMountCount = 0;
  let gitErrorHandler = null;
  const remountChanges = [];
  const normGit = normalizeFsPath(path.join(repoA, '.git'));
  const gitRemountWatcher = createRepositoryWatcher({
    metadataDebounceMs: 30,
    worktreeRetryDelayMs: 40,
    existsFn: () => true,
    statFn: () => ({ isDirectory: () => false }),
    watchFn: (dir) => {
      const key = normalizeFsPath(dir);
      if (key === normGit) gitMountCount += 1;
      return {
        close() {},
        on(evt, fn) {
          if (key === normGit && evt === 'error') gitErrorHandler = fn;
        },
      };
    },
    onChange: (info) => remountChanges.push(info.channel),
  });
  t.after(() => gitRemountWatcher.close());

  gitRemountWatcher.setTarget({
    gitCommonDir: path.join(repoA, '.git'),
    gitDir: path.join(repoA, '.git'),
    worktreePath: repoA,
    isBare: false,
  });
  assert.equal(gitMountCount, 1);
  gitErrorHandler(new Error('EPERM transient'));
  await new Promise((resolve) => setTimeout(resolve, 140));
  assert.equal(gitMountCount, 2, '.git 监听遭遇瞬时错误后应自动延迟重挂');
  assert.ok(remountChanges.includes('metadata'), '.git 监听重挂成功后应主动触发 metadata 同步补齐中断窗口');
});
