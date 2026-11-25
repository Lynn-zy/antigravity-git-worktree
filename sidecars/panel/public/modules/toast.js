/**
 * 轻提示（Toast）就近显示模块：提示条贴在触发操作的控件下方，下方空间不足时改到上方；
 * 没有锚点或锚点不可见时停靠在面板底部。同一锚点的提示条叠成一栈。
 */

const TOAST_GAP = 4;
const TOAST_EDGE_MARGIN = 8;
const MIN_SPACE_BELOW = 96;
const MAX_TOASTS_PER_STACK = 3;

/**
 * 计算提示栈的固定定位。
 *
 * @param {{ top: number, bottom: number, width: number, height: number } | null} anchorRect 触发控件的视口矩形，无锚点时为 null
 * @param {number} viewportHeight 视口高度
 * @param {Array<{ top: number, bottom: number }>} [clipRects=[]] 会裁切锚点的祖先滚动容器矩形；锚点只有落在其中的部分算可见
 * @returns {{ edge: 'top' | 'bottom', offset: number }} 以视口上边（edge = 'top'）或下边为基准的像素偏移（无副作用）
 */
export const computeToastPlacement = (anchorRect, viewportHeight, clipRects = []) => {
  if (!anchorRect || anchorRect.width <= 0) {
    return { edge: 'bottom', offset: TOAST_EDGE_MARGIN };
  }
  let top = Math.max(anchorRect.top, 0);
  let bottom = Math.min(anchorRect.bottom, viewportHeight);
  for (const clip of clipRects) {
    top = Math.max(top, clip.top);
    bottom = Math.min(bottom, clip.bottom);
  }
  if (bottom <= top) {
    return { edge: 'bottom', offset: TOAST_EDGE_MARGIN };
  }
  const below = bottom + TOAST_GAP;
  const spaceBelow = viewportHeight - below;
  const spaceAbove = top - TOAST_GAP;
  // 下方放得下就贴下方；都放不下时选空间更大的一侧，避免提示栈越出视口
  if (spaceBelow >= MIN_SPACE_BELOW || spaceBelow >= spaceAbove) {
    return { edge: 'top', offset: Math.max(TOAST_EDGE_MARGIN, below) };
  }
  return { edge: 'bottom', offset: Math.max(TOAST_EDGE_MARGIN, viewportHeight - top + TOAST_GAP) };
};

/**
 * 创建就近提示控制器。
 *
 * @param {{ layerEl: HTMLElement, createIcon: (name: string, className?: string) => SVGElement }} options 提示栈挂载层与图标工厂
 * @returns {{
 *   show: (message: string, variant?: 'info' | 'success' | 'warning' | 'error', options?: { detail?: string, anchor?: Element | null }) => void
 * }} 提示控制接口（有 DOM 写入、定时器与 resize 监听副作用）
 */
export const createToastController = ({ layerEl, createIcon }) => {
  const doc = layerEl.ownerDocument;
  const win = doc.defaultView;
  const stacks = new Map();

  // 祖先滚动容器会裁掉锚点，例如更改区滚动后提交按钮已滚出该区可视范围、但仍在视口内
  const collectClipRects = (anchor) => {
    const clipRects = [];
    for (let el = anchor.parentElement; el; el = el.parentElement) {
      if (win.getComputedStyle(el).overflowY !== 'visible') clipRects.push(el.getBoundingClientRect());
    }
    return clipRects;
  };

  const placeStack = (stackEl, anchor) => {
    const anchorRect = anchor?.isConnected ? anchor.getBoundingClientRect() : null;
    const clipRects = anchorRect ? collectClipRects(anchor) : [];
    const { edge, offset } = computeToastPlacement(anchorRect, win.innerHeight, clipRects);
    stackEl.style.top = edge === 'top' ? `${offset}px` : '';
    stackEl.style.bottom = edge === 'bottom' ? `${offset}px` : '';
  };

  const getStack = (anchor) => {
    let stackEl = stacks.get(anchor);
    if (!stackEl) {
      stackEl = doc.createElement('div');
      stackEl.className = 'gw-toast-stack';
      layerEl.append(stackEl);
      stacks.set(anchor, stackEl);
    }
    placeStack(stackEl, anchor);
    return stackEl;
  };

  const show = (message, variant = 'info', { detail = '', anchor = null } = {}) => {
    const stackEl = getStack(anchor);
    while (stackEl.children.length >= MAX_TOASTS_PER_STACK) {
      stackEl.firstElementChild.remove();
    }

    const toastEl = doc.createElement('div');
    toastEl.className = `gw-toast is-${variant}`;
    toastEl.dataset.testid = `toast-${variant}`;
    toastEl.setAttribute('role', variant === 'error' ? 'alert' : 'status');

    const iconName = { error: 'error', warning: 'warning', success: 'check' }[variant] ?? 'info';
    const iconWrap = doc.createElement('span');
    iconWrap.className = 'gw-toast-icon';
    iconWrap.setAttribute('aria-hidden', 'true');
    iconWrap.append(createIcon(iconName));

    const contentWrap = doc.createElement('div');
    contentWrap.className = 'gw-toast-content';
    const msgDiv = doc.createElement('div');
    msgDiv.textContent = message;
    contentWrap.append(msgDiv);
    if (detail) {
      const detailDiv = doc.createElement('div');
      detailDiv.className = 'gw-toast-detail';
      detailDiv.textContent = detail;
      contentWrap.append(detailDiv);
    }

    const closeBtn = doc.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'gw-icon-btn';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.append(createIcon('close'));

    let timerId = null;
    const dismiss = () => {
      win.clearTimeout(timerId);
      toastEl.remove();
      // 被挤出栈的旧提示到期时，同一锚点可能已建了新栈，只清理自己所在的栈
      if (stackEl.childElementCount === 0 && stacks.get(anchor) === stackEl) {
        stackEl.remove();
        stacks.delete(anchor);
      }
    };

    closeBtn.addEventListener('click', dismiss);
    toastEl.append(iconWrap, contentWrap, closeBtn);
    stackEl.append(toastEl);
    timerId = win.setTimeout(dismiss, variant === 'error' || variant === 'warning' ? 5500 : 3400);
  };

  win.addEventListener('resize', () => {
    for (const [anchor, stackEl] of stacks) placeStack(stackEl, anchor);
  });

  return { show };
};
