/**
 * Antigravity Git Graph 下区「图表」视图组件。
 * 行结构、泳道图形与引用徽标对齐 VS Code 源代码管理「图表」视图；
 * 负责顶栏工具、⋯ 溢出菜单、本地即时提交搜索、原地文件展开、分页加载与提交详情悬浮卡。
 */

import {
  SWIMLANE_HEIGHT,
  buildRefColorMap,
  toHistoryItemViewModels,
  computeHistoryItemGraph,
  computeGraphPlaceholder,
  computeCommitFilesPlaceholder,
  groupHistoryItemBadges,
} from './graph-layout.js';
import { computeMinOcclusionPopoverStyle } from './popover.js';
import { renderCommitMarkdown } from './markdown.js';
import { formatRelativeTime, formatAbsoluteTime } from './i18n.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const GRAPH_HARD_SOFT_LIMIT = 2000;

const createSvgNode = (tagName, attrs = {}) => {
  const el = document.createElementNS(SVG_NS, tagName);
  for (const [key, value] of Object.entries(attrs)) {
    el.setAttribute(key, String(value));
  }
  return el;
};

const renderGraphSvg = ({ width, shapes }, className) => {
  const svg = createSvgNode('svg', {
    class: className,
    width,
    height: SWIMLANE_HEIGHT,
    'aria-hidden': 'true',
  });
  for (const shape of shapes) {
    if (shape.type === 'path') {
      const pathEl = createSvgNode('path', {
        d: shape.d,
        fill: 'none',
        'stroke-width': `${shape.strokeWidth}px`,
        'stroke-linecap': 'round',
      });
      if (shape.isOutgoing) pathEl.setAttribute('class', 'gw-graph-outgoing');
      pathEl.style.stroke = shape.color;
      svg.append(pathEl);
      continue;
    }
    // 圆点描边颜色由样式表按行状态（常态/悬停/选中）设置，形成与背景同色的间隙
    const circleEl = createSvgNode('circle', { cx: shape.cx, cy: shape.cy, r: shape.r });
    circleEl.style.strokeWidth = `${shape.strokeWidth}px`;
    if (shape.fill) circleEl.style.fill = shape.fill;
    svg.append(circleEl);
  }
  return svg;
};

const matchesSearchQuery = (commit, normalizedQuery) => {
  const haystacks = [
    commit.subject,
    commit.shortSha,
    commit.sha,
    commit.authorName,
    commit.authorEmail,
    ...(commit.refs ?? []).flatMap((ref) => [ref.name, ref.fullRef]),
  ];
  return haystacks.some((field) => typeof field === 'string' && field.toLowerCase().includes(normalizedQuery));
};

const copyTextWithFallback = async (text) => {
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // sandbox iframe 下 Clipboard API 可能受限，回退到临时 textarea 复制
  }
  try {
    const helper = document.createElement('textarea');
    helper.value = text;
    helper.setAttribute('readonly', 'true');
    helper.style.position = 'fixed';
    helper.style.opacity = '0';
    helper.style.pointerEvents = 'none';
    document.body.append(helper);
    helper.select();
    const ok = document.execCommand('copy');
    helper.remove();
    return Boolean(ok);
  } catch {
    return false;
  }
};

const formatFileStatus = (status) => {
  const code = typeof status === 'string' && status.trim() ? status.trim()[0].toUpperCase() : 'M';
  const classNameByCode = {
    A: 'is-added',
    D: 'is-deleted',
    R: 'is-renamed',
    C: 'is-copied',
  };
  return { code, className: classNameByCode[code] ?? 'is-modified' };
};

/**
 * 创建下区「图表」视图控制器，协调顶栏工具、提交拓扑图、原地文件展开、分页与详情悬浮卡。
 *
 * @param {{
 *   headerEl: HTMLElement,
 *   sectionTitleEl: HTMLElement,
 *   toolbarActionsEl: HTMLElement,
 *   searchBarEl: HTMLElement,
 *   bodyEl: HTMLElement,
 *   moreMenuEl: HTMLElement,
 *   popoverEl: HTMLElement
 * }} elements DOM 容器节点集合
 * @param {{
 *   createIcon: (name: string, className?: string) => SVGElement,
 *   createFileIcon: (filePath: string) => HTMLImageElement,
 *   createSplitPath: (filePath: string, origPath?: string | null) => HTMLElement,
 *   captureFocus: (container: HTMLElement) => { focusId: string | null, wasFocusVisible: boolean } | null,
 *   restoreFocus: (container: HTMLElement, savedFocus: { focusId: string | null, wasFocusVisible: boolean } | null) => void,
 *   showToast: (message: string, variant?: 'info' | 'success' | 'warning' | 'error', options?: { detail?: string, anchor?: Element | null }) => void,
 *   onOpenFile: (file: Record<string, any>, anchorEl: Element) => void,
 *   onToggleScope: (nextScope: 'auto' | 'all') => void,
 *   onFetch: (repo: Record<string, any>) => Promise<void>,
 *   onPull: (repo: Record<string, any>) => Promise<void>,
 *   onPushOrPublish: (repo: Record<string, any>) => void,
 *   onRefresh: () => Promise<void>,
 *   onLoadMore: () => Promise<void>,
 *   onSwitchLanguage: () => void,
 *   onLoadCommitDetail: (worktreePath: string | null, sha: string, repoId?: string | null) => Promise<any>
 * }} deps 外部服务与交互回调
 * @returns {{
 *   render: (state: { activeRepo: Record<string, any> | null, graph: Record<string, any> | null, graphScope: 'auto' | 'all', pendingOp: string | null, loadingMore: boolean, locale: 'zh-CN' | 'en', t: (key: string, params?: Record<string, unknown>) => string }) => void,
 *   clearDetailCache: () => void,
 *   closeOverlays: () => void
 * }} 图表视图控制接口（有 DOM 读写与事件监听副作用）
 */
