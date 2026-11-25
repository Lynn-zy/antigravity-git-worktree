import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  discoverRepositories,
  normalizeFsPath,
  toFileUri,
} from '../../sidecars/panel/backend/discovery.mjs';
import {
  discoverAndBuildSnapshotBase,
  queryCommitDetail,
  queryCommitGraph,
  queryRemotes,
  queryWorktreeStatus,
} from '../../sidecars/panel/backend/git-queries.mjs';
import {
  AppError,
  ERROR_CODES,
  buildGitArgs,
  runGitNetwork,
  runGitRead,
  runGitWrite,
} from '../../sidecars/panel/backend/git-runner.mjs';

function execGit(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out = [];
    const err = [];
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => err.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      const stdout = Buffer.concat(out).toString('utf8');
      const stderr = Buffer.concat(err).toString('utf8');
      if (code !== 0) {
        reject(new Error(`git ${args.join(' ')} failed (${code}): ${stderr}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

async function initConfiguredRepo(repoDir, branch = 'main') {
  fs.mkdirSync(repoDir, { recursive: true });
  await execGit(['init', '-b', branch], repoDir);
  await execGit(['config', 'user.name', 'Test User'], repoDir);
  await execGit(['config', 'user.email', 'test@example.com'], repoDir);
}

test('集成测试：多仓库去重、Worktree 顺序前缀匹配、非 Git 忽略、Submodule 边界与 Bare 仓库', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm1-int-discovery-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const nonGitDir = path.join(root, 'plain-dir');
  fs.mkdirSync(nonGitDir, { recursive: true });

  const subSource = path.join(root, 'sub-source');
  await initConfiguredRepo(subSource, 'main');
  fs.writeFileSync(path.join(subSource, 'sub.txt'), 'submodule content\n');
  await execGit(['add', '--', 'sub.txt'], subSource);
  await execGit(['commit', '-m', 'init submodule'], subSource);

  const repoMain = path.join(root, 'repo-alpha');
  await initConfiguredRepo(repoMain, 'main');
  fs.mkdirSync(path.join(repoMain, 'packages', 'web'), { recursive: true });
  fs.writeFileSync(path.join(repoMain, 'packages', 'web', 'index.js'), 'console.log(1);\n');
  await execGit(['add', '--', 'packages/web/index.js'], repoMain);
  await execGit(['commit', '-m', 'init alpha'], repoMain);

  // 嵌套 Submodule 不应在打开父仓库时被自动当作独立仓库
  await execGit(['-c', 'protocol.file.allow=always', 'submodule', 'add', subSource, 'libs/sub'], repoMain);
  await execGit(['commit', '-m', 'add submodule'], repoMain);

  // 同前缀目录与 linked worktree，校验按路径段边界精确命中而非字符串前向误匹配
  const repoMainWt = path.join(root, 'repo-alpha-wt');
  const similarNamedNonGit = path.join(root, 'repo-alpha-wt-sibling');
  fs.mkdirSync(similarNamedNonGit, { recursive: true });
  await execGit(['worktree', 'add', '-b', 'feat-wt', repoMainWt], repoMain);

  const bareRepo = path.join(root, 'remote-bare.git');
  await execGit(['clone', '--bare', repoMain, bareRepo], root);

  const subWorktree = path.join(repoMain, 'libs', 'sub');

  const dedupedMainFirst = await discoverRepositories([
    toFileUri(nonGitDir),
    toFileUri(similarNamedNonGit),
    toFileUri(path.join(repoMain, 'packages', 'web')),
    toFileUri(repoMainWt),
  ]);
  assert.equal(dedupedMainFirst.length, 1);
  assert.equal(dedupedMainFirst[0].worktreePath, normalizeFsPath(repoMain));
  assert.equal(dedupedMainFirst[0].branch, 'main');
  assert.equal(dedupedMainFirst[0].isBare, false);

  const dedupedWtFirst = await discoverRepositories([
    toFileUri(repoMainWt),
    toFileUri(repoMain),
  ]);
  assert.equal(dedupedWtFirst.length, 1);
  assert.equal(dedupedWtFirst[0].worktreePath, normalizeFsPath(repoMainWt));
  assert.equal(dedupedWtFirst[0].branch, 'feat-wt');
  assert.equal(dedupedWtFirst[0].gitCommonDir, dedupedMainFirst[0].gitCommonDir);
  assert.notEqual(dedupedWtFirst[0].gitDir, dedupedMainFirst[0].gitDir);

  // 仅当显式将 Submodule 目录作为 Workspace 根打开时视为独立 Repository
  const withSubmoduleOpened = await discoverRepositories([
    toFileUri(repoMain),
    toFileUri(subWorktree),
  ]);
  assert.equal(withSubmoduleOpened.length, 2);
  assert.equal(withSubmoduleOpened[1].worktreePath, normalizeFsPath(subWorktree));

  const bareSnapshot = await discoverAndBuildSnapshotBase({
    workspaceUris: [toFileUri(bareRepo)],
  });
  assert.equal(bareSnapshot.repositories.length, 1);
  assert.equal(bareSnapshot.activeRepo.isBare, true);
  assert.equal(bareSnapshot.activeRepo.worktreePath, null);
  assert.equal(bareSnapshot.activeRepo.branch, 'main');
  assert.equal(bareSnapshot.changes.totalEntries, 0);
  assert.ok(bareSnapshot.graph.commits.length >= 2);
});

test('集成测试：unborn 仓库、中文路径、-weird.txt、MM 双态、Detached HEAD 与 Merge Commit 详情', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm1-int-queries-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const upstreamBare = path.join(root, 'upstream.git');
  await execGit(['init', '--bare', '-b', 'main', upstreamBare], root);

  const repoDir = path.join(root, 'work');
  await initConfiguredRepo(repoDir, 'main');
  await execGit(['remote', 'add', 'origin', upstreamBare], repoDir);

  // 1) 0 提交 unborn 仓库兼容
  fs.writeFileSync(path.join(repoDir, 'first.txt'), 'draft');
  await execGit(['add', '--', 'first.txt'], repoDir);
  const unbornSnap = await discoverAndBuildSnapshotBase({
    workspaceUris: [toFileUri(repoDir)],
    graphScope: 'auto',
  });
  assert.equal(unbornSnap.activeRepo.isUnborn, true);
  assert.deepEqual(unbornSnap.graph.commits, []);
  assert.equal(unbornSnap.changes.staged.length, 1);
  assert.deepEqual(unbornSnap.activeRepo.remotes, ['origin']);

  const unbornAllGraph = await queryCommitGraph(repoDir, { scope: 'all', isUnborn: true });
  assert.deepEqual(unbornAllGraph.commits, []);

  // 2) 建立历史、重命名、Merge Commit、Co-authored-by 与已删文件
  fs.writeFileSync(path.join(repoDir, 'to-delete.txt'), 'bye\n');
  fs.writeFileSync(path.join(repoDir, 'rename src.txt'), 'line1\nline2\nline3\nline4\n');
  await execGit(['add', '--', 'to-delete.txt', 'rename src.txt'], repoDir);
  await execGit(['commit', '-m', 'root commit'], repoDir);
  await execGit(['push', '-u', 'origin', 'main'], repoDir);

  await execGit(['checkout', '-b', 'feature'], repoDir);
  await execGit(['mv', '--', 'rename src.txt', 'rename dest.txt'], repoDir);
  await execGit(['rm', '--', 'to-delete.txt'], repoDir);
  fs.mkdirSync(path.join(repoDir, '中文 目录'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, '中文 目录', '新 文件.txt'), 'feat\n');
  await execGit(['add', '--', '中文 目录/新 文件.txt'], repoDir);
  await execGit(['commit', '-m', 'feat: rename and delete'], repoDir);

  await execGit(['checkout', 'main'], repoDir);
  fs.writeFileSync(path.join(repoDir, 'main-only.txt'), 'ahead\n');
  await execGit(['add', '--', 'main-only.txt'], repoDir);
  await runGitWrite(['commit', '-F', '-'], {
    cwd: repoDir,
    input: 'main work\n\n通过 stdin 写入 UTF-8 提交说明。\n',
  });

  const mergeMessage = [
    'merge: integrate feature',
    '',
    'Merge body line.',
    '',
    'Co-authored-by: Pair Dev <pair@example.com>',
  ].join('\n');
  await runGitWrite(['merge', '--no-ff', '-m', mergeMessage, '--end-of-options', 'feature'], {
    cwd: repoDir,
  });

  const mergeSha = await execGit(['rev-parse', 'HEAD'], repoDir);
  const mergeDetail = await queryCommitDetail(repoDir, mergeSha);
  assert.equal(mergeDetail.subject, 'merge: integrate feature');
  assert.equal(mergeDetail.body, 'Merge body line.');
  assert.deepEqual(mergeDetail.coAuthors, [{ name: 'Pair Dev', email: 'pair@example.com' }]);
  // 相对第一父提交：纯重命名 0 行、删除 to-delete.txt 1 行、新增「中文 目录/新 文件.txt」1 行
  assert.deepEqual(mergeDetail.stats, { files: 3, insertions: 1, deletions: 1 });

  const renamedFile = mergeDetail.files.find((item) => item.status === 'R');
  assert.ok(renamedFile, 'Merge commit detail should detect renamed file');
  assert.equal(renamedFile.origPath, 'rename src.txt');
  assert.equal(renamedFile.path, 'rename dest.txt');
  assert.equal(renamedFile.existsInWorktree, true);
  assert.ok(renamedFile.fileUri.startsWith('file:///'));

  const deletedFile = mergeDetail.files.find((item) => item.path === 'to-delete.txt');
  assert.ok(deletedFile);
  assert.equal(deletedFile.status, 'D');
  assert.equal(deletedFile.existsInWorktree, false);
  assert.equal(deletedFile.fileUri, null);

  // 3) 分页 hasMore 与 2000 软上限标记
  const paged = await queryCommitGraph(repoDir, { scope: 'auto', limit: 2, upstream: 'origin/main' });
  assert.equal(paged.commits.length, 2);
  assert.equal(paged.hasMore, true);
  assert.equal(paged.reachedSoftLimit, false);

  const softLimitGraph = await queryCommitGraph(repoDir, { scope: 'all', limit: 2000 });
  assert.equal(softLimitGraph.hasMore, false);
  assert.equal(softLimitGraph.reachedSoftLimit, true);
  assert.equal(softLimitGraph.commits.length, 4);

  // 4) 中文路径、-weird.txt 与 MM 双态工作区变更
  fs.writeFileSync(path.join(repoDir, '中文 目录', '新 文件.txt'), 'staged content\n');
  await execGit(['add', '--', '中文 目录/新 文件.txt'], repoDir);
  fs.writeFileSync(path.join(repoDir, '中文 目录', '新 文件.txt'), 'unstaged override\n');
  fs.writeFileSync(path.join(repoDir, '-weird.txt'), 'leading dash\n');

  const statusResult = await queryWorktreeStatus(repoDir);
  assert.equal(statusResult.branchInfo.ahead, 3);
  assert.equal(statusResult.branchInfo.behind, 0);
  assert.ok(statusResult.changes.staged.some((item) => item.path === '中文 目录/新 文件.txt' && item.status === 'M'));
  assert.ok(statusResult.changes.unstaged.some((item) => item.path === '中文 目录/新 文件.txt' && item.status === 'M' && !item.untracked));
  assert.ok(statusResult.changes.unstaged.some((item) => item.path === '-weird.txt' && item.status === 'U' && item.untracked));

  // 5) Detached HEAD 探测
  await execGit(['reset', '--hard', 'HEAD'], repoDir);
  fs.rmSync(path.join(repoDir, '-weird.txt'), { force: true });
  const prevSha = await execGit(['rev-parse', 'HEAD~1'], repoDir);
  await execGit(['checkout', '--detach', prevSha], repoDir);
  const detachedSnap = await discoverAndBuildSnapshotBase({
    workspaceUris: [toFileUri(repoDir)],
  });
  assert.equal(detachedSnap.activeRepo.isDetached, true);
  assert.equal(detachedSnap.activeRepo.branch, null);
  assert.equal(detachedSnap.activeRepo.headOid, prevSha);
  assert.deepEqual(await queryRemotes(repoDir), ['origin']);
});

test('集成测试：status 超过 2000 条自动置 truncated: true 且数组上限 2000', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm1-int-truncate-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  await initConfiguredRepo(root, 'main');
  for (let i = 0; i < 2005; i += 1) {
    fs.writeFileSync(path.join(root, `f-${i}.txt`), '');
  }

  const { changes } = await queryWorktreeStatus(root);
  assert.equal(changes.truncated, true);
  assert.equal(changes.totalEntries, 2005);
  assert.equal(changes.unstaged.length, 2000);
});

test('集成测试：.git/index.lock 退避重试 3 次返回 GIT_LOCKED 且不删原锁文件，瞬时解锁后可成功', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm1-int-lock-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  await initConfiguredRepo(root, 'main');
  const filePath = path.join(root, 'item.txt');
  fs.writeFileSync(filePath, 'v1');
  const lockPath = path.join(root, '.git', 'index.lock');
  fs.writeFileSync(lockPath, 'keep-user-lock');

  const t0 = Date.now();
  await assert.rejects(
    () => runGitWrite(buildGitArgs('add', { paths: ['item.txt'] }), { cwd: root }),
    (err) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.code, ERROR_CODES.GIT_LOCKED);
      assert.equal(err.statusCode, 409);
      assert.match(err.detail, /index\.lock/i);
      return true;
    }
  );
  const elapsedMs = Date.now() - t0;
  assert.ok(elapsedMs >= 600, `Expected 80+200+400ms retries, got ${elapsedMs}ms`);
  assert.equal(fs.existsSync(lockPath), true, 'Must never delete existing user .lock file');
  assert.equal(fs.readFileSync(lockPath, 'utf8'), 'keep-user-lock');

  const releaseTimer = setTimeout(() => {
    fs.rmSync(lockPath, { force: true });
  }, 140);
  t.after(() => clearTimeout(releaseTimer));

  await runGitWrite(buildGitArgs('add', { paths: ['item.txt'] }), { cwd: root });
  const { changes } = await queryWorktreeStatus(root);
  assert.equal(changes.staged.length, 1);
  assert.equal(changes.staged[0].path, 'item.txt');
});

test('集成测试：127.0.0.1 HTTP 401 非交互 <2s 快速失败返回 AUTH_REQUIRED 且支持超时强杀', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm1-int-auth-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  await initConfiguredRepo(root, 'main');

  const authServer = http.createServer((req, res) => {
    res.writeHead(401, {
      'WWW-Authenticate': 'Basic realm="GitAuthTest"',
      Connection: 'close',
    });
    res.end('Unauthorized');
  });
  await new Promise((resolve) => authServer.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    authServer.closeAllConnections?.();
    authServer.close();
  });

  const { port } = authServer.address();
  await execGit(['remote', 'add', 'origin', `http://127.0.0.1:${port}/repo.git`], root);

  const startedAt = Date.now();
  await assert.rejects(
    () => runGitNetwork(['-c', 'credential.helper=', 'fetch', '--end-of-options', 'origin'], { cwd: root }),
    (err) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.code, ERROR_CODES.AUTH_REQUIRED);
      assert.equal(err.statusCode, 401);
      return true;
    }
  );
  const directElapsedMs = Date.now() - startedAt;
  assert.ok(directElapsedMs < 2000, `Expected non-interactive 401 failure < 2000ms, got ${directElapsedMs}ms`);

  // 同时验证不覆写 credential.helper 时，GCM_INTERACTIVE=never 同样快速返回 AUTH_REQUIRED 而不挂起
  const gcmStartedAt = Date.now();
  await assert.rejects(
    () => runGitNetwork(['fetch', '--end-of-options', 'origin'], { cwd: root, timeoutMs: 10_000 }),
    (err) => err instanceof AppError && err.code === ERROR_CODES.AUTH_REQUIRED
  );
  const gcmElapsedMs = Date.now() - gcmStartedAt;
  assert.ok(gcmElapsedMs < 5000, `Expected GCM_INTERACTIVE=never failure well under timeout, got ${gcmElapsedMs}ms`);

  // 验证只读池 8 并发执行正常，以及网络无响应时硬超时返回 GIT_TIMEOUT (504)
  const readBatch = await Promise.all(
    Array.from({ length: 8 }, () => runGitRead(['remote'], { cwd: root }))
  );
  assert.equal(readBatch.length, 8);

  const blackholeServer = http.createServer(() => {
    // 故意不响应请求以验证硬超时强杀
  });
  await new Promise((resolve) => blackholeServer.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    blackholeServer.closeAllConnections?.();
    blackholeServer.close();
  });
  const blackholePort = blackholeServer.address().port;
  await execGit(['remote', 'set-url', 'origin', `http://127.0.0.1:${blackholePort}/hang.git`], root);

  await assert.rejects(
    () => runGitNetwork(['fetch', '--end-of-options', 'origin'], { cwd: root, timeoutMs: 300 }),
    (err) => err instanceof AppError && err.code === ERROR_CODES.GIT_TIMEOUT && err.statusCode === 504
  );
});
