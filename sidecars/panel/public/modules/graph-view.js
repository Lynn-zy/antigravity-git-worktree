/**
 * Antigravity Git Graph 下区「图表」视图组件。
 * 负责单行紧凑顶栏、⋯ 三项溢出菜单、本地即时提交搜索、动态 SVG 拓扑车道、
 * 原地文件展开（含连续穿行竖线）、分页加载与最小遮挡悬浮提交详情卡。
 */

import {
  GRAPH_ROW_HEIGHT,
  computeGraphTopology,
  computeGraphMetrics,
  buildCurvePath,
} from './graph-layout.js';
import {
  computeMinOcclusionPopoverStyle,
  createPopoverController,
} from './popover.js';
import { formatRelativeTime, formatAbsoluteTime } from './i18n.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const FILE_SUBROW_HEIGHT = 22;
const MAX_VISIBLE_REFS = 2;
const GRAPH_HARD_SOFT_LIMIT = 2000;

const createSvgNode = (tagName, attrs = {}) => {
  const el = document.createElementNS(SVG_NS, tagName);
  for (const [key, value] of Object.entries(attrs)) {
    el.setAttribute(key, String(value));
  }
  return el;
};

const classifyRef = (ref) => {
  const fullRef = typeof ref?.fullRef === 'string' ? ref.fullRef : '';
  const type = typeof ref?.type === 'string' ? ref.type : '';
  if (type === 'head' || fullRef === 'HEAD') {
    return { rank: 0, className: 'is-head' };
  }
  if (type === 'branch' || fullRef.startsWith('refs/heads/')) {
    return { rank: 1, className: 'is-branch' };
  }
  if (type === 'remote' || fullRef.startsWith('refs/remotes/')) {
    return { rank: 2, className: 'is-remote' };
  }
  if (type === 'tag' || fullRef.startsWith('refs/tags/')) {
    return { rank: 3, className: 'is-tag' };
  }
  return { rank: 4, className: 'is-remote' };
};

