import { createHash } from 'node:crypto';
import { AppError, ERROR_CODES } from './git-runner.mjs';

const SHA_PATTERN = /^[0-9a-f]{7,64}$/i;
const MAX_GRAPH_LIMIT = 2000;
const DEFAULT_GRAPH_LIMIT = 150;

function makeMockSha(seed) {
  return createHash('sha1').update(String(seed)).digest('hex');
}

function buildMockFileUri(worktreePath, relPath) {
  const cleanRoot = worktreePath.replaceAll('\\', '/').replace(/\/+$/, '');
  const cleanRel = relPath.replace(/^\/+/, '');
  const encodedRel = cleanRel.split('/').map((seg) => encodeURIComponent(seg)).join('/');
  return `file:///${cleanRoot}/${encodedRel}`;
}

function validateMockRelativePath(relPath) {
  if (typeof relPath !== 'string' || relPath.length === 0 || /[\x00-\x1f\x7f]/.test(relPath)) {
    throw new AppError(ERROR_CODES.INVALID_REQUEST, 'Relative path must be a non-empty valid string.');
  }
  if (relPath.startsWith('/') || relPath.startsWith('\\') || /^[A-Za-z]:/.test(relPath)) {
    throw new AppError(ERROR_CODES.OUT_OF_WORKTREE, 'Absolute paths are not allowed inside worktree scope.');
  }
  const segments = relPath.split(/[\\/]+/);
  const clean = [];
  for (const segment of segments) {
    if (!segment || segment === '.') {
      continue;
    }
    if (segment === '..') {
      throw new AppError(ERROR_CODES.OUT_OF_WORKTREE, 'Path traversal ("..") outside worktree is forbidden.');
    }
    clean.push(segment);
  }
  if (clean.length === 0) {
    throw new AppError(ERROR_CODES.INVALID_REQUEST, 'Relative path must target a file.');
  }
  return clean.join('/');
}

