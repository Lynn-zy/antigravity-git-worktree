/**
 * Antigravity Git Graph 上区「更改」视图组件，布局对齐 VS Code 源代码管理「更改」视图。
 * 负责特殊状态横幅（冲突/游离 HEAD/裸仓）、按 repo.id 内存保留的提交草稿、
 * 智能主按钮状态机、可折叠变更分组及三档 Discard 安全确认护栏。
 */

const PRIMARY_ICON_BY_ACTION = Object.freeze({
  commit: 'check',
  'clean-disabled': 'check',
  'conflict-blocked': 'warning',
  publish: 'cloudUpload',
  push: 'repoPush',
  pull: 'repoPull',
});

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

/**
 * 按 specs 7.2.3 互斥优先级计算智能主按钮当前状态与交互语义。
 *
 * @param {{
 *   activeRepo: Record<string, any> | null,
 *   changes: { conflicted?: any[], staged?: any[], unstaged?: any[] } | null,
 *   pendingOp: string | null,
 *   t: (key: string, params?: Record<string, unknown>) => string
 * }} params 当前仓库、变更集合、异步状态与翻译器
 * @returns {{
 *   action: 'busy' | 'conflict-blocked' | 'commit' | 'publish' | 'push' | 'pull' | 'clean-disabled',
 *   label: string,
 *   title: string,
 *   hint: string,
 *   disabled: boolean,
 *   conflictBlocked: boolean
 * }} 主按钮渲染描述对象（无副作用）
 */
export const computePrimaryButtonState = ({ activeRepo, changes, pendingOp, t }) => {
  if (pendingOp === 'commit') {
    return {
      action: 'busy',
      label: t('primary.committing'),
      title: t('primary.committing'),
      hint: '',
      disabled: true,
      conflictBlocked: false,
    };
  }
  if (pendingOp === 'publish') {
    return {
      action: 'busy',
      label: t('primary.publishing'),
      title: t('primary.publishing'),
      hint: '',
      disabled: true,
      conflictBlocked: false,
    };
  }
  if (pendingOp === 'push') {
    return {
      action: 'busy',
      label: t('primary.pushing'),
      title: t('primary.pushing'),
      hint: '',
      disabled: true,
      conflictBlocked: false,
    };
  }
  if (pendingOp === 'pull') {
    return {
      action: 'busy',
      label: t('primary.pulling'),
      title: t('primary.pulling'),
      hint: '',
      disabled: true,
      conflictBlocked: false,
    };
  }

  const conflictedCount = changes?.conflicted?.length ?? 0;
  if (conflictedCount > 0) {
    return {
      action: 'conflict-blocked',
      label: t('primary.conflictBlocked'),
      title: t('primary.conflictBlockedTitle'),
      hint: '',
      disabled: true,
      conflictBlocked: true,
    };
  }

  const stagedCount = changes?.staged?.length ?? 0;
  const unstagedCount = changes?.unstaged?.length ?? 0;
  if (stagedCount > 0 || unstagedCount > 0) {
    return {
      action: 'commit',
      label: t('primary.commit'),
      title: stagedCount > 0 ? t('primary.commitTitle') : t('primary.commitUnstagedTitle'),
      hint: '',
      disabled: false,
      conflictBlocked: false,
    };
  }

  const isUnborn = Boolean(activeRepo?.isUnborn);
  const isDetached = Boolean(activeRepo?.isDetached);
  const remotes = Array.isArray(activeRepo?.remotes) ? activeRepo.remotes : [];
  const ahead = Number(activeRepo?.ahead ?? 0);
  const behind = Number(activeRepo?.behind ?? 0);

  if (!isUnborn && !isDetached) {
    if (!activeRepo?.upstream && remotes.length > 0) {
      const branchName = activeRepo?.branch || '';
      return {
        action: 'publish',
        label: branchName
          ? t('primary.publishBranchWithName', { branch: branchName })
          : t('primary.publishBranch'),
        title: t('primary.publishBranchTitle', { branch: branchName }),
        hint: '',
        disabled: false,
        conflictBlocked: false,
      };
    }

    if (ahead > 0) {
      const behindHint = behind > 0 ? t('primary.pushBehindHint', { behind }) : '';
      return {
        action: 'push',
        label: t('primary.pushChanges', { count: ahead }),
        title: behindHint
          ? `${t('primary.pushChangesTitle', { count: ahead })} — ${behindHint}`
          : t('primary.pushChangesTitle', { count: ahead }),
        hint: behindHint,
        disabled: false,
        conflictBlocked: false,
      };
    }

    if (ahead === 0 && behind > 0) {
      return {
        action: 'pull',
        label: t('primary.pullChanges', { count: behind }),
        title: t('primary.pullChangesTitle', { count: behind }),
        hint: '',
        disabled: false,
        conflictBlocked: false,
      };
    }
  }

  return {
    action: 'clean-disabled',
    label: t('primary.commit'),
    title: t('primary.commitCleanDisabledTitle'),
    hint: '',
    disabled: true,
    conflictBlocked: false,
  };
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
 *   onCommit: (payload: { worktreePath: string, repoId: string, message: string, autoStageAll: boolean }) => Promise<boolean>,
 *   onPublish: (repo: Record<string, any>) => void,
 *   onPush: (repo: Record<string, any>) => Promise<void>,
 *   onPull: (repo: Record<string, any>) => Promise<void>
 * }} deps 外部服务与交互回调
 * @returns {{
 *   render: (state: { activeRepo: Record<string, any> | null, changes: Record<string, any> | null, pendingOp: string | null, t: (key: string, params?: Record<string, unknown>) => string }) => void,
 *   clearDraft: (repoId: string) => void
 * }} 上区视图控制接口（有 DOM 读写与事件监听副作用）
 */
