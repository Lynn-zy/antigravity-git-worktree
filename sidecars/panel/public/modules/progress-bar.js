/**
 * 窗格标题栏底边的不定进度条，移植 VS Code ProgressBar 的 infinite 模式（progressbar.ts / progressbar.css）：
 * 2px 高、宽度 2% 的小段从左到右循环移动。有任一进行中的任务时显示，全部结束后隐藏。
 */

// 同 VS Code ProgressBar.LONG_RUNNING_INFINITE_THRESHOLD：超过 10 秒改为步进动画，降低 GPU 占用
const LONG_RUNNING_MS = 10_000;

/**
 * 在窗格标题栏底边挂一条进度条。
 *
 * @param {HTMLElement} headerEl 窗格标题栏（需为定位容器），进度条贴在它的底边
 * @param {{ hideDelayMs?: number }} [options] 全部任务结束后再等多久隐藏；
 *   VS Code 源代码管理的进度为 300ms，连续的 Git 操作之间不闪烁
 * @returns {{ begin: () => () => void }} `begin` 开始一项任务并立即显示，返回结束函数，每项任务调用一次
 */
export const createProgressBar = (headerEl, { hideDelayMs = 0 } = {}) => {
  const doc = headerEl.ownerDocument;
  const win = doc.defaultView;
  // 进度状态由所在窗格的 aria-busy 表达，进度条本身只是装饰
  const busyEl = headerEl.closest('section');

  const barEl = doc.createElement('div');
  barEl.className = 'gw-progress';
  barEl.dataset.testid = 'progress-bar';
  barEl.setAttribute('aria-hidden', 'true');
  const bitEl = doc.createElement('div');
  bitEl.className = 'gw-progress-bit';
  barEl.append(bitEl);
  headerEl.append(barEl);

  let pendingCount = 0;
  let hideTimer = null;
  let longRunningTimer = null;

  const show = () => {
    if (barEl.classList.contains('is-active')) return;
    barEl.classList.add('is-active');
    busyEl.setAttribute('aria-busy', 'true');
    longRunningTimer = win.setTimeout(() => barEl.classList.add('is-long-running'), LONG_RUNNING_MS);
  };

  const hide = () => {
    win.clearTimeout(longRunningTimer);
    barEl.classList.remove('is-active', 'is-long-running');
    busyEl.removeAttribute('aria-busy');
  };

  const begin = () => {
    pendingCount += 1;
    win.clearTimeout(hideTimer);
    show();

    return () => {
      pendingCount -= 1;
      if (pendingCount > 0) return;
      hideTimer = win.setTimeout(hide, hideDelayMs);
    };
  };

  return { begin };
};
