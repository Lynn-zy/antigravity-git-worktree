/**
 * Antigravity Git Graph 面板双语国际化词典与时间格式化纯函数模块。
 * 完整覆盖架构规格第 4.3、5.1 与 7.1–7.6 节的全部界面文案与错误码提示。
 */

/** @type {readonly ['zh-CN', 'en']} 面板支持的界面语言列表 */
export const SUPPORTED_LOCALES = Object.freeze(['zh-CN', 'en']);

/** @type {Readonly<Record<'zh-CN' | 'en', Readonly<Record<string, string>>>>} 中英双语完整词典 */
export const MESSAGES = Object.freeze({
  'zh-CN': Object.freeze({
    // 面板空态与存储库列表
    'loading.repository': '正在加载 Git 仓库…',
    'error.bootFailed': '面板初始化失败',
    'empty.noRepo.title': '当前工作区未发现 Git 仓库',
    'empty.noRepo.description': '请在 Antigravity 中打开包含 Git 仓库的本地目录后自动同步。',
    'repo.switcherAria': '选择要查看的 Git 仓库',
    'repo.currentBranch': '当前分支：{branch}',
    'repo.bareLabel': '裸仓库',

    // 特殊仓库与监听状态横幅
    'watch.tooManyChangesBanner': '变更超过 {count} 条，只显示前 {count} 条；文件改动的自动刷新已放慢',
    'watch.errorBanner': '文件监听出错，已暂停自动刷新，请手动刷新',
    'repo.detachedBanner': '当前处于游离 HEAD（Detached HEAD）状态：可正常提交，但无法直接推送或拉取。',
    'repo.bareNotice': '裸仓库不支持工作区修改，可在下方浏览提交图表或执行提取（Fetch）。',
    'repo.unbornNotice': '当前分支尚无任何提交记录，完成首次提交后将生成提交图表。',
    'changes.conflictBanner': '存在 {count} 个未解决合并冲突，请先在编辑器中解决并暂存后再提交。',

    // 区域标题与分隔条
    'section.repositories': '存储库',
    'section.changes': '更改',
    'section.graph': '图表',
    'section.collapse': '折叠 {section}',
    'section.expand': '展开 {section}',
    'section.resizeSash': '拖动调整上下区域高度',

    // 上区：Commit 草稿、校验与智能主按钮
    'commit.placeholder': '消息({shortcut} 提交)',
    'commit.placeholderWithBranch': '消息({shortcut} 在“{branch}”提交)',
    'commit.inputAria': '提交说明输入框',
    'commit.emptyMessageError': '请先输入提交说明',
    'primary.conflictBlocked': '存在冲突，请先解决',
    'primary.conflictBlockedTitle': '工作区存在未解决的合并冲突，解决前禁止提交',
    'primary.commit': '提交',
    'primary.commitTitle': '提交已暂存更改（Ctrl/Cmd+Enter）',
    'primary.commitUnstagedTitle': '当前无已暂存更改，点击可选择自动暂存全部并提交',
    'primary.commitCleanDisabledTitle': '工作区没有待提交或待同步的更改',
    'primary.committing': '正在提交更改...',
    'primary.publishBranch': '发布分支',
    'primary.publishBranchWithName': '发布分支 ({branch})',
    'primary.publishBranchTitle': '将本地分支 {branch} 发布并关联上游远端',
    'primary.publishing': '正在发布分支…',
    'primary.syncChanges': '同步更改',

    // 同步状态悬停提示（文案沿用 VS Code 简体中文语言包）
    'sync.title': '同步更改',
    'sync.syncing': '正在同步更改...',
    'sync.pullTitle': '从 {upstream} 拉取 {count} 个提交',
    'sync.pushTitle': '将 {count} 个提交推送到 {upstream}',
    'sync.pullPushTitle': '在 {upstream} 之间拉取 {behind} 个提交并推送 {ahead} 个提交',

    // 上区：变更文件分组与行操作
    'changes.conflictedGroup': '合并冲突',
    'changes.stagedGroup': '暂存的更改',
    'changes.unstagedGroup': '更改',
    'action.openFile': '打开文件',
    'action.stage': '暂存更改',
    'action.stageAll': '全部暂存',
    'action.unstage': '取消暂存',
    'action.unstageAll': '全部取消暂存',
    'action.discard': '放弃更改',
    'action.discardAll': '全部放弃更改',
    'action.deleteUntracked': '永久删除未跟踪文件',
    'status.M': '已修改',
    'status.A': '已新增',
    'status.D': '已删除',
    'status.R': '已重命名',
    'status.C': '已复制',
    'status.U': '未跟踪',
    'status.conflicted': '冲突',

    // 上区：全部确认弹窗
    'modal.cancel': '取消',
    'modal.autoStageCommit.title': '没有要提交的暂存更改',
    'modal.autoStageCommit.body': '没有要提交的暂存更改。是否自动暂存全部 {count} 个更改并直接提交？',
    'modal.autoStageCommit.confirm': '暂存全部并提交',
    'modal.chooseRemote.title': '选择发布目标远端',
    'modal.chooseRemote.body': '当前仓库配置了多个远端，请选择分支 {branch} 要发布到的目标远端：',
    'modal.chooseRemote.confirm': '发布分支',
    'modal.discardFile.title': '放弃更改',
    'modal.discardFile.body': '确定要放弃工作区文件「{path}」的未暂存修改吗？此操作无法撤销。',
    'modal.discardFile.confirm': '放弃更改',
    'modal.deleteUntracked.title': '永久删除未跟踪文件',
    'modal.deleteUntracked.body': '高危操作：将从磁盘永久删除未跟踪文件「{path}」，删除后无法恢复！',
    'modal.deleteUntracked.confirm': '永久删除',
    'modal.discardAll.title': '全部放弃更改',
    'modal.discardAll.body': '确定要还原全部 {count} 个已跟踪文件的未暂存修改吗？此操作不会删除未跟踪文件，但已跟踪修改将无法恢复。',
    'modal.discardAll.confirm': '全部放弃',

    // 下区：图表顶栏、⋯ 菜单、本地搜索与分页
    'graph.scopeAuto': '自动',
    'graph.scopeAll': '全部',
    'graph.scopeToggleTitle': '切换分支显示范围：自动（当前分支及上游） / 全部（所有分支与标签）',
    'graph.action.fetch': '提取',
    'graph.action.fetchTitle': '提取所有远端引用并清理已删除分支（git fetch --all --prune）',
    'graph.action.pull': '拉取',
    'graph.action.pullTitle': '快进拉取上游更改（git pull --ff-only）',
    'graph.action.push': '推送',
    'graph.action.pushTitle': '推送本地提交到上游远端（git push）',
    'graph.action.publishTitle': '发布当前分支到远端并设置上游（git push -u）',
    'graph.action.refresh': '刷新',
    'graph.action.refreshTitle': '刷新工作区更改与提交图表（同时尝试恢复文件监听）',
    'graph.action.more': '更多操作',
    'graph.action.goToCurrent': '转到当前历史记录项',
    'graph.headNotLoaded': '当前提交还不在已加载的历史中，请先加载更多',
    'graph.menu.toggleSearch': '显示/隐藏提交搜索栏',
    'graph.menu.collapseAll': '折叠全部已展开提交',
    'graph.menu.switchLanguage': '切换界面语言（中文 / English）',
    'graph.search.placeholder': '搜索提交标题、短 SHA、作者或分支…',
    'graph.search.inputAria': '按提交信息或分支本地过滤已加载提交',
    'graph.search.clear': '清除搜索',
    'graph.search.noMatches': '没有匹配当前筛选条件的已加载提交',
    'graph.empty': '当前范围内暂无提交记录',
    'graph.emptyUnborn': '当前分支尚无提交记录',
    'graph.loadingDetail': '正在加载提交文件清单…',
    'graph.emptyFiles': '该提交未包含文件改动',
    'graph.loadMore': '加载更多...',
    'graph.loadingMore': '正在加载更多提交…',
    'graph.softLimitNotice': '已达到 2000 条单次展示上限；如需查看特定历史，建议切换为「自动」范围或缩小仓库检查',
    'graph.deletedFileDisabled': '该文件在当前工作区已不存在',
    'graph.standaloneFilePreviewNotice': '文件预览仅在 Antigravity 桌面端辅助栏内可用',
    'graph.openDetailCard': '查看提交详情',
    'graph.expandCommit': '展开或收起提交文件列表',
    'graph.incomingChanges': '传入的更改',
    'graph.outgoingChanges': '传出的更改',

    // 提交详情卡（改动统计文案沿用 VS Code 简体中文语言包）
    'popover.close': '关闭提交详情',
    'popover.loading': '正在加载提交详情…',
    'popover.coAuthor': '共同作者',
    'popover.fileChanged': '已更改 {count} 个文件',
    'popover.filesChanged': '已更改 {count} 个文件',
    'popover.insertion': '{count} 行插入(+)',
    'popover.insertions': '{count} 行插入(+)',
    'popover.deletion': '{count} 行删除(-)',
    'popover.deletions': '{count} 行删除(-)',
    'popover.copySha': '复制完整 SHA',
    'popover.copiedSha': '已复制完整 SHA：{sha}',

    // 后端标准错误码映射（docs/spec.md 5.1）
    'error.INVALID_REQUEST': '请求参数无效或包含非法字符，请刷新后重试。',
    'error.OUT_OF_WORKTREE': '文件路径试图越出当前工作树目录范围，操作已被安全拦截。',
    'error.NO_REPOSITORY': '当前工作区未找到对应的 Git 仓库或工作树。',
    'error.CONFLICT_BLOCKED': '工作区存在未解决的合并冲突，操作已阻断，请先解决冲突。',
    'error.EMPTY_COMMIT_MESSAGE': '提交说明不能为空，请先填写提交说明。',
    'error.NOTHING_TO_COMMIT': '当前暂存区与工作区没有可提交的更改。',
    'error.GIT_LOCKED': 'Git 锁文件（.lock）正被其他进程占用，经重试后仍未释放，请稍后再试或检查终端中的 Git 操作。',
    'error.GIT_TIMEOUT': 'Git 命令执行超时，请检查网络连通性或仓库体积。',
    'error.AUTH_REQUIRED': '远端身份验证失败，请在系统终端完成 Git 凭据登录或配置 SSH 密钥后重试。',
    'error.NON_FAST_FORWARD': '远程分支已领先或与本地分叉，无法快进拉取或直接推送，请在终端手动合并或变基。',
    'error.NO_REMOTE': '当前仓库尚未配置任何远端仓库，无法执行远程同步。',
    'error.GIT_ERROR': 'Git 命令执行失败，请检查详细信息或在终端重试。',
  }),
  en: Object.freeze({
    // Panel empty state & repository list
    'loading.repository': 'Loading Git repository…',
    'error.bootFailed': 'Panel initialization failed',
    'empty.noRepo.title': 'No Git Repository Found',
    'empty.noRepo.description': 'Open a local folder containing a Git repository in Antigravity to sync automatically.',
    'repo.switcherAria': 'Select active Git repository',
    'repo.currentBranch': 'Current branch: {branch}',
    'repo.bareLabel': 'Bare repository',

    // Special repository & file-watch banners
    'watch.tooManyChangesBanner': 'More than {count} changes; only the first {count} are shown. Auto refresh on file edits is slowed down.',
    'watch.errorBanner': 'File watching failed; auto refresh is paused. Please refresh manually.',
    'repo.detachedBanner': 'HEAD is detached: you can still commit, but push and pull are disabled.',
    'repo.bareNotice': 'Bare repositories do not support working tree modifications. You can still browse the Commit Graph and fetch.',
    'repo.unbornNotice': 'This branch has no commits yet. Make an initial commit to populate the Commit Graph.',
    'changes.conflictBanner': '{count} unresolved merge conflict(s). Resolve and stage them in the editor before committing.',

    // Section headers & resize sash
    'section.repositories': 'Repositories',
    'section.changes': 'Changes',
    'section.graph': 'Graph',
    'section.collapse': 'Collapse {section}',
    'section.expand': 'Expand {section}',
    'section.resizeSash': 'Drag to resize Changes and Graph panes',

    // Top section: commit message, validation & smart primary button
    'commit.placeholder': 'Message ({shortcut} to commit)',
    'commit.placeholderWithBranch': 'Message ({shortcut} to commit on "{branch}")',
    'commit.inputAria': 'Commit message input',
    'commit.emptyMessageError': 'Please enter a commit message',
    'primary.conflictBlocked': 'Resolve conflicts first',
    'primary.conflictBlockedTitle': 'Unresolved merge conflicts must be resolved before committing',
    'primary.commit': 'Commit',
    'primary.commitTitle': 'Commit staged changes (Ctrl/Cmd+Enter)',
    'primary.commitUnstagedTitle': 'No staged changes; click to confirm staging all changes and committing',
    'primary.commitCleanDisabledTitle': 'No pending changes to commit or sync',
    'primary.committing': 'Committing Changes...',
    'primary.publishBranch': 'Publish Branch',
    'primary.publishBranchWithName': 'Publish Branch ({branch})',
    'primary.publishBranchTitle': 'Publish local branch {branch} and set upstream',
    'primary.publishing': 'Publishing Branch…',
    'primary.syncChanges': 'Sync Changes',

    // Sync status tooltips (wording follows VS Code)
    'sync.title': 'Synchronize Changes',
    'sync.syncing': 'Synchronizing Changes...',
    'sync.pullTitle': 'Pull {count} commits from {upstream}',
    'sync.pushTitle': 'Push {count} commits to {upstream}',
    'sync.pullPushTitle': 'Pull {behind} and push {ahead} commits between {upstream}',

    // Top section: change groups & file actions
    'changes.conflictedGroup': 'Merge Conflicts',
    'changes.stagedGroup': 'Staged Changes',
    'changes.unstagedGroup': 'Changes',
    'action.openFile': 'Open File',
    'action.stage': 'Stage Changes',
    'action.stageAll': 'Stage All Changes',
    'action.unstage': 'Unstage Changes',
    'action.unstageAll': 'Unstage All Changes',
    'action.discard': 'Discard Changes',
    'action.discardAll': 'Discard All Changes',
    'action.deleteUntracked': 'Delete Untracked File',
    'status.M': 'Modified',
    'status.A': 'Added',
    'status.D': 'Deleted',
    'status.R': 'Renamed',
    'status.C': 'Copied',
    'status.U': 'Untracked',
    'status.conflicted': 'Conflicted',

    // Top section: confirmation modals
    'modal.cancel': 'Cancel',
    'modal.autoStageCommit.title': 'No Staged Changes to Commit',
    'modal.autoStageCommit.body': 'There are no staged changes to commit. Would you like to automatically stage all {count} change(s) and commit directly?',
    'modal.autoStageCommit.confirm': 'Stage All & Commit',
    'modal.chooseRemote.title': 'Select Remote to Publish',
    'modal.chooseRemote.body': 'Multiple remotes are configured. Choose the target remote for branch {branch}:',
    'modal.chooseRemote.confirm': 'Publish Branch',
    'modal.discardFile.title': 'Discard Changes',
    'modal.discardFile.body': 'Discard unstaged working tree changes to "{path}"? This cannot be undone.',
    'modal.discardFile.confirm': 'Discard Changes',
    'modal.deleteUntracked.title': 'Delete Untracked File Permanently',
    'modal.deleteUntracked.body': 'Warning: Untracked file "{path}" will be permanently deleted from disk and cannot be recovered!',
    'modal.deleteUntracked.confirm': 'Delete Permanently',
    'modal.discardAll.title': 'Discard All Tracked Changes',
    'modal.discardAll.body': 'Discard unstaged changes across all {count} tracked file(s)? Untracked files will not be deleted, and tracked changes cannot be undone.',
    'modal.discardAll.confirm': 'Discard All',

    // Bottom section: graph toolbar, overflow menu, local search & pagination
    'graph.scopeAuto': 'Auto',
    'graph.scopeAll': 'All',
    'graph.scopeToggleTitle': 'Toggle commit scope: Auto (current branch & upstream) / All (all branches & tags)',
    'graph.action.fetch': 'Fetch',
    'graph.action.fetchTitle': 'Fetch all remotes and prune deleted branches (git fetch --all --prune)',
    'graph.action.pull': 'Pull',
    'graph.action.pullTitle': 'Fast-forward pull from upstream (git pull --ff-only)',
    'graph.action.push': 'Push',
    'graph.action.pushTitle': 'Push local commits to upstream (git push)',
    'graph.action.publishTitle': 'Publish current branch and set upstream (git push -u)',
    'graph.action.refresh': 'Refresh',
    'graph.action.refreshTitle': 'Refresh working tree changes and Commit Graph (and attempt to restore watching)',
    'graph.action.more': 'More Actions',
    'graph.action.goToCurrent': 'Go to Current History Item',
    'graph.headNotLoaded': 'The current commit is not in the loaded history yet. Load more to reach it.',
    'graph.menu.toggleSearch': 'Toggle Commit Search',
    'graph.menu.collapseAll': 'Collapse All Expanded Commits',
    'graph.menu.switchLanguage': 'Switch Language (中文 / English)',
    'graph.search.placeholder': 'Filter loaded commits by subject, SHA, author, or ref…',
    'graph.search.inputAria': 'Filter loaded commits locally',
    'graph.search.clear': 'Clear Search',
    'graph.search.noMatches': 'No loaded commits match the current filter.',
    'graph.empty': 'No commits in the current scope.',
    'graph.emptyUnborn': 'No commits yet on this branch.',
    'graph.loadingDetail': 'Loading commit file list…',
    'graph.emptyFiles': 'No changed files in this commit.',
    'graph.loadMore': 'Load More...',
    'graph.loadingMore': 'Loading more commits…',
    'graph.softLimitNotice': 'Reached the 2,000-commit display limit. Switch to "Auto" scope to focus on the current branch.',
    'graph.deletedFileDisabled': 'This file no longer exists in the current worktree',
    'graph.standaloneFilePreviewNotice': 'File preview is only available inside the Antigravity desktop Auxiliary Pane',
    'graph.openDetailCard': 'View Commit Details',
    'graph.expandCommit': 'Expand or collapse commit files',
    'graph.incomingChanges': 'Incoming Changes',
    'graph.outgoingChanges': 'Outgoing Changes',

    // Commit detail popover (change statistics wording follows VS Code)
    'popover.close': 'Close Commit Details',
    'popover.loading': 'Loading commit details…',
    'popover.coAuthor': 'Co-author',
    'popover.fileChanged': '{count} file changed',
    'popover.filesChanged': '{count} files changed',
    'popover.insertion': '{count} insertion(+)',
    'popover.insertions': '{count} insertions(+)',
    'popover.deletion': '{count} deletion(-)',
    'popover.deletions': '{count} deletions(-)',
    'popover.copySha': 'Copy Full SHA',
    'popover.copiedSha': 'Copied SHA: {sha}',

    // Backend canonical error code messages (docs/spec.md 5.1)
    'error.INVALID_REQUEST': 'Invalid request parameters or disallowed characters. Please refresh and try again.',
    'error.OUT_OF_WORKTREE': 'File path escapes the active worktree directory boundary and was blocked.',
    'error.NO_REPOSITORY': 'Target Git repository or worktree could not be found in the current workspace.',
    'error.CONFLICT_BLOCKED': 'Operation blocked by unresolved merge conflicts in the working tree. Resolve conflicts first.',
    'error.EMPTY_COMMIT_MESSAGE': 'Commit message cannot be empty.',
    'error.NOTHING_TO_COMMIT': 'No staged or working tree changes to commit.',
    'error.GIT_LOCKED': 'A Git lock file (.lock) is still held by another process after retries. Wait a moment or check active Git commands in your terminal.',
    'error.GIT_TIMEOUT': 'Git command timed out. Check network connectivity or repository size.',
    'error.AUTH_REQUIRED': 'Remote authentication failed in non-interactive mode. Sign in to Git or configure SSH keys in your terminal and retry.',
    'error.NON_FAST_FORWARD': 'Remote branch has diverged and cannot fast-forward. Merge or rebase manually in a terminal.',
    'error.NO_REMOTE': 'No remote repository is configured for this repository.',
    'error.GIT_ERROR': 'Git command failed. Check details or retry in a terminal.',
  }),
});