function createInitialMockRepositories() {
  const mainWorktree = 'D:/mock-workspace/antigravity-git-worktree';
  const mainCommonDir = `${mainWorktree}/.git`;

  const shaMerge = makeMockSha('mock-merge-head');
  const shaMainAhead = makeMockSha('mock-main-ahead');
  const shaFeat2 = makeMockSha('mock-feat-2');
  const shaFeat1 = makeMockSha('mock-feat-1');
  const shaOriginMain = makeMockSha('mock-origin-main');
  const shaRoot = makeMockSha('mock-root');

  const mainCommits = [
    {
      sha: shaMerge,
      shortSha: shaMerge.slice(0, 7),
      parents: [shaMainAhead, shaFeat2],
      refs: [
        { type: 'head', name: 'main', fullRef: 'refs/heads/main' },
      ],
      authorName: 'Lynn-zy',
      authorEmail: 'lynn@example.com',
      timestamp: 1795251200,
      subject: 'merge: integrate feat/svg-graph into main',
      scopeTags: ['auto', 'all'],
      body: '合并 SVG 动态拓扑车道与双语悬浮详情卡实现。\n\n- 泳道算法移植自 VS Code 的 `scmHistory.ts`\n- 详情卡按 **Markdown** 渲染提交说明',
      insertions: 336,
      deletions: 78,
      coAuthors: [{ name: 'Antigravity Bot', email: 'noreply@antigravity.dev' }],
      files: [
        { status: 'M', path: 'sidecars/panel/public/modules/graph-layout.js', origPath: null, existsInWorktree: true },
        { status: 'A', path: 'docs/使用说明.md', origPath: null, existsInWorktree: true },
      ],
    },
    {
      sha: shaMainAhead,
      shortSha: shaMainAhead.slice(0, 7),
      parents: [shaOriginMain],
      refs: [],
      authorName: 'Lynn-zy',
      authorEmail: 'lynn@example.com',
      timestamp: 1795247600,
      subject: 'feat(backend): add watcher storm circuit breaker',
      scopeTags: ['auto', 'all'],
      body: '加入 Windows 自毁守卫与 200 次/秒事件风暴熔断恢复机制。',
      insertions: 42,
      deletions: 7,
      coAuthors: [],
      files: [
        { status: 'M', path: 'sidecars/panel/backend/watcher.mjs', origPath: null, existsInWorktree: true },
      ],
    },
    {
      sha: shaFeat2,
      shortSha: shaFeat2.slice(0, 7),
      parents: [shaFeat1],
      refs: [
        { type: 'branch', name: 'feat/svg-graph', fullRef: 'refs/heads/feat/svg-graph' },
      ],
      authorName: 'Alice',
      authorEmail: 'alice@example.com',
      timestamp: 1795244000,
      subject: 'feat(ui): compute minimal-occlusion commit popover',
      scopeTags: ['auto', 'all'],
      body: '',
      coAuthors: [],
      files: [
        { status: 'R', path: 'sidecars/panel/public/modules/popover.js', origPath: 'prototype/popover-draft.js', existsInWorktree: true },
      ],
    },
    {
      sha: shaFeat1,
      shortSha: shaFeat1.slice(0, 7),
      parents: [shaOriginMain],
      refs: [],
      authorName: 'Alice',
      authorEmail: 'alice@example.com',
      timestamp: 1795240400,
      subject: 'feat(ui): render bilingual labels and relative timestamps',
      scopeTags: ['auto', 'all'],
      body: '',
      coAuthors: [],
      files: [
        { status: 'D', path: 'prototype/legacy-draft.html', origPath: null, existsInWorktree: false },
      ],
    },
    {
      sha: shaOriginMain,
      shortSha: shaOriginMain.slice(0, 7),
      parents: [shaRoot],
      refs: [
        { type: 'remote', name: 'origin/main', fullRef: 'refs/remotes/origin/main' },
        { type: 'tag', name: 'v0.1.0', fullRef: 'refs/tags/v0.1.0' },
      ],
      authorName: 'Lynn-zy',
      authorEmail: 'lynn@example.com',
      timestamp: 1795236800,
      subject: 'docs: finalize V1 architecture spec',
      scopeTags: ['auto', 'all'],
      body: '定稿 V1 规格文档与双模式 HTTP 契约。',
      coAuthors: [],
      files: [
        { status: 'M', path: 'docs/spec.md', origPath: null, existsInWorktree: true },
      ],
    },
    {
      sha: shaRoot,
      shortSha: shaRoot.slice(0, 7),
      parents: [],
      refs: [],
      authorName: 'Lynn-zy',
      authorEmail: 'lynn@example.com',
      timestamp: 1795233200,
      subject: 'chore: initialize repository',
      scopeTags: ['auto', 'all'],
      body: '',
      coAuthors: [],
      files: [
        { status: 'A', path: 'README.md', origPath: null, existsInWorktree: true },
      ],
    },
  ];

  // 为 all 范围追加一条仅在其它分支出现的提交，体现 Auto / All 切换差异
  const shaSideBranch = makeMockSha('mock-side-experiment');
  const sideBranchCommit = {
    sha: shaSideBranch,
    shortSha: shaSideBranch.slice(0, 7),
    parents: [shaOriginMain],
    refs: [
      { type: 'branch', name: 'chore/docs-cleanup', fullRef: 'refs/heads/chore/docs-cleanup' },
    ],
    authorName: 'Bob',
    authorEmail: 'bob@example.com',
    timestamp: 1795249000,
    subject: 'docs: polish glossary examples on side branch',
    scopeTags: ['all'],
    body: '独立分支上的术语表校对提交，仅在「全部」视图中可见。',
    coAuthors: [],
    files: [
      { status: 'M', path: 'GLOSSARY.md', origPath: null, existsInWorktree: true },
    ],
  };

  const repoMain = {
    id: 'd:/mock-workspace/antigravity-git-worktree/.git',
    name: 'antigravity-git-worktree',
    gitCommonDir: mainCommonDir,
    gitDir: mainCommonDir,
    worktreePath: mainWorktree,
    isBare: false,
    isUnborn: false,
    isDetached: false,
    headOid: shaMerge,
    branch: 'main',
    upstream: 'origin/main',
    ahead: 2,
    behind: 0,
    remotes: ['origin'],
    changes: {
      conflicted: [],
      staged: [
        {
          path: 'docs/使用说明.md',
          origPath: null,
          status: 'M',
          fileUri: buildMockFileUri(mainWorktree, 'docs/使用说明.md'),
        },
        {
          path: 'src/组件/中文面板.js',
          origPath: null,
          status: 'M',
          fileUri: buildMockFileUri(mainWorktree, 'src/组件/中文面板.js'),
        },
      ],
      unstaged: [
        {
          path: 'src/组件/中文面板.js',
          origPath: null,
          status: 'M',
          untracked: false,
          fileUri: buildMockFileUri(mainWorktree, 'src/组件/中文面板.js'),
        },
        {
          path: 'README.md',
          origPath: null,
          status: 'M',
          untracked: false,
          fileUri: buildMockFileUri(mainWorktree, 'README.md'),
        },
        {
          path: '临时草稿/新建笔记.txt',
          origPath: null,
          status: 'U',
          untracked: true,
          fileUri: buildMockFileUri(mainWorktree, '临时草稿/新建笔记.txt'),
        },
      ],
    },
    commits: [sideBranchCommit, ...mainCommits],
  };

  const docsWorktree = 'D:/mock-workspace/docs-portal';
  const docsHeadSha = makeMockSha('mock-docs-head');
  const docsUpstreamSha = makeMockSha('mock-docs-upstream');

  const repoDocs = {
    id: 'd:/mock-workspace/docs-portal/.git',
    name: 'docs-portal',
    gitCommonDir: `${docsWorktree}/.git`,
    gitDir: `${docsWorktree}/.git`,
    worktreePath: docsWorktree,
    isBare: false,
    isUnborn: false,
    isDetached: false,
    headOid: docsHeadSha,
    branch: 'main',
    upstream: 'origin/main',
    ahead: 0,
    behind: 1,
    remotes: ['origin'],
    changes: {
      conflicted: [],
      staged: [],
      unstaged: [],
    },
    commits: [
      {
        sha: docsUpstreamSha,
        shortSha: docsUpstreamSha.slice(0, 7),
        parents: [docsHeadSha],
        refs: [{ type: 'remote', name: 'origin/main', fullRef: 'refs/remotes/origin/main' }],
        authorName: 'CI Bot',
        authorEmail: 'ci@example.com',
        timestamp: 1795250800,
        subject: 'docs: sync upstream changelog',
        scopeTags: ['auto', 'all'],
        body: '',
        coAuthors: [],
        files: [{ status: 'M', path: 'CHANGELOG.md', origPath: null, existsInWorktree: true }],
      },
      {
        sha: docsHeadSha,
        shortSha: docsHeadSha.slice(0, 7),
        parents: [],
        refs: [{ type: 'head', name: 'main', fullRef: 'refs/heads/main' }],
        authorName: 'Lynn-zy',
        authorEmail: 'lynn@example.com',
        timestamp: 1795240000,
        subject: 'docs: initialize portal pages',
        scopeTags: ['auto', 'all'],
        body: '',
        coAuthors: [],
        files: [{ status: 'A', path: 'index.md', origPath: null, existsInWorktree: true }],
      },
    ],
  };

  return [repoMain, repoDocs];
}

