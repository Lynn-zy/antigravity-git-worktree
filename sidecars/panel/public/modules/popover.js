/**
 * 提交详情悬浮卡（Popover）最小可见图表遮挡定位算法与交互定时控制器。
 * 纯函数计算与 DOM/定时器控制解耦，可在无浏览器环境的 Node.js 下直接导入验证。
 */

/** @type {Readonly<{ hoverOpenMs: number, hoverCloseMs: number }>} 悬浮详情卡默认开关延迟（毫秒） */
export const POPOVER_TIMINGS = Object.freeze({
  hoverOpenMs: 260,
  hoverCloseMs: 180,
});

const normalizeRect = (rect) => {
  const top = Number.isFinite(rect?.top) ? rect.top : 0;
  const left = Number.isFinite(rect?.left) ? rect.left : 0;
  const rawWidth = Number.isFinite(rect?.width)
    ? rect.width
    : (Number.isFinite(rect?.right) ? rect.right - left : 0);
  const rawHeight = Number.isFinite(rect?.height)
    ? rect.height
    : (Number.isFinite(rect?.bottom) ? rect.bottom - top : 0);
  const width = Math.max(0, rawWidth);
  const height = Math.max(0, rawHeight);
  const right = Number.isFinite(rect?.right) ? rect.right : left + width;
  const bottom = Number.isFinite(rect?.bottom) ? rect.bottom : top + height;
  return { top, left, right, bottom, width, height };
};

const computeVerticalOverlap = (topA, bottomA, topB, bottomB) =>
  Math.max(0, Math.min(bottomA, bottomB) - Math.max(topA, topB));

/**
 * 计算对可见提交图表区域遮挡最小的悬浮详情卡定位样式。
 * 上方候选允许向上借用「源代码管理」区域空间，仅统计与可见图表行内容区 `graphContentRect` 的垂直重叠像素；
 * 遮挡像素更小的一侧胜出，相等时默认向下；任一侧在视口内空间不足时自动翻转并严格钳制在 `viewportRect` 内。
 *
 * @param {{ top: number, left: number, width?: number, height?: number, right?: number, bottom?: number }} anchorRect 触发悬浮的提交行矩形
 * @param {{ width: number, height: number }} cardSize 详情卡预期尺寸（像素）
 * @param {{ top: number, left?: number, width?: number, height?: number, right?: number, bottom?: number } | null} graphContentRect 可见图表内容区矩形
 * @param {{ top: number, left: number, width?: number, height?: number, right?: number, bottom?: number }} viewportRect 面板/iframe 视口边界矩形
 * @param {{ gap?: number, padding?: number, align?: 'left' | 'right' }} [options] 可选间距、边距与水平对齐参数
 * @returns {{
 *   top: number,
 *   left: number,
 *   width: number,
 *   maxHeight: number,
 *   placement: 'above' | 'below',
 *   occludedGraphPx: number
 * }} 严格不越出视口且避开锚点行本体的定位样式结果（无副作用）
 */
export const computeMinOcclusionPopoverStyle = (
  anchorRect,
  cardSize,
  graphContentRect,
  viewportRect,
  options = {},
) => {
  const anchor = normalizeRect(anchorRect);
  const viewport = normalizeRect(viewportRect);
  const graphContent = graphContentRect ? normalizeRect(graphContentRect) : viewport;

  const gap = Math.max(0, Number.isFinite(options?.gap) ? options.gap : 4);
  const padding = Math.max(0, Number.isFinite(options?.padding) ? options.padding : 8);
  const align = options?.align === 'right' ? 'right' : 'left';

  const cardWidth = Math.max(0, Number.isFinite(cardSize?.width) ? cardSize.width : 280);
  const cardHeight = Math.max(0, Number.isFinite(cardSize?.height) ? cardSize.height : 160);

  const safePadX = Math.min(padding, Math.max(0, viewport.width / 4));
  const safePadY = Math.min(padding, Math.max(0, viewport.height / 4));

  const vpLeft = viewport.left + safePadX;
  const vpRight = viewport.right - safePadX;
  const vpTop = viewport.top + safePadY;
  const vpBottom = viewport.bottom - safePadY;

  const availWidth = Math.max(0, vpRight - vpLeft);
  const width = Math.min(cardWidth, availWidth);
  const desiredLeft = align === 'right' ? anchor.right - width : anchor.left;
  const left = Math.max(vpLeft, Math.min(desiredLeft, vpRight - width));

  const availAbove = Math.max(0, Math.min(anchor.top - gap, vpBottom) - vpTop);
  const availBelow = Math.max(0, vpBottom - Math.max(anchor.bottom + gap, vpTop));

  const fitsAbove = availAbove >= cardHeight;
  const fitsBelow = availBelow >= cardHeight;

  const usedHeightAbove = Math.min(cardHeight, availAbove);
  const topAbove = Math.max(vpTop, Math.min(anchor.top - gap, vpBottom) - usedHeightAbove);
  const occAbove = computeVerticalOverlap(
    topAbove,
    topAbove + usedHeightAbove,
    graphContent.top,
    graphContent.bottom,
  );

  const usedHeightBelow = Math.min(cardHeight, availBelow);
  const topBelow = Math.max(vpTop, anchor.bottom + gap);
  const occBelow = computeVerticalOverlap(
    topBelow,
    topBelow + usedHeightBelow,
    graphContent.top,
    graphContent.bottom,
  );

  let placement = 'below';
  if (fitsAbove && fitsBelow) {
    placement = occAbove < occBelow ? 'above' : 'below';
  } else if (fitsAbove !== fitsBelow) {
    placement = fitsAbove ? 'above' : 'below';
  } else if (availAbove > 0 || availBelow > 0) {
    if (availAbove !== availBelow) {
      placement = availAbove > availBelow ? 'above' : 'below';
    } else {
      placement = occAbove < occBelow ? 'above' : 'below';
    }
  } else {
    const vpHeight = Math.max(0, vpBottom - vpTop);
    const clampedHeight = Math.min(cardHeight, vpHeight);
    const fallbackTop = Math.max(vpTop, Math.min(vpBottom - clampedHeight, anchor.top));
    return {
      top: fallbackTop,
      left,
      width,
      maxHeight: vpHeight,
      placement: 'below',
      occludedGraphPx: computeVerticalOverlap(
        fallbackTop,
        fallbackTop + clampedHeight,
        graphContent.top,
        graphContent.bottom,
      ),
    };
  }

  if (placement === 'above') {
    return {
      top: topAbove,
      left,
      width,
      maxHeight: usedHeightAbove,
      placement: 'above',
      occludedGraphPx: occAbove,
    };
  }

  return {
    top: topBelow,
    left,
    width,
    maxHeight: availBelow,
    placement: 'below',
    occludedGraphPx: occBelow,
  };
};