const interpolateTemplate = (template, params) => {
  if (!params || typeof params !== 'object') return template;
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (fullMatch, tokenName) => {
    const replacement = params[tokenName];
    return replacement === undefined || replacement === null ? fullMatch : String(replacement);
  });
};

/**
 * 根据用户偏好语言与宿主浏览器 `navigator.language` 解析最终生效的界面语言标识。
 * 当 `prefLocale` 为 `'auto'`、空值或未受支持时，按 `navigatorLanguage` 的 `zh` 前缀匹配 `'zh-CN'`，其余回退 `'en'`。
 *
 * @param {string | null | undefined} prefLocale 持久化偏好语言（`'auto' | 'zh-CN' | 'en'`）
 * @param {string | null | undefined} [navigatorLanguage] 浏览器语言标识（未传入时自动安全探测 `globalThis.navigator?.language`）
 * @returns {'zh-CN' | 'en'} 规范化后的语言标识（无副作用）
 */
export const resolveLocale = (prefLocale, navigatorLanguage) => {
  if (typeof prefLocale === 'string') {
    const normalizedPref = prefLocale.trim().toLowerCase();
    if (normalizedPref === 'zh-cn' || normalizedPref.startsWith('zh')) {
      return 'zh-CN';
    }
    if (normalizedPref === 'en' || normalizedPref.startsWith('en-')) {
      return 'en';
    }
  }

  const fallbackNavigatorLang = navigatorLanguage !== undefined
    ? navigatorLanguage
    : (typeof navigator !== 'undefined' ? navigator.language : '');

  if (typeof fallbackNavigatorLang === 'string' && fallbackNavigatorLang.trim().toLowerCase().startsWith('zh')) {
    return 'zh-CN';
  }

  return 'en';
};

