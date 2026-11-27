/**
 * Antigravity Git Graph 上区「更改」视图组件，布局对齐 VS Code 源代码管理「更改」视图。
 * 负责特殊状态横幅（冲突/游离 HEAD/裸仓）、长列表按可视区渲染的文件分组、按 repo.id 内存保留的提交草稿、
 * 智能主按钮状态机、可折叠变更分组及三档 Discard 安全确认护栏。
 */

import { formatSyncTitle } from './i18n.js';

// 与 styles.css 中 .gw-file-row 的固定行高一致，虚拟列表按它换算滚动位置
const FILE_ROW_HEIGHT_PX = 22;
// 单个分组不超过这么多行时整表渲染；超过后只渲染可视区附近的行
const FULL_RENDER_ROW_LIMIT = 500;
const OVERSCAN_ROWS = 10;

// 同步、发布期间换成同步图标，由样式表让它旋转（同 VS Code `sync~spin`）
const PRIMARY_ICON_BY_ACTION = Object.freeze({
  commit: 'check',
  'clean-disabled': 'check',
  'conflict-blocked': 'warning',
  publish: 'cloudUpload',
  publishing: 'sync',
  sync: 'sync',
  syncing: 'sync',
});

// 同 VS Code ActionButton 的 isSyncInProgress（同步、推送、拉取）；发布走的也是推送
const SYNC_OPS = new Set(['sync', 'push', 'pull', 'publish']);

const normalizeStatusMeta = (file, isConflicted, t) => {
  if (isConflicted) {
    return {
      letter: '!',
      className: 'is-conflicted',
      label: t('status.conflicted'),
    };
  }
  if (file?.untracked) {
    return {
      letter: 'U',
      className: 'is-untracked',
      label: t('status.U'),
    };
  }
  const rawCode = typeof file?.status === 'string' && file.status.trim()
    ? file.status.trim()[0].toUpperCase()
    : 'M';
  const map = {
    M: { className: 'is-modified', key: 'status.M' },
    A: { className: 'is-added', key: 'status.A' },
    D: { className: 'is-deleted', key: 'status.D' },
    R: { className: 'is-renamed', key: 'status.R' },
    C: { className: 'is-copied', key: 'status.C' },
    U: { className: 'is-untracked', key: 'status.U' },
  };
  const entry = map[rawCode] ?? { className: 'is-modified', key: 'status.M' };
  return {
    letter: rawCode,
    className: entry.className,
    label: t(entry.key),
  };
};

// 同 VS Code「同步更改」按钮：落后数在前、领先数在后，为 0 的一侧省略
const computeSyncCounts = ({ ahead, behind }) => [
  ...(behind > 0 ? [{ value: behind, icon: 'arrowDown' }] : []),
  ...(ahead > 0 ? [{ value: ahead, icon: 'arrowUp' }] : []),
];

const buttonState = (action, label, title, { disabled = false, conflictBlocked = false, counts = [] } = {}) => ({
  action,
  label,
  title,
  disabled,
  conflictBlocked,
  counts,
});

// 没有操作进行时的按钮状态；工作区干净时的顺序同 VS Code Git 扩展的 ActionButton：发布分支 → 同步更改 → 禁用的提交
const computeIdleButtonState = ({ activeRepo, changes, t }) => {
  if ((changes?.conflicted?.length ?? 0) > 0) {
    return buttonState('conflict-blocked', t('primary.conflictBlocked'), t('primary.conflictBlockedTitle'), {
      disabled: true,
      conflictBlocked: true,
    });
  }

  const stagedCount = changes?.staged?.length ?? 0;
  const unstagedCount = changes?.unstaged?.length ?? 0;
  if (stagedCount > 0 || unstagedCount > 0) {
    return buttonState('commit', t('primary.commit'), stagedCount > 0 ? t('primary.commitTitle') : t('primary.commitUnstagedTitle'));
  }

  const remotes = Array.isArray(activeRepo?.remotes) ? activeRepo.remotes : [];
  const ahead = Number(activeRepo?.ahead ?? 0);
  const behind = Number(activeRepo?.behind ?? 0);

  if (activeRepo && !activeRepo.isUnborn && !activeRepo.isDetached) {
    if (!activeRepo.upstream && remotes.length > 0) {
      const branchName = activeRepo.branch || '';
      return buttonState(
        'publish',
        branchName ? t('primary.publishBranchWithName', { branch: branchName }) : t('primary.publishBranch'),
        t('primary.publishBranchTitle', { branch: branchName }),
      );
    }
    if (activeRepo.upstream && (ahead > 0 || behind > 0)) {
      return buttonState('sync', t('primary.syncChanges'), formatSyncTitle(activeRepo, t), {
        counts: computeSyncCounts({ ahead, behind }),
      });
    }
  }

  return buttonState('clean-disabled', t('primary.commit'), t('primary.commitCleanDisabledTitle'), { disabled: true });
};