export const createChangesView = (elements, deps) => {
  const { bodyEl, sectionTitleEl } = elements;
  const doc = bodyEl.ownerDocument;
  const commitShortcut = /Mac|iPhone|iPad/.test(doc.defaultView.navigator.platform) ? 'Cmd+Enter' : 'Ctrl+Enter';

  const draftsByRepo = new Map();
  const groupCollapsed = {
    conflicted: false,
    staged: false,
    unstaged: false,
  };

  let currentRepoId = null;
  let showValidationError = false;
  let latestRenderState = null;

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

  const primaryHintEl = doc.createElement('div');
  primaryHintEl.className = 'gw-primary-hint hidden';
  primaryHintEl.dataset.testid = 'commit-primary-hint';

  composerEl.append(textareaEl, validationEl, primaryBtnEl, primaryHintEl);

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
        repoId: activeRepo.id,
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
          repoId: activeRepo.id,
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
    if (btnState.action === 'push') {
      void deps.onPush(activeRepo);
      return;
    }
    if (btnState.action === 'pull') {
      void deps.onPull(activeRepo);
    }
  };

  textareaEl.addEventListener('input', () => {
    if (currentRepoId) {
      draftsByRepo.set(currentRepoId, textareaEl.value);
    }
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
      listEl.className = 'gw-group-list';
      listEl.setAttribute('role', 'list');

      files.forEach((file, index) => {
        const rowEl = doc.createElement('div');
        rowEl.className = 'gw-file-row';
        rowEl.tabIndex = 0;
        rowEl.setAttribute('role', 'listitem');
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

        listEl.append(rowEl);
      });

      groupEl.append(listEl);
    }

    return groupEl;
  };

  const render = (state) => {
    latestRenderState = state;
    const { activeRepo, changes, pendingOp, t } = state;

    sectionTitleEl.textContent = t('section.changes');

    if (!activeRepo) {
      bannersEl.classList.add('hidden');
      composerEl.classList.add('hidden');
      groupsEl.replaceChildren();
      return;
    }

    if (currentRepoId !== activeRepo.id) {
      if (currentRepoId) {
        draftsByRepo.set(currentRepoId, textareaEl.value);
      }
      currentRepoId = activeRepo.id;
      textareaEl.value = draftsByRepo.get(currentRepoId) ?? '';
      showValidationError = false;
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
    primaryBtnEl.replaceChildren(...(primaryIcon ? [deps.createIcon(primaryIcon), primaryLabelEl] : [primaryLabelEl]));
    primaryBtnEl.title = btnState.title;
    primaryBtnEl.disabled = btnState.disabled;
    primaryBtnEl.dataset.actionState = btnState.action;
    primaryBtnEl.classList.toggle('is-conflict-blocked', btnState.conflictBlocked);

    primaryHintEl.textContent = btnState.hint;
    primaryHintEl.classList.toggle('hidden', !btnState.hint);

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
    deps.restoreFocus(groupsEl, savedFocus);
  };

  const clearDraft = (repoId) => {
    if (repoId) draftsByRepo.delete(repoId);
    if (repoId === currentRepoId) {
      textareaEl.value = '';
      showValidationError = false;
      if (latestRenderState) syncValidationUi(latestRenderState.t);
    }
  };

  return {
    render,
    clearDraft,
  };
};
