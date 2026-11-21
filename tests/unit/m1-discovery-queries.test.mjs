import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  discoverRepositories,
  isPathInside,
  normalizeFsPath,
  normalizeWorkspaceUri,
  probeWorkspaceGitRoot,
  resolvePathInsideWorktree,
  toFileUri,
  toPathKey,
} from '../../sidecars/panel/backend/discovery.mjs';
import {
  parseCommitMessageB,
  parseCommitNameStatusZ,
  parseLogRecordsZ,
  parseStatusPorcelainV2Z,
  parseWorktreeListPorcelainZ,
} from '../../sidecars/panel/backend/git-queries.mjs';
import {
  AppError,
  ConcurrencyPool,
  ERROR_CODES,
  ERROR_HTTP_STATUS,
  KeyedSerialQueue,
  LOCK_RETRY_DELAYS_MS,
  NETWORK_TIMEOUT_MS,
  READ_POOL_CONCURRENCY,
  READ_TIMEOUT_MS,
  appendEndOfOptions,
  appendPathspecs,
  assertValidGitArg,
  buildGitArgs,
  buildGitEnv,
  buildGitGlobalPrefix,
  enqueueRepositoryAndWorktreeWrite,
  getHttpStatusForErrorCode,
  isAuthRequiredError,
  isGitLockError,
  isNonFastForwardError,
  splitNullTokens,
} from '../../sidecars/panel/backend/git-runner.mjs';

test('ERROR_CODES 与 HTTP 状态映射完整覆盖 spec 5.1 全部 12 个错误码', () => {
  const expectedCodes = [
    'INVALID_REQUEST',
    'OUT_OF_WORKTREE',
    'NO_REPOSITORY',
    'CONFLICT_BLOCKED',
    'EMPTY_COMMIT_MESSAGE',
    'NOTHING_TO_COMMIT',
    'GIT_LOCKED',
    'GIT_TIMEOUT',
    'AUTH_REQUIRED',
    'NON_FAST_FORWARD',
    'NO_REMOTE',
    'GIT_ERROR',
  ];
  assert.deepEqual(Object.keys(ERROR_CODES).sort(), [...expectedCodes].sort());

  const statuses = new Set(expectedCodes.map((code) => getHttpStatusForErrorCode(code)));
  for (const requiredStatus of [400, 401, 403, 409, 504, 500]) {
    assert.ok(statuses.has(requiredStatus), `Missing HTTP status ${requiredStatus}`);
  }
  assert.equal(ERROR_HTTP_STATUS[ERROR_CODES.OUT_OF_WORKTREE], 403);
  assert.equal(ERROR_HTTP_STATUS[ERROR_CODES.AUTH_REQUIRED], 401);
  assert.equal(ERROR_HTTP_STATUS[ERROR_CODES.GIT_TIMEOUT], 504);

  const err = new AppError(ERROR_CODES.NON_FAST_FORWARD, '不能快进', { detail: 'fatal: Not possible to fast-forward' });
  assert.equal(err.statusCode, 409);
  assert.deepEqual(err.toJSON(), {
    ok: false,
    error: {
      code: 'NON_FAST_FORWARD',
      message: '不能快进',
      detail: 'fatal: Not possible to fast-forward',
    },
  });
});