/**
 * 按 docs/spec.md 7.2 的互斥优先级计算智能主按钮当前状态与交互语义。
 * 同 VS Code：操作进行中按钮保留原文案并禁用，进度由窗格标题栏底边的进度条表示；同步、发布期间图标旋转。
 *
 * @param {{
 *   activeRepo: Record<string, any> | null,
 *   changes: { conflicted?: any[], staged?: any[], unstaged?: any[] } | null,
 *   pendingOp: string | null,
 *   t: (key: string, params?: Record<string, unknown>) => string
 * }} params 当前仓库、变更集合、进行中的写操作与翻译器
 * @returns {{
 *   action: 'conflict-blocked' | 'commit' | 'publish' | 'publishing' | 'sync' | 'syncing' | 'clean-disabled',
 *   label: string,
 *   title: string,
 *   disabled: boolean,
 *   conflictBlocked: boolean,
 *   counts: Array<{ value: number, icon: 'arrowDown' | 'arrowUp' }>
 * }} 主按钮渲染描述对象（无副作用）；`counts` 是同步按钮文案后的落后、领先数
 */
export const computePrimaryButtonState = ({ activeRepo, changes, pendingOp, t }) => {
  const idle = computeIdleButtonState({ activeRepo, changes, t });
  if (!pendingOp) return idle;
  if (SYNC_OPS.has(pendingOp) && idle.action === 'sync') {
    return { ...idle, action: 'syncing', title: t('sync.syncing'), disabled: true };
  }
  if (SYNC_OPS.has(pendingOp) && idle.action === 'publish') {
    return { ...idle, action: 'publishing', title: t('primary.publishing'), disabled: true };
  }
  if (pendingOp === 'commit' && idle.action === 'commit') {
    return { ...idle, title: t('primary.committing'), disabled: true };
  }
  return { ...idle, disabled: true };
};

/**
 * 创建上区「源代码管理」视图控制器，管理草稿输入、智能提交、分组列表与确认弹窗。
 *
 * @param {{
 *   bodyEl: HTMLElement,
 *   sectionTitleEl: HTMLElement
 * }} elements DOM 容器节点集合
 * @param {{
 *   createIcon: (name: string, className?: string) => SVGElement,
 *   createFileIcon: (filePath: string) => HTMLImageElement,
 *   createSplitPath: (filePath: string, origPath?: string | null) => HTMLElement,
 *   captureFocus: (container: HTMLElement) => { focusId: string | null, wasFocusVisible: boolean, group?: string, index?: number } | null,
 *   restoreFocus: (container: HTMLElement, savedFocus: { focusId: string | null, wasFocusVisible: boolean, group?: string, index?: number } | null) => void,
 *   openModal: (config: Record<string, any>) => void,
 *   onOpenFile: (file: Record<string, any>, anchorEl: Element) => void,
 *   onStage: (payload: { worktreePath: string, all: boolean, paths?: string[] }) => Promise<void>,
 *   onUnstage: (payload: { worktreePath: string, all: boolean, paths?: string[] }) => Promise<void>,
 *   onDiscard: (payload: { worktreePath: string, allTracked: boolean, paths?: string[], untracked: boolean }) => Promise<void>,
 *   onCommit: (payload: { worktreePath: string, message: string, autoStageAll: boolean }) => Promise<boolean>,
 *   onPublish: (repo: Record<string, any>) => void,
 *   onSync: (repo: Record<string, any>) => Promise<void>
 * }} deps 外部服务与交互回调
 * @returns {{
 *   render: (state: { activeRepo: Record<string, any> | null, changes: Record<string, any> | null, pendingOp: string | null, t: (key: string, params?: Record<string, unknown>) => string }) => void,
 *   clearDraft: () => void,
 *   handleWorktreeSwitch: () => void
 * }} 上区视图控制接口（有 DOM 读写与事件监听副作用）
 */