/**
 * 创建提交详情悬浮卡的悬停延迟与固定状态控制器（纯显式调用，无全局副作用）。
 *
 * @param {{
 *   onOpen?: (sha: string, pinned: boolean) => void,
 *   onClose?: () => void,
 *   hoverOpenMs?: number,
 *   hoverCloseMs?: number,
 *   setTimer?: (fn: () => void, ms: number) => unknown,
 *   clearTimer?: (id: unknown) => void
 * }} [options] 回调与可选定时器注入（便于单元测试）
 * @returns {{
 *   enterAnchor: (sha: string) => void,
 *   leaveAnchor: () => void,
 *   enterCard: () => void,
 *   leaveCard: () => void,
 *   togglePin: (sha: string) => void,
 *   close: () => void,
 *   getState: () => { activeSha: string | null, pinned: boolean },
 *   dispose: () => void
 * }} 控制器实例
 */
export const createPopoverController = (options = {}) => {
  const hoverOpenMs = Number.isFinite(options?.hoverOpenMs)
    ? options.hoverOpenMs
    : POPOVER_TIMINGS.hoverOpenMs;
  const hoverCloseMs = Number.isFinite(options?.hoverCloseMs)
    ? options.hoverCloseMs
    : POPOVER_TIMINGS.hoverCloseMs;
  const schedule = options?.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = options?.clearTimer ?? ((id) => clearTimeout(id));

  let activeSha = null;
  let pinned = false;
  let openTimerId = null;
  let closeTimerId = null;

  const clearOpenTimer = () => {
    if (openTimerId !== null) {
      cancel(openTimerId);
      openTimerId = null;
    }
  };

  const clearCloseTimer = () => {
    if (closeTimerId !== null) {
      cancel(closeTimerId);
      closeTimerId = null;
    }
  };

  const clearAllTimers = () => {
    clearOpenTimer();
    clearCloseTimer();
  };

  const close = () => {
    clearAllTimers();
    if (activeSha === null && !pinned) return;
    activeSha = null;
    pinned = false;
    options?.onClose?.();
  };

  const enterAnchor = (sha) => {
    if (pinned || !sha) return;
    clearCloseTimer();
    if (activeSha === sha) return;
    clearOpenTimer();
    openTimerId = schedule(() => {
      openTimerId = null;
      if (pinned) return;
      activeSha = sha;
      options?.onOpen?.(sha, false);
    }, hoverOpenMs);
  };

  const scheduleHoverClose = () => {
    if (pinned) return;
    clearOpenTimer();
    clearCloseTimer();
    closeTimerId = schedule(() => {
      closeTimerId = null;
      if (!pinned) close();
    }, hoverCloseMs);
  };

  const enterCard = () => {
    clearCloseTimer();
  };

  const togglePin = (sha) => {
    clearAllTimers();
    if (!sha) {
      close();
      return;
    }
    if (pinned && activeSha === sha) {
      close();
      return;
    }
    activeSha = sha;
    pinned = true;
    options?.onOpen?.(sha, true);
  };

  return {
    enterAnchor,
    leaveAnchor: scheduleHoverClose,
    enterCard,
    leaveCard: scheduleHoverClose,
    togglePin,
    close,
    getState: () => ({ activeSha, pinned }),
    dispose: clearAllTimers,
  };
};
