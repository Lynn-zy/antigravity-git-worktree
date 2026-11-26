import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  createWorktreePathResolver,
  discoverRepositories,
  isPathInside,
  normalizeFsPath,
  normalizeWorkspaceUri,
  probeWorkspaceGitRoot,
  toFileUri,
  toPathKey,
} from '../../sidecars/panel/backend/discovery.mjs';
import {
  parseCommitMessageB,
  parseCommitNameStatusZ,
  parseCommitNumstatZ,
  parseLogRecordsZ,
  queryCommitDetail,
  createStatusParser,
  MAX_STATUS_ENTRIES,
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

test('createWorktreePathResolver 拒绝空字节、控制字符、绝对路径、.. 与符号链接逃逸，并报告目标是否存在', (t) => {
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

  // 同一个解析器贯穿整个用例：先校验过的目录被缓存，不能掩盖之后才出现的逃逸目录
  const resolvePath = createWorktreePathResolver(worktreeDir);
  const valid = resolvePath('src/中文 文件.txt');
  assert.equal(valid.relativePath, 'src/中文 文件.txt');
  assert.equal(valid.fileUri, toFileUri(valid.fullPath));
  assert.equal(valid.exists, true);

  const validDash = resolvePath('-weird.txt');
  assert.equal(validDash.relativePath, '-weird.txt');
  assert.equal(validDash.exists, false);
  assert.equal(resolvePath('src/deleted/gone.txt').exists, false);

  assert.throws(
    () => resolvePath(''),
    (err) => err instanceof AppError && err.code === ERROR_CODES.INVALID_REQUEST
  );
  assert.throws(
    () => resolvePath('a\0b.txt'),
    (err) => err instanceof AppError && err.code === ERROR_CODES.INVALID_REQUEST
  );
  assert.throws(
    () => resolvePath('a\nb.txt'),
    (err) => err instanceof AppError && err.code === ERROR_CODES.INVALID_REQUEST
  );
  assert.throws(
    () => resolvePath('.'),
    (err) => err instanceof AppError && err.code === ERROR_CODES.INVALID_REQUEST
  );

  for (const escapePath of ['../outside/secret.txt', 'src/../../outside/secret.txt', '/etc/passwd', 'C:\\Windows\\win.ini', 'D:relative.txt', '\\\\server\\share\\x']) {
    assert.throws(
      () => resolvePath(escapePath),
      (err) => err instanceof AppError && err.code === ERROR_CODES.OUT_OF_WORKTREE,
      `Expected OUT_OF_WORKTREE for ${escapePath}`
    );
  }

  // escape-dir 此刻还不存在，解析它下面的路径不能把它记成已校验，否则之后建成外部链接也会被放行
  assert.equal(resolvePath('escape-dir/probe.txt').exists, false);
  const symlinkType = process.platform === 'win32' ? 'junction' : 'dir';
  fs.symlinkSync(outsideDir, path.join(worktreeDir, 'escape-dir'), symlinkType);

  assert.throws(
    () => resolvePath('escape-dir/secret.txt'),
    (err) => err instanceof AppError && err.code === ERROR_CODES.OUT_OF_WORKTREE
  );
  assert.throws(
    () => resolvePath('escape-dir/nonexistent-deep/file.txt'),
    (err) => err instanceof AppError && err.code === ERROR_CODES.OUT_OF_WORKTREE
  );
  assert.throws(
    () => resolvePath('escape-dir'),
    (err) => err instanceof AppError && err.code === ERROR_CODES.OUT_OF_WORKTREE,
    '指向 Worktree 外的符号链接本身也要拒绝'
  );

  // 指向外部的链接即使目标已删除（悬空），无论作为文件本身还是中间目录都要拒绝
  const goneOutside = path.join(sandbox, 'gone-outside');
  fs.mkdirSync(goneOutside);
  fs.symlinkSync(goneOutside, path.join(worktreeDir, 'dangling-out'), symlinkType);
  fs.rmSync(goneOutside, { recursive: true });
  for (const danglingPath of ['dangling-out', 'dangling-out/file.txt']) {
    assert.throws(
      () => resolvePath(danglingPath),
      (err) => err instanceof AppError && err.code === ERROR_CODES.OUT_OF_WORKTREE,
      `Expected OUT_OF_WORKTREE for ${danglingPath}`
    );
  }

  // 指向 Worktree 内的链接放行；目标被删除后成为悬空链接，按不存在处理
  const innerTarget = path.join(worktreeDir, 'inner-target');
  fs.mkdirSync(innerTarget);
  fs.symlinkSync(innerTarget, path.join(worktreeDir, 'inner-link'), symlinkType);
  assert.equal(resolvePath('inner-link').exists, true);
  fs.rmSync(innerTarget, { recursive: true });
  assert.equal(resolvePath('inner-link').exists, false);
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

const parseStatusChunks = (chunks, options) => {
  const parser = createStatusParser(options);
  for (const chunk of chunks) {
    if (parser.push(chunk)) break;
  }
  return parser.finish();
};

const STATUS_SAMPLE = Buffer.from(
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

test('createStatusParser 区分重命名顺序、MM 双态、空格路径、unborn 与冲突', () => {
  const parsed = parseStatusChunks([STATUS_SAMPLE]);
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
});

test('createStatusParser 分块喂入时与整块解析结果一致（任意切分点，含重命名双 token 与中文多字节跨块）', () => {
  const whole = parseStatusChunks([STATUS_SAMPLE]);
  for (let cut = 1; cut < STATUS_SAMPLE.length; cut += 1) {
    const chunked = parseStatusChunks([STATUS_SAMPLE.subarray(0, cut), STATUS_SAMPLE.subarray(cut)]);
    assert.deepEqual(chunked, whole, `split at byte ${cut}`);
  }
  const byteByByte = parseStatusChunks(Array.from(STATUS_SAMPLE, (byte) => Buffer.from([byte])));
  assert.deepEqual(byteByByte, whole);
});

test('createStatusParser 由 Worktree 根目录直接拼出 file URI：指向 Worktree 外的链接也可打开，未跟踪目录不带末尾斜杠', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm1-status-uri-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'm1-status-uri-outside-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  // Windows 上 junction 不需要管理员权限；POSIX 上这个参数被忽略，建的是目录符号链接
  fs.symlinkSync(outside, path.join(root, 'ext'), 'junction');
  const realRoot = fs.realpathSync.native(root);

  const { changes } = parseStatusChunks(
    [Buffer.from([
      '? ext',
      '? 中文 目录/新 文件.txt',
      '? newdir/',
      '1 .M N... 100644 100644 100644 abc def src/改动.js',
      '2 R. N... 100644 100644 100644 abc def R100 docs/新名.md',
      'docs/旧名.md',
      'u UU N... 100644 100644 100644 100644 h1 h2 h3 冲突.txt',
      '',
    ].join('\0'), 'utf8')],
    { worktreePath: root },
  );
  const expectedUri = (...segments) => pathToFileURL(path.join(realRoot, ...segments)).href;
  const uriOf = (group, relPath) => changes[group].find((item) => item.path === relPath)?.fileUri;
  assert.equal(uriOf('unstaged', 'ext'), expectedUri('ext'), '指向 Worktree 外的链接照常给出 URI');
  assert.equal(uriOf('unstaged', '中文 目录/新 文件.txt'), expectedUri('中文 目录', '新 文件.txt'));
  assert.equal(uriOf('unstaged', 'newdir/'), expectedUri('newdir'));
  assert.equal(uriOf('unstaged', 'src/改动.js'), expectedUri('src', '改动.js'));
  assert.equal(uriOf('staged', 'docs/新名.md'), expectedUri('docs', '新名.md'), '重命名指向新路径');
  assert.equal(uriOf('conflicted', '冲突.txt'), expectedUri('冲突.txt'));
});

test('createStatusParser 默认上限 5000 条，超出后只保留前 5000 条并通知调用方停止', () => {
  assert.equal(MAX_STATUS_ENTRIES, 5_000);
  const untrackedLines = (count) => Buffer.from(
    Array.from({ length: count }, (_, i) => `? f-${i}.txt`).join('\0') + '\0',
    'utf8'
  );

  const exactLimit = parseStatusChunks([untrackedLines(5_000)]);
  assert.equal(exactLimit.changes.truncated, false);
  assert.equal(exactLimit.changes.unstaged.length, 5_000);

  const parser = createStatusParser();
  assert.equal(parser.push(untrackedLines(5_001)), true, '超过上限的那一块必须返回 true，供调用方结束 git 进程');
  assert.equal(parser.push(untrackedLines(5)), true, '超限后继续喂入也只返回 true，不再追加');
  const overLimit = parser.finish();
  assert.equal(overLimit.changes.truncated, true);
  assert.equal(overLimit.changes.unstaged.length, 5_000);
  assert.equal(overLimit.changes.unstaged.at(-1).path, 'f-4999.txt');

  const customLimit = parseStatusChunks([untrackedLines(3)], { maxEntries: 2 });
  assert.equal(customLimit.changes.truncated, true);
  assert.deepEqual(customLimit.changes.unstaged.map((item) => item.path), ['f-0.txt', 'f-1.txt']);
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

test('parseCommitNumstatZ 汇总文件数与增删行数：重命名路径不计为文件，二进制文件只计文件数', () => {
  assert.deepEqual(parseCommitNumstatZ(Buffer.alloc(0)), { files: 0, insertions: 0, deletions: 0 });
  // 路径故意写成形如统计行的「7\t7\tx」，若重命名后的两个路径 token 未被跳过就会多算一个文件
  const numstatBuf = Buffer.from(
    ['12\t3\tsrc/app.js', '0\t0\t', 'old/中文.txt', '7\t7\tx', '-\t-\tassets/logo.png', '5\t0\tdocs/新 文件.md', ''].join('\0'),
    'utf8',
  );
  assert.deepEqual(parseCommitNumstatZ(numstatBuf), { files: 4, insertions: 17, deletions: 3 });
});

test('queryCommitDetail：文件列表不等改动统计，不运行比 name-status 慢数倍的 numstat', async () => {
  const gitCommands = [];
  const fakeRead = async (args) => {
    gitCommands.push(args);
    if (args.includes('--name-status')) return { stdout: Buffer.from('M\0src/app.js\0', 'utf8') };
    return { stdout: Buffer.from('fix: 修复\n\n正文\n', 'utf8') };
  };

  const detail = await queryCommitDetail('/repo', 'abcdef1234567', { isBare: true, runGitRead: fakeRead });
  assert.equal(detail.subject, 'fix: 修复');
  assert.deepEqual(detail.files.map((file) => file.path), ['src/app.js']);
  assert.deepEqual(gitCommands.filter((args) => args.includes('--numstat')), []);
});
