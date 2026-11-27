/**
 * Antigravity Git Graph「存储库」视图组件，对齐 VS Code 源代码管理「存储库」视图。
 * 常驻显示当前 Workspace 命中的全部 Repository：每行是仓库名与当前分支，点击行切换当前仓库。
 * 只有当前仓库那一行显示同步状态：后端只监听当前仓库，其他仓库的领先、落后数会过时，所以不显示。
 * 点击同步状态执行同步或发布分支（同 VS Code 状态栏），不会改动工作区里未提交的文件；
 * 分支名只用于显示（分支 Checkout 不在 V1 范围），也不提供 ⋯ 菜单。
 */

import { formatSyncTitle } from './i18n.js';

// 正在执行这些操作时同步图标旋转，同 VS Code 的 isSyncRunning（Sync、Push、Pull）
const SYNCING_OPS = new Set(['sync', 'push', 'pull', 'publish']);

/**
 * 计算存储库行右侧的分支与同步状态，规则同 VS Code Git 扩展状态栏的 CheckoutStatusBar 与 SyncStatusBar。
 * 同步状态只对当前仓库计算。
 *
 * @param {{ isBare: boolean, isDetached: boolean, headOid: string | null, branch: string | null }
 *   | { isBare: boolean, isUnborn: boolean, isDetached: boolean, headOid: string | null, branch: string | null, upstream: string | null, ahead: number, behind: number, remotes: string[] }} repo
 *   非当前仓库为 `/api/snapshot` 的 `repositories` 项，当前仓库为 `activeRepo`
 * @param {{ t: (key: string, params?: Record<string, unknown>) => string, isActive: boolean, isSyncing?: boolean }} options
 *   翻译函数、是否为当前仓库，以及当前仓库是否正在同步、推送、拉取或发布
 * @returns {{
 *   branch: { icon: 'gitBranch' | 'gitCommit' | null, label: string } | null,
 *   sync: { icon: 'sync' | 'cloudUpload', label: string, title: string, spinning: boolean, command: 'sync' | 'publish' | null } | null
 * }} 分支项与同步项；不显示的项为 null。`command` 是点击同步项执行的操作，同 VS Code 在 unborn、游离 HEAD 与同步进行中时不可点（无副作用）
 */
export const describeRepoStatus = (repo, { t, isActive, isSyncing = false }) => {
  let branch = null;
  if (repo.isBare) {
    branch = { icon: null, label: t('repo.bareLabel') };
  } else if (repo.isDetached) {
    branch = { icon: 'gitCommit', label: repo.headOid.slice(0, 8) };
  } else if (repo.branch) {
    branch = { icon: 'gitBranch', label: repo.branch };
  }

  // 没有远端时 VS Code 只在装了发布提供方（如 GitHub 扩展）时显示发布图标，插件没有发布提供方
  if (!isActive || repo.isBare || repo.remotes.length === 0) return { branch, sync: null };

  let sync;
  if (repo.isUnborn || repo.isDetached || !repo.branch) {
    sync = { icon: 'sync', label: '', title: '', command: null };
  } else if (!repo.upstream) {
    sync = { icon: 'cloudUpload', label: '', title: t('primary.publishBranch'), command: 'publish' };
  } else {
    const { ahead, behind } = repo;
    sync = { icon: 'sync', label: ahead || behind ? `${behind}↓ ${ahead}↑` : '', title: formatSyncTitle(repo, t), command: 'sync' };
  }
  return {
    branch,
    sync: isSyncing
      ? { icon: 'sync', label: sync.label, title: t('sync.syncing'), spinning: true, command: null }
      : { ...sync, spinning: false },
  };
};

/**
 * 创建「存储库」视图控制器：渲染仓库列表、维护折叠状态，并把点击或键盘选中的仓库交给 `onSelect`。
 *
 * @param {{
 *   sectionEl: HTMLElement,
 *   collapseBtnEl: HTMLButtonElement,
 *   chevronEl: HTMLElement,
 *   titleEl: HTMLElement,
 *   bodyEl: HTMLElement
 * }} elements 区域外壳、标题栏折叠按钮与列表容器
 * @param {{
 *   createIcon: (name: string, className?: string) => SVGElement,
 *   captureFocus: (container: HTMLElement) => object | null,
 *   restoreFocus: (container: HTMLElement, savedFocus: object | null) => void,
 *   onSelect: (repoId: string) => void,
 *   onSync: (repo: object) => void,
 *   onPublish: (repo: object) => void
 * }} deps 图标工厂、重渲染保焦、切换仓库回调，以及点击当前仓库同步项时执行同步、发布分支的回调
 * @returns {{
 *   render: (state: { repositories: object[], activeRepo: object | null, pendingOp: string | null, t: (key: string, params?: Record<string, unknown>) => string }) => void
 * }} 视图控制接口（有 DOM 读写与事件监听副作用）
 */
