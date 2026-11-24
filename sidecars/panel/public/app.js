/**
 * Antigravity Git Graph 面板前端主协调入口。
 * 负责宿主主题同步、Workspace 被动跟随、挂起式长轮询、多仓库顶部切换、
 * 上下双区折叠与中缝拖拽、模态弹窗与轻提示系统，以及偏好防抖持久化。
 */

import { initThemeSync } from './modules/theme.js';
import {
  createTranslator,
  resolveLocale,
  translateApiError,
} from './modules/i18n.js';
import { createApiClient, ApiClientError } from './modules/api-client.js';
import { createChangesView } from './modules/changes-view.js';
import { createGraphView } from './modules/graph-view.js';
import { CODICON_PATHS } from './modules/codicons.js';
import { resolveFileIconUrl } from './modules/file-icons.js';
import { createToastController } from './modules/toast.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const DEFAULT_SPLIT_RATIO = 0.42;
const MIN_SPLIT_RATIO = 0.15;
const MAX_SPLIT_RATIO = 0.85;
const INITIAL_GRAPH_LIMIT = 150;
const GRAPH_PAGE_STEP = 200;
const GRAPH_SOFT_LIMIT = 2000;
const EVENTS_WAIT_TIMEOUT_MS = 20000;
const WORKSPACE_BOOTSTRAP_TIMEOUT_MS = 1200;

const clampSplitRatio = (value) => {
  if (!Number.isFinite(value)) return DEFAULT_SPLIT_RATIO;
  return Math.max(MIN_SPLIT_RATIO, Math.min(MAX_SPLIT_RATIO, Number(value.toFixed(4))));
};

/**
 * 创建 16×16 Codicon 填充图标元素（无全局状态副作用）。
 *
 * @param {string} name `CODICON_PATHS` 中的图标名
 * @param {string} [extraClass=''] 追加 CSS 类名
 * @returns {SVGElement} 内联矢量图标 DOM 节点
 */
export const createIcon = (name, extraClass = '') => {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', extraClass ? `gw-icon ${extraClass}` : 'gw-icon');
  for (const entry of CODICON_PATHS[name]) {
    const pathEl = document.createElementNS(SVG_NS, 'path');
    if (typeof entry === 'string') {
      pathEl.setAttribute('d', entry);
    } else {
      pathEl.setAttribute('d', entry.d);
      pathEl.setAttribute('fill-rule', 'evenodd');
      pathEl.setAttribute('clip-rule', 'evenodd');
    }
    svg.append(pathEl);
  }
  return svg;
};

const currentThemeMode = () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');

/**
 * 创建 16×16 文件类型图标（vscode-icons）元素，按当前明暗主题选取图标变体（无全局状态副作用）。
 *
 * @param {string} filePath 仓库内相对路径
 * @returns {HTMLImageElement} 文件图标节点，`data-file-path` 供主题切换时重新解析
 */
export const createFileIcon = (filePath) => {
  const img = document.createElement('img');
  img.className = 'gw-file-icon';
  img.alt = '';
  img.width = 16;
  img.height = 16;
  img.dataset.filePath = filePath;
  img.src = resolveFileIconUrl(filePath, currentThemeMode());
  return img;
};

/**
 * 将相对文件路径拆分为「文件名 + 目录」双段结构，在窄栏下优先压缩目录保留文件名完整可见。
 *
 * @param {string} filePath 文件相对路径
 * @param {string | null} [origPath=null] 重命名或复制时的源路径
 * @returns {HTMLElement} 拆分路径 DOM 容器（无全局副作用）
 */
export const createSplitPath = (filePath, origPath = null) => {
  const safePath = typeof filePath === 'string' ? filePath : '';
  const lastSlash = safePath.lastIndexOf('/');
  const fileName = lastSlash >= 0 ? safePath.slice(lastSlash + 1) : safePath;
  const dirPart = lastSlash > 0 ? safePath.slice(0, lastSlash) : '';

  const wrapper = document.createElement('span');
  wrapper.className = 'gw-split-path';

  const nameSpan = document.createElement('span');
  nameSpan.className = 'gw-file-name';
  nameSpan.textContent = fileName || safePath;
  wrapper.append(nameSpan);

  const dirDisplay = origPath
    ? (dirPart ? `${dirPart} ← ${origPath}` : `← ${origPath}`)
    : dirPart;

  if (dirDisplay) {
    const dirSpan = document.createElement('span');
    dirSpan.className = 'gw-file-dir';
    dirSpan.textContent = dirDisplay;
    wrapper.append(dirSpan);
  }

  return wrapper;
};

const readQueryParam = (key) => {
  try {
    return new URLSearchParams(window.location.search).get(key);
  } catch {
    return null;
  }
};

const safeReadLocalPrefs = () => {
  try {
    const raw = window.localStorage?.getItem('ag-git-graph:prefs');
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
};

const safeWriteLocalPrefs = (prefs) => {
  try {
    window.localStorage?.setItem('ag-git-graph:prefs', JSON.stringify(prefs));
  } catch {
    // sandbox="allow-scripts" 隔离 iframe 下禁止访问 localStorage 时静默跳过
  }
};

const areStringArraysEqual = (a, b) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
};