test('git-runner 参数隔离、前缀注入、默认常量与环境构造', () => {
  assert.equal(READ_TIMEOUT_MS, 10_000);
  assert.equal(NETWORK_TIMEOUT_MS, 45_000);
  assert.equal(READ_POOL_CONCURRENCY, 4);
  assert.deepEqual(LOCK_RETRY_DELAYS_MS, [80, 200, 400]);

  assert.deepEqual(buildGitGlobalPrefix({ readOnly: true }), [
    '-c', 'core.quotepath=false',
    '-c', 'i18n.logOutputEncoding=utf-8',
    '--no-pager',
    '--no-optional-locks',
  ]);
  assert.deepEqual(buildGitGlobalPrefix({ readOnly: false }), [
    '-c', 'core.quotepath=false',
    '-c', 'i18n.logOutputEncoding=utf-8',
    '--no-pager',
  ]);

  assert.deepEqual(
    buildGitArgs('log', { flags: ['--topo-order'], refs: ['HEAD', 'origin/main'], paths: ['-weird.txt'] }),
    ['log', '--topo-order', '--end-of-options', 'HEAD', 'origin/main', '--', '-weird.txt']
  );
  assert.deepEqual(appendEndOfOptions(['show'], []), ['show']);
  assert.deepEqual(appendPathspecs(['add'], ['-weird.txt']), ['add', '--', '-weird.txt']);

  assert.throws(() => assertValidGitArg('bad\0arg', 'path'), (err) => err.code === ERROR_CODES.INVALID_REQUEST);
  assert.throws(() => assertValidGitArg('bad\narg', 'ref'), (err) => err.code === ERROR_CODES.INVALID_REQUEST);

  const readEnv = buildGitEnv({ readOnly: true, env: { CUSTOM_FLAG: '1' } });
  assert.equal(readEnv.GIT_OPTIONAL_LOCKS, '0');
  assert.equal(readEnv.CUSTOM_FLAG, '1');

  const netEnv = buildGitEnv({ network: true, env: { GIT_SSH_COMMAND: '' } });
  assert.equal(netEnv.GIT_TERMINAL_PROMPT, '0');
  assert.equal(netEnv.GCM_INTERACTIVE, 'never');
  assert.equal(netEnv.GIT_ASKPASS, '');
  assert.equal(netEnv.SSH_ASKPASS_REQUIRE, 'never');
  assert.equal(netEnv.GIT_SSH_COMMAND, 'ssh -o BatchMode=yes');

  const customSshEnv = buildGitEnv({ network: true, env: { GIT_SSH_COMMAND: 'ssh -i ~/.ssh/custom' } });
  assert.equal(customSshEnv.GIT_SSH_COMMAND, 'ssh -i ~/.ssh/custom');

  assert.equal(isGitLockError("fatal: Unable to create 'D:/repo/.git/index.lock': File exists."), true);
  assert.equal(isAuthRequiredError(128, 'fatal: could not read Username for ...: terminal prompts disabled'), true);
  assert.equal(isAuthRequiredError(1, 'fatal: could not read Username for ...: terminal prompts disabled'), false);
  assert.equal(isNonFastForwardError('fatal: Not possible to fast-forward, aborting.'), true);
});

test('ConcurrencyPool 严格限制最大并发为 4 且异常后不泄漏槽位', async () => {
  const pool = new ConcurrencyPool(4);
  let active = 0;
  let peak = 0;

  const tasks = Array.from({ length: 12 }, (_, idx) =>
    pool.run(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      if (idx === 3) {
        throw new Error('boom');
      }
      return idx;
    })
  );

  const settled = await Promise.allSettled(tasks);
  assert.equal(peak, 4);
  assert.equal(pool.activeCount, 0);
  assert.equal(pool.pendingCount, 0);
  assert.equal(settled[3].status, 'rejected');
  assert.equal(settled.filter((item) => item.status === 'fulfilled').length, 11);
});

test('KeyedSerialQueue 与双锁顺序执行防止竞争且单次失败不阻塞后续任务', async () => {
  const queue = new KeyedSerialQueue();
  const events = [];

  const first = queue.enqueue('same', async () => {
    events.push('first:start');
    await new Promise((resolve) => setTimeout(resolve, 25));
    events.push('first:fail');
    throw new Error('fail-first');
  });
  const second = queue.enqueue('same', async () => {
    events.push('second:start');
    await new Promise((resolve) => setTimeout(resolve, 10));
    events.push('second:end');
    return 'ok';
  });

  await assert.rejects(first, /fail-first/);
  assert.equal(await second, 'ok');
  assert.deepEqual(events, ['first:start', 'first:fail', 'second:start', 'second:end']);
  assert.equal(queue.size, 0);

  const dualResult = await enqueueRepositoryAndWorktreeWrite('/repo/.git', '/repo', async () => 'dual-ok');
  assert.equal(dualResult, 'dual-ok');
});