/**
 * 创建指定语言的双语翻译函数，支持 `{param}` 占位符插值与缺省英文兜底。
 *
 * @param {string | null | undefined} locale 目标语言标识（支持 `'zh-CN'`、`'en'` 或 `'auto'`）
 * @returns {((key: string, params?: Record<string, unknown>) => string) & { locale: 'zh-CN' | 'en' }} 附带 `.locale` 属性的翻译函数（无副作用）
 */
export const createTranslator = (locale) => {
  const resolvedLocale = resolveLocale(locale);
  const activeDict = MESSAGES[resolvedLocale] ?? MESSAGES.en;
  const fallbackDict = MESSAGES.en;

  const translate = (key, params = {}) => {
    const template = activeDict[key] ?? fallbackDict[key];
    if (typeof template !== 'string') {
      return String(key ?? '');
    }
    return interpolateTemplate(template, params);
  };

  translate.locale = resolvedLocale;
  return translate;
};

/**
 * 根据后端错误对象与目标语言生成用户可读的本地化错误提示文本。
 *
 * @param {{ code?: string, message?: string } | null | undefined} error 后端返回的错误对象
 * @param {string | null | undefined} [locale='en'] 目标语言标识
 * @returns {string} 本地化后的错误说明文案（无副作用）
 */