const bootstrapPanel = () => {
  const appEl = document.getElementById('app');
  if (!appEl || window.__agGitGraphPanelInstalled) {
    return;
  }
  window.__agGitGraphPanelInstalled = true;

  const queryTheme = readQueryParam('theme');
  if (queryTheme === 'dark' || queryTheme === 'light') {
    document.documentElement.setAttribute('data-theme-mode', queryTheme);
  }

  initThemeSync({
    root: document.documentElement,
    win: window,
    onThemeChange: ({ mode }) => {
      for (const img of document.querySelectorAll('img.gw-file-icon')) {
        img.src = resolveFileIconUrl(img.dataset.filePath, mode);
      }
    },
  });

  const repoBarEl = document.getElementById('repo-bar');
  const repoBarIconEl = document.getElementById('repo-bar-icon');
  const repoSelectEl = document.getElementById('repo-select');
  const repoBranchMetaEl = document.getElementById('repo-branch-meta');
  const globalBannersEl = document.getElementById('global-banners');
  const loadingStateEl = document.getElementById('loading-state');
  const loadingStateTextEl = document.getElementById('loading-state-text');
  const emptyStateEl = document.getElementById('empty-state');
  const emptyStateIconEl = document.getElementById('empty-state-icon');
  const emptyStateTitleEl = document.getElementById('empty-state-title');
  const emptyStateDescEl = document.getElementById('empty-state-desc');
  const dualPaneEl = document.getElementById('dual-pane');

  const changesSectionEl = document.getElementById('section-changes');
  const changesCollapseBtnEl = document.getElementById('changes-collapse-btn');
  const changesChevronEl = document.getElementById('changes-collapse-chevron');
  const changesTitleEl = document.getElementById('changes-section-title');
  const changesBodyEl = document.getElementById('section-changes-body');

  const sashEl = document.getElementById('pane-sash');

  const graphSectionEl = document.getElementById('section-graph');
  const graphCollapseBtnEl = document.getElementById('graph-collapse-btn');
  const graphChevronEl = document.getElementById('graph-collapse-chevron');
  const graphTitleEl = document.getElementById('graph-section-title');
  const graphHeaderEl = document.getElementById('graph-section-header');
  const graphToolbarEl = document.getElementById('graph-toolbar-actions');
  const graphSearchBarEl = document.getElementById('graph-search-bar');
  const graphBodyEl = document.getElementById('section-graph-body');

  const moreMenuEl = document.getElementById('graph-more-menu');
  const popoverEl = document.getElementById('commit-popover');
  const modalOverlayEl = document.getElementById('modal-overlay');
  const modalDialogEl = document.getElementById('modal-dialog');
  const toastContainerEl = document.getElementById('toast-container');

  repoBarIconEl.replaceChildren(createIcon('gitBranch'));
  emptyStateIconEl.replaceChildren(createIcon('gitBranch'));

  const localPrefs = safeReadLocalPrefs();
  const state = {
    workspaceUris: [],
    selectedRepoId: null,
    graphScope: null,
    graphLimit: INITIAL_GRAPH_LIMIT,
    prefLocale: localPrefs?.locale ?? 'auto',
    effectiveLocale: resolveLocale(localPrefs?.locale ?? 'auto'),
    splitRatio: clampSplitRatio(localPrefs?.splitRatio ?? DEFAULT_SPLIT_RATIO),
    changesCollapsed: false,
    graphCollapsed: false,
    snapshot: null,
    revision: 0,
    pendingOp: null,
    loadingMore: false,
    hasLoadedInitial: false,
    hasSyncedInitialPrefs: false,
    userOverrodeScope: false,
    userOverrodeLocale: false,
    userOverrodeSplit: false,
  };

  document.documentElement.lang = state.effectiveLocale;
  const getT = () => createTranslator(state.effectiveLocale);

  const apiClient = createApiClient({
    getLocale: () => state.effectiveLocale,
    getWorkspaceUris: () => state.workspaceUris,
  });

  // --- Toast 轻提示：就近显示在触发操作的控件旁 ---
  const { show: showToast } = createToastController({ layerEl: toastContainerEl, createIcon });

  // --- 界面内 DOM 对话框（严禁使用 window.confirm / alert / prompt） ---
  let activeModalCleanup = null;

  const closeModal = () => {
    if (activeModalCleanup) {
      activeModalCleanup();
      activeModalCleanup = null;
    }
    modalOverlayEl.classList.add('hidden');
    modalDialogEl.className = 'gw-modal';
    modalDialogEl.replaceChildren();
  };

  const openModal = ({
    title,
    body,
    confirmLabel,
    cancelLabel,
    variant = 'default',
    selectOptions = null,
    onConfirm,
  }) => {
    closeModal();
    const prevFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    modalDialogEl.className = variant === 'danger' ? 'gw-modal is-danger' : 'gw-modal';

    const headerEl = document.createElement('div');
    headerEl.className = 'gw-modal-header';

    const iconEl = document.createElement('span');
    iconEl.className = 'gw-modal-icon';
    iconEl.setAttribute('aria-hidden', 'true');
    iconEl.append(createIcon(variant === 'danger' ? 'warning' : 'info'));

    const titleEl = document.createElement('h3');
    titleEl.id = 'modal-title';
    titleEl.className = 'gw-modal-title';
    titleEl.textContent = title;
    headerEl.append(iconEl, titleEl);

    const bodyEl = document.createElement('p');
    bodyEl.className = 'gw-modal-body';
    bodyEl.textContent = body;

    let selectEl = null;
    if (Array.isArray(selectOptions) && selectOptions.length > 0) {
      selectEl = document.createElement('select');
      selectEl.className = 'gw-modal-select';
      selectEl.dataset.testid = 'modal-select';
      for (const opt of selectOptions) {
        const optionEl = document.createElement('option');
        optionEl.value = opt.value;
        optionEl.textContent = opt.label;
        selectEl.append(optionEl);
      }
    }

    const actionsEl = document.createElement('div');
    actionsEl.className = 'gw-modal-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'gw-btn-secondary';
    cancelBtn.dataset.testid = 'modal-cancel-btn';
    cancelBtn.textContent = cancelLabel;
    cancelBtn.addEventListener('click', closeModal);

    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = variant === 'danger' ? 'gw-btn-confirm is-danger' : 'gw-btn-confirm';
    confirmBtn.dataset.testid = 'modal-confirm-btn';
    confirmBtn.textContent = confirmLabel;
    confirmBtn.addEventListener('click', () => {
      const selectedValue = selectEl ? selectEl.value : undefined;
      closeModal();
      onConfirm?.(selectedValue);
    });

    actionsEl.append(cancelBtn, confirmBtn);

    if (selectEl) {
      modalDialogEl.replaceChildren(headerEl, bodyEl, selectEl, actionsEl);
    } else {
      modalDialogEl.replaceChildren(headerEl, bodyEl, actionsEl);
    }

    modalOverlayEl.classList.remove('hidden');

    const handleOverlayClick = (event) => {
      if (event.target === modalOverlayEl) {
        closeModal();
      }
    };
    const handleKeydown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeModal();
        return;
      }
      if (event.key === 'Tab') {
        const focusables = [...modalDialogEl.querySelectorAll('button, select, input, [tabindex]')];
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };

    modalOverlayEl.addEventListener('click', handleOverlayClick);
    document.addEventListener('keydown', handleKeydown);

    activeModalCleanup = () => {
      modalOverlayEl.removeEventListener('click', handleOverlayClick);
      document.removeEventListener('keydown', handleKeydown);
      if (prevFocused && prevFocused.isConnected) {
        prevFocused.focus({ preventScroll: true });
      }
    };

    if (selectEl) {
      selectEl.focus();
    } else if (variant === 'danger') {
      cancelBtn.focus();
    } else {
      confirmBtn.focus();
    }
  };

  // --- 局部重渲染键盘保焦 ---
  const captureFocus = (container) => {
    const activeEl = document.activeElement;
    if (!activeEl || !container.contains(activeEl)) return null;
    let wasFocusVisible = false;
    try {
      wasFocusVisible = activeEl.matches(':focus-visible');
    } catch {
      wasFocusVisible = false;
    }
    if (!wasFocusVisible) return null;

    const focusId = activeEl.getAttribute('data-focus-id');
    const rowEl = activeEl.closest('[data-focus-group]');
    return {
      focusId,
      wasFocusVisible: true,
      group: rowEl?.getAttribute('data-focus-group') ?? null,
      index: rowEl ? Number(rowEl.getAttribute('data-focus-index')) : null,
    };
  };

  const restoreFocus = (container, savedFocus) => {
    if (!savedFocus?.wasFocusVisible) return;
    let target = null;

    if (savedFocus.focusId) {
      const candidates = container.querySelectorAll('[data-focus-id]');
      for (const candidate of candidates) {
        if (candidate.getAttribute('data-focus-id') === savedFocus.focusId) {
          target = candidate;
          break;
        }
      }
    }

    if (!target && savedFocus.group && Number.isFinite(savedFocus.index)) {
      const groupRows = [...container.querySelectorAll(`.gw-file-row[data-focus-group="${savedFocus.group}"]`)];
      if (groupRows.length > 0) {
        target = groupRows[Math.min(savedFocus.index, groupRows.length - 1)];
      } else {
        target = container.querySelector(`[data-testid="group-toggle-${savedFocus.group}"]`)
          ?? container.querySelector('.gw-file-row, .gw-group-toggle');
      }
    }

    if (target instanceof HTMLElement && !target.hasAttribute('disabled')) {
      target.focus({ preventScroll: true });
    }
  };

  // --- 偏好防抖持久化 ---
  let pendingPrefsPatch = {};
  let prefsDebounceTimer = null;

  const scheduleSavePreferences = (patch, delayMs = 180) => {
    pendingPrefsPatch = { ...pendingPrefsPatch, ...patch };
    safeWriteLocalPrefs({
      locale: state.prefLocale,
      graphScope: state.graphScope ?? 'auto',
      splitRatio: state.splitRatio,
    });
    if (prefsDebounceTimer !== null) {
      window.clearTimeout(prefsDebounceTimer);
    }
    prefsDebounceTimer = window.setTimeout(() => {
      const payload = pendingPrefsPatch;
      pendingPrefsPatch = {};
      prefsDebounceTimer = null;
      void apiClient.savePreferences(payload).catch(() => {
        // 偏好写入失败不打断用户当前工作流
      });
    }, delayMs);
  };

  // --- 宿主文件打开 ---
  const openFileInHost = (file, anchorEl) => {
    if (!file || file.existsInWorktree === false) return;
    const t = getT();
    if (typeof window.sidecar?.ui?.toggleAuxPane === 'function' && file.fileUri) {
      window.sidecar.ui.toggleAuxPane({ tabType: 'fileView', uri: file.fileUri });
      return;
    }
    showToast(t('graph.standaloneFilePreviewNotice'), 'info', { anchor: anchorEl });
  };

  // --- 业务请求与状态刷新 ---
  let snapshotAbortController = null;
  let snapshotRequestSeq = 0;
  let eventsAbortController = null;
  let eventsLoopToken = 0;
  let eventsLoopActive = false;
  let eventsRestartTimer = null;
  let eventsBackoffMs = 1200;

  const abortEventsWait = () => {
    eventsLoopToken += 1;
    eventsLoopActive = false;
    if (eventsRestartTimer !== null) {
      window.clearTimeout(eventsRestartTimer);
      eventsRestartTimer = null;
    }
    if (eventsAbortController) {
      eventsAbortController.abort();
      eventsAbortController = null;
    }
  };

  const handleApiError = (err, anchor = null) => {
    if (err?.name === 'AbortError') return;
    if (err instanceof ApiClientError) {
      showToast(err.message, 'error', { detail: err.detail, anchor });
      return;
    }
    const t = getT();
    showToast(translateApiError({ message: err?.message }, t.locale), 'error', { anchor });
  };

  /**
   * 串行执行一次写操作并刷新快照；失败提示显示在 `anchor` 控件旁。
   *
   * @param {string} opName 写操作名（同时作为 `pendingOp` 驱动按钮忙碌态）
   * @param {() => Promise<void>} fn 实际请求
   * @param {Element | null} anchor 触发该操作的控件，提示就近显示
   * @returns {Promise<boolean>} 请求是否成功
   */
  const runMutation = async (opName, fn, anchor) => {
    if (state.pendingOp) return false;
    state.pendingOp = opName;
    abortEventsWait();
    renderAll();
    let ranSnapshot = false;
    try {
      await fn();
      ranSnapshot = true;
      await loadSnapshot({ forceRefresh: false, toastAnchor: anchor });
      return true;
    } catch (err) {
      handleApiError(err, anchor);
      if (!ranSnapshot) {
        restartEventsWaitLoop();
      }
      return false;
    } finally {
      state.pendingOp = null;
      renderAll();
    }
  };

  const runPushOrPublish = (repo, anchor, explicitRemote = null) => {
    const t = getT();
    const remotes = Array.isArray(repo?.remotes) ? repo.remotes : [];
    if (remotes.length === 0) {
      showToast(translateApiError({ code: 'NO_REMOTE' }, t.locale), 'error', { anchor });
      return;
    }

    const isPublish = !repo.upstream;
    if (isPublish && !explicitRemote && remotes.length >= 2) {
      openModal({
        title: t('modal.chooseRemote.title'),
        body: t('modal.chooseRemote.body', { branch: repo.branch || '' }),
        confirmLabel: t('modal.chooseRemote.confirm'),
        cancelLabel: t('modal.cancel'),
        selectOptions: remotes.map((remoteName) => ({ value: remoteName, label: remoteName })),
        onConfirm: (selectedRemote) => {
          if (selectedRemote) {
            runPushOrPublish(repo, anchor, selectedRemote);
          }
        },
      });
      return;
    }

    const targetRemote = isPublish ? (explicitRemote || remotes[0]) : undefined;
    void runMutation(isPublish ? 'publish' : 'push', async () => {
      const payload = targetRemote
        ? { worktreePath: repo.worktreePath, remote: targetRemote }
        : { worktreePath: repo.worktreePath };
      await apiClient.pushBranch(payload);
      if (isPublish) {
        showToast(t('remote.publishSuccess', { branch: repo.branch || '', remote: targetRemote }), 'success', { anchor });
      } else {
        showToast(t('remote.pushSuccess'), 'success', { anchor });
      }
    }, anchor);
  };

  const changesView = createChangesView(
    {
      bodyEl: changesBodyEl,
      sectionTitleEl: changesTitleEl,
    },
    {
      createIcon,
      createFileIcon,
      createSplitPath,
      captureFocus,
      restoreFocus,
      openModal,
      onOpenFile: openFileInHost,
      onStage: async ({ worktreePath, all, paths }) => {
        await runMutation('stage', async () => {
          const payload = all ? { worktreePath, all: true } : { worktreePath, all: false, paths };
          await apiClient.stageChanges(payload);
        }, commitButtonEl);
      },
      onUnstage: async ({ worktreePath, all, paths }) => {
        await runMutation('unstage', async () => {
          const payload = all ? { worktreePath, all: true } : { worktreePath, all: false, paths };
          await apiClient.unstageChanges(payload);
        }, commitButtonEl);
      },
      onDiscard: async ({ worktreePath, allTracked, paths, untracked }) => {
        await runMutation('discard', async () => {
          const payload = allTracked
            ? { worktreePath, allTracked: true, untracked: false }
            : { worktreePath, allTracked: false, paths, untracked };
          await apiClient.discardChanges(payload);
        }, commitButtonEl);
      },
      onCommit: async ({ worktreePath, repoId, message, autoStageAll }) => {
        const t = getT();
        let committedSha = '';
        const ok = await runMutation('commit', async () => {
          const res = await apiClient.commitChanges({ worktreePath, message, autoStageAll });
          changesView.clearDraft(repoId);
          committedSha = typeof res?.sha === 'string' ? res.sha : '';
        }, commitButtonEl);
        if (ok) {
          const shortSha = (committedSha || state.snapshot?.activeRepo?.headOid || '').slice(0, 7);
          if (shortSha) {
            showToast(t('commit.successToast', { sha: shortSha }), 'success', { anchor: commitButtonEl });
          }
        }
        return ok;
      },
      onPublish: (repo) => runPushOrPublish(repo, commitButtonEl),
      onPush: async (repo) => runPushOrPublish(repo, commitButtonEl),
      onPull: async (repo) => {
        const t = getT();
        await runMutation('pull', async () => {
          await apiClient.pullBranch({ worktreePath: repo.worktreePath });
          showToast(t('remote.pullSuccess'), 'success', { anchor: commitButtonEl });
        }, commitButtonEl);
      },
    },
  );
  // 上区操作（提交、暂存、推送等）的提示统一显示在提交按钮下方
  const commitButtonEl = document.getElementById('commit-primary-btn');

  const handleManualRefresh = async (anchor) => {
    if (state.pendingOp) return;
    const t = getT();
    graphView.clearDetailCache();
    const ok = await loadSnapshot({ forceRefresh: true, toastAnchor: anchor });
    if (ok) {
      showToast(t('remote.refreshed'), 'info', { anchor });
    }
  };

  const graphView = createGraphView(
    {
      sectionTitleEl: graphTitleEl,
      toolbarActionsEl: graphToolbarEl,
      searchBarEl: graphSearchBarEl,
      bodyEl: graphBodyEl,
      moreMenuEl,
      popoverEl,
    },
    {
      createIcon,
      createFileIcon,
      createSplitPath,
      captureFocus,
      restoreFocus,
      showToast,
      onOpenFile: openFileInHost,
      onToggleScope: (nextScope) => {
        state.userOverrodeScope = true;
        state.graphScope = nextScope;
        state.graphLimit = INITIAL_GRAPH_LIMIT;
        scheduleSavePreferences({ graphScope: nextScope }, 80);
        void loadSnapshot({ forceRefresh: false, toastAnchor: graphHeaderEl });
      },
      onFetch: async (repo) => {
        const t = getT();
        await runMutation('fetch', async () => {
          await apiClient.fetchRemotes({
            worktreePath: repo.worktreePath ?? null,
            repoId: repo.id ?? null,
          });
          showToast(t('remote.fetchSuccess'), 'success', { anchor: graphHeaderEl });
        }, graphHeaderEl);
      },
      onPull: async (repo) => {
        const t = getT();
        await runMutation('pull', async () => {
          await apiClient.pullBranch({ worktreePath: repo.worktreePath });
          showToast(t('remote.pullSuccess'), 'success', { anchor: graphHeaderEl });
        }, graphHeaderEl);
      },
      onPushOrPublish: (repo) => runPushOrPublish(repo, graphHeaderEl),
      onRefresh: () => handleManualRefresh(graphHeaderEl),
      onLoadMore: async () => {
        if (state.loadingMore) return;
        state.loadingMore = true;
        renderAll();
        try {
          state.graphLimit = Math.min(GRAPH_SOFT_LIMIT, state.graphLimit + GRAPH_PAGE_STEP);
          await loadSnapshot({ forceRefresh: false });
        } finally {
          state.loadingMore = false;
          renderAll();
        }
      },
      onSwitchLanguage: () => {
        const nextLocale = state.effectiveLocale === 'zh-CN' ? 'en' : 'zh-CN';
        state.userOverrodeLocale = true;
        state.prefLocale = nextLocale;
        state.effectiveLocale = resolveLocale(nextLocale);
        document.documentElement.lang = state.effectiveLocale;
        scheduleSavePreferences({ locale: nextLocale }, 80);
        renderAll();
      },
      onLoadCommitDetail: async (worktreePath, sha, repoId) =>
        apiClient.fetchCommitDetail({ worktreePath, repoId, sha }),
    },
  );

  // --- 双区折叠与 4px 中缝拖拽 ---
  const applyPaneLayout = () => {
    const t = getT();
    state.splitRatio = clampSplitRatio(state.splitRatio);
    dualPaneEl.style.setProperty('--gw-split-ratio', String(state.splitRatio));

    const changesExpanded = !state.changesCollapsed;
    const graphExpanded = !state.graphCollapsed;

    changesSectionEl.classList.toggle('is-collapsed', state.changesCollapsed);
    changesSectionEl.classList.toggle('is-expanded-sole', changesExpanded && !graphExpanded);
    changesCollapseBtnEl.setAttribute('aria-expanded', String(changesExpanded));
    changesCollapseBtnEl.setAttribute(
      'aria-label',
      changesExpanded
        ? t('section.collapse', { section: t('section.changes') })
        : t('section.expand', { section: t('section.changes') }),
    );
    changesChevronEl.replaceChildren(createIcon(changesExpanded ? 'chevronDown' : 'chevronRight'));

    graphSectionEl.classList.toggle('is-collapsed', state.graphCollapsed);
    graphSectionEl.classList.toggle('is-expanded-sole', graphExpanded && !changesExpanded);
    graphCollapseBtnEl.setAttribute('aria-expanded', String(graphExpanded));
    graphCollapseBtnEl.setAttribute(
      'aria-label',
      graphExpanded
        ? t('section.collapse', { section: t('section.graph') })
        : t('section.expand', { section: t('section.graph') }),
    );
    graphChevronEl.replaceChildren(createIcon(graphExpanded ? 'chevronDown' : 'chevronRight'));

    const showSash = changesExpanded && graphExpanded;
    sashEl.classList.toggle('hidden', !showSash);
    sashEl.setAttribute('aria-label', t('section.resizeSash'));
    sashEl.setAttribute('aria-valuenow', String(Math.round(state.splitRatio * 100)));
  };

  changesCollapseBtnEl.addEventListener('click', () => {
    state.changesCollapsed = !state.changesCollapsed;
    graphView.closeOverlays();
    applyPaneLayout();
  });

  graphCollapseBtnEl.addEventListener('click', () => {
    state.graphCollapsed = !state.graphCollapsed;
    graphView.closeOverlays();
    applyPaneLayout();
  });

  let activeDragPointerId = null;

  const stopSashDrag = () => {
    if (activeDragPointerId === null) return;
    activeDragPointerId = null;
    sashEl.classList.remove('is-dragging');
    document.body.classList.remove('is-resizing-panes');
    state.userOverrodeSplit = true;
    scheduleSavePreferences({ splitRatio: state.splitRatio }, 160);
  };

  sashEl.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || state.changesCollapsed || state.graphCollapsed) return;
    event.preventDefault();
    activeDragPointerId = event.pointerId;
    sashEl.setPointerCapture?.(event.pointerId);
    sashEl.classList.add('is-dragging');
    document.body.classList.add('is-resizing-panes');
    graphView.closeOverlays();
  });

  sashEl.addEventListener('pointermove', (event) => {
    if (activeDragPointerId !== event.pointerId) return;
    const rect = dualPaneEl.getBoundingClientRect();
    if (rect.height <= 0) return;
    state.splitRatio = clampSplitRatio((event.clientY - rect.top) / rect.height);
    applyPaneLayout();
  });

  sashEl.addEventListener('pointerup', (event) => {
    if (activeDragPointerId === event.pointerId) {
      stopSashDrag();
    }
  });

  sashEl.addEventListener('pointercancel', (event) => {
    if (activeDragPointerId === event.pointerId) {
      stopSashDrag();
    }
  });

  sashEl.addEventListener('keydown', (event) => {
    if (state.changesCollapsed || state.graphCollapsed) return;
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      const delta = event.key === 'ArrowUp' ? -0.05 : 0.05;
      state.splitRatio = clampSplitRatio(state.splitRatio + delta);
      state.userOverrodeSplit = true;
      applyPaneLayout();
      scheduleSavePreferences({ splitRatio: state.splitRatio }, 160);
    }
  });

  // --- 顶部多仓库条与全局横幅渲染 ---
  const formatRepoBranchSuffix = (repo, t) => {
    if (repo.isBare) return t('repo.bareLabel');
    if (repo.isDetached) return t('repo.detachedLabel');
    if (repo.isUnborn) return repo.branch ? `${repo.branch} · ${t('repo.unbornLabel')}` : t('repo.unbornLabel');
    return repo.branch || '';
  };

  const renderRepoBar = (snapshot, t) => {
    const repositories = Array.isArray(snapshot?.repositories) ? snapshot.repositories : [];
    if (repositories.length < 2) {
      repoBarEl.classList.add('hidden');
      repoSelectEl.replaceChildren();
      repoBranchMetaEl.textContent = '';
      return;
    }

    repoBarEl.classList.remove('hidden');
    repoSelectEl.setAttribute('aria-label', t('repo.switcherAria'));
    repoSelectEl.title = t('repo.switcherLabel');

    const activeId = snapshot.activeRepo?.id ?? state.selectedRepoId ?? repositories[0].id;
    const fragment = document.createDocumentFragment();
    for (const repo of repositories) {
      const optionEl = document.createElement('option');
      optionEl.value = repo.id;
      const repoForSuffix = repo.id === activeId && snapshot.activeRepo ? snapshot.activeRepo : repo;
      const suffix = formatRepoBranchSuffix(repoForSuffix, t);
      optionEl.textContent = suffix ? `${repo.name} (${suffix})` : repo.name;
      optionEl.selected = repo.id === activeId;
      fragment.append(optionEl);
    }
    repoSelectEl.replaceChildren(fragment);
    repoSelectEl.value = activeId;

    const activeMeta = snapshot.activeRepo ? formatRepoBranchSuffix(snapshot.activeRepo, t) : '';
    repoBranchMetaEl.textContent = activeMeta;
    repoBranchMetaEl.title = activeMeta;
  };

  repoSelectEl.addEventListener('change', () => {
    const nextId = repoSelectEl.value;
    if (!nextId || nextId === state.selectedRepoId) return;
    state.selectedRepoId = nextId;
    state.graphLimit = INITIAL_GRAPH_LIMIT;
    graphView.clearDetailCache();
    void loadSnapshot({ forceRefresh: false });
  });

  const renderGlobalBanners = (snapshot, t) => {
    if (!snapshot?.watchState?.degraded) {
      globalBannersEl.classList.add('hidden');
      globalBannersEl.replaceChildren();
      return;
    }

    const savedFocus = captureFocus(globalBannersEl);

    const bannerEl = document.createElement('div');
    bannerEl.className = 'gw-banner is-warning';
    bannerEl.dataset.testid = 'watch-degraded-banner';
    bannerEl.setAttribute('role', 'status');

    const iconWrap = document.createElement('span');
    iconWrap.className = 'gw-banner-icon';
    iconWrap.setAttribute('aria-hidden', 'true');
    iconWrap.append(createIcon('warning'));

    const textEl = document.createElement('span');
    textEl.className = 'gw-banner-text';
    textEl.textContent = t('watch.degradedBanner');

    const refreshBtn = document.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.className = 'gw-banner-action gw-clip-focus';
    refreshBtn.dataset.testid = 'watch-degraded-refresh-btn';
    refreshBtn.dataset.focusId = 'watch-degraded-refresh';
    refreshBtn.title = t('graph.action.refreshTitle');
    refreshBtn.setAttribute('aria-label', t('graph.action.refreshTitle'));
    refreshBtn.disabled = Boolean(state.pendingOp);
    refreshBtn.append(createIcon('refresh'));
    const refreshLabel = document.createElement('span');
    refreshLabel.textContent = t('graph.action.refresh');
    refreshBtn.append(refreshLabel);
    refreshBtn.addEventListener('click', () => {
      void handleManualRefresh(globalBannersEl);
    });

    bannerEl.append(iconWrap, textEl, refreshBtn);
    globalBannersEl.replaceChildren(bannerEl);
    globalBannersEl.classList.remove('hidden');
    restoreFocus(globalBannersEl, savedFocus);
  };

  const renderAll = () => {
    const t = getT();
    const snapshot = state.snapshot;
    const repositories = Array.isArray(snapshot?.repositories) ? snapshot.repositories : [];

    renderRepoBar(snapshot, t);
    renderGlobalBanners(snapshot, t);
    applyPaneLayout();

    if (!state.hasLoadedInitial) {
      if (loadingStateTextEl) {
        loadingStateTextEl.textContent = t('loading.repository');
      }
      loadingStateEl?.classList.remove('hidden');
      emptyStateEl.classList.add('hidden');
      dualPaneEl.classList.add('hidden');
      return;
    }

    loadingStateEl?.classList.add('hidden');

    if (repositories.length === 0 || !snapshot?.activeRepo) {
      dualPaneEl.classList.add('hidden');
      emptyStateEl.classList.remove('hidden');
      emptyStateTitleEl.textContent = t('empty.noRepo.title');
      emptyStateDescEl.textContent = t('empty.noRepo.description');
      return;
    }

    emptyStateEl.classList.add('hidden');
    dualPaneEl.classList.remove('hidden');

    changesView.render({
      activeRepo: snapshot.activeRepo,
      changes: snapshot.changes,
      pendingOp: state.pendingOp,
      t,
    });

    graphView.render({
      activeRepo: snapshot.activeRepo,
      graph: snapshot.graph,
      graphScope: state.graphScope ?? snapshot.graph?.scope ?? 'auto',
      pendingOp: state.pendingOp,
      loadingMore: state.loadingMore,
      locale: state.effectiveLocale,
      t,
    });
  };

  // --- 快照加载与挂起式长轮询 ---
  const scheduleEventsWaitRestart = () => {
    if (document.hidden || !state.snapshot?.workspaceKey || eventsLoopActive || eventsRestartTimer !== null) {
      return;
    }
    const delayMs = eventsBackoffMs;
    eventsBackoffMs = Math.min(5000, eventsBackoffMs * 2);
    eventsRestartTimer = window.setTimeout(() => {
      eventsRestartTimer = null;
      if (!document.hidden && state.snapshot?.workspaceKey && !snapshotAbortController) {
        restartEventsWaitLoop();
      }
    }, delayMs);
  };

  const restartEventsWaitLoop = () => {
    abortEventsWait();
    if (document.hidden || !state.snapshot?.workspaceKey) {
      return;
    }

    const token = eventsLoopToken;
    eventsLoopActive = true;
    const poll = async () => {
      try {
        while (token === eventsLoopToken && !document.hidden && state.snapshot?.workspaceKey) {
          const controller = new AbortController();
          eventsAbortController = controller;
          try {
            const eventRes = await apiClient.waitEvents(
              {
                workspaceKey: state.snapshot.workspaceKey,
                sinceRevision: state.revision,
                timeoutMs: EVENTS_WAIT_TIMEOUT_MS,
              },
              controller.signal,
            );
            eventsBackoffMs = 1200;
            if (token !== eventsLoopToken || document.hidden) return;

            const shouldRefresh = Boolean(eventRes?.changed)
              || (Number.isFinite(eventRes?.revision) && eventRes.revision > state.revision)
              || Boolean(eventRes?.watchDegraded && !state.snapshot?.watchState?.degraded);

            if (shouldRefresh) {
              // loadSnapshot 会立即接管长轮询生命周期（成功重启、失败退避重连），当前循环直接退出
              await loadSnapshot({ forceRefresh: false });
              return;
            }
          } catch (err) {
            // 仅本端主动取消或页面不可见时退出；宿主 fetch 超时/连接重置等外部 AbortError 必须退避重连
            if (controller.signal.aborted || token !== eventsLoopToken || document.hidden) {
              return;
            }
            await new Promise((resolve) => window.setTimeout(resolve, eventsBackoffMs));
            eventsBackoffMs = Math.min(5000, eventsBackoffMs * 2);
          } finally {
            if (eventsAbortController === controller) {
              eventsAbortController = null;
            }
          }
        }
      } finally {
        if (token === eventsLoopToken) {
          eventsLoopActive = false;
        }
      }
    };

    void poll();
  };

  const loadSnapshot = async ({ forceRefresh = false, toastAnchor = null } = {}) => {
    snapshotRequestSeq += 1;
    const reqSeq = snapshotRequestSeq;
    abortEventsWait();

    if (snapshotAbortController) {
      snapshotAbortController.abort();
    }
    const controller = new AbortController();
    snapshotAbortController = controller;

    const payload = {
      workspaceUris: state.workspaceUris,
      graphLimit: state.graphLimit,
      forceRefresh,
    };
    if (state.selectedRepoId) {
      payload.selectedRepoId = state.selectedRepoId;
    }
    if (state.graphScope) {
      payload.graphScope = state.graphScope;
    }

    let nextSnapshot;
    try {
      nextSnapshot = await apiClient.fetchSnapshot(payload, controller.signal);
    } catch (err) {
      if (reqSeq === snapshotRequestSeq) {
        if (!controller.signal.aborted && err?.name !== 'AbortError') {
          state.hasLoadedInitial = true;
          renderAll();
          handleApiError(err, toastAnchor);
        }
        // 快照失败后仍需退避恢复长轮询，防止页面回切或瞬时异常后自动同步永久停摆
        scheduleEventsWaitRestart();
      }
      return false;
    } finally {
      if (snapshotAbortController === controller) {
        snapshotAbortController = null;
      }
    }

    if (reqSeq !== snapshotRequestSeq) return false;

    const prevRepoId = state.snapshot?.activeRepo?.id ?? null;
    const nextRepoId = nextSnapshot?.activeRepo?.id ?? null;
    if (prevRepoId !== nextRepoId) {
      graphView.clearDetailCache();
      state.graphLimit = INITIAL_GRAPH_LIMIT;
    }

    state.snapshot = nextSnapshot;
    state.revision = Number(nextSnapshot?.revision ?? 0);
    state.selectedRepoId = nextRepoId;
    state.hasLoadedInitial = true;
    eventsBackoffMs = 1200;

    if (!state.hasSyncedInitialPrefs) {
      state.hasSyncedInitialPrefs = true;
      const prefs = nextSnapshot?.preferences;
      if (!state.userOverrodeLocale && prefs?.locale) {
        state.prefLocale = prefs.locale;
        state.effectiveLocale = resolveLocale(state.prefLocale);
        document.documentElement.lang = state.effectiveLocale;
      }
      if (!state.userOverrodeSplit && Number.isFinite(prefs?.splitRatio)) {
        state.splitRatio = clampSplitRatio(prefs.splitRatio);
      }
      if (!state.userOverrodeScope) {
        const persistedScope = prefs?.graphScope;
        const returnedScope = nextSnapshot?.graph?.scope;
        state.graphScope = returnedScope || persistedScope || 'auto';
        if (persistedScope && returnedScope && persistedScope !== returnedScope) {
          state.graphScope = persistedScope;
          renderAll();
          void loadSnapshot({ forceRefresh: false });
          return true;
        }
      }
    } else if (!state.graphScope && nextSnapshot?.graph?.scope) {
      state.graphScope = nextSnapshot.graph.scope;
    }

    renderAll();
    restartEventsWaitLoop();
    return true;
  };

  // --- 宿主工作区跟随与页面可见性联动 ---
  let workspaceEventHandled = false;

  const handleWorkspaceChange = (nextUris) => {
    workspaceEventHandled = true;
    const normalized = Array.isArray(nextUris)
      ? nextUris.filter((item) => typeof item === 'string' && item.trim())
      : [];
    if (snapshotRequestSeq > 0 && areStringArraysEqual(state.workspaceUris, normalized)) {
      return;
    }
    state.workspaceUris = normalized;
    state.graphLimit = INITIAL_GRAPH_LIMIT;
    void loadSnapshot({ forceRefresh: false });
  };

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      abortEventsWait();
    } else if (state.hasLoadedInitial) {
      void loadSnapshot({ forceRefresh: false });
    }
  });

  window.addEventListener('focus', () => {
    if (
      !document.hidden &&
      state.hasLoadedInitial &&
      state.snapshot?.workspaceKey &&
      !eventsLoopActive &&
      !snapshotAbortController &&
      eventsRestartTimer === null
    ) {
      restartEventsWaitLoop();
    }
  });

  window.addEventListener('beforeunload', () => {
    abortEventsWait();
    snapshotAbortController?.abort();
  });

  if (typeof window.sidecar?.onWorkspaceChange === 'function') {
    window.sidecar.onWorkspaceChange(handleWorkspaceChange);
  }

  const initWorkspaceAndBoot = async () => {
    if (typeof window.sidecar?.getWorkspaceUris === 'function') {
      const initialUris = await Promise.race([
        window.sidecar.getWorkspaceUris().catch(() => []),
        new Promise((resolve) => window.setTimeout(() => resolve(null), WORKSPACE_BOOTSTRAP_TIMEOUT_MS)),
      ]);
      if (Array.isArray(initialUris)) {
        const normalized = initialUris.filter((item) => typeof item === 'string' && item.trim());
        if (workspaceEventHandled && snapshotRequestSeq > 0 && areStringArraysEqual(state.workspaceUris, normalized)) {
          return;
        }
        state.workspaceUris = normalized;
      } else if (workspaceEventHandled && snapshotRequestSeq > 0) {
        return;
      }
    }

    await loadSnapshot({ forceRefresh: false });
  };

  if (loadingStateTextEl) {
    loadingStateTextEl.textContent = getT()('loading.repository');
  }
  applyPaneLayout();
  void initWorkspaceAndBoot();
};

const safeBootstrapPanel = () => {
  try {
    bootstrapPanel();
  } catch (error) {
    const loadingEl = document.getElementById('loading-state');
    const emptyEl = document.getElementById('empty-state');
    const titleEl = document.getElementById('empty-state-title');
    const descEl = document.getElementById('empty-state-desc');
    loadingEl?.classList.add('hidden');
    if (emptyEl && titleEl && descEl) {
      const t = createTranslator(resolveLocale('auto'));
      titleEl.textContent = t('error.bootFailed');
      descEl.textContent = error instanceof Error ? error.message : String(error);
      emptyEl.classList.remove('hidden');
    }
    console.error('[antigravity-git-worktree] Failed to bootstrap panel:', error);
  }
};

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', safeBootstrapPanel, { once: true });
  } else {
    safeBootstrapPanel();
  }
}