test('normalizeWorkspaceUri / normalizeFsPath / toPathKey / isPathInside 边界规范化', () => {
  assert.equal(normalizeWorkspaceUri('https://github.com/org/repo'), null);
  assert.equal(normalizeWorkspaceUri('vscode-remote://wsl+ubuntu/home/user'), null);
  assert.equal(normalizeWorkspaceUri('not a uri'), null);

  if (process.platform === 'win32') {
    assert.equal(
      normalizeWorkspaceUri('file:///d%3A/nonexistent-agw-path/sub/../%E4%B8%AD%E6%96%87/'),
      'D:/nonexistent-agw-path/中文'
    );
    assert.equal(
      normalizeWorkspaceUri('file://fileserver/share/project/', { resolveRealpath: false }),
      '//fileserver/share/project'
    );
    assert.equal(normalizeFsPath('c:\\', { resolveRealpath: false }), 'C:/');
    assert.equal(toPathKey('D:\\Repo\\Sub\\', { resolveRealpath: false }), 'd:/repo/sub');
  }

  assert.equal(
    normalizeFsPath('/tmp/demo/sub/../leaf/', { resolveRealpath: false, platform: 'linux' }),
    '/tmp/demo/leaf'
  );
  assert.equal(
    toPathKey('/Tmp/Demo/', { resolveRealpath: false, platform: 'linux' }),
    '/Tmp/Demo'
  );

  assert.equal(isPathInside('D:/repo', 'D:/repo', { resolveRealpath: false, platform: 'win32' }), true);
  assert.equal(isPathInside('D:/repo', 'D:/repo/sub', { resolveRealpath: false, platform: 'win32' }), true);
  assert.equal(isPathInside('D:/repo', 'D:/repo-wt', { resolveRealpath: false, platform: 'win32' }), false);
});

test('resolvePathInsideWorktree 拒绝空字节、控制字符、绝对路径、.. 与符号链接逃逸', (t) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'm1-path-sec-'));
  const worktreeDir = path.join(sandbox, 'wt');
  const outsideDir = path.join(sandbox, 'outside');
  fs.mkdirSync(path.join(worktreeDir, 'src'), { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.writeFileSync(path.join(worktreeDir, 'src', '中文 文件.txt'), 'ok');
  fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'secret');

  t.after(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  const valid = resolvePathInsideWorktree(worktreeDir, 'src/中文 文件.txt');
  assert.equal(valid.relativePath, 'src/中文 文件.txt');
  assert.equal(valid.fileUri, toFileUri(valid.fullPath));

  const validDash = resolvePathInsideWorktree(worktreeDir, '-weird.txt');
  assert.equal(validDash.relativePath, '-weird.txt');

  assert.throws(
    () => resolvePathInsideWorktree(worktreeDir, ''),
    (err) => err instanceof AppError && err.code === ERROR_CODES.INVALID_REQUEST
  );
  assert.throws(
    () => resolvePathInsideWorktree(worktreeDir, 'a\0b.txt'),
    (err) => err instanceof AppError && err.code === ERROR_CODES.INVALID_REQUEST
  );
  assert.throws(
    () => resolvePathInsideWorktree(worktreeDir, 'a\nb.txt'),
    (err) => err instanceof AppError && err.code === ERROR_CODES.INVALID_REQUEST
  );
  assert.throws(
    () => resolvePathInsideWorktree(worktreeDir, '.'),
    (err) => err instanceof AppError && err.code === ERROR_CODES.INVALID_REQUEST
  );

  for (const escapePath of ['../outside/secret.txt', 'src/../../outside/secret.txt', '/etc/passwd', 'C:\\Windows\\win.ini', 'D:relative.txt', '\\\\server\\share\\x']) {
    assert.throws(
      () => resolvePathInsideWorktree(worktreeDir, escapePath),
      (err) => err instanceof AppError && err.code === ERROR_CODES.OUT_OF_WORKTREE,
      `Expected OUT_OF_WORKTREE for ${escapePath}`
    );
  }

  const symlinkType = process.platform === 'win32' ? 'junction' : 'dir';
  const linkDir = path.join(worktreeDir, 'escape-dir');
  fs.symlinkSync(outsideDir, linkDir, symlinkType);

  assert.throws(
    () => resolvePathInsideWorktree(worktreeDir, 'escape-dir/secret.txt'),
    (err) => err instanceof AppError && err.code === ERROR_CODES.OUT_OF_WORKTREE
  );
  assert.throws(
    () => resolvePathInsideWorktree(worktreeDir, 'escape-dir/nonexistent-deep/file.txt'),
    (err) => err instanceof AppError && err.code === ERROR_CODES.OUT_OF_WORKTREE
  );
});