const sortCommitRefs = (refs) => {
  if (!Array.isArray(refs) || refs.length === 0) return [];
  const deduped = [];
  const seen = new Set();
  for (const ref of refs) {
    if (!ref?.name) continue;
    const classified = classifyRef(ref);
    const key = `${classified.rank}:${ref.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push({
      name: ref.name,
      fullRef: ref.fullRef || '',
      ...classified,
    });
  }
  return deduped.sort((a, b) => a.rank - b.rank);
};

const matchesSearchQuery = (commit, normalizedQuery) => {
  if (!normalizedQuery) return true;
  const haystacks = [
    commit?.subject,
    commit?.shortSha,
    commit?.sha,
    commit?.authorName,
    commit?.authorEmail,
  ];
  for (const field of haystacks) {
    if (typeof field === 'string' && field.toLowerCase().includes(normalizedQuery)) {
      return true;
    }
  }
  if (Array.isArray(commit?.refs)) {
    for (const ref of commit.refs) {
      if (typeof ref?.name === 'string' && ref.name.toLowerCase().includes(normalizedQuery)) {
        return true;
      }
      if (typeof ref?.fullRef === 'string' && ref.fullRef.toLowerCase().includes(normalizedQuery)) {
        return true;
      }
    }
  }
  return false;
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

const buildCommitRowSvg = ({ topologyRow, metrics, isHead, isLastRow }) => {
  const svg = createSvgNode('svg', {
    class: 'gw-graph-svg',
    width: metrics.width,
    height: metrics.rowHeight,
    viewBox: `0 0 ${metrics.width} ${metrics.rowHeight}`,
    'aria-hidden': 'true',
  });

  const cy = metrics.rowHeight / 2;
  const bottomY = metrics.rowHeight;
  const ownX = metrics.getLaneX(topologyRow.ownLane);

  for (const passLane of topologyRow.passThroughLanesBefore) {
    const laneX = metrics.getLaneX(passLane.lane);
    svg.append(
      createSvgNode('line', {
        x1: laneX,
        y1: 0,
        x2: laneX,
        y2: bottomY,
        stroke: passLane.color,
        'stroke-width': '1.6',
      }),
    );
  }

  for (const exiting of topologyRow.exitingLanes) {
    const fromX = metrics.getLaneX(exiting.fromLane);
    const toX = metrics.getLaneX(exiting.toLane);
    svg.append(
      createSvgNode('path', {
        d: buildCurvePath(fromX, 0, toX, cy),
        stroke: exiting.color,
        'stroke-width': '1.6',
        fill: 'none',
      }),
    );
  }

  if (topologyRow.incomingOnOwnLane) {
    svg.append(
      createSvgNode('line', {
        x1: ownX,
        y1: 0,
        x2: ownX,
        y2: cy,
        stroke: topologyRow.ownColor,
        'stroke-width': '1.6',
      }),
    );
  }

  for (const edge of topologyRow.outgoingEdges) {
    const fromX = metrics.getLaneX(edge.fromLane);
    const toX = metrics.getLaneX(edge.toLane);
    svg.append(
      createSvgNode('path', {
        d: buildCurvePath(fromX, cy, toX, bottomY),
        stroke: edge.color,
        'stroke-width': '1.6',
        fill: 'none',
      }),
    );
  }

  // 仅在列表末尾分页截断边界绘制短淡出虚线，避免在中间提交跨行悬空
  if (topologyRow.hasHiddenParent && topologyRow.outgoingEdges.length === 0 && isLastRow) {
    svg.append(
      createSvgNode('line', {
        x1: ownX,
        y1: cy,
        x2: ownX,
        y2: bottomY - 2,
        stroke: topologyRow.ownColor,
        'stroke-width': '1.6',
        'stroke-opacity': '0.45',
        'stroke-dasharray': '2 2',
      }),
    );
  }

  if (isHead) {
    svg.append(
      createSvgNode('circle', {
        cx: ownX,
        cy,
        r: '4.5',
        fill: 'var(--gw-bg)',
        stroke: topologyRow.ownColor,
        'stroke-width': '1.6',
      }),
    );
    svg.append(
      createSvgNode('circle', {
        cx: ownX,
        cy,
        r: '2.1',
        fill: topologyRow.ownColor,
      }),
    );
  } else {
    svg.append(
      createSvgNode('circle', {
        cx: ownX,
        cy,
        r: '3.5',
        fill: topologyRow.ownColor,
        stroke: 'var(--gw-bg)',
        'stroke-width': '1',
      }),
    );
  }

  return svg;
};

const buildPassThroughSvg = (passThroughLanesAfter, metrics, height = FILE_SUBROW_HEIGHT) => {
  const svg = createSvgNode('svg', {
    class: 'gw-graph-svg',
    width: metrics.width,
    height,
    viewBox: `0 0 ${metrics.width} ${height}`,
    'aria-hidden': 'true',
  });

  for (const laneItem of passThroughLanesAfter) {
    const laneX = metrics.getLaneX(laneItem.lane);
    svg.append(
      createSvgNode('line', {
        x1: laneX,
        y1: 0,
        x2: laneX,
        y2: height,
        stroke: laneItem.color,
        'stroke-width': '1.6',
      }),
    );
  }

  return svg;
};

const formatFileStatusClass = (status) => {
  const code = typeof status === 'string' && status.trim() ? status.trim()[0].toUpperCase() : 'M';
  if (code === 'A') return 'is-added';
  if (code === 'D') return 'is-deleted';
  if (code === 'R') return 'is-renamed';
  if (code === 'C') return 'is-copied';
  return 'is-modified';
};

/**
 * 创建下区「图表」视图控制器，协调顶栏工具、提交拓扑图、原地文件展开、分页与详情悬浮卡。
 *
 * @param {{
 *   sectionTitleEl: HTMLElement,
 *   toolbarActionsEl: HTMLElement,
 *   searchBarEl: HTMLElement,
 *   bodyEl: HTMLElement,
 *   moreMenuEl: HTMLElement,
 *   popoverEl: HTMLElement
 * }} elements DOM 容器节点集合
 * @param {{
 *   createIcon: (name: string, className?: string) => SVGElement,
 *   createSplitPath: (filePath: string, origPath?: string | null) => HTMLElement,
 *   captureFocus: (container: HTMLElement) => { focusId: string | null, wasFocusVisible: boolean } | null,
 *   restoreFocus: (container: HTMLElement, savedFocus: { focusId: string | null, wasFocusVisible: boolean } | null) => void,
 *   showToast: (message: string, variant?: 'info' | 'success' | 'warning' | 'error', detail?: string) => void,
 *   onOpenFile: (file: Record<string, any>) => void,
 *   onToggleScope: (nextScope: 'auto' | 'all') => void,
 *   onFetch: (repo: Record<string, any>) => Promise<void>,
 *   onPull: (repo: Record<string, any>) => Promise<void>,
 *   onPushOrPublish: (repo: Record<string, any>) => void,
 *   onRefresh: () => Promise<void>,
 *   onLoadMore: () => Promise<void>,
 *   onSwitchLanguage: () => void,
 *   onLoadCommitDetail: (worktreePath: string, sha: string) => Promise<any>
 * }} deps 外部服务与交互回调
 * @returns {{
 *   render: (state: { activeRepo: Record<string, any> | null, graph: Record<string, any> | null, graphScope: 'auto' | 'all', pendingOp: string | null, loadingMore: boolean, locale: 'zh-CN' | 'en', t: (key: string, params?: Record<string, unknown>) => string }) => void,
 *   clearDetailCache: () => void,
 *   closeOverlays: () => void
 * }} 图表视图控制接口（有 DOM 读写与事件监听副作用）
 */
export const createGraphView = (elements, deps) => {
  const {
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

  const findCommitBySha = (sha) => {
    const commits = latestRenderState?.graph?.commits ?? [];
    return commits.find((item) => item.sha === sha) ?? null;
  };

  const findCommitRowEl = (sha) => {
    for (const row of bodyEl.querySelectorAll('.gw-commit-row')) {
      if (row.dataset.commitSha === sha) return row;
    }
    return null;
  };

  const renderAndPositionPopover = (sha) => {
    if (!latestRenderState || !sha) return;
    const commit = findCommitBySha(sha);
    const anchorEl = findCommitRowEl(sha);
    if (!commit || !anchorEl) {
      popoverController.close();
      return;
    }

    const { t, locale } = latestRenderState;
    const detail = commitDetailCache.get(sha);
    const isLoadingDetail = loadingDetailShas.has(sha);
    const popState = popoverController.getState();

    const headerEl = doc.createElement('div');
    headerEl.className = 'gw-popover-header';

    const shaSpan = doc.createElement('span');
    shaSpan.className = 'gw-popover-sha';
    shaSpan.textContent = commit.shortSha || sha.slice(0, 7);

    const actionsEl = doc.createElement('div');
    actionsEl.className = 'gw-popover-actions';

    const copyBtn = doc.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'gw-popover-copy-btn';
    copyBtn.dataset.testid = 'popover-copy-sha-btn';
    copyBtn.append(deps.createIcon('copy'));
    const copyTextSpan = doc.createElement('span');
    copyTextSpan.textContent = t('popover.copySha');
    copyBtn.append(copyTextSpan);
    copyBtn.addEventListener('click', () => {
      void copyTextWithFallback(commit.sha).then((copied) => {
        if (copied) {
          deps.showToast(t('popover.copiedSha', { sha: commit.shortSha || sha.slice(0, 7) }), 'success');
        }
      });
    });

    actionsEl.append(copyBtn);

    if (popState.pinned) {
      const closeBtn = doc.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'gw-icon-btn';
      closeBtn.dataset.testid = 'popover-close-btn';
      closeBtn.title = t('popover.close');
      closeBtn.setAttribute('aria-label', t('popover.close'));
      closeBtn.append(deps.createIcon('close'));
      closeBtn.addEventListener('click', () => popoverController.close());
      actionsEl.append(closeBtn);
    }

    headerEl.append(shaSpan, actionsEl);

    const subjectEl = doc.createElement('h3');
    subjectEl.id = 'popover-subject';
    subjectEl.className = 'gw-popover-subject';
    subjectEl.textContent = detail?.subject || commit.subject || '';

    const metaEl = doc.createElement('div');
    metaEl.className = 'gw-popover-meta';

    const authorLine = doc.createElement('div');
    const authorText = commit.authorEmail
      ? `${commit.authorName || ''} <${commit.authorEmail}>`
      : (commit.authorName || '');
    authorLine.textContent = `${t('popover.author')}: ${authorText}`;
    metaEl.append(authorLine);

    const relTime = formatRelativeTime(commit.timestamp, locale);
    const absTime = formatAbsoluteTime(commit.timestamp, locale);
    if (relTime || absTime) {
      const timeLine = doc.createElement('div');
      timeLine.textContent = relTime && absTime ? `${relTime} (${absTime})` : (absTime || relTime);
      metaEl.append(timeLine);
    }

    const coAuthors = Array.isArray(detail?.coAuthors) ? detail.coAuthors : [];
    if (coAuthors.length > 0) {
      const coLine = doc.createElement('div');
      const coText = coAuthors
        .map((author) => (author.email ? `${author.name} <${author.email}>` : author.name))
        .join(', ');
      coLine.textContent = `${t('popover.coAuthors')}: ${coText}`;
      metaEl.append(coLine);
    }

    const bodyBox = doc.createElement('pre');
    bodyBox.className = 'gw-popover-body';
    if (isLoadingDetail && !detail) {
      bodyBox.classList.add('is-empty');
      bodyBox.textContent = t('graph.loadingDetail');
    } else if (detail && typeof detail.body === 'string' && detail.body.trim()) {
      bodyBox.textContent = detail.body.trim();
    } else {
      bodyBox.classList.add('is-empty');
      bodyBox.textContent = t('popover.noBody');
    }

    popoverEl.replaceChildren(headerEl, subjectEl, metaEl, bodyBox);
    popoverEl.classList.remove('hidden');

    const viewportRect = {
      top: 0,
      left: 0,
      width: win.innerWidth,
      height: win.innerHeight,
    };
    const targetWidth = Math.min(340, Math.max(200, viewportRect.width - 16));
    popoverEl.style.width = `${targetWidth}px`;
    popoverEl.style.maxHeight = `${Math.max(120, Math.floor(viewportRect.height * 0.65))}px`;

    const measuredHeight = Math.min(260, Math.max(110, popoverEl.scrollHeight));
    const anchorRect = anchorEl.getBoundingClientRect();
    const graphContentRect = bodyEl.getBoundingClientRect();

    const style = computeMinOcclusionPopoverStyle(
      anchorRect,
      { width: targetWidth, height: measuredHeight },
      graphContentRect,
      viewportRect,
      { gap: 4, padding: 8 },
    );

    popoverEl.style.top = `${style.top}px`;
    popoverEl.style.left = `${style.left}px`;
    popoverEl.style.width = `${style.width}px`;
    popoverEl.style.maxHeight = `${style.maxHeight}px`;
    popoverEl.dataset.placement = style.placement;
    popoverEl.dataset.occludedGraphPx = String(Math.round(style.occludedGraphPx));
  };

  const syncActiveCommitHighlight = () => {
    const activeSha = popoverController.getState().activeSha;
    const pinned = popoverController.getState().pinned;
    for (const row of bodyEl.querySelectorAll('.gw-commit-row')) {
      const isMatch = Boolean(activeSha && row.dataset.commitSha === activeSha);
      row.classList.toggle('is-popover-active', isMatch);
      const btn = row.querySelector('.gw-commit-detail-btn');
      if (btn) {
        btn.classList.toggle('is-active', isMatch && pinned);
      }
    }
  };

  const ensureCommitDetail = async (sha) => {
    const activeRepo = latestRenderState?.activeRepo;
    if (!activeRepo?.worktreePath) return null;
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
      const detail = await deps.onLoadCommitDetail(activeRepo.worktreePath, sha);
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
      const popState = popoverController.getState();
      if (popState.activeSha === sha) {
        renderAndPositionPopover(sha);
      }
    }
  };

  const popoverController = createPopoverController({
    onOpen: (sha) => {
      syncActiveCommitHighlight();
      renderAndPositionPopover(sha);
      if (!commitDetailCache.has(sha)) {
        void ensureCommitDetail(sha);
      }
    },
    onClose: () => {
      popoverEl.classList.add('hidden');
      popoverEl.replaceChildren();
      syncActiveCommitHighlight();
    },
  });

  popoverEl.addEventListener('mouseenter', () => popoverController.enterCard());
  popoverEl.addEventListener('mouseleave', () => popoverController.leaveCard());

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
        icon: 'search',
        label: t('graph.menu.toggleSearch'),
        action: () => {
          searchVisible = !searchVisible;
          searchBarEl.classList.toggle('hidden', !searchVisible);
          if (searchVisible) {
            searchInputEl.focus();
          } else if (searchQuery) {
            searchQuery = '';
            searchInputEl.value = '';
            searchClearBtn.classList.add('hidden');
            if (latestRenderState) renderCommitList(latestRenderState);
          }
        },
      },
      {
        id: 'collapse-all',
        icon: 'collapseAll',
        label: t('graph.menu.collapseAll'),
        action: () => {
          expandedCommits.clear();
          if (latestRenderState) renderCommitList(latestRenderState);
        },
      },
      {
        id: 'switch-language',
        icon: 'globe',
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

      const iconWrap = doc.createElement('span');
      iconWrap.className = 'gw-menu-item-icon';
      iconWrap.setAttribute('aria-hidden', 'true');
      iconWrap.append(deps.createIcon(item.icon));

      const labelSpan = doc.createElement('span');
      labelSpan.className = 'gw-menu-item-text';
      labelSpan.textContent = item.label;

      btn.append(iconWrap, labelSpan);
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
    searchQuery = '';
    searchInputEl.value = '';
    searchClearBtn.classList.add('hidden');
    searchInputEl.focus();
    if (latestRenderState) {
      renderCommitList(latestRenderState);
    }
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
    const popState = popoverController.getState();
    if (!popState.activeSha) return;
    if (!popState.pinned) {
      popoverController.close();
      return;
    }
    renderAndPositionPopover(popState.activeSha);
  }, { passive: true });

  doc.addEventListener('pointerdown', (event) => {
    const target = event.target;
    if (!(target instanceof Node)) return;

    if (moreMenuOpen && !moreMenuEl.contains(target) && !toolbarActionsEl.contains(target)) {
      closeMoreMenu();
    }

    const popState = popoverController.getState();
    if (popState.pinned && !popoverEl.contains(target)) {
      const detailTrigger = target instanceof Element ? target.closest('.gw-commit-detail-btn') : null;
      if (!detailTrigger) {
        popoverController.close();
      }
    }
  });

  doc.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (moreMenuOpen) {
        closeMoreMenu();
      }
      if (popoverController.getState().activeSha) {
        popoverController.close();
      }
    }
  });

  win.addEventListener('resize', () => {
    closeMoreMenu();
    const popState = popoverController.getState();
    if (popState.activeSha) {
      renderAndPositionPopover(popState.activeSha);
    }
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
    scopeBtn.className = graphScope === 'all' ? 'gw-scope-btn is-all gw-clip-focus' : 'gw-scope-btn gw-clip-focus';
    scopeBtn.dataset.testid = 'graph-scope-btn';
    scopeBtn.dataset.focusId = 'graph-scope';
    scopeBtn.textContent = graphScope === 'all' ? t('graph.scopeAll') : t('graph.scopeAuto');
    scopeBtn.title = t('graph.scopeToggleTitle');
    scopeBtn.disabled = !activeRepo;
    scopeBtn.addEventListener('click', () => {
      deps.onToggleScope(graphScope === 'all' ? 'auto' : 'all');
    });
    fragment.append(scopeBtn);

    const createToolbarIconBtn = ({ testid, focusId, icon, title, disabled, onClick }) => {
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'gw-icon-btn';
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
        testid: 'graph-fetch-btn',
        focusId: 'graph-fetch',
        icon: 'fetch',
        title: t('graph.action.fetchTitle'),
        disabled: !activeRepo || isBusy,
        onClick: () => {
          if (activeRepo) void deps.onFetch(activeRepo);
        },
      }),
      createToolbarIconBtn({
        testid: 'graph-pull-btn',
        focusId: 'graph-pull',
        icon: 'pull',
        title: t('graph.action.pullTitle'),
        disabled: !activeRepo || isBare || isDetached || isUnborn || !activeRepo.upstream || isBusy,
        onClick: () => {
          if (activeRepo) void deps.onPull(activeRepo);
        },
      }),
      createToolbarIconBtn({
        testid: 'graph-push-btn',
        focusId: 'graph-push',
        icon: 'push',
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
      icon: 'more',
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

  const renderCommitList = (state) => {
    const { activeRepo, graph, loadingMore, t } = state;
    const savedFocus = deps.captureFocus(bodyEl);

    if (!activeRepo) {
      popoverController.close();
      bodyEl.replaceChildren();
      return;
    }

    if (activeRepo.isUnborn) {
      popoverController.close();
      const unbornEl = doc.createElement('div');
      unbornEl.className = 'gw-quiet-empty';
      unbornEl.dataset.testid = 'graph-unborn-empty';
      unbornEl.textContent = t('repo.unbornNotice');
      bodyEl.replaceChildren(unbornEl);
      return;
    }

    const allCommits = Array.isArray(graph?.commits) ? graph.commits : [];
    const normalizedQuery = searchQuery.trim().toLowerCase();
    const visibleCommits = normalizedQuery
      ? allCommits.filter((commit) => matchesSearchQuery(commit, normalizedQuery))
      : allCommits;

    if (visibleCommits.length === 0) {
      popoverController.close();
      const emptyEl = doc.createElement('div');
      emptyEl.className = 'gw-quiet-empty';
      emptyEl.dataset.testid = normalizedQuery ? 'graph-search-empty' : 'graph-empty';
      emptyEl.textContent = normalizedQuery ? t('graph.search.noMatches') : t('graph.empty');
      bodyEl.replaceChildren(emptyEl);
      return;
    }

    const topology = computeGraphTopology(visibleCommits);
    const metrics = computeGraphMetrics(topology, { rowHeight: GRAPH_ROW_HEIGHT });
    const listEl = doc.createElement('div');
    listEl.className = 'gw-commit-list';
    listEl.dataset.testid = 'graph-commit-list';
    listEl.setAttribute('role', 'list');

    const popState = popoverController.getState();

    visibleCommits.forEach((commit, index) => {
      const topologyRow = topology[index];
      const isExpanded = expandedCommits.has(commit.sha);
      const isHead = commit.sha === activeRepo.headOid
        || (Array.isArray(commit.refs) && commit.refs.some((ref) => ref.type === 'head' || ref.fullRef === 'HEAD'));

      const rowEl = doc.createElement('div');
      rowEl.className = 'gw-commit-row';
      if (isExpanded) rowEl.classList.add('is-expanded');
      if (popState.activeSha === commit.sha) rowEl.classList.add('is-popover-active');
      rowEl.tabIndex = 0;
      rowEl.setAttribute('role', 'listitem');
      rowEl.setAttribute('aria-expanded', String(isExpanded));
      rowEl.dataset.testid = 'commit-row';
      rowEl.dataset.commitSha = commit.sha;
      rowEl.dataset.focusId = `commit:${commit.sha}`;
      rowEl.title = `${commit.shortSha || commit.sha.slice(0, 7)} — ${commit.subject || ''}`;

      rowEl.append(
        buildCommitRowSvg({
          topologyRow,
          metrics,
          isHead,
          isLastRow: index === visibleCommits.length - 1,
        }),
      );

      const subjectEl = doc.createElement('span');
      subjectEl.className = 'gw-commit-subject';
      subjectEl.textContent = commit.subject || '';
      rowEl.append(subjectEl);

      const sortedRefs = sortCommitRefs(commit.refs);
      if (sortedRefs.length > 0) {
        const refsWrap = doc.createElement('div');
        refsWrap.className = 'gw-commit-refs';
        const visibleRefs = sortedRefs.slice(0, MAX_VISIBLE_REFS);
        const overflowRefs = sortedRefs.slice(MAX_VISIBLE_REFS);

        for (const ref of visibleRefs) {
          const pill = doc.createElement('span');
          pill.className = `gw-ref-pill ${ref.className}`;
          pill.textContent = ref.name;
          pill.title = ref.fullRef || ref.name;
          refsWrap.append(pill);
        }

        if (overflowRefs.length > 0) {
          const morePill = doc.createElement('span');
          morePill.className = 'gw-ref-pill is-more';
          morePill.textContent = t('graph.moreRefsLabel', { count: overflowRefs.length });
          morePill.title = overflowRefs.map((ref) => ref.name).join(', ');
          refsWrap.append(morePill);
        }

        rowEl.append(refsWrap);
      }

      const detailBtn = doc.createElement('button');
      detailBtn.type = 'button';
      detailBtn.className = popState.activeSha === commit.sha && popState.pinned
        ? 'gw-icon-btn gw-commit-detail-btn is-active'
        : 'gw-icon-btn gw-commit-detail-btn';
      detailBtn.dataset.testid = 'commit-detail-btn';
      detailBtn.dataset.focusId = `commit-detail:${commit.sha}`;
      detailBtn.title = t('graph.openDetailCard');
      detailBtn.setAttribute('aria-label', t('graph.openDetailCard'));
      detailBtn.append(deps.createIcon('fileText'));
      detailBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        popoverController.togglePin(commit.sha);
      });
      rowEl.append(detailBtn);

      rowEl.addEventListener('click', () => {
        void toggleCommitExpand(commit.sha);
      });
      rowEl.addEventListener('mouseenter', () => {
        popoverController.enterAnchor(commit.sha);
      });
      rowEl.addEventListener('mouseleave', () => {
        popoverController.leaveAnchor();
      });

      listEl.append(rowEl);

      if (isExpanded) {
        const filesWrap = doc.createElement('div');
        filesWrap.className = 'gw-commit-files';
        filesWrap.dataset.testid = 'commit-files';
        filesWrap.dataset.commitSha = commit.sha;

        const detail = commitDetailCache.get(commit.sha);
        const detailErr = detailErrors.get(commit.sha);
        const isLoading = loadingDetailShas.has(commit.sha);

        if (isLoading && !detail) {
          const loadingRow = doc.createElement('div');
          loadingRow.className = 'gw-commit-file-loading';
          loadingRow.append(
            buildPassThroughSvg(topologyRow.passThroughLanesAfter, metrics),
            doc.createTextNode(t('graph.loadingDetail')),
          );
          filesWrap.append(loadingRow);
        } else if (detailErr && !detail) {
          const errRow = doc.createElement('div');
          errRow.className = 'gw-commit-file-empty';
          errRow.append(
            buildPassThroughSvg(topologyRow.passThroughLanesAfter, metrics),
            doc.createTextNode(detailErr),
          );
          filesWrap.append(errRow);
        } else if (!detail?.files || detail.files.length === 0) {
          const emptyFilesRow = doc.createElement('div');
          emptyFilesRow.className = 'gw-commit-file-empty';
          emptyFilesRow.append(
            buildPassThroughSvg(topologyRow.passThroughLanesAfter, metrics),
            doc.createTextNode(t('graph.emptyFiles')),
          );
          filesWrap.append(emptyFilesRow);
        } else {
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
              fileBtn.addEventListener('click', () => deps.onOpenFile(file));
            }

            const indent = doc.createElement('span');
            indent.className = 'gw-commit-file-indent';
            indent.setAttribute('aria-hidden', 'true');

            const statusCode = typeof file.status === 'string' && file.status.trim()
              ? file.status.trim()[0].toUpperCase()
              : 'M';
            const badge = doc.createElement('span');
            badge.className = `gw-status-badge ${formatFileStatusClass(statusCode)}`;
            badge.textContent = statusCode;

            fileBtn.append(
              buildPassThroughSvg(topologyRow.passThroughLanesAfter, metrics),
              indent,
              deps.createSplitPath(file.path, file.origPath),
              badge,
            );
            filesWrap.append(fileBtn);
          }
        }

        listEl.append(filesWrap);
      }
    });

    const fragment = doc.createDocumentFragment();
    fragment.append(listEl);

    const reachedSoftLimit = Boolean(graph?.reachedSoftLimit) || allCommits.length >= GRAPH_HARD_SOFT_LIMIT;
    if (graph?.hasMore && !reachedSoftLimit) {
      const footerEl = doc.createElement('div');
      footerEl.className = 'gw-graph-footer';
      const loadMoreBtn = doc.createElement('button');
      loadMoreBtn.type = 'button';
      loadMoreBtn.className = 'gw-load-more-btn';
      loadMoreBtn.dataset.testid = 'graph-load-more-btn';
      loadMoreBtn.dataset.focusId = 'graph-load-more';
      loadMoreBtn.disabled = Boolean(loadingMore);
      loadMoreBtn.textContent = loadingMore ? t('graph.loadingMore') : t('graph.loadMore');
      loadMoreBtn.addEventListener('click', () => {
        void deps.onLoadMore();
      });
      footerEl.append(loadMoreBtn);
      fragment.append(footerEl);
    } else if (reachedSoftLimit) {
      const footerEl = doc.createElement('div');
      footerEl.className = 'gw-graph-footer';
      const limitNotice = doc.createElement('div');
      limitNotice.className = 'gw-soft-limit-notice';
      limitNotice.dataset.testid = 'graph-soft-limit-notice';
      limitNotice.textContent = t('graph.softLimitNotice');
      footerEl.append(limitNotice);
      fragment.append(footerEl);
    }

    bodyEl.replaceChildren(fragment);
    deps.restoreFocus(bodyEl, savedFocus);

    if (popState.activeSha) {
      if (!findCommitBySha(popState.activeSha)) {
        popoverController.close();
      } else {
        renderAndPositionPopover(popState.activeSha);
      }
    }
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
    popoverController.close();
  };

  const closeOverlays = () => {
    closeMoreMenu();
    popoverController.close();
  };

  return {
    render,
    clearDetailCache,
    closeOverlays,
  };
};