export const createGraphView = (elements, deps) => {
  const {
    headerEl,
    sectionTitleEl,
    toolbarActionsEl,
    searchBarEl,
    bodyEl,
    moreMenuEl,
    popoverEl,
  } = elements;
  const doc = bodyEl.ownerDocument;
  const win = doc.defaultView ?? window;

  const commitDetailCache = new Map();
  const detailErrors = new Map();
  const loadingDetailShas = new Set();
  const expandedCommits = new Set();

  let searchVisible = false;
  let searchQuery = '';
  let moreMenuOpen = false;
  let latestRenderState = null;
  let latestViewModelBySha = new Map();
  // 当前打开详情卡的提交；详情卡只由行尾「查看提交详情」按钮打开
  let popoverSha = null;

  // 持久挂载搜索栏输入框，保证输入与 IME 期间不被后台刷新销毁
  const searchFieldEl = doc.createElement('div');
  searchFieldEl.className = 'gw-search-field';

  const searchIconEl = doc.createElement('span');
  searchIconEl.className = 'gw-search-icon';
  searchIconEl.setAttribute('aria-hidden', 'true');
  searchIconEl.append(deps.createIcon('search'));

  const searchInputEl = doc.createElement('input');
  searchInputEl.id = 'graph-search-input';
  searchInputEl.type = 'search';
  searchInputEl.className = 'gw-search-input';
  searchInputEl.dataset.testid = 'graph-search-input';
  searchInputEl.dataset.focusId = 'graph-search-input';

  const searchClearBtn = doc.createElement('button');
  searchClearBtn.type = 'button';
  searchClearBtn.className = 'gw-icon-btn hidden';
  searchClearBtn.dataset.testid = 'graph-search-clear';
  searchClearBtn.append(deps.createIcon('close'));

  searchFieldEl.append(searchIconEl, searchInputEl, searchClearBtn);
  searchBarEl.replaceChildren(searchFieldEl);

  const clearSearch = () => {
    searchQuery = '';
    searchInputEl.value = '';
    searchClearBtn.classList.add('hidden');
    if (latestRenderState) renderCommitList(latestRenderState);
  };

  const findCommitRowEl = (sha) => {
    for (const row of bodyEl.querySelectorAll('.gw-commit-row')) {
      if (row.dataset.commitSha === sha) return row;
    }
    return null;
  };

  const createRefBadge = ({ color, icon, count, name }) => {
    const badgeEl = doc.createElement('div');
    badgeEl.className = 'gw-ref-badge';
    badgeEl.style.backgroundColor = color;
    if (count > 1) {
      const countEl = doc.createElement('span');
      countEl.className = 'gw-ref-badge-count';
      countEl.textContent = String(count);
      badgeEl.append(countEl);
    }
    badgeEl.append(deps.createIcon(icon, `gw-ref-badge-icon is-${icon}`));
    if (name) {
      const nameEl = doc.createElement('span');
      nameEl.className = 'gw-ref-badge-name';
      nameEl.textContent = name;
      badgeEl.append(nameEl);
    }
    return badgeEl;
  };

  const createPopoverPerson = (name, email, suffix = '') => {
    const lineEl = doc.createElement('p');
    lineEl.className = 'gw-popover-person';
    const nameEl = doc.createElement('strong');
    nameEl.className = 'gw-popover-person-name';
    nameEl.textContent = name;
    if (email) nameEl.title = email;
    lineEl.append(deps.createIcon('account'), ' ', nameEl);
    if (suffix) {
      const suffixEl = doc.createElement('em');
      suffixEl.textContent = ` (${suffix})`;
      lineEl.append(suffixEl);
    }
    return lineEl;
  };

  const createPopoverSection = (className, children) => {
    const sectionEl = doc.createElement('div');
    sectionEl.className = `gw-popover-section ${className}`;
    sectionEl.append(...children);
    return sectionEl;
  };

  const createStatsLine = ({ files, insertions, deletions }, t) => {
    const statsEl = doc.createElement('p');
    statsEl.append(t(files === 1 ? 'popover.fileChanged' : 'popover.filesChanged', { count: files }));
    const parts = [
      { count: insertions, className: 'is-insertions', one: 'popover.insertion', many: 'popover.insertions' },
      { count: deletions, className: 'is-deletions', one: 'popover.deletion', many: 'popover.deletions' },
    ];
    for (const { count, className, one, many } of parts) {
      if (!count) continue;
      const partEl = doc.createElement('span');
      partEl.className = className;
      partEl.textContent = t(count === 1 ? one : many, { count });
      statsEl.append(', ', partEl);
    }
    return statsEl;
  };

  // 卡片分区与 VS Code Git 扩展的提交悬浮卡一致：作者与提交说明、改动统计、引用、SHA 操作
  const buildPopoverSections = (viewModel, { t, locale }) => {
    const { commit } = viewModel;
    const detail = commitDetailCache.get(commit.sha);

    // 不联网取头像，与 VS Code 取不到头像时一样显示账号图标
    const authorEl = createPopoverPerson(commit.authorName || '', commit.authorEmail);
    const absTime = formatAbsoluteTime(commit.timestamp, locale);
    if (absTime) {
      authorEl.append(', ', deps.createIcon('history'), ` ${formatRelativeTime(commit.timestamp, locale)} (${absTime})`);
    }
    const contentChildren = [authorEl];
    for (const coAuthor of detail?.coAuthors ?? []) {
      contentChildren.push(createPopoverPerson(coAuthor.name, coAuthor.email, t('popover.coAuthor')));
    }
    const message = detail ? [detail.subject, detail.body].filter(Boolean).join('\n\n') : (commit.subject || '');
    contentChildren.push(renderCommitMarkdown(doc, message));
    if (!detail && loadingDetailShas.has(commit.sha)) {
      const loadingEl = doc.createElement('p');
      loadingEl.className = 'gw-popover-loading';
      loadingEl.textContent = t('popover.loading');
      contentChildren.push(loadingEl);
    }
    const sections = [createPopoverSection('gw-popover-content', contentChildren)];

    if (detail?.stats) {
      sections.push(createPopoverSection('gw-popover-stats', [createStatsLine(detail.stats, t)]));
    }

    if (viewModel.references.length > 0) {
      const refEls = viewModel.references.map((ref) => {
        const refEl = doc.createElement('span');
        refEl.className = ref.color ? 'gw-popover-ref' : 'gw-popover-ref is-default';
        if (ref.color) refEl.style.backgroundColor = ref.color;
        refEl.title = ref.name;
        const refNameEl = doc.createElement('span');
        refNameEl.textContent = ref.name;
        refEl.append(deps.createIcon(ref.icon), refNameEl);
        return refEl;
      });
      sections.push(createPopoverSection('gw-popover-refs', refEls));
    }

    const shortSha = commit.shortSha || commit.sha.slice(0, 7);
    const shaSpan = doc.createElement('span');
    shaSpan.className = 'gw-popover-sha';
    shaSpan.textContent = shortSha;
    const copyBtn = doc.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'gw-icon-btn';
    copyBtn.dataset.testid = 'popover-copy-sha-btn';
    copyBtn.title = t('popover.copySha');
    copyBtn.setAttribute('aria-label', t('popover.copySha'));
    copyBtn.append(deps.createIcon('copy'));
    copyBtn.addEventListener('click', () => {
      void copyTextWithFallback(commit.sha).then((copied) => {
        if (copied) {
          deps.showToast(t('popover.copiedSha', { sha: shortSha }), 'success', { anchor: copyBtn });
        }
      });
    });
    sections.push(createPopoverSection('gw-popover-footer', [deps.createIcon('gitCommit'), shaSpan, copyBtn]));
    return sections;
  };

  const positionPopover = (anchorEl) => {
    // 量自然高度要先去掉 maxHeight，这会让滚动位置归零，量完后恢复
    const { scrollTop } = popoverEl;
    const viewportRect = {
      top: 0,
      left: 0,
      width: win.innerWidth,
      height: win.innerHeight,
    };
    const popoverPadding = 8;
    // 最大宽度对齐侧边栏可视宽度（左右各保留 8px 边距），避免宽侧边栏下卡片过窄
    const targetWidth = Math.max(0, viewportRect.width - popoverPadding * 2);
    popoverEl.style.width = `${targetWidth}px`;
    popoverEl.style.maxHeight = '';

    const maxPreferredHeight = Math.min(340, Math.max(220, Math.floor(viewportRect.height * 0.45)));
    // box-sizing: border-box 下 scrollHeight 不含上下 1px 边框，使用 offsetHeight/getBoundingClientRect 避免短卡片多出 2px 冗余滚动条
    const naturalHeight = Math.ceil(Math.max(popoverEl.offsetHeight, popoverEl.getBoundingClientRect().height));
    const measuredHeight = Math.min(maxPreferredHeight, Math.max(72, naturalHeight));
    const anchorRect = anchorEl.getBoundingClientRect();
    const graphContentRect = bodyEl.getBoundingClientRect();

    const style = computeMinOcclusionPopoverStyle(
      anchorRect,
      { width: targetWidth, height: measuredHeight },
      graphContentRect,
      viewportRect,
      { gap: 4, padding: popoverPadding },
    );

    popoverEl.style.top = `${style.top}px`;
    popoverEl.style.left = `${style.left}px`;
    popoverEl.style.width = `${style.width}px`;
    popoverEl.style.maxHeight = `${style.maxHeight}px`;
    popoverEl.dataset.placement = style.placement;
    popoverEl.dataset.occludedGraphPx = String(Math.round(style.occludedGraphPx));
    popoverEl.scrollTop = scrollTop;
  };

  const renderPopover = (sha) => {
    const viewModel = latestViewModelBySha.get(sha);
    const anchorEl = findCommitRowEl(sha);
    if (!latestRenderState || !viewModel || !anchorEl) {
      closePopover();
      return;
    }
    popoverEl.setAttribute('aria-label', viewModel.commit.subject || viewModel.commit.sha);
    popoverEl.replaceChildren(...buildPopoverSections(viewModel, latestRenderState));
    popoverEl.classList.remove('hidden');
    positionPopover(anchorEl);
  };

  // 滚动与窗口缩放只移动卡片，不重建内容，保留卡片内的滚动位置与选中的文字
  const repositionPopover = () => {
    const anchorEl = popoverSha ? findCommitRowEl(popoverSha) : null;
    if (anchorEl) positionPopover(anchorEl);
  };

  const syncActiveCommitHighlight = () => {
    for (const row of bodyEl.querySelectorAll('.gw-commit-row')) {
      const isActive = row.dataset.commitSha === popoverSha;
      row.classList.toggle('is-popover-active', isActive);
      row.querySelector('.gw-commit-detail-btn')?.classList.toggle('is-active', isActive);
    }
  };

  const closePopover = () => {
    if (popoverSha === null) return;
    popoverSha = null;
    popoverEl.classList.add('hidden');
    popoverEl.replaceChildren();
    syncActiveCommitHighlight();
  };

  const ensureCommitDetail = async (sha) => {
    const activeRepo = latestRenderState?.activeRepo;
    if (!activeRepo || (!activeRepo.worktreePath && !activeRepo.id)) return null;
    if (commitDetailCache.has(sha)) {
      return commitDetailCache.get(sha);
    }
    if (loadingDetailShas.has(sha)) return null;

    loadingDetailShas.add(sha);
    detailErrors.delete(sha);
    if (expandedCommits.has(sha) && latestRenderState) {
      renderCommitList(latestRenderState);
    }

    try {
      const detail = await deps.onLoadCommitDetail(
        activeRepo.worktreePath ?? null,
        sha,
        activeRepo.id ?? null,
      );
      if (detail) {
        commitDetailCache.set(sha, detail);
      }
      return detail;
    } catch (err) {
      detailErrors.set(sha, err?.message || 'Error');
      return null;
    } finally {
      loadingDetailShas.delete(sha);
      if (expandedCommits.has(sha) && latestRenderState) {
        renderCommitList(latestRenderState);
      }
      if (popoverSha === sha) {
        renderPopover(sha);
      }
    }
  };

  const togglePopover = (sha) => {
    if (popoverSha === sha) {
      closePopover();
      return;
    }
    popoverSha = sha;
    syncActiveCommitHighlight();
    // 先触发详情加载使 loadingDetailShas 同步入集，首次渲染即显示加载提示
    if (!commitDetailCache.has(sha)) {
      void ensureCommitDetail(sha);
    }
    renderPopover(sha);
    popoverEl.scrollTop = 0;
  };

  const toggleCommitExpand = async (sha) => {
    if (expandedCommits.has(sha)) {
      expandedCommits.delete(sha);
      if (latestRenderState) renderCommitList(latestRenderState);
      return;
    }
    expandedCommits.add(sha);
    if (latestRenderState) renderCommitList(latestRenderState);
    if (!commitDetailCache.has(sha)) {
      await ensureCommitDetail(sha);
    }
  };

  const closeMoreMenu = () => {
    if (!moreMenuOpen) return;
    moreMenuOpen = false;
    moreMenuEl.classList.add('hidden');
    moreMenuEl.replaceChildren();
    const moreBtn = toolbarActionsEl.querySelector('[data-testid="graph-more-btn"]');
    moreBtn?.setAttribute('aria-expanded', 'false');
  };

  const renderMoreMenu = (anchorBtn, t) => {
    const items = [
      {
        id: 'toggle-search',
        label: t('graph.menu.toggleSearch'),
        action: () => {
          searchVisible = !searchVisible;
          searchBarEl.classList.toggle('hidden', !searchVisible);
          if (searchVisible) {
            searchInputEl.focus();
          } else if (searchQuery) {
            clearSearch();
          }
        },
      },
      {
        id: 'collapse-all',
        label: t('graph.menu.collapseAll'),
        action: () => {
          expandedCommits.clear();
          if (latestRenderState) renderCommitList(latestRenderState);
        },
      },
      {
        id: 'switch-language',
        label: t('graph.menu.switchLanguage'),
        action: () => {
          deps.onSwitchLanguage();
        },
      },
    ];

    const fragment = doc.createDocumentFragment();
    for (const item of items) {
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'gw-menu-item';
      btn.setAttribute('role', 'menuitem');
      btn.dataset.testid = `graph-menu-${item.id}`;
      btn.textContent = item.label;
      btn.addEventListener('click', () => {
        closeMoreMenu();
        item.action();
      });
      fragment.append(btn);
    }

    moreMenuEl.replaceChildren(fragment);
    moreMenuEl.classList.remove('hidden');

    const anchorRect = anchorBtn.getBoundingClientRect();
    const menuWidth = moreMenuEl.offsetWidth || 196;
    const menuHeight = moreMenuEl.offsetHeight || 110;
    const left = Math.max(8, Math.min(anchorRect.right - menuWidth, win.innerWidth - menuWidth - 8));
    const top = Math.max(8, Math.min(anchorRect.bottom + 4, win.innerHeight - menuHeight - 8));

    moreMenuEl.style.left = `${left}px`;
    moreMenuEl.style.top = `${top}px`;
    anchorBtn.setAttribute('aria-expanded', 'true');
  };

  searchInputEl.addEventListener('input', () => {
    searchQuery = searchInputEl.value;
    searchClearBtn.classList.toggle('hidden', !searchQuery);
    if (latestRenderState) {
      renderCommitList(latestRenderState);
    }
  });

  searchClearBtn.addEventListener('click', () => {
    clearSearch();
    searchInputEl.focus();
  });

  // 键盘上下浏览提交行，显式跳过表单控件与内层按钮
  bodyEl.addEventListener('keydown', (event) => {
    if (event.target instanceof Element && event.target.closest('input, select, textarea, button, [contenteditable]')) {
      return;
    }
    const currentRow = event.target instanceof Element ? event.target.closest('.gw-commit-row') : null;
    if (!currentRow) return;
    const rows = [...bodyEl.querySelectorAll('.gw-commit-row')];
    const currentIndex = rows.indexOf(currentRow);
    if (currentIndex === -1) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      rows[Math.min(rows.length - 1, currentIndex + 1)]?.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      rows[Math.max(0, currentIndex - 1)]?.focus();
    } else if (event.key === 'Home') {
      event.preventDefault();
      rows[0]?.focus();
    } else if (event.key === 'End') {
      event.preventDefault();
      rows[rows.length - 1]?.focus();
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const sha = currentRow.dataset.commitSha;
      if (sha) {
        void toggleCommitExpand(sha);
      }
    }
  });

  bodyEl.addEventListener('scroll', () => {
    repositionPopover();
  }, { passive: true });

  doc.addEventListener('pointerdown', (event) => {
    const target = event.target;
    if (!(target instanceof Node)) return;

    if (moreMenuOpen && !moreMenuEl.contains(target) && !toolbarActionsEl.contains(target)) {
      closeMoreMenu();
    }

    // 点详情按钮交给按钮自身切换，避免这里先关闭、按钮再打开
    const detailTrigger = target instanceof Element ? target.closest('.gw-commit-detail-btn') : null;
    if (!popoverEl.contains(target) && !detailTrigger) {
      closePopover();
    }
  });

  doc.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeMoreMenu();
      closePopover();
    }
  });

  win.addEventListener('resize', () => {
    closeMoreMenu();
    repositionPopover();
  });

  const renderToolbar = ({ activeRepo, graphScope, pendingOp, t }) => {
    const savedFocus = deps.captureFocus(toolbarActionsEl);
    const fragment = doc.createDocumentFragment();

    const isBare = Boolean(activeRepo?.isBare);
    const isDetached = Boolean(activeRepo?.isDetached);
    const isUnborn = Boolean(activeRepo?.isUnborn);
    const remotes = Array.isArray(activeRepo?.remotes) ? activeRepo.remotes : [];
    const isBusy = Boolean(pendingOp);

    const scopeBtn = doc.createElement('button');
    scopeBtn.type = 'button';
    scopeBtn.className = 'gw-action-label gw-scope-btn';
    scopeBtn.dataset.testid = 'graph-scope-btn';
    scopeBtn.dataset.focusId = 'graph-scope';
    scopeBtn.title = t('graph.scopeToggleTitle');
    scopeBtn.disabled = !activeRepo;
    const scopeTextEl = doc.createElement('span');
    scopeTextEl.className = 'gw-scope-name';
    scopeTextEl.textContent = graphScope === 'all' ? t('graph.scopeAll') : t('graph.scopeAuto');
    scopeBtn.append(deps.createIcon('gitBranch'), scopeTextEl);
    scopeBtn.addEventListener('click', () => {
      deps.onToggleScope(graphScope === 'all' ? 'auto' : 'all');
    });
    fragment.append(scopeBtn);

    const createToolbarIconBtn = ({ testid, focusId, icon, title, disabled, onClick }) => {
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'gw-action-label';
      btn.dataset.testid = testid;
      btn.dataset.focusId = focusId;
      btn.title = title;
      btn.setAttribute('aria-label', title);
      btn.disabled = disabled;
      btn.append(deps.createIcon(icon));
      btn.addEventListener('click', onClick);
      return btn;
    };

    fragment.append(
      createToolbarIconBtn({
        testid: 'graph-go-to-current-btn',
        focusId: 'graph-go-to-current',
        icon: 'target',
        title: t('graph.action.goToCurrent'),
        disabled: !activeRepo?.headOid || isUnborn,
        onClick: () => {
          if (searchQuery) clearSearch();
          const headRow = findCommitRowEl(activeRepo.headOid);
          if (!headRow) {
            // 与提取、刷新等顶栏操作共用标题栏锚点，提示叠进同一栈而不是同位置重叠
            deps.showToast(t('graph.headNotLoaded'), 'info', { anchor: headerEl });
            return;
          }
          headRow.scrollIntoView({ block: 'nearest' });
          headRow.focus();
        },
      }),
      createToolbarIconBtn({
        testid: 'graph-fetch-btn',
        focusId: 'graph-fetch',
        icon: 'repoFetch',
        title: t('graph.action.fetchTitle'),
        disabled: !activeRepo || isBusy,
        onClick: () => {
          if (activeRepo) void deps.onFetch(activeRepo);
        },
      }),
      createToolbarIconBtn({
        testid: 'graph-pull-btn',
        focusId: 'graph-pull',
        icon: 'repoPull',
        title: t('graph.action.pullTitle'),
        disabled: !activeRepo || isBare || isDetached || isUnborn || !activeRepo.upstream || isBusy,
        onClick: () => {
          if (activeRepo) void deps.onPull(activeRepo);
        },
      }),
      createToolbarIconBtn({
        testid: 'graph-push-btn',
        focusId: 'graph-push',
        icon: 'repoPush',
        title: (!activeRepo?.upstream && remotes.length > 0)
          ? t('graph.action.publishTitle')
          : t('graph.action.pushTitle'),
        disabled: !activeRepo || isBare || isDetached || isUnborn || remotes.length === 0 || isBusy,
        onClick: () => {
          if (activeRepo) deps.onPushOrPublish(activeRepo);
        },
      }),
      createToolbarIconBtn({
        testid: 'graph-refresh-btn',
        focusId: 'graph-refresh',
        icon: 'refresh',
        title: t('graph.action.refreshTitle'),
        disabled: !activeRepo || isBusy,
        onClick: () => {
          void deps.onRefresh();
        },
      }),
    );

    const moreBtn = createToolbarIconBtn({
      testid: 'graph-more-btn',
      focusId: 'graph-more',
      icon: 'ellipsis',
      title: t('graph.action.more'),
      disabled: false,
      onClick: () => {
        if (moreMenuOpen) {
          closeMoreMenu();
        } else {
          moreMenuOpen = true;
          renderMoreMenu(moreBtn, t);
        }
      },
    });
    moreBtn.setAttribute('aria-haspopup', 'menu');
    moreBtn.setAttribute('aria-expanded', String(moreMenuOpen));
    fragment.append(moreBtn);

    toolbarActionsEl.replaceChildren(fragment);
    deps.restoreFocus(toolbarActionsEl, savedFocus);
  };

  const renderQuietRow = (placeholder, text, className) => {
    const rowEl = doc.createElement('div');
    rowEl.className = className;
    const spacerEl = doc.createElement('span');
    spacerEl.className = 'gw-tree-indent';
    const textEl = doc.createElement('span');
    textEl.className = 'gw-quiet-row-text';
    textEl.textContent = text;
    rowEl.append(renderGraphSvg(placeholder, 'gw-graph-placeholder'), spacerEl, textEl);
    return rowEl;
  };

  const renderCommitFiles = (viewModel, t) => {
    const { commit } = viewModel;
    const filesWrap = doc.createElement('div');
    filesWrap.className = 'gw-commit-files';
    filesWrap.dataset.testid = 'commit-files';
    filesWrap.dataset.commitSha = commit.sha;

    const placeholder = computeCommitFilesPlaceholder(viewModel);
    const detail = commitDetailCache.get(commit.sha);
    const detailErr = detailErrors.get(commit.sha);

    if (loadingDetailShas.has(commit.sha) && !detail) {
      filesWrap.append(renderQuietRow(placeholder, t('graph.loadingDetail'), 'gw-commit-file-loading'));
      return filesWrap;
    }
    if (detailErr && !detail) {
      filesWrap.append(renderQuietRow(placeholder, detailErr, 'gw-commit-file-empty'));
      return filesWrap;
    }
    if (!detail?.files || detail.files.length === 0) {
      filesWrap.append(renderQuietRow(placeholder, t('graph.emptyFiles'), 'gw-commit-file-empty'));
      return filesWrap;
    }

    for (const file of detail.files) {
      const exists = file.existsInWorktree !== false;
      const fileBtn = doc.createElement('button');
      fileBtn.type = 'button';
      fileBtn.className = exists ? 'gw-commit-file-row' : 'gw-commit-file-row is-missing';
      fileBtn.dataset.testid = 'commit-file-row';
      fileBtn.dataset.filePath = file.path;
      fileBtn.dataset.focusId = `commit-file:${commit.sha}:${file.path}`;
      fileBtn.disabled = !exists;
      if (!exists) {
        fileBtn.setAttribute('aria-disabled', 'true');
        fileBtn.title = t('graph.deletedFileDisabled');
      } else {
        fileBtn.title = file.origPath ? `${file.origPath} → ${file.path}` : file.path;
        fileBtn.addEventListener('click', () => deps.onOpenFile(file, fileBtn));
      }

      const indentEl = doc.createElement('span');
      indentEl.className = 'gw-tree-indent';
      indentEl.setAttribute('aria-hidden', 'true');

      const status = formatFileStatus(file.status);
      const badge = doc.createElement('span');
      badge.className = `gw-status-badge ${status.className}`;
      badge.textContent = status.code;

      fileBtn.append(
        renderGraphSvg(placeholder, 'gw-graph-placeholder'),
        indentEl,
        deps.createFileIcon(file.path),
        deps.createSplitPath(file.path, file.origPath),
        badge,
      );
      filesWrap.append(fileBtn);
    }
    return filesWrap;
  };

  const renderCommitRow = (viewModel, t) => {
    const { commit } = viewModel;
    const isExpanded = expandedCommits.has(commit.sha);
    const isCurrent = viewModel.kind === 'HEAD';

    const rowEl = doc.createElement('div');
    rowEl.className = 'gw-commit-row';
    rowEl.classList.toggle('is-expanded', isExpanded);
    rowEl.classList.toggle('is-current', isCurrent);
    rowEl.classList.toggle('is-popover-active', popoverSha === commit.sha);
    rowEl.tabIndex = 0;
    rowEl.setAttribute('role', 'listitem');
    rowEl.setAttribute('aria-expanded', String(isExpanded));
    rowEl.dataset.testid = 'commit-row';
    rowEl.dataset.commitSha = commit.sha;
    rowEl.dataset.focusId = `commit:${commit.sha}`;
    // 只写 aria-label 不写 title：详情由行尾按钮打开，原生 tooltip 只会重复一遍标题
    rowEl.setAttribute('aria-label', `${commit.shortSha || commit.sha.slice(0, 7)} ${commit.subject || ''}`.trim());

    const graphContainerEl = doc.createElement('span');
    graphContainerEl.className = 'gw-graph-container';
    graphContainerEl.append(renderGraphSvg(computeHistoryItemGraph(viewModel), 'gw-graph'));

    const labelEl = doc.createElement('span');
    labelEl.className = 'gw-commit-label';
    const subjectEl = doc.createElement('span');
    subjectEl.className = 'gw-commit-subject';
    subjectEl.textContent = commit.subject || '';
    const authorEl = doc.createElement('span');
    authorEl.className = 'gw-commit-author';
    authorEl.textContent = commit.authorName || '';
    labelEl.append(subjectEl, authorEl);

    rowEl.append(graphContainerEl, labelEl);

    const badges = groupHistoryItemBadges(viewModel.references);
    if (badges.length > 0) {
      const refsWrap = doc.createElement('div');
      refsWrap.className = 'gw-commit-refs';
      for (const badge of badges) {
        refsWrap.append(createRefBadge(badge));
      }
      rowEl.append(refsWrap);
    }

    const detailBtn = doc.createElement('button');
    detailBtn.type = 'button';
    detailBtn.className = 'gw-icon-btn gw-commit-detail-btn';
    detailBtn.classList.toggle('is-active', popoverSha === commit.sha);
    detailBtn.dataset.testid = 'commit-detail-btn';
    detailBtn.dataset.focusId = `commit-detail:${commit.sha}`;
    detailBtn.title = t('graph.openDetailCard');
    detailBtn.setAttribute('aria-label', t('graph.openDetailCard'));
    detailBtn.append(deps.createIcon('info'));
    detailBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      togglePopover(commit.sha);
    });
    rowEl.append(detailBtn);

    rowEl.addEventListener('click', () => {
      void toggleCommitExpand(commit.sha);
    });

    return rowEl;
  };

  const renderListFooter = ({ graph, allCommits, lastViewModel, loadingMore, t }) => {
    const reachedSoftLimit = Boolean(graph?.reachedSoftLimit) || allCommits.length >= GRAPH_HARD_SOFT_LIMIT;
    if (reachedSoftLimit) {
      const noticeEl = doc.createElement('div');
      noticeEl.className = 'gw-soft-limit-notice';
      noticeEl.dataset.testid = 'graph-soft-limit-notice';
      noticeEl.textContent = t('graph.softLimitNotice');
      return noticeEl;
    }
    if (!graph?.hasMore) return null;

    const rowEl = doc.createElement('div');
    rowEl.className = 'gw-load-more-row';
    const placeholder = computeGraphPlaceholder(lastViewModel.outputSwimlanes);
    const loadMoreBtn = doc.createElement('button');
    loadMoreBtn.type = 'button';
    loadMoreBtn.className = 'gw-load-more-btn';
    loadMoreBtn.dataset.testid = 'graph-load-more-btn';
    loadMoreBtn.dataset.focusId = 'graph-load-more';
    loadMoreBtn.disabled = Boolean(loadingMore);
    const labelEl = doc.createElement('span');
    labelEl.textContent = loadingMore ? t('graph.loadingMore') : t('graph.loadMore');
    loadMoreBtn.append(deps.createIcon('foldDown'), labelEl);
    loadMoreBtn.addEventListener('click', () => {
      void deps.onLoadMore();
    });
    rowEl.append(renderGraphSvg(placeholder, 'gw-graph-placeholder is-fading'), loadMoreBtn);
    return rowEl;
  };

  const renderCommitList = (state) => {
    const { activeRepo, graph, graphScope, loadingMore, t } = state;
    const savedFocus = deps.captureFocus(bodyEl);

    if (!activeRepo) {
      closePopover();
      latestViewModelBySha = new Map();
      bodyEl.replaceChildren();
      return;
    }

    if (activeRepo.isUnborn) {
      closePopover();
      latestViewModelBySha = new Map();
      const unbornEl = doc.createElement('div');
      unbornEl.className = 'gw-quiet-empty';
      unbornEl.dataset.testid = 'graph-unborn-empty';
      unbornEl.textContent = t('repo.unbornNotice');
      bodyEl.replaceChildren(unbornEl);
      return;
    }

    const allCommits = Array.isArray(graph?.commits) ? graph.commits : [];
    const normalizedQuery = searchQuery.trim().toLowerCase();
    const matchedCommits = normalizedQuery
      ? allCommits.filter((commit) => matchesSearchQuery(commit, normalizedQuery))
      : allCommits;

    if (matchedCommits.length === 0) {
      closePopover();
      latestViewModelBySha = new Map();
      const emptyEl = doc.createElement('div');
      emptyEl.className = 'gw-quiet-empty';
      emptyEl.dataset.testid = normalizedQuery ? 'graph-search-empty' : 'graph-empty';
      emptyEl.textContent = normalizedQuery ? t('graph.search.noMatches') : t('graph.empty');
      bodyEl.replaceChildren(emptyEl);
      return;
    }

    // 搜索结果只连接结果集内部的父子关系，否则每个被滤掉的父提交都会留下一条贯穿到底的泳道
    let visibleCommits = matchedCommits;
    if (normalizedQuery) {
      const visibleShas = new Set(matchedCommits.map((commit) => commit.sha));
      visibleCommits = matchedCommits.map((commit) => ({
        ...commit,
        parents: commit.parents.filter((parentSha) => visibleShas.has(parentSha)),
      }));
    }

    const currentRefId = activeRepo.branch && !activeRepo.isDetached ? `refs/heads/${activeRepo.branch}` : null;
    const remoteRefId = activeRepo.upstream ? `refs/remotes/${activeRepo.upstream}` : null;
    const viewModels = toHistoryItemViewModels(visibleCommits, {
      headSha: activeRepo.headOid ?? null,
      currentRefId,
      remoteRefId,
      colorMap: buildRefColorMap({ currentRefId, remoteRefId, scope: graphScope, commits: visibleCommits }),
    });
    latestViewModelBySha = new Map(viewModels.map((viewModel) => [viewModel.commit.sha, viewModel]));

    const listEl = doc.createElement('div');
    listEl.className = 'gw-commit-list';
    listEl.dataset.testid = 'graph-commit-list';
    listEl.setAttribute('role', 'list');

    for (const viewModel of viewModels) {
      listEl.append(renderCommitRow(viewModel, t));
      if (expandedCommits.has(viewModel.commit.sha)) {
        listEl.append(renderCommitFiles(viewModel, t));
      }
    }

    const footerEl = renderListFooter({
      graph,
      allCommits,
      lastViewModel: viewModels.at(-1),
      loadingMore,
      t,
    });
    bodyEl.replaceChildren(...(footerEl ? [listEl, footerEl] : [listEl]));
    deps.restoreFocus(bodyEl, savedFocus);

    if (popoverSha) renderPopover(popoverSha);
  };

  const render = (state) => {
    latestRenderState = state;
    const { t } = state;

    sectionTitleEl.textContent = t('section.graph');
    searchInputEl.placeholder = t('graph.search.placeholder');
    searchInputEl.setAttribute('aria-label', t('graph.search.inputAria'));
    searchClearBtn.title = t('graph.search.clear');
    searchClearBtn.setAttribute('aria-label', t('graph.search.clear'));
    searchBarEl.classList.toggle('hidden', !searchVisible);

    renderToolbar(state);
    renderCommitList(state);
  };

  const clearDetailCache = () => {
    commitDetailCache.clear();
    detailErrors.clear();
    loadingDetailShas.clear();
    expandedCommits.clear();
    closePopover();
  };

  const closeOverlays = () => {
    closeMoreMenu();
    closePopover();
  };

  return {
    render,
    clearDetailCache,
    closeOverlays,
  };
};