test('discovery 两阶段 rev-parse 不含 --show-toplevel 且兼容 Git <2.31 缺少 --path-format=absolute', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'm1-old-git-'));
  const repoDir = path.join(tempRoot, 'repo');
  const wtDir = path.join(repoDir, 'packages', 'app');
  fs.mkdirSync(wtDir, { recursive: true });
  t.after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const calls = [];
  const fakeRunGitRead = async (args) => {
    calls.push(args);
    if (args[0] === 'rev-parse' && args.includes('--path-format=absolute')) {
      assert.equal(args.includes('--show-toplevel'), false, 'Phase 1 must never pass --show-toplevel');
      return {
        exitCode: 129,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from("fatal: unknown option 'path-format=absolute'\n"),
        stdoutText: '',
        stderrText: "fatal: unknown option 'path-format=absolute'\n",
      };
    }
    if (args[0] === 'rev-parse') {
      assert.equal(args.includes('--show-toplevel'), false);
      return {
        exitCode: 0,
        stdout: Buffer.from('../../.git\n../../.git\ntrue\nfalse\n'),
        stderr: Buffer.alloc(0),
        stdoutText: '../../.git\n../../.git\ntrue\nfalse\n',
        stderrText: '',
      };
    }
    if (args[0] === 'worktree') {
      const normalizedRepo = normalizeFsPath(repoDir);
      const wtBuf = Buffer.from(
        `worktree ${normalizedRepo}\0HEAD 1234567890abcdef1234567890abcdef12345678\0branch refs/heads/main\0\0`,
        'utf8'
      );
      return {
        exitCode: 0,
        stdout: wtBuf,
        stderr: Buffer.alloc(0),
        stdoutText: wtBuf.toString('utf8'),
        stderrText: '',
      };
    }
    throw new Error(`Unexpected git call: ${args.join(' ')}`);
  };

  const probe = await probeWorkspaceGitRoot(wtDir, { runGitRead: fakeRunGitRead });
  assert.ok(probe);
  assert.equal(probe.gitCommonDir, normalizeFsPath(path.join(repoDir, '.git')));

  const repos = await discoverRepositories([toFileUri(wtDir)], { runGitRead: fakeRunGitRead });
  assert.equal(repos.length, 1);
  assert.equal(repos[0].worktreePath, normalizeFsPath(repoDir));
  assert.equal(repos[0].branch, 'main');
  assert.equal(repos[0].isBare, false);
  assert.ok(calls.some((args) => args[0] === 'rev-parse' && !args.includes('--path-format=absolute')));
});

test('parseWorktreeListPorcelainZ 正确解析主工作树、链接工作树、bare 与 detached', () => {
  const payload = Buffer.from(
    [
      'worktree D:/repo-main',
      'HEAD aaaaaaa111111111111111111111111111111111',
      'branch refs/heads/main',
      '',
      'worktree D:/repo-wt',
      'HEAD bbbbbbb222222222222222222222222222222222',
      'detached',
      'locked reason with space',
      '',
      'worktree D:/repo-bare.git',
      'bare',
      '',
      '',
    ].join('\0'),
    'utf8'
  );
  const list = parseWorktreeListPorcelainZ(payload);
  assert.equal(list.length, 3);
  assert.equal(list[0].branch, 'main');
  assert.equal(list[0].isBare, false);
  assert.equal(list[1].isDetached, true);
  assert.equal(list[1].isLocked, true);
  assert.equal(list[1].lockReason, 'reason with space');
  assert.equal(list[2].isBare, true);
});

test('parseStatusPorcelainV2Z 区分重命名顺序、MM 双态、空格路径、unborn、冲突与 2000 截断', () => {
  const sample = Buffer.from(
    [
      '# branch.oid (initial)',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +2 -1',
      '# stash 1',
      '1 MM N... 100644 100644 100644 abc def src/spaced dir/中文 -weird.txt',
      '2 RM N... 100644 100644 100644 abc def R100 new path/name.txt',
      'old path/name.txt',
      'u UU N... 100644 100644 100644 100644 h1 h2 h3 conflict file.txt',
      '? untracked -file.txt',
      '',
    ].join('\0'),
    'utf8'
  );

  const parsed = parseStatusPorcelainV2Z(sample);
  assert.equal(parsed.branchInfo.isUnborn, true);
  assert.equal(parsed.branchInfo.headOid, null);
  assert.equal(parsed.branchInfo.branch, 'main');
  assert.equal(parsed.branchInfo.upstream, 'origin/main');
  assert.equal(parsed.branchInfo.ahead, 2);
  assert.equal(parsed.branchInfo.behind, 1);
  assert.equal(parsed.branchInfo.stashCount, 1);

  assert.equal(parsed.changes.conflicted.length, 1);
  assert.equal(parsed.changes.conflicted[0].path, 'conflict file.txt');
  assert.equal(parsed.changes.conflicted[0].status, 'UU');

  assert.equal(parsed.changes.staged.length, 2);
  assert.deepEqual(
    parsed.changes.staged.map((item) => ({ path: item.path, origPath: item.origPath, status: item.status })),
    [
      { path: 'src/spaced dir/中文 -weird.txt', origPath: null, status: 'M' },
      { path: 'new path/name.txt', origPath: 'old path/name.txt', status: 'R' },
    ]
  );

  assert.equal(parsed.changes.unstaged.length, 3);
  assert.deepEqual(
    parsed.changes.unstaged.map((item) => ({ path: item.path, status: item.status, untracked: item.untracked })),
    [
      { path: 'src/spaced dir/中文 -weird.txt', status: 'M', untracked: false },
      { path: 'new path/name.txt', status: 'M', untracked: false },
      { path: 'untracked -file.txt', status: 'U', untracked: true },
    ]
  );
  assert.equal(parsed.changes.truncated, false);

  const exact2000 = Buffer.from(
    Array.from({ length: 2000 }, (_, i) => `? f-${i}.txt`).join('\0') + '\0',
    'utf8'
  );
  const notTruncated = parseStatusPorcelainV2Z(exact2000);
  assert.equal(notTruncated.changes.truncated, false);
  assert.equal(notTruncated.changes.totalEntries, 2000);
  assert.equal(notTruncated.changes.unstaged.length, 2000);

  const over2000 = Buffer.from(
    Array.from({ length: 2001 }, (_, i) => `? f-${i}.txt`).join('\0') + '\0',
    'utf8'
  );
  const truncated = parseStatusPorcelainV2Z(over2000);
  assert.equal(truncated.changes.truncated, true);
  assert.equal(truncated.changes.totalEntries, 2001);
  assert.equal(truncated.changes.unstaged.length, 2000);
});