export const translateApiError = (error, locale = 'en') => {
  const translate = createTranslator(locale);
  const errorCode = typeof error?.code === 'string' ? error.code.trim() : '';
  if (errorCode && Object.prototype.hasOwnProperty.call(MESSAGES.en, `error.${errorCode}`)) {
    return translate(`error.${errorCode}`);
  }
  if (typeof error?.message === 'string' && error.message.trim()) {
    return error.message.trim();
  }
  return translate('error.GIT_ERROR');
};

/**
 * 生成同步状态的悬停提示，规则同 VS Code Git 扩展的 `syncTooltip`：只落后时说拉取、只领先时说推送、分叉时两者都说。
 *
 * @param {{ upstream?: string | null, ahead?: number, behind?: number }} repo 仓库的上游与领先、落后提交数
 * @param {(key: string, params?: Record<string, unknown>) => string} t 翻译函数
 * @returns {string} 本地化的提示文案；没有上游或与上游一致时为「同步更改」（无副作用）
 */
export const formatSyncTitle = ({ upstream, ahead = 0, behind = 0 }, t) => {
  if (!upstream || (!ahead && !behind)) return t('sync.title');
  if (!ahead) return t('sync.pullTitle', { count: behind, upstream });
  if (!behind) return t('sync.pushTitle', { count: ahead, upstream });
  return t('sync.pullPushTitle', { behind, ahead, upstream });
};