export const createReposView = (elements, deps) => {
  const { sectionEl, collapseBtnEl, chevronEl, titleEl, bodyEl } = elements;
  const doc = bodyEl.ownerDocument;
  let collapsed = false;
  let latestState = null;

  const createStatusItem = (icon, label, title, { extraClass = '', tagName = 'span' } = {}) => {
    const itemEl = doc.createElement(tagName);
    itemEl.className = 'gw-repo-status-item';
    if (title) itemEl.title = title;
    if (icon) itemEl.append(deps.createIcon(icon, extraClass));
    if (label) {
      const labelEl = doc.createElement('span');
      labelEl.className = 'gw-repo-status-label';
      labelEl.textContent = label;
      itemEl.append(labelEl);
    }
    return itemEl;
  };

  const createSyncItem = (repo, sync, pendingOp) => {
    const extraClass = sync.spinning ? 'is-spinning' : '';
    if (!sync.command) return createStatusItem(sync.icon, sync.label, sync.title, { extraClass });
    const btnEl = createStatusItem(sync.icon, sync.label, sync.title, { extraClass, tagName: 'button' });
    btnEl.type = 'button';
    btnEl.classList.add('gw-repo-sync-btn');
    btnEl.dataset.testid = 'repo-sync-btn';
    btnEl.dataset.focusId = `repo-sync:${repo.id}`;
    btnEl.dataset.command = sync.command;
    btnEl.setAttribute('aria-label', sync.label ? `${sync.title} (${sync.label})` : sync.title);
    // 写操作串行执行，其他操作进行中时不可点
    btnEl.disabled = Boolean(pendingOp);
    return btnEl;
  };

  const createRow = ({ repo, isActive, showSelectedIcon, pendingOp, index, total, t }) => {
    const rowEl = doc.createElement('div');
    rowEl.className = 'gw-repo-row';
    rowEl.classList.toggle('is-selected', isActive);
    rowEl.tabIndex = 0;
    rowEl.setAttribute('role', 'option');
    rowEl.setAttribute('aria-selected', String(isActive));
    rowEl.setAttribute('aria-posinset', String(index + 1));
    rowEl.setAttribute('aria-setsize', String(total));
    rowEl.dataset.testid = 'repo-row';
    rowEl.dataset.repoId = repo.id;
    rowEl.dataset.focusId = `repo:${repo.id}`;
    rowEl.title = repo.worktreePath ?? repo.name;

    const iconEl = doc.createElement('span');
    iconEl.className = 'gw-repo-row-icon';
    iconEl.append(deps.createIcon(showSelectedIcon ? 'repoSelected' : 'repo'));

    const nameEl = doc.createElement('span');
    nameEl.className = 'gw-repo-row-name';
    nameEl.textContent = repo.name;

    const statusEl = doc.createElement('span');
    statusEl.className = 'gw-repo-row-status';
    const { branch, sync } = describeRepoStatus(repo, { t, isActive, isSyncing: isActive && SYNCING_OPS.has(pendingOp) });
    if (branch) statusEl.append(createStatusItem(branch.icon, branch.label, branch.label));
    if (sync) statusEl.append(createSyncItem(repo, sync, pendingOp));

    rowEl.append(iconEl, nameEl, statusEl);
    return rowEl;
  };

  const render = (state) => {
    latestState = state;
    const { repositories, activeRepo, pendingOp, t } = state;

    titleEl.textContent = t('section.repositories');
    collapseBtnEl.setAttribute('aria-expanded', String(!collapsed));
    collapseBtnEl.setAttribute('aria-label', t(collapsed ? 'section.expand' : 'section.collapse', { section: t('section.repositories') }));
    chevronEl.replaceChildren(deps.createIcon(collapsed ? 'chevronRight' : 'chevronDown'));
    sectionEl.classList.toggle('is-collapsed', collapsed);
    bodyEl.setAttribute('aria-label', t('repo.switcherAria'));

    const savedFocus = deps.captureFocus(bodyEl);
    const rows = repositories.map((summary, index) => {
      const isActive = summary.id === activeRepo?.id;
      return createRow({
        // 当前仓库用 activeRepo：带上游与领先、落后数，只刷新 git status 时也会更新
        repo: isActive ? activeRepo : summary,
        isActive,
        // 同 VS Code：多个仓库时当前仓库换成带勾的图标
        showSelectedIcon: isActive && repositories.length > 1,
        pendingOp,
        index,
        total: repositories.length,
        t,
      });
    });
    bodyEl.replaceChildren(...rows);
    deps.restoreFocus(bodyEl, savedFocus);
  };

  collapseBtnEl.addEventListener('click', () => {
    collapsed = !collapsed;
    if (latestState) render(latestState);
  });

  bodyEl.addEventListener('click', (event) => {
    const rowEl = event.target instanceof Element ? event.target.closest('.gw-repo-row') : null;
    if (!rowEl) return;
    // 同步项只出现在当前仓库那一行
    const syncBtn = event.target.closest('.gw-repo-sync-btn');
    if (syncBtn) {
      const { activeRepo } = latestState;
      if (syncBtn.dataset.command === 'publish') deps.onPublish(activeRepo);
      else deps.onSync(activeRepo);
      return;
    }
    deps.onSelect(rowEl.dataset.repoId);
  });

  bodyEl.addEventListener('keydown', (event) => {
    const rowEl = event.target instanceof Element ? event.target.closest('.gw-repo-row') : null;
    if (!rowEl) return;
    // 焦点在同步项上时 Enter、Space 交给按钮自身触发点击
    if ((event.key === 'Enter' || event.key === ' ') && event.target === rowEl) {
      event.preventDefault();
      deps.onSelect(rowEl.dataset.repoId);
      return;
    }
    const rowEls = [...bodyEl.querySelectorAll('.gw-repo-row')];
    const targetIndex = {
      ArrowDown: rowEls.indexOf(rowEl) + 1,
      ArrowUp: rowEls.indexOf(rowEl) - 1,
      Home: 0,
      End: rowEls.length - 1,
    }[event.key];
    if (targetIndex === undefined) return;
    event.preventDefault();
    rowEls[Math.max(0, Math.min(rowEls.length - 1, targetIndex))]?.focus();
  });

  return { render };
};