test('parseLogRecordsZ / parseCommitMessageB / parseCommitNameStatusZ 精确解析', () => {
  assert.deepEqual(splitNullTokens(Buffer.alloc(0)), []);
  assert.deepEqual(parseLogRecordsZ(Buffer.alloc(0)), []);

  const logBuf = Buffer.from(
    [
      [
        '111111122222223333333444444455555556666666',
        'aaaaaaa bbbbbbb',
        'tag: refs/tags/v1.0, refs/remotes/origin/main, refs/heads/feat, HEAD -> refs/heads/main',
        'Alice',
        'alice@example.com',
        '1795251200',
        'merge: feat into main',
      ].join('\x1f'),
      [
        'aaaaaaa11111112222222333333344444445555555',
        '',
        'HEAD',
        'Bob',
        'bob@example.com',
        '1795251000',
        'root commit',
      ].join('\x1f'),
      '',
    ].join('\0'),
    'utf8'
  );

  const commits = parseLogRecordsZ(logBuf);
  assert.equal(commits.length, 2);
  assert.equal(commits[0].shortSha, '1111111');
  assert.deepEqual(commits[0].parents, ['aaaaaaa', 'bbbbbbb']);
  assert.deepEqual(
    commits[0].refs.map((r) => `${r.type}:${r.name}`),
    ['head:main', 'branch:feat', 'remote:origin/main', 'tag:v1.0']
  );
  assert.equal(commits[0].timestamp, 1795251200);
  assert.deepEqual(commits[1].refs, [{ type: 'head', name: 'HEAD', fullRef: 'HEAD' }]);
  assert.deepEqual(commits[1].parents, []);

  const msgBuf = Buffer.from(
    'feat: support utf8\r\n\r\n第一段正文。\r\n\r\nSigned-off-by: Dev <dev@example.com>\r\nCo-authored-by: Alice <alice@example.com>\r\nco-authored-by: 张三 <zhang@example.com>\r\n',
    'utf8'
  );
  assert.deepEqual(parseCommitMessageB(msgBuf), {
    subject: 'feat: support utf8',
    body: '第一段正文。\n\nSigned-off-by: Dev <dev@example.com>',
    coAuthors: [
      { name: 'Alice', email: 'alice@example.com' },
      { name: '张三', email: 'zhang@example.com' },
    ],
  });

  const nameStatusBuf = Buffer.from(
    ['A', 'added.txt', 'R095', 'old/中文.txt', 'new/中文 2.txt', 'C100', 'src.txt', 'copy.txt', 'D', 'gone.txt', ''].join('\0'),
    'utf8'
  );
  assert.deepEqual(parseCommitNameStatusZ(nameStatusBuf), [
    { status: 'A', path: 'added.txt', origPath: null },
    { status: 'R', path: 'new/中文 2.txt', origPath: 'old/中文.txt' },
    { status: 'C', path: 'copy.txt', origPath: 'src.txt' },
    { status: 'D', path: 'gone.txt', origPath: null },
  ]);
});