/**
 * 创建隔离的内存离线 Mock 演示状态机，供 `?fixture=mock` 与 `AG_GIT_FIXTURE=mock` 驱动无仓演示与回归测试。
 * 支持多分支 Merge、中文路径、`MM` 双态、未跟踪、领先/落后上游计数，以及内存内全链路写操作流转。
 *
 * @param {{ eventBus?: import('./event-bus.mjs').EventBus }} [options] 可选共享事件总线
 * @returns {{
 *   reset: () => void,
 *   getSnapshot: (params?: object, preferences?: object) => object,
 *   getCommitDetail: (params: object) => object,
 *   getCommitStats: (params: object) => { files: number, insertions: number, deletions: number },
 *   stage: (params: object) => { revision: number },
 *   unstage: (params: object) => { revision: number },
 *   discard: (params: object) => { revision: number },
 *   commit: (params: object) => { revision: number, sha: string },
 *   fetch: (params: object) => { revision: number },
 *   pull: (params: object) => { revision: number },
 *   push: (params: object) => { revision: number }
 * }} Mock 夹具控制器
 */
export function createMockFixtureStore(options = {}) {
  let repositories = createInitialMockRepositories();
  let localRevision = 1;
  let commitCounter = 0;

  const bump = () => {
    if (options.eventBus) {
      return options.eventBus.bumpRevision().revision;
    }
    localRevision += 1;
    return localRevision;
  };

  const currentRevision = () => (options.eventBus ? options.eventBus.revision : localRevision);

  const findRepoByWorktreeOrId = (worktreePath, repoId) => {
    const normalizedWt = typeof worktreePath === 'string'
      ? worktreePath.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
      : null;
    const hit = repositories.find((repo) => {
      if (repoId && repo.id === repoId) {
        return true;
      }
      if (normalizedWt && repo.worktreePath) {
        return repo.worktreePath.toLowerCase() === normalizedWt;
      }
      return false;
    });
    if (!hit) {
      throw new AppError(ERROR_CODES.NO_REPOSITORY, 'Mock repository not found for given worktreePath.');
    }
    return hit;
  };

  const reset = () => {
    repositories = createInitialMockRepositories();
    commitCounter = 0;
  };

  const getSnapshot = (params = {}, preferences = { locale: 'auto', graphScope: 'auto', splitRatio: 0.42 }) => {
    const selectedRepoId = params.selectedRepoId ?? null;
    const rawScope = params.graphScope ?? preferences.graphScope ?? 'auto';
    if (rawScope !== 'auto' && rawScope !== 'all') {
      throw new AppError(ERROR_CODES.INVALID_REQUEST, `Invalid graphScope: ${rawScope}`);
    }
    const rawLimit = params.graphLimit ?? DEFAULT_GRAPH_LIMIT;
    if (typeof rawLimit !== 'number' || !Number.isFinite(rawLimit) || rawLimit < 1) {
      throw new AppError(ERROR_CODES.INVALID_REQUEST, `Invalid graphLimit: ${rawLimit}`);
    }
    const limit = Math.min(Math.trunc(rawLimit), MAX_GRAPH_LIMIT);

    const active = (selectedRepoId ? repositories.find((r) => r.id === selectedRepoId) : null) ?? repositories[0];
    const filteredCommits = active.commits.filter((c) => c.scopeTags.includes(rawScope));
    const hasMore = filteredCommits.length > limit;
    const slicedCommits = filteredCommits.slice(0, limit).map((c) => ({
      sha: c.sha,
      shortSha: c.shortSha,
      parents: [...c.parents],
      refs: c.refs.map((r) => ({ ...r })),
      authorName: c.authorName,
      authorEmail: c.authorEmail,
      timestamp: c.timestamp,
      subject: c.subject,
    }));

    const workspaceKey = createHash('sha256')
      .update(`${active.id}\0${(active.worktreePath ?? '').toLowerCase()}`)
      .digest('hex');

    return {
      workspaceKey,
      revision: currentRevision(),
      repositories: repositories.map((r) => ({
        id: r.id,
        name: r.name,
        worktreePath: r.worktreePath,
        branch: r.branch,
        isBare: r.isBare,
      })),
      activeRepo: {
        id: active.id,
        name: active.name,
        gitCommonDir: active.gitCommonDir,
        gitDir: active.gitDir,
        worktreePath: active.worktreePath,
        isBare: active.isBare,
        isUnborn: active.isUnborn,
        isDetached: active.isDetached,
        headOid: active.headOid,
        branch: active.branch,
        upstream: active.upstream,
        ahead: active.ahead,
        behind: active.behind,
        remotes: [...active.remotes],
      },
      changes: {
        conflicted: active.changes.conflicted.map((item) => ({ ...item })),
        staged: active.changes.staged.map((item) => ({ ...item })),
        unstaged: active.changes.unstaged.map((item) => ({ ...item })),
        truncated: false,
      },
      graph: {
        scope: rawScope,
        limit,
        hasMore,
        reachedSoftLimit: limit >= MAX_GRAPH_LIMIT,
        commits: slicedCommits,
      },
      watchState: {
        active: true,
        degraded: false,
        reason: null,
      },
      preferences,
    };
  };

  const findMockCommit = (params) => {
    const sha = params.sha;
    if (typeof sha !== 'string' || !SHA_PATTERN.test(sha)) {
      throw new AppError(ERROR_CODES.INVALID_REQUEST, 'Invalid commit SHA.');
    }
    const repo = findRepoByWorktreeOrId(params.worktreePath, params.repoId);
    const target = repo.commits.find((c) => c.sha === sha || c.sha.startsWith(sha));
    if (!target) {
      throw new AppError(ERROR_CODES.GIT_ERROR, `Commit "${sha}" not found in mock fixture.`);
    }
    return { repo, target };
  };

  const getCommitStats = (params = {}) => {
    const { target } = findMockCommit(params);
    return { files: target.files.length, insertions: target.insertions ?? 0, deletions: target.deletions ?? 0 };
  };

  const getCommitDetail = (params = {}) => {
    const { repo, target } = findMockCommit(params);
    return {
      sha: target.sha,
      subject: target.subject,
      body: target.body,
      coAuthors: target.coAuthors.map((item) => ({ ...item })),
      files: target.files.map((item) => {
        const canBuildFileUri = Boolean(repo.worktreePath) && !repo.isBare && item.existsInWorktree;
        return {
          status: item.status,
          path: item.path,
          origPath: item.origPath,
          existsInWorktree: canBuildFileUri,
          fileUri: canBuildFileUri ? buildMockFileUri(repo.worktreePath, item.path) : null,
        };
      }),
    };
  };

  const stage = (params = {}) => {
    const repo = findRepoByWorktreeOrId(params.worktreePath);
    const all = Boolean(params.all);
    const targets = all
      ? repo.changes.unstaged.map((item) => item.path)
      : (() => {
          if (!Array.isArray(params.paths) || params.paths.length === 0) {
            throw new AppError(ERROR_CODES.INVALID_REQUEST, 'paths must be a non-empty array.');
          }
          return params.paths.map(validateMockRelativePath);
        })();

    const targetSet = new Set(targets);
    const remainingUnstaged = [];
    for (const item of repo.changes.unstaged) {
      if (!targetSet.has(item.path)) {
        remainingUnstaged.push(item);
        continue;
      }
      if (!repo.changes.staged.some((s) => s.path === item.path)) {
        repo.changes.staged.push({
          path: item.path,
          origPath: item.origPath,
          status: item.untracked ? 'A' : item.status,
          fileUri: item.fileUri,
        });
      }
    }
    repo.changes.unstaged = remainingUnstaged;
    return { revision: bump() };
  };

  const unstage = (params = {}) => {
    const repo = findRepoByWorktreeOrId(params.worktreePath);
    const all = Boolean(params.all);
    const targets = all
      ? repo.changes.staged.map((item) => item.path)
      : (() => {
          if (!Array.isArray(params.paths) || params.paths.length === 0) {
            throw new AppError(ERROR_CODES.INVALID_REQUEST, 'paths must be a non-empty array.');
          }
          return params.paths.map(validateMockRelativePath);
        })();

    const targetSet = new Set(targets);
    const remainingStaged = [];
    for (const item of repo.changes.staged) {
      if (!targetSet.has(item.path)) {
        remainingStaged.push(item);
        continue;
      }
      if (!repo.changes.unstaged.some((u) => u.path === item.path)) {
        repo.changes.unstaged.push({
          path: item.path,
          origPath: null,
          status: item.status === 'A' ? 'U' : item.status,
          untracked: item.status === 'A',
          fileUri: item.fileUri,
        });
      }
    }
    repo.changes.staged = remainingStaged;
    return { revision: bump() };
  };

  const discard = (params = {}) => {
    const repo = findRepoByWorktreeOrId(params.worktreePath);
    const allTracked = Boolean(params.allTracked);
    const untracked = Boolean(params.untracked);

    if (allTracked && untracked) {
      throw new AppError(ERROR_CODES.INVALID_REQUEST, 'allTracked and untracked cannot both be true.');
    }

    if (untracked) {
      if (!Array.isArray(params.paths) || params.paths.length !== 1) {
        throw new AppError(ERROR_CODES.INVALID_REQUEST, 'Deleting an untracked file requires paths.length === 1.');
      }
      const targetPath = validateMockRelativePath(params.paths[0]);
      const index = repo.changes.unstaged.findIndex((item) => item.untracked && item.path === targetPath);
      if (index === -1) {
        throw new AppError(ERROR_CODES.INVALID_REQUEST, `Target "${targetPath}" is not untracked.`);
      }
      repo.changes.unstaged.splice(index, 1);
      return { revision: bump() };
    }

    if (allTracked) {
      if (repo.changes.conflicted.length > 0) {
        throw new AppError(ERROR_CODES.CONFLICT_BLOCKED, 'Conflicted files prevent discard.');
      }
      repo.changes.unstaged = repo.changes.unstaged.filter((item) => item.untracked);
      return { revision: bump() };
    }

    if (!Array.isArray(params.paths) || params.paths.length === 0) {
      throw new AppError(ERROR_CODES.INVALID_REQUEST, 'paths must be a non-empty array.');
    }
    const targets = new Set(params.paths.map(validateMockRelativePath));
    for (const p of targets) {
      if (repo.changes.conflicted.some((c) => c.path === p)) {
        throw new AppError(ERROR_CODES.CONFLICT_BLOCKED, `File "${p}" is conflicted.`);
      }
    }
    repo.changes.unstaged = repo.changes.unstaged.filter(
      (item) => item.untracked || !targets.has(item.path),
    );
    return { revision: bump() };
  };

  const commit = (params = {}) => {
    const repo = findRepoByWorktreeOrId(params.worktreePath);
    const message = params.message;
    const autoStageAll = Boolean(params.autoStageAll);

    if (typeof message !== 'string') {
      throw new AppError(ERROR_CODES.INVALID_REQUEST, 'Commit message must be a string.');
    }
    if (message.trim().length === 0) {
      throw new AppError(ERROR_CODES.EMPTY_COMMIT_MESSAGE, '提交说明不能为空。');
    }
    if (repo.changes.conflicted.length > 0) {
      throw new AppError(ERROR_CODES.CONFLICT_BLOCKED, '存在未解决冲突，无法提交。');
    }

    if (autoStageAll) {
      if (repo.changes.staged.length === 0 && repo.changes.unstaged.length === 0) {
        throw new AppError(ERROR_CODES.NOTHING_TO_COMMIT, '没有可提交的更改。');
      }
      stage({ worktreePath: repo.worktreePath, all: true });
    } else if (repo.changes.staged.length === 0) {
      throw new AppError(ERROR_CODES.NOTHING_TO_COMMIT, '暂存区为空。');
    }

    commitCounter += 1;
    const newSha = makeMockSha(`mock-new-commit-${commitCounter}-${message}`);
    const lines = message.replaceAll('\r\n', '\n').split('\n');
    const subject = lines[0].trim();
    const body = lines.slice(1).join('\n').trim();

    for (const existing of repo.commits) {
      existing.refs = existing.refs.filter((r) => r.type !== 'head');
    }

    const committedFiles = repo.changes.staged.map((item) => ({
      status: item.status,
      path: item.path,
      origPath: item.origPath,
      existsInWorktree: item.status !== 'D',
    }));

    const newCommit = {
      sha: newSha,
      shortSha: newSha.slice(0, 7),
      parents: repo.headOid ? [repo.headOid] : [],
      refs: [{ type: 'head', name: repo.branch ?? 'HEAD', fullRef: repo.branch ? `refs/heads/${repo.branch}` : 'HEAD' }],
      authorName: 'Developer',
      authorEmail: 'dev@example.com',
      timestamp: 1795251200 + commitCounter * 60,
      subject,
      scopeTags: ['auto', 'all'],
      body,
      coAuthors: [],
      files: committedFiles,
    };

    repo.commits.unshift(newCommit);
    repo.headOid = newSha;
    repo.isUnborn = false;
    repo.changes.staged = [];
    if (repo.upstream) {
      repo.ahead += 1;
    }

    return {
      revision: bump(),
      sha: newSha,
    };
  };

  const fetch = (params = {}) => {
    const repo = findRepoByWorktreeOrId(params.worktreePath, params.repoId);
    if (repo.remotes.length === 0) {
      throw new AppError(ERROR_CODES.NO_REMOTE, 'No remote configured.');
    }
    return { revision: bump() };
  };

  const pull = (params = {}) => {
    const repo = findRepoByWorktreeOrId(params.worktreePath);
    if (repo.remotes.length === 0) {
      throw new AppError(ERROR_CODES.NO_REMOTE, 'No remote configured.');
    }
    if (repo.isUnborn || repo.isDetached || !repo.upstream) {
      throw new AppError(ERROR_CODES.INVALID_REQUEST, 'Branch cannot pull without upstream.');
    }
    if (repo.ahead > 0 && repo.behind > 0) {
      throw new AppError(ERROR_CODES.NON_FAST_FORWARD, 'Cannot fast-forward diverged mock branch.');
    }
    if (repo.behind > 0) {
      const upstreamRefName = repo.upstream;
      const upstreamCommit = repo.commits.find((c) =>
        c.refs.some((r) => r.type === 'remote' && r.name === upstreamRefName),
      );
      if (upstreamCommit) {
        for (const existing of repo.commits) {
          existing.refs = existing.refs.filter((r) => r.type !== 'head');
        }
        upstreamCommit.refs.unshift({
          type: 'head',
          name: repo.branch,
          fullRef: `refs/heads/${repo.branch}`,
        });
        repo.headOid = upstreamCommit.sha;
      }
      repo.behind = 0;
    }
    return { revision: bump() };
  };

  const push = (params = {}) => {
    if (params.force || params.forceWithLease) {
      throw new AppError(ERROR_CODES.INVALID_REQUEST, 'Force push is disabled.');
    }
    const repo = findRepoByWorktreeOrId(params.worktreePath);
    if (repo.remotes.length === 0) {
      throw new AppError(ERROR_CODES.NO_REMOTE, 'No remote configured.');
    }
    if (repo.isUnborn || repo.isDetached || !repo.branch) {
      throw new AppError(ERROR_CODES.INVALID_REQUEST, 'Cannot push unborn or detached HEAD.');
    }

    const remoteName = repo.upstream
      ? repo.upstream.split('/')[0]
      : params.remote;

    if (!remoteName || !repo.remotes.includes(remoteName)) {
      throw new AppError(ERROR_CODES.INVALID_REQUEST, 'Valid remote is required to publish branch.');
    }

    if (!repo.upstream) {
      repo.upstream = `${remoteName}/${repo.branch}`;
    }

    const remoteFullName = `${remoteName}/${repo.branch}`;
    for (const c of repo.commits) {
      c.refs = c.refs.filter((r) => !(r.type === 'remote' && r.name === remoteFullName));
    }
    const headCommit = repo.commits.find((c) => c.sha === repo.headOid);
    if (headCommit) {
      headCommit.refs.push({
        type: 'remote',
        name: remoteFullName,
        fullRef: `refs/remotes/${remoteFullName}`,
      });
    }
    repo.ahead = 0;
    return { revision: bump() };
  };

  return {
    reset,
    getSnapshot,
    getCommitDetail,
    getCommitStats,
    stage,
    unstage,
    discard,
    commit,
    fetch,
    pull,
    push,
  };
}
