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
  assert.deepEqual(immediate, { revision: 5, changed: true, watchDegraded: false });

  const waiters = [];
  for (let i = 0; i < 8; i += 1) {
    waiters.push(bus.waitForEvent({ sinceRevision: 5, timeoutMs: 20_000 }));
  }
  assert.equal(bus.pendingCount, 8);

  // 第 9 个等待者进入时，应立即唤醒第 1 个（最旧者）并返回 changed: false
  const ninth = bus.waitForEvent({ sinceRevision: 5, timeoutMs: 20_000 });
  const evictedResult = await waiters[0];
  assert.deepEqual(evictedResult, { revision: 5, changed: false, watchDegraded: false });
  assert.equal(bus.pendingCount, 8);

  const bumped = bus.bumpRevision();
  assert.equal(bumped.revision, 6);

  const settledRest = await Promise.all([...waiters.slice(1), ninth]);
  assert.equal(settledRest.length, 8);
  for (const item of settledRest) {
    assert.deepEqual(item, { revision: 6, changed: true, watchDegraded: false });
  }
  assert.equal(bus.pendingCount, 0);
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

  // 5) bare 仓库支持 /api/snapshot、/api/commit/detail（worktreePath: null）与 /api/remote/fetch（有/无 remote）
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

  const bareFetch = await postApi(server.url, '/api/remote/fetch', { worktreePath: null });
  assert.equal(bareFetch.response.status, 200);
});

test('集成测试：events/wait 文件修改即时唤醒、删除目录触发自毁守卫无风暴、模拟风暴熔断与 forceRefresh 恢复', async (t) => {
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

  // 1) 文件修改通过 fs.watch 即时唤醒 POST /api/events/wait
  const initialSnap = await postApi(server.url, '/api/snapshot', {
    workspaceUris: [toFileUri(repoDir)],
  });
  assert.equal(initialSnap.json.data.watchState.active, true);
  assert.equal(initialSnap.json.data.watchState.degraded, false);
  const baseRevision = initialSnap.json.data.revision;

  const waitPromise = postApi(server.url, '/api/events/wait', {
    workspaceKey: initialSnap.json.data.workspaceKey,
    sinceRevision: baseRevision,
    timeoutMs: 10_000,
  });

  setTimeout(() => {
    fs.writeFileSync(path.join(repoDir, 'app.txt'), 'v2-changed\n');
  }, 80);

  const waitRes = await waitPromise;
  assert.equal(waitRes.response.status, 200);
  assert.equal(waitRes.json.data.changed, true);
  assert.ok(waitRes.json.data.revision > baseRevision);
  assert.equal(waitRes.json.data.watchDegraded, false);

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

  // 2) 模拟风暴（超过 200 次有效工作区事件）触发 watchDegraded 并随 forceRefresh 恢复
  const snapBeforeStorm = await postApi(server.url, '/api/snapshot', {
    workspaceUris: [toFileUri(repoDir)],
  });
  const stormWaitPromise = postApi(server.url, '/api/events/wait', {
    workspaceKey: snapBeforeStorm.json.data.workspaceKey,
    sinceRevision: snapBeforeStorm.json.data.revision,
    timeoutMs: 10_000,
  });

  // 在独立单元测试级监听器上也同时验证 200 次窗口熔断机制
  let stormDegradeNotified = false;
  let injectedClock = 1000;
  let fakeEmit = null;
  const fakeWatcher = createRepositoryWatcher({
    stormEventLimit: 200,
    stormWindowMs: 1000,
    nowFn: () => injectedClock,
    existsFn: () => true,
    watchFn: (dir, _opts, listener) => {
      if (normalizeFsPath(dir) === normalizeFsPath(repoDir)) {
        fakeEmit = listener;
      }
      return { close() {}, on() {} };
    },
    onDegraded: () => {
      stormDegradeNotified = true;
    },
  });
  fakeWatcher.setTarget({
    gitCommonDir: path.join(repoDir, '.git'),
    gitDir: path.join(repoDir, '.git'),
    worktreePath: repoDir,
    isBare: false,
  });
  assert.ok(fakeEmit);
  for (let i = 0; i < 205; i += 1) {
    fakeEmit('change', `src/file-${i}.js`);
  }
  assert.equal(stormDegradeNotified, true);
  assert.equal(fakeWatcher.getWatchState().degraded, true);
  assert.equal(fakeWatcher.getWatchState().active, false);
  fakeWatcher.setTarget(
    {
      gitCommonDir: path.join(repoDir, '.git'),
      gitDir: path.join(repoDir, '.git'),
      worktreePath: repoDir,
      isBare: false,
    },
    { forceRefresh: true },
  );
  assert.equal(fakeWatcher.getWatchState().degraded, false);
  assert.equal(fakeWatcher.getWatchState().active, true);
  fakeWatcher.close();

  // 真实服务器实例上触发降级并验证 events/wait 返回 watchDegraded: true，再经 forceRefresh 恢复
  server.runtime.watcher.degrade('watch_storm');
  const stormWaitRes = await stormWaitPromise;
  assert.equal(stormWaitRes.json.data.changed, true);
  assert.equal(stormWaitRes.json.data.watchDegraded, true);

  const degradedSnap = await postApi(server.url, '/api/snapshot', {
    workspaceUris: [toFileUri(repoDir)],
    forceRefresh: false,
  });
  assert.equal(degradedSnap.json.data.watchState.degraded, true);
  assert.equal(degradedSnap.json.data.watchState.active, false);

  const recoveredSnap = await postApi(server.url, '/api/snapshot', {
    workspaceUris: [toFileUri(repoDir)],
    forceRefresh: true,
  });
  assert.equal(recoveredSnap.json.data.watchState.degraded, false);
  assert.equal(recoveredSnap.json.data.watchState.active, true);
  assert.equal(recoveredSnap.json.data.watchState.reason, null);

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
    server.runtime.eventBus.bumpRevision({ watchDegraded: false });
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
  assert.equal(wakeRes.changed, true);
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
      onChange: () => eventBus.bumpRevision({ watchDegraded: watcher.getWatchState().degraded }),
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

  // 会话 A 推送必须成功，且其长轮询不会因为 currentWorkspaceKey 不同而立即误报 changed: true
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
  assert.equal(waitA.body.data.changed, false, '多会话 workspaceKey 不同不得触发互相唤醒风暴');

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
  assert.equal(restartWait.body.data.changed, true, 'Sidecar 重启后应立即唤醒已挂载前端重新同步快照');

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