export const createChangesView = (elements, deps) => {
  const { bodyEl, sectionTitleEl } = elements;
  const doc = bodyEl.ownerDocument;
  const commitShortcut = /Mac|iPhone|iPad/.test(doc.defaultView.navigator.platform) ? 'Cmd+Enter' : 'Ctrl+Enter';

  const groupCollapsed = {
    conflicted: false,
    staged: false,
    unstaged: false,
  };

  let showValidationError = false;
  let latestRenderState = null;
  let groupViews = [];

  // 持久挂载横幅、输入区与列表区，避免后台刷新打断 textarea 拼音/IME 组合输入
  const bannersEl = doc.createElement('div');
  bannersEl.className = 'gw-banner-stack hidden';
  bannersEl.dataset.testid = 'changes-banners';

  const composerEl = doc.createElement('div');
  composerEl.className = 'gw-composer';
  composerEl.dataset.testid = 'commit-composer';

  const textareaEl = doc.createElement('textarea');
  textareaEl.id = 'commit-message-input';
  textareaEl.className = 'gw-commit-input';
  textareaEl.rows = 1;
  textareaEl.dataset.testid = 'commit-message-input';
  textareaEl.dataset.focusId = 'commit-message';

  const validationEl = doc.createElement('div');
  validationEl.className = 'gw-validation-msg hidden';
  validationEl.dataset.testid = 'commit-validation-msg';
  validationEl.setAttribute('role', 'alert');

  const primaryBtnEl = doc.createElement('button');
  primaryBtnEl.id = 'commit-primary-btn';
  primaryBtnEl.type = 'button';
  primaryBtnEl.className = 'gw-primary-btn';
  primaryBtnEl.dataset.testid = 'commit-primary-btn';
  primaryBtnEl.dataset.focusId = 'commit-primary';
  const primaryLabelEl = doc.createElement('span');
  primaryLabelEl.className = 'gw-primary-btn-label';

  composerEl.append(textareaEl, validationEl, primaryBtnEl);

  const groupsEl = doc.createElement('div');
  groupsEl.className = 'gw-changes-groups';
  groupsEl.dataset.testid = 'changes-groups';

  bodyEl.replaceChildren(bannersEl, composerEl, groupsEl);

  const syncValidationUi = (t) => {
    textareaEl.classList.toggle('has-error', showValidationError);
    validationEl.classList.toggle('hidden', !showValidationError);
    validationEl.textContent = showValidationError ? t('commit.emptyMessageError') : '';
  };

  const triggerCommitFlow = () => {
    if (!latestRenderState) return;
    const { activeRepo, changes, pendingOp, t } = latestRenderState;
    if (!activeRepo || activeRepo.isBare || pendingOp) return;

    const conflicted = changes?.conflicted ?? [];
    const staged = changes?.staged ?? [];
    const unstaged = changes?.unstaged ?? [];
    if (conflicted.length > 0) return;
    if (staged.length === 0 && unstaged.length === 0) return;

    const message = textareaEl.value;
    if (!message.trim()) {
      showValidationError = true;
      syncValidationUi(t);
      textareaEl.focus();
      return;
    }

    showValidationError = false;
    syncValidationUi(t);

    if (staged.length > 0) {
      void deps.onCommit({
        worktreePath: activeRepo.worktreePath,
        message,
        autoStageAll: false,
      });
      return;
    }

    deps.openModal({
      title: t('modal.autoStageCommit.title'),
      body: t('modal.autoStageCommit.body', { count: unstaged.length }),
      confirmLabel: t('modal.autoStageCommit.confirm'),
      cancelLabel: t('modal.cancel'),
      variant: 'default',
      onConfirm: () => {
        void deps.onCommit({
          worktreePath: activeRepo.worktreePath,
          message,
          autoStageAll: true,
        });
      },
    });
  };

  const handlePrimaryAction = () => {
    if (!latestRenderState) return;
    const { activeRepo, changes, pendingOp, t } = latestRenderState;
    if (!activeRepo || activeRepo.isBare || pendingOp) return;

    const btnState = computePrimaryButtonState({ activeRepo, changes, pendingOp, t });
    if (btnState.disabled) return;

    if (btnState.action === 'commit') {
      triggerCommitFlow();
      return;
    }
    if (btnState.action === 'publish') {
      deps.onPublish(activeRepo);
      return;
    }
    if (btnState.action === 'sync') {
      void deps.onSync(activeRepo);
    }
  };

  textareaEl.addEventListener('input', () => {
    if (showValidationError && textareaEl.value.trim() && latestRenderState) {
      showValidationError = false;
      syncValidationUi(latestRenderState.t);
    }
  });

  textareaEl.addEventListener('keydown', (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key === 'Enter') {
      // 必须阻止默认并阻止 preload.js 将 Ctrl/Cmd+Enter 透传给宿主
      event.preventDefault();
      triggerCommitFlow();
    }
  });

  primaryBtnEl.addEventListener('click', handlePrimaryAction);

  const createActionButton = ({ iconName, title, focusId, onClick }) => {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'gw-icon-btn';
    btn.title = title;
    btn.setAttribute('aria-label', title);
    if (focusId) btn.dataset.focusId = focusId;
    btn.append(deps.createIcon(iconName));
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      onClick();
    });
    return btn;
  };

  const renderBanners = ({ activeRepo, changes, t }) => {
    const items = [];
    if (activeRepo?.isBare) {
      items.push({ variant: 'info', icon: 'info', text: t('repo.bareNotice'), testid: 'banner-bare' });
    }
    if (activeRepo?.isDetached) {
      items.push({ variant: 'warning', icon: 'warning', text: t('repo.detachedBanner'), testid: 'banner-detached' });
    }
    const conflictedCount = changes?.conflicted?.length ?? 0;
    if (conflictedCount > 0) {
      items.push({
        variant: 'error',
        icon: 'error',
        text: t('changes.conflictBanner', { count: conflictedCount }),
        testid: 'banner-conflict',
      });
    }

    if (items.length === 0) {
      bannersEl.classList.add('hidden');
      bannersEl.replaceChildren();
      return;
    }

    bannersEl.classList.remove('hidden');
    const fragment = doc.createDocumentFragment();
    for (const item of items) {
      const banner = doc.createElement('div');
      banner.className = `gw-banner is-${item.variant}`;
      banner.dataset.testid = item.testid;
      banner.setAttribute('role', 'status');

      const iconWrap = doc.createElement('span');
      iconWrap.className = 'gw-banner-icon';
      iconWrap.setAttribute('aria-hidden', 'true');
      iconWrap.append(deps.createIcon(item.icon));

      const textSpan = doc.createElement('span');
      textSpan.className = 'gw-banner-text';
      textSpan.textContent = item.text;

      banner.append(iconWrap, textSpan);
      fragment.append(banner);
    }
    bannersEl.replaceChildren(fragment);
  };

  const createFileRow = ({ groupKey, file, index, total, activeRepo, t, isConflicted }) => {
    const rowEl = doc.createElement('div');
    rowEl.className = 'gw-file-row';
    rowEl.tabIndex = 0;
    rowEl.setAttribute('role', 'listitem');
    rowEl.setAttribute('aria-posinset', String(index + 1));
    rowEl.setAttribute('aria-setsize', String(total));
    rowEl.dataset.testid = `change-file-${groupKey}`;
    rowEl.dataset.filePath = file.path;
    rowEl.dataset.focusGroup = groupKey;
    rowEl.dataset.focusIndex = String(index);
    rowEl.dataset.focusId = `file:${groupKey}:${file.path}`;

    const fullTooltip = file.origPath ? `${file.origPath} → ${file.path}` : file.path;
    rowEl.title = fullTooltip;

    const statusMeta = normalizeStatusMeta(file, isConflicted, t);
    rowEl.classList.add(statusMeta.className);
    rowEl.append(deps.createFileIcon(file.path), deps.createSplitPath(file.path, file.origPath));

    const rowActions = doc.createElement('div');
    rowActions.className = 'gw-row-actions';

    rowActions.append(
      createActionButton({
        iconName: 'goToFile',
        title: t('action.openFile'),
        focusId: `file-act:${groupKey}:open:${file.path}`,
        onClick: () => deps.onOpenFile(file, rowEl),
      }),
    );

    if (groupKey === 'staged') {
      const unstageBtn = createActionButton({
        iconName: 'remove',
        title: t('action.unstage'),
        focusId: `file-act:${groupKey}:unstage:${file.path}`,
        onClick: () => {
          void deps.onUnstage({
            worktreePath: activeRepo.worktreePath,
            all: false,
            paths: [file.path],
          });
        },
      });
      unstageBtn.dataset.testid = 'file-unstage-btn';
      rowActions.append(unstageBtn);
    } else if (groupKey === 'unstaged') {
      const isUntracked = Boolean(file.untracked);
      const discardBtn = createActionButton({
        iconName: 'discard',
        title: isUntracked ? t('action.deleteUntracked') : t('action.discard'),
        focusId: `file-act:${groupKey}:discard:${file.path}`,
        onClick: () => {
          deps.openModal({
            title: isUntracked
              ? t('modal.deleteUntracked.title')
              : t('modal.discardFile.title'),
            body: isUntracked
              ? t('modal.deleteUntracked.body', { path: file.path })
              : t('modal.discardFile.body', { path: file.path }),
            confirmLabel: isUntracked
              ? t('modal.deleteUntracked.confirm')
              : t('modal.discardFile.confirm'),
            cancelLabel: t('modal.cancel'),
            variant: isUntracked ? 'danger' : 'default',
            onConfirm: () => {
              void deps.onDiscard({
                worktreePath: activeRepo.worktreePath,
                allTracked: false,
                paths: [file.path],
                untracked: isUntracked,
              });
            },
          });
        },
      });
      discardBtn.dataset.testid = isUntracked ? 'file-delete-untracked-btn' : 'file-discard-btn';

      const stageBtn = createActionButton({
        iconName: 'add',
        title: t('action.stage'),
        focusId: `file-act:${groupKey}:stage:${file.path}`,
        onClick: () => {
          void deps.onStage({
            worktreePath: activeRepo.worktreePath,
            all: false,
            paths: [file.path],
          });
        },
      });
      stageBtn.dataset.testid = 'file-stage-btn';
      rowActions.append(discardBtn, stageBtn);
    }

    const statusBadge = doc.createElement('span');
    statusBadge.className = `gw-status-badge ${statusMeta.className}`;
    statusBadge.textContent = statusMeta.letter;
    statusBadge.title = statusMeta.label;
    statusBadge.setAttribute('aria-label', statusMeta.label);

    rowEl.append(rowActions, statusBadge);

    rowEl.addEventListener('click', () => {
      deps.onOpenFile(file, rowEl);
    });
    rowEl.addEventListener('keydown', (event) => {
      if (event.target !== rowEl) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        deps.onOpenFile(file, rowEl);
      }
    });

    return rowEl;
  };

  // 计算分组列表当前应渲染的行区间 [start, end)；短列表整表渲染，保持 Tab 可遍历全部文件
  const computeRowWindow = (view, containerRect) => {
    const total = view.files.length;
    if (total <= FULL_RENDER_ROW_LIMIT) {
      return { start: 0, end: total };
    }
    // 列表顶部相对滚动容器可视区顶部的偏移，滚过头时为负
    const listOffset = view.listEl.getBoundingClientRect().top - containerRect.top;
    const firstVisible = Math.floor(-listOffset / FILE_ROW_HEIGHT_PX);
    const lastVisible = Math.ceil((groupsEl.clientHeight - listOffset) / FILE_ROW_HEIGHT_PX);
    const start = Math.min(total, Math.max(0, firstVisible - OVERSCAN_ROWS));
    const end = Math.min(total, Math.max(start, lastVisible + OVERSCAN_ROWS));
    return { start, end };
  };

  const applySpacerHeights = (view) => {
    view.topSpacerEl.style.height = `${view.start * FILE_ROW_HEIGHT_PX}px`;
    view.bottomSpacerEl.style.height = `${(view.files.length - view.end) * FILE_ROW_HEIGHT_PX}px`;
  };

  // 只增删窗口两端的行，留在窗口内的行原地不动，避免带焦点的行被移出 DOM 而失焦
  const syncRowWindow = (view, containerRect) => {
    const { start, end } = computeRowWindow(view, containerRect);
    if (start === view.start && end === view.end) return;

    const keptStart = Math.max(start, view.start);
    const keptEnd = Math.min(end, view.end);
    for (const [index, rowEl] of view.rows) {
      if (index < keptStart || index >= keptEnd) {
        // 带焦点的行滚出窗口时焦点交给列表本身（同 VS Code 列表），不掉到页面最外层
        if (rowEl.contains(doc.activeElement)) view.listEl.focus({ preventScroll: true });
        rowEl.remove();
        view.rows.delete(index);
      }
    }

    const createRows = (from, to) => {
      const created = [];
      for (let index = from; index < to; index += 1) {
        const rowEl = createFileRow({ ...view.rowContext, file: view.files[index], index, total: view.files.length });
        view.rows.set(index, rowEl);
        created.push(rowEl);
      }
      return created;
    };

    if (keptStart >= keptEnd) {
      view.topSpacerEl.after(...createRows(start, end));
    } else {
      view.rows.get(keptStart).before(...createRows(start, keptStart));
      view.rows.get(keptEnd - 1).after(...createRows(keptEnd, end));
    }

    view.start = start;
    view.end = end;
    applySpacerHeights(view);
  };

  const syncAllRowWindows = () => {
    // 只有长列表需要读布局，短列表整表渲染时不强制同步布局
    const needsLayout = groupViews.some((view) => view.files.length > FULL_RENDER_ROW_LIMIT);
    const containerRect = needsLayout ? groupsEl.getBoundingClientRect() : null;
    for (const view of groupViews) {
      syncRowWindow(view, containerRect);
    }
  };

  let windowSyncFrame = null;
  const scheduleRowWindowSync = () => {
    if (windowSyncFrame !== null) return;
    windowSyncFrame = doc.defaultView.requestAnimationFrame(() => {
      windowSyncFrame = null;
      syncAllRowWindows();
    });
  };
  groupsEl.addEventListener('scroll', scheduleRowWindowSync, { passive: true });
  // 面板折叠展开、拖动中缝或窗口缩放都会改变可视高度
  new doc.defaultView.ResizeObserver(scheduleRowWindowSync).observe(groupsEl);

  const renderFileGroup = ({ groupKey, title, files, activeRepo, t, isConflicted = false }) => {
    const groupEl = doc.createElement('div');
    groupEl.className = 'gw-change-group';
    groupEl.dataset.testid = `changes-group-${groupKey}`;

    const isCollapsed = groupCollapsed[groupKey];
    const headerEl = doc.createElement('div');
    headerEl.className = 'gw-group-header';

    const toggleBtn = doc.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'gw-group-toggle';
    toggleBtn.dataset.focusId = `group:${groupKey}`;
    toggleBtn.dataset.testid = `group-toggle-${groupKey}`;
    toggleBtn.setAttribute('aria-expanded', String(!isCollapsed));

    const chevron = doc.createElement('span');
    chevron.className = 'gw-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    chevron.append(deps.createIcon(isCollapsed ? 'chevronRight' : 'chevronDown'));

    const titleSpan = doc.createElement('span');
    titleSpan.className = 'gw-group-title';
    titleSpan.textContent = title;

    toggleBtn.append(chevron, titleSpan);
    toggleBtn.addEventListener('click', () => {
      groupCollapsed[groupKey] = !groupCollapsed[groupKey];
      if (latestRenderState) render(latestRenderState);
    });

    headerEl.append(toggleBtn);

    if (!isConflicted && files.length > 0) {
      const groupActions = doc.createElement('div');
      groupActions.className = 'gw-group-actions';

      if (groupKey === 'staged') {
        groupActions.append(
          createActionButton({
            iconName: 'remove',
            title: t('action.unstageAll'),
            focusId: 'group-act:staged:unstageAll',
            onClick: () => {
              void deps.onUnstage({ worktreePath: activeRepo.worktreePath, all: true });
            },
          }),
        );
      } else if (groupKey === 'unstaged') {
        const trackedFiles = files.filter((file) => !file.untracked);
        if (trackedFiles.length > 0) {
          const discardAllBtn = createActionButton({
            iconName: 'discard',
            title: t('action.discardAll'),
            focusId: 'group-act:unstaged:discardAll',
            onClick: () => {
              deps.openModal({
                title: t('modal.discardAll.title'),
                body: t('modal.discardAll.body', { count: trackedFiles.length }),
                confirmLabel: t('modal.discardAll.confirm'),
                cancelLabel: t('modal.cancel'),
                variant: 'default',
                onConfirm: () => {
                  void deps.onDiscard({
                    worktreePath: activeRepo.worktreePath,
                    allTracked: true,
                    untracked: false,
                  });
                },
              });
            },
          });
          discardAllBtn.dataset.testid = 'discard-all-btn';
          groupActions.append(discardAllBtn);
        }

        const stageAllBtn = createActionButton({
          iconName: 'add',
          title: t('action.stageAll'),
          focusId: 'group-act:unstaged:stageAll',
          onClick: () => {
            void deps.onStage({ worktreePath: activeRepo.worktreePath, all: true });
          },
        });
        stageAllBtn.dataset.testid = 'stage-all-btn';
        groupActions.append(stageAllBtn);
      }

      headerEl.append(groupActions);
    }

    const countEl = doc.createElement('span');
    countEl.className = 'gw-count-badge';
    countEl.textContent = String(files.length);
    headerEl.append(countEl);

    groupEl.append(headerEl);

    if (!isCollapsed) {
      const listEl = doc.createElement('div');
      listEl.className = 'gw-group-list gw-clip-focus';
      listEl.setAttribute('role', 'list');
      // 不进 Tab 序列，只接住滚出窗口的行交出的焦点；重渲染后按 focusId 还原
      listEl.tabIndex = -1;
      listEl.dataset.focusId = `list:${groupKey}`;
      // 焦点在列表本身时 Tab 进入可视区第一行；默认会进入窗口顶部预渲染、看不见的行，列表随之上跳
      listEl.addEventListener('keydown', (event) => {
        if (event.target !== listEl || event.key !== 'Tab' || event.shiftKey) return;
        const viewTop = groupsEl.getBoundingClientRect().top;
        const firstVisibleRow = [...listEl.querySelectorAll('.gw-file-row')].find((row) => row.getBoundingClientRect().top >= viewTop);
        if (!firstVisibleRow) return;
        event.preventDefault();
        firstVisibleRow.focus({ preventScroll: true });
      });
      const topSpacerEl = doc.createElement('div');
      topSpacerEl.className = 'gw-list-spacer';
      topSpacerEl.setAttribute('aria-hidden', 'true');
      const bottomSpacerEl = topSpacerEl.cloneNode();
      listEl.append(topSpacerEl, bottomSpacerEl);
      groupEl.append(listEl);

      // 行在分组挂进 DOM 后由 syncAllRowWindows 按可视区填充。占位先撑满整表高度：
      // 填充前要读布局，此时内容若塌成 0 高，浏览器会把滚动位置截回顶部
      const view = {
        files,
        listEl,
        topSpacerEl,
        bottomSpacerEl,
        rowContext: { groupKey, activeRepo, t, isConflicted },
        rows: new Map(),
        start: 0,
        end: 0,
      };
      applySpacerHeights(view);
      groupViews.push(view);
    }

    return groupEl;
  };

  const render = (state) => {
    latestRenderState = state;
    const { activeRepo, changes, pendingOp, t } = state;

    sectionTitleEl.textContent = t('section.changes');

    groupViews = [];
    if (!activeRepo) {
      bannersEl.classList.add('hidden');
      composerEl.classList.add('hidden');
      groupsEl.replaceChildren();
      return;
    }

    const conflicted = changes?.conflicted ?? [];
    const staged = changes?.staged ?? [];
    const unstaged = changes?.unstaged ?? [];

    renderBanners({ activeRepo, changes, t });

    if (activeRepo.isBare) {
      composerEl.classList.add('hidden');
      groupsEl.replaceChildren();
      return;
    }

    composerEl.classList.remove('hidden');
    const canNameBranch = activeRepo.branch && !activeRepo.isDetached;
    textareaEl.placeholder = canNameBranch
      ? t('commit.placeholderWithBranch', { shortcut: commitShortcut, branch: activeRepo.branch })
      : t('commit.placeholder', { shortcut: commitShortcut });
    textareaEl.setAttribute('aria-label', t('commit.inputAria'));
    textareaEl.disabled = pendingOp === 'commit';
    syncValidationUi(t);

    const btnState = computePrimaryButtonState({ activeRepo, changes, pendingOp, t });
    const primaryIcon = PRIMARY_ICON_BY_ACTION[btnState.action];
    primaryLabelEl.textContent = btnState.label;
    const countEls = btnState.counts.map(({ value, icon }) => {
      const countEl = doc.createElement('span');
      countEl.className = 'gw-primary-btn-count';
      countEl.append(String(value), deps.createIcon(icon));
      return countEl;
    });
    primaryBtnEl.replaceChildren(...(primaryIcon ? [deps.createIcon(primaryIcon)] : []), primaryLabelEl, ...countEls);
    primaryBtnEl.title = btnState.title;
    primaryBtnEl.disabled = btnState.disabled;
    primaryBtnEl.dataset.actionState = btnState.action;
    primaryBtnEl.classList.toggle('is-conflict-blocked', btnState.conflictBlocked);

    const savedFocus = deps.captureFocus(groupsEl);
    const fragment = doc.createDocumentFragment();

    if (conflicted.length > 0) {
      fragment.append(
        renderFileGroup({
          groupKey: 'conflicted',
          title: t('changes.conflictedGroup'),
          files: conflicted,
          activeRepo,
          t,
          isConflicted: true,
        }),
      );
    }

    if (staged.length > 0) {
      fragment.append(
        renderFileGroup({
          groupKey: 'staged',
          title: t('changes.stagedGroup'),
          files: staged,
          activeRepo,
          t,
        }),
      );
    }

    if (unstaged.length > 0) {
      fragment.append(
        renderFileGroup({
          groupKey: 'unstaged',
          title: t('changes.unstagedGroup'),
          files: unstaged,
          activeRepo,
          t,
        }),
      );
    }

    groupsEl.replaceChildren(fragment);
    syncAllRowWindows();
    deps.restoreFocus(groupsEl, savedFocus);
  };

  const clearDraft = () => {
    textareaEl.value = '';
    showValidationError = false;
    if (latestRenderState) syncValidationUi(latestRenderState.t);
  };

  /**
   * 切换到另一个仓库或 Worktree 时、渲染新快照之前调用：清空提交说明输入框，列表回到顶部，释放列表里的键盘焦点。
   * 原焦点属于上一个 Worktree，不释放会在重渲染时按行号还原到新列表里，把列表又滚下去。
   */
  const handleWorktreeSwitch = () => {
    clearDraft();
    groupsEl.scrollTop = 0;
    if (groupsEl.contains(doc.activeElement)) doc.activeElement.blur();
  };

  return {
    render,
    clearDraft,
    handleWorktreeSwitch,
  };
};