/**
 * 将 Unix 秒级时间戳格式化为可读的相对时间字符串（如 `刚刚` / `15 分钟前` / `1 天前` 或 `just now` / `2 hours ago`）。
 *
 * @param {number} timestampSec Unix 秒级时间戳
 * @param {string | null | undefined} [locale='en'] 目标语言标识
 * @param {number} [nowMs=Date.now()] 可选当前基准毫秒时间戳（便于确定性单元测试）
 * @returns {string} 相对时间描述；时间戳无效时返回空字符串（无副作用）
 */
export const formatRelativeTime = (timestampSec, locale = 'en', nowMs = Date.now()) => {
  if (!Number.isFinite(timestampSec) || !Number.isFinite(nowMs)) {
    return '';
  }

  const resolvedLocale = resolveLocale(locale);
  const isZh = resolvedLocale === 'zh-CN';
  const elapsedSec = Math.max(0, Math.floor((nowMs - timestampSec * 1000) / 1000));

  if (elapsedSec < 60) {
    return isZh ? '刚刚' : 'just now';
  }
  if (elapsedSec < 3600) {
    const minutes = Math.floor(elapsedSec / 60);
    return isZh ? `${minutes} 分钟前` : (minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`);
  }
  if (elapsedSec < 86400) {
    const hours = Math.floor(elapsedSec / 3600);
    return isZh ? `${hours} 小时前` : (hours === 1 ? '1 hour ago' : `${hours} hours ago`);
  }
  if (elapsedSec < 30 * 86400) {
    const days = Math.floor(elapsedSec / 86400);
    return isZh ? `${days} 天前` : (days === 1 ? '1 day ago' : `${days} days ago`);
  }
  if (elapsedSec < 365 * 86400) {
    const months = Math.floor(elapsedSec / (30 * 86400));
    return isZh ? `${months} 个月前` : (months === 1 ? '1 month ago' : `${months} months ago`);
  }
  const years = Math.floor(elapsedSec / (365 * 86400));
  return isZh ? `${years} 年前` : (years === 1 ? '1 year ago' : `${years} years ago`);
};

/**
 * 将 Unix 秒级时间戳格式化为本地长日期时间，格式与 VS Code 提交悬浮卡一致
 * （如 `2026年11月20日 11:17`、`November 20, 2026 at 11:17 AM`）。
 *
 * @param {number} timestampSec Unix 秒级时间戳
 * @param {string | null | undefined} [locale='en'] 目标语言标识
 * @returns {string} 本地日期时间字符串；时间戳无效时返回空字符串（无副作用）
 */
export const formatAbsoluteTime = (timestampSec, locale = 'en') => {
  const date = new Date(timestampSec * 1000);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return date.toLocaleString(resolveLocale(locale), {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
  });
};
