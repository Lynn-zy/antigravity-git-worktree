import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import {
  buildPanelAppBundle,
  buildPanelPageHtml,
} from '../../sidecars/panel/public-bundle.mjs';

import {
  createApiClient,
} from '../../sidecars/panel/public/modules/api-client.js';

import {
  GRAPH_ROW_HEIGHT,
  LANE_STEP,
  MAX_LANES,
  LANE_COLORS,
  computeGraphTopology,
  computeGraphMetrics,
  buildCurvePath,
} from '../../sidecars/panel/public/modules/graph-layout.js';

import {
  POPOVER_TIMINGS,
  computeMinOcclusionPopoverStyle,
  createPopoverController,
} from '../../sidecars/panel/public/modules/popover.js';

import {
  DEFAULT_UI_FONT_STACK,
  DEFAULT_MONO_FONT_STACK,
  normalizeThemeMode,
  relativeLuminance,
  contrastRatio,
  adjustForegroundContrast,
  sanitizeCssFontList,
  resolveThemeVariablesFromComputed,
  initThemeSync,
} from '../../sidecars/panel/public/modules/theme.js';

import {
  SUPPORTED_LOCALES,
  MESSAGES,
  resolveLocale,
  createTranslator,
  translateApiError,
  formatRelativeTime,
  formatAbsoluteTime,
} from '../../sidecars/panel/public/modules/i18n.js';

/**
 * 验证图谱拓扑在任意相邻提交行（含原地展开文件子行）之间 100% 连续无断口，
 * 且每条可见父提交关系都在 outgoingEdges 中存在精确对应。
 */
const assertGraphContinuity = (commits, topology) => {
  assert.equal(topology.length, commits.length);
  const visibleShas = new Set(commits.map((commit) => commit.sha));

  for (let rowIndex = 0; rowIndex < commits.length; rowIndex += 1) {
    const commit = commits[rowIndex];
    const row = topology[rowIndex];

    assert.equal(row.sha, commit.sha);

    // 验证所有可见父提交均出现在 outgoingEdges 中，不可见父提交绝不占槽
    const visibleParents = (commit.parents ?? []).filter((parentSha) => visibleShas.has(parentSha));
    const hiddenCount = (commit.parents ?? []).length - visibleParents.length;
    assert.equal(row.hasHiddenParent, hiddenCount > 0);
    assert.deepEqual(
      new Set(row.outgoingEdges.map((edge) => edge.targetSha)),
      new Set(visibleParents),
    );
    for (const edge of row.outgoingEdges) {
      assert.equal(edge.fromLane, row.ownLane);
      assert.ok(visibleShas.has(edge.targetSha), `不应为不可见父提交 ${edge.targetSha} 建立出边`);
    }

    // 验证本行底部所有连线出口（穿行线 + outgoingEdges 终点）与 passThroughLanesAfter 完全一致
    const bottomSockets = new Map();
    for (const laneItem of row.passThroughLanesBefore) {
      bottomSockets.set(laneItem.lane, laneItem.colorIndex);
    }
    for (const edge of row.outgoingEdges) {
      if (!bottomSockets.has(edge.toLane)) {
        bottomSockets.set(edge.toLane, edge.colorIndex);
      }
    }
    const afterSockets = new Map(
      row.passThroughLanesAfter.map((laneItem) => [laneItem.lane, laneItem.colorIndex]),
    );
    assert.deepEqual(
      new Set(bottomSockets.keys()),
      new Set(afterSockets.keys()),
      `行 ${commit.sha} 底部出口与 passThroughLanesAfter 车道不一致`,
    );

    // 验证相邻行边界（含提交展开文件列表行的垂直穿行线）无缝衔接
    if (rowIndex + 1 < commits.length) {
      const nextRow = topology[rowIndex + 1];
      const nextTopSockets = new Map();
      if (nextRow.incomingOnOwnLane) {
        nextTopSockets.set(nextRow.ownLane, nextRow.ownColorIndex);
      }
      for (const exiting of nextRow.exitingLanes) {
        nextTopSockets.set(exiting.lane, exiting.colorIndex);
      }
      for (const pass of nextRow.passThroughLanesBefore) {
        nextTopSockets.set(pass.lane, pass.colorIndex);
      }

      assert.deepEqual(
        afterSockets,
        nextTopSockets,
        `行 ${commit.sha} 底部到行 ${commits[rowIndex + 1].sha} 顶部之间存在断口或颜色不匹配`,
      );
    }
  }
};

test('纯模块在无 window/document 的 Node.js 环境下直接导入且无顶层副作用', () => {
  assert.equal(typeof globalThis.window, 'undefined');
  assert.equal(typeof globalThis.document, 'undefined');
  assert.equal(GRAPH_ROW_HEIGHT, 24);
  assert.equal(LANE_STEP, 12);
  assert.equal(MAX_LANES, 6);
  assert.equal(LANE_COLORS.length, 6);
  for (const color of LANE_COLORS) {
    assert.match(color, /^var\(--lane-\d,\s*#[0-9a-f]{6}\)$/i);
  }
});

test('graph-layout: 线性提交与边界空输入', () => {
  assert.deepEqual(computeGraphTopology([]), []);

  const commits = [
    { sha: 'c3', parents: ['c2'] },
    { sha: 'c2', parents: ['c1'] },
    { sha: 'c1', parents: [] },
  ];
  const topology = computeGraphTopology(commits);
  assertGraphContinuity(commits, topology);

  assert.equal(topology[0].ownLane, 0);
  assert.equal(topology[0].incomingOnOwnLane, false);
  assert.equal(topology[1].incomingOnOwnLane, true);
  assert.equal(topology[2].incomingOnOwnLane, true);
  assert.deepEqual(topology[2].outgoingEdges, []);
  assert.deepEqual(topology[2].passThroughLanesAfter, []);
});

test('graph-layout: 合并分支（含主干靠左保持与 exitingLanes 收束）连续无断口', () => {
  // 场景 A：经典 Merge Commit 后先遍历 main 新提交再遍历 feature 分支
  const commitsMainFirst = [
    { sha: 'm2', parents: ['m1', 'f1'] },
    { sha: 'm1', parents: ['m0'] },
    { sha: 'f1', parents: ['m0'] },
    { sha: 'm0', parents: [] },
  ];
  const topoA = computeGraphTopology(commitsMainFirst);
  assertGraphContinuity(commitsMainFirst, topoA);
  assert.equal(topoA[0].isMerge, true);
  assert.equal(topoA[0].outgoingEdges.length, 2);
  assert.deepEqual(
    topoA[0].passThroughLanesAfter.map((item) => item.lane),
    [0, 1],
  );
  // f1 合并回早已在 lane 0 等待的 m0，立即释放 lane 1
  assert.deepEqual(topoA[2].outgoingEdges, [
    {
      fromLane: 1,
      toLane: 0,
      targetSha: 'm0',
      colorIndex: topoA[2].ownColorIndex,
      color: topoA[2].ownColor,
      isMerge: false,
    },
  ]);
  assert.deepEqual(topoA[2].passThroughLanesAfter.map((item) => item.lane), [0]);

  // 场景 B：git log --topo-order 先遍历侧分支 f1 再遍历 m1，测试主线留在 lane 0 且 m0 通过 exitingLanes 收束 lane 1
  const commitsSideFirst = [
    { sha: 'm2', parents: ['m1', 'f1'] },
    { sha: 'f1', parents: ['m0'] },
    { sha: 'm1', parents: ['m0'] },
    { sha: 'm0', parents: [] },
  ];
  const topoB = computeGraphTopology(commitsSideFirst);
  assertGraphContinuity(commitsSideFirst, topoB);
  assert.equal(topoB[1].ownLane, 1);
  assert.equal(topoB[2].ownLane, 0);
  assert.equal(topoB[3].ownLane, 0);
  assert.equal(topoB[3].exitingLanes.length, 1);
  assert.equal(topoB[3].exitingLanes[0].lane, 1);
  assert.equal(topoB[3].exitingLanes[0].toLane, 0);
});

test('graph-layout: 交叉多分支、章鱼合并、多独立根节点与复用释放槽位连续性', () => {
  const commits = [
    { sha: 'oct', parents: ['a2', 'b1', 'c1'] },
    { sha: 'tip-independent', parents: ['b1'] },
    { sha: 'c1', parents: ['base'] },
    { sha: 'b1', parents: ['a1'] },
    { sha: 'a2', parents: ['a1'] },
    { sha: 'a1', parents: ['base'] },
    { sha: 'base', parents: [] },
    { sha: 'orphan-tip', parents: ['orphan-root'] },
    { sha: 'orphan-root', parents: [] },
  ];
  const topology = computeGraphTopology(commits);
  assertGraphContinuity(commits, topology);

  // 确认独立分支末端也未发生车道碰撞
  assert.notEqual(topology[1].ownLane, topology[0].ownLane);
  // 确认独立第二个历史根节点不会和前面的根连线，且重新复用最左槽位 0
  assert.equal(topology[7].ownLane, 0);
  assert.equal(topology[7].incomingOnOwnLane, false);
  assert.notEqual(topology[7].ownColorIndex, topology[0].ownColorIndex);
  assert.equal(topology[8].incomingOnOwnLane, true);
});

test('graph-layout: auto 过滤视图与分页截断对不可见父提交不画悬空线头', () => {
  const autoCommits = [
    { sha: 'head-2', parents: ['head-1', 'hidden-topic'] },
    { sha: 'head-1', parents: ['hidden-ancestor'] },
  ];
  const topology = computeGraphTopology(autoCommits);
  assertGraphContinuity(autoCommits, topology);

  assert.equal(topology[0].hasHiddenParent, true);
  assert.equal(topology[0].outgoingEdges.length, 1);
  assert.equal(topology[0].outgoingEdges[0].targetSha, 'head-1');
  assert.deepEqual(topology[0].passThroughLanesAfter.map((item) => item.lane), [0]);

  assert.equal(topology[1].hasHiddenParent, true);
  assert.deepEqual(topology[1].outgoingEdges, []);
  assert.deepEqual(topology[1].passThroughLanesAfter, []);
});

test('graph-layout: 泳道宽度上限 72px 压缩与三阶贝塞尔路径切线生成', () => {
  const metrics6 = computeGraphMetrics(6);
  assert.equal(metrics6.laneCount, 6);
  assert.equal(metrics6.laneStep, 12);
  assert.equal(metrics6.width, 72);

  const metrics10 = computeGraphMetrics(10);
  assert.equal(metrics10.laneCount, 10);
  assert.equal(metrics10.width, 72);
  assert.ok(metrics10.laneStep < 12);
  assert.ok(metrics10.getLaneX(9) < metrics10.width);

  // 极大量并发车道（rawLaneCount > 72）时 effectivePadX 与各车道坐标仍保持正值且不越界
  const metrics80 = computeGraphMetrics(80);
  assert.equal(metrics80.laneCount, 80);
  assert.equal(metrics80.width, 72);
  assert.ok(metrics80.padX >= 2);
  assert.ok(metrics80.laneStep > 0);
  assert.ok(metrics80.getLaneX(0) >= 2);
  assert.ok(metrics80.getLaneX(79) <= metrics80.width - 2);

  assert.equal(buildCurvePath(6, 12, 6, 24), 'M 6 12 L 6 24');
  assert.equal(buildCurvePath(6, 12, 18, 24), 'M 6 12 C 6 18, 18 18, 18 24');
});

test('popover: 第 1、2 行借用上区向上弹出且遮挡图表像素最小', () => {
  const viewportRect = { top: 0, left: 0, width: 360, height: 600 };
  const graphContentRect = { top: 280, left: 0, width: 360, height: 320 };
  const cardSize = { width: 320, height: 150 };

  const row1Anchor = { top: 280, left: 0, width: 360, height: 24 };
  const style1 = computeMinOcclusionPopoverStyle(row1Anchor, cardSize, graphContentRect, viewportRect);
  assert.equal(style1.placement, 'above');
  assert.equal(style1.occludedGraphPx, 0);
  assert.equal(style1.top + style1.maxHeight <= row1Anchor.top, true);

  const row2Anchor = { top: 304, left: 0, width: 360, height: 24 };
  const style2 = computeMinOcclusionPopoverStyle(row2Anchor, cardSize, graphContentRect, viewportRect);
  assert.equal(style2.placement, 'above');
  assert.equal(style2.occludedGraphPx, 20);
});

test('popover: 中部遮挡相等默认向下，底部空间不足自动翻转向上并严格钳制视口', () => {
  const viewportRect = { top: 0, left: 0, width: 320, height: 600 };
  const graphContentRect = { top: 280, left: 0, width: 320, height: 320 };
  const cardSize = { width: 340, height: 120 };

  // 中部行：上方 [304, 424] 与下方 [456, 576] 均全量落在图表区，遮挡均为 120px -> 默认 below
  const middleAnchor = { top: 428, left: 16, width: 300, height: 24 };
  const middleStyle = computeMinOcclusionPopoverStyle(middleAnchor, cardSize, graphContentRect, viewportRect);
  assert.equal(middleStyle.placement, 'below');
  assert.equal(middleStyle.occludedGraphPx, 120);
  assert.ok(middleStyle.left >= viewportRect.left);
  assert.ok(middleStyle.left + middleStyle.width <= viewportRect.left + viewportRect.width);

  // 底部行：下方仅剩 10px，放不下 120px 卡片 -> 翻转至 above
  const bottomAnchor = { top: 558, left: 0, width: 320, height: 24 };
  const bottomStyle = computeMinOcclusionPopoverStyle(bottomAnchor, cardSize, graphContentRect, viewportRect);
  assert.equal(bottomStyle.placement, 'above');
  assert.ok(bottomStyle.top >= viewportRect.top);
  assert.ok(bottomStyle.top + bottomStyle.maxHeight <= bottomAnchor.top);

  // 极矮视口（双侧都放不下完整高度）：选更大一侧并严格钳制 maxHeight 不越界
  const tinyViewport = { top: 0, left: 0, width: 320, height: 180 };
  const tinyGraph = { top: 40, left: 0, width: 320, height: 140 };
  const nearTopAnchor = { top: 42, left: 0, width: 320, height: 24 };
  const tinyStyle = computeMinOcclusionPopoverStyle(
    nearTopAnchor,
    { width: 300, height: 160 },
    tinyGraph,
    tinyViewport,
  );
  assert.equal(tinyStyle.placement, 'below');
  assert.ok(tinyStyle.top >= nearTopAnchor.top + nearTopAnchor.height);
  assert.ok(tinyStyle.top + tinyStyle.maxHeight <= tinyViewport.top + tinyViewport.height);
});

test('popover: 悬浮延迟控制器支持 260ms 打开、移入保活、180ms 离开关闭与 Pin 固定', () => {
  let currentTime = 0;
  let nextTimerId = 1;
  const timers = new Map();
  const events = [];

  const controller = createPopoverController({
    setTimer: (fn, ms) => {
      const id = nextTimerId++;
      timers.set(id, { fn, runAt: currentTime + ms });
      return id;
    },
    clearTimer: (id) => {
      timers.delete(id);
    },
    onOpen: (sha, pinned) => events.push({ type: 'open', sha, pinned }),
    onClose: () => events.push({ type: 'close' }),
  });

  const advanceBy = (deltaMs) => {
    currentTime += deltaMs;
    for (const [id, entry] of [...timers.entries()]) {
      if (entry.runAt <= currentTime) {
        timers.delete(id);
        entry.fn();
      }
    }
  };

  assert.equal(POPOVER_TIMINGS.hoverOpenMs, 260);
  assert.equal(POPOVER_TIMINGS.hoverCloseMs, 180);

  controller.enterAnchor('abc1234');
  advanceBy(200);
  assert.equal(events.length, 0);
  advanceBy(60);
  assert.deepEqual(events, [{ type: 'open', sha: 'abc1234', pinned: false }]);

  controller.leaveAnchor();
  advanceBy(100);
  controller.enterCard();
  advanceBy(200);
  assert.equal(events.length, 1);

  controller.leaveCard();
  advanceBy(180);
  assert.deepEqual(events[1], { type: 'close' });

  controller.togglePin('def5678');
  assert.deepEqual(controller.getState(), { activeSha: 'def5678', pinned: true });
  controller.leaveAnchor();
  advanceBy(500);
  assert.equal(controller.getState().pinned, true);
  controller.close();
  assert.deepEqual(controller.getState(), { activeSha: null, pinned: false });
});

test('theme: 模式规范化、WCAG 相对亮度与 4.5:1 对比度自动微调', () => {
  assert.equal(normalizeThemeMode('dark'), 'dark');
  assert.equal(normalizeThemeMode('vs-dark'), 'dark');
  assert.equal(normalizeThemeMode('hc-black'), 'dark');
  assert.equal(normalizeThemeMode('hc-light'), 'light');
  assert.equal(normalizeThemeMode('vscode-high-contrast-light'), 'light');
  assert.equal(normalizeThemeMode('auto'), null);
  assert.equal(normalizeThemeMode(null), null);

  assert.equal(relativeLuminance([0, 0, 0]), 0);
  assert.equal(relativeLuminance([255, 255, 255]), 1);
  assert.equal(contrastRatio('#000000', '#ffffff'), 21);

  const adjustedOnDark = adjustForegroundContrast('#404040', ['#18181a', '#202024'], 4.5);
  assert.ok(contrastRatio(adjustedOnDark, '#18181a') >= 4.5);
  assert.ok(contrastRatio(adjustedOnDark, '#202024') >= 4.5);

  const adjustedOnLight = adjustForegroundContrast('#c4c4c4', ['#ffffff', '#f8f8f9'], 4.5);
  assert.ok(contrastRatio(adjustedOnLight, '#ffffff') >= 4.5);
  assert.ok(contrastRatio(adjustedOnLight, '#f8f8f9') >= 4.5);
});

test('theme: 字体白名单安全过滤拒绝注入负载并保留双语本地回退', () => {
  assert.equal(
    sanitizeCssFontList('Inter, "Segoe UI"'),
    'Inter, "Segoe UI", "Microsoft YaHei", sans-serif',
  );
  assert.equal(
    sanitizeCssFontList('"JetBrains Mono", Consolas', DEFAULT_MONO_FONT_STACK, DEFAULT_MONO_FONT_STACK),
    '"JetBrains Mono", Consolas, ui-monospace, "Cascadia Mono", monospace',
  );

  for (const malicious of [
    'Arial; background: url(https://evil.example/a.woff2)',
    'expression(alert(1))',
    'var(--injected)',
    '<script>alert(1)</script>',
    'inherit',
    '',
  ]) {
    assert.equal(sanitizeCssFontList(malicious), DEFAULT_UI_FONT_STACK);
  }
});

test('theme: resolveThemeVariablesFromComputed 与 initThemeSync Canvas + MutationObserver 联动', () => {
  const resolvedDark = resolveThemeVariablesFromComputed({
    computedStyle: {
      '--background': '#18181a',
      '--card': '#202024',
      '--error': '#992222',
      '--font-family': '"Segoe UI"',
      '--editor-font-family': '"Cascadia Mono"',
    },
    backgroundRgb: { r: 24, g: 24, b: 26, a: 255 },
    prefersDark: false,
  });
  assert.equal(resolvedDark.mode, 'dark');
  assert.equal(resolvedDark.colorScheme, 'dark');
  assert.ok(contrastRatio(resolvedDark.cssVariables['--gw-error'], '#18181a') >= 4.5);
  assert.ok(resolvedDark.cssVariables['--gw-font-ui'].includes('"Microsoft YaHei"'));
  assert.ok(resolvedDark.cssVariables['--gw-font-mono'].includes('monospace'));

  // 构造纯内存模拟 DOM 与 1x1 Canvas 测试 initThemeSync（不触发 setInterval）
  const styleMap = new Map([['--background', 'oklch(0.2 0.01 250)']]);
  let mockCanvasPixel = [24, 24, 26, 255];
  let observerCallback = null;
  let observerDisconnected = false;
  let mediaListener = null;
  let mediaMatches = false;

  const mockRoot = {
    dataset: {},
    className: '',
    attributes: new Map(),
    getAttribute(name) {
      if (name === 'data-theme') return this.dataset.theme;
      return this.attributes.get(name) ?? null;
    },
    setAttribute(name, value) {
      if (name === 'data-theme') this.dataset.theme = value;
      else this.attributes.set(name, value);
    },
    style: {
      colorScheme: '',
      getPropertyValue: (name) => styleMap.get(name) ?? '',
      setProperty: (name, value) => styleMap.set(name, value),
    },
    ownerDocument: {
      createElement: (tag) => {
        if (tag !== 'canvas') return { style: {}, remove: () => {} };
        return {
          width: 0,
          height: 0,
          getContext: () => ({
            fillStyle: '',
            clearRect: () => {},
            fillRect: () => {},
            getImageData: () => ({ data: mockCanvasPixel }),
          }),
        };
      },
    },
  };

  class MockMutationObserver {
    constructor(cb) {
      observerCallback = cb;
    }

    observe() {}

    takeRecords() {
      return [];
    }

    disconnect() {
      observerDisconnected = true;
    }
  }

  const mockWin = {
    MutationObserver: MockMutationObserver,
    getComputedStyle: () => ({
      getPropertyValue: (name) => styleMap.get(name) ?? '',
    }),
    matchMedia: () => ({
      get matches() {
        return mediaMatches;
      },
      addEventListener: (_evt, cb) => {
        mediaListener = cb;
      },
      removeEventListener: (_evt, cb) => {
        if (mediaListener === cb) mediaListener = null;
      },
    }),
  };

  const notifications = [];
  const themeController = initThemeSync({
    root: mockRoot,
    win: mockWin,
    onThemeChange: (state) => notifications.push(state),
  });

  assert.equal(mockRoot.dataset.theme, 'dark');
  assert.equal(mockRoot.style.colorScheme, 'dark');
  assert.equal(notifications.length, 1);

  // 宿主将 --background 切换为透明（alpha < 250），应回退 matchMedia（prefers-color-scheme: dark = false -> light）
  styleMap.set('--background', 'rgba(0, 0, 0, 0)');
  mockCanvasPixel = [0, 0, 0, 120];
  mediaMatches = false;
  observerCallback([{ attributeName: 'style' }]);
  assert.equal(mockRoot.dataset.theme, 'light');
  assert.equal(mockRoot.style.colorScheme, 'light');

  // 系统暗色偏好切换应实时联动
  mediaMatches = true;
  mediaListener();
  assert.equal(mockRoot.dataset.theme, 'dark');

  // 外部显式设置 data-theme="light" 应覆盖回退，随后 --background 变更应清除该覆写
  mockRoot.dataset.theme = 'light';
  observerCallback([{ attributeName: 'data-theme' }]);
  assert.equal(mockRoot.dataset.theme, 'light');
  assert.equal(mockRoot.style.colorScheme, 'light');

  styleMap.set('--background', '#18181a');
  mockCanvasPixel = [24, 24, 26, 255];
  observerCallback([{ attributeName: 'style' }]);
  assert.equal(mockRoot.dataset.theme, 'dark');

  themeController.dispose();
  assert.equal(observerDisconnected, true);
  assert.equal(mediaListener, null);
});

test('i18n: 中英词典键全对称、全错误码覆盖、时间与语言解析', () => {
  assert.deepEqual(SUPPORTED_LOCALES, ['zh-CN', 'en']);

  const zhKeys = Object.keys(MESSAGES['zh-CN']).sort();
  const enKeys = Object.keys(MESSAGES.en).sort();
  assert.deepEqual(zhKeys, enKeys);

  for (const key of zhKeys) {
    assert.ok(MESSAGES['zh-CN'][key].length > 0, `zh-CN 缺失文案: ${key}`);
    assert.ok(MESSAGES.en[key].length > 0, `en 缺失文案: ${key}`);
  }

  const requiredErrorCodes = [
    'INVALID_REQUEST',
    'OUT_OF_WORKTREE',
    'NO_REPOSITORY',
    'CONFLICT_BLOCKED',
    'EMPTY_COMMIT_MESSAGE',
    'NOTHING_TO_COMMIT',
    'GIT_LOCKED',
    'GIT_TIMEOUT',
    'AUTH_REQUIRED',
    'NON_FAST_FORWARD',
    'NO_REMOTE',
    'GIT_ERROR',
  ];
  for (const code of requiredErrorCodes) {
    assert.ok(MESSAGES['zh-CN'][`error.${code}`], `缺少错误码 zh-CN: ${code}`);
    assert.ok(MESSAGES.en[`error.${code}`], `缺少错误码 en: ${code}`);
    assert.equal(translateApiError({ code }, 'zh-CN'), MESSAGES['zh-CN'][`error.${code}`]);
  }

  assert.equal(resolveLocale('auto', 'zh-TW'), 'zh-CN');
  assert.equal(resolveLocale('auto', 'zh-CN'), 'zh-CN');
  assert.equal(resolveLocale('auto', 'en-US'), 'en');
  assert.equal(resolveLocale('auto', 'ja-JP'), 'en');
  assert.equal(resolveLocale('en', 'zh-CN'), 'en');
  assert.equal(resolveLocale('zh-CN', 'en-US'), 'zh-CN');

  const tZh = createTranslator('zh-CN');
  const tEn = createTranslator('en');
  assert.equal(tZh.locale, 'zh-CN');
  assert.equal(tEn.locale, 'en');
  assert.equal(tZh('primary.pushChanges', { count: 3 }), '推送更改 3↑');
  assert.equal(tEn('primary.pushChanges', { count: 3 }), 'Push Changes 3↑');
  assert.equal(tZh('graph.deletedFileDisabled'), '该文件在当前工作区已不存在');
  assert.equal(tZh('graph.standaloneFilePreviewNotice'), '文件预览仅在 Antigravity 桌面端辅助栏内可用');

  const baseMs = new Date(2026, 10, 21, 12, 0, 0).getTime();
  const oneDayAgoSec = Math.floor(baseMs / 1000) - 86400;
  assert.equal(formatRelativeTime(Math.floor(baseMs / 1000) - 20, 'zh-CN', baseMs), '刚刚');
  assert.equal(formatRelativeTime(Math.floor(baseMs / 1000) - 20, 'en', baseMs), 'just now');
  assert.equal(formatRelativeTime(Math.floor(baseMs / 1000) - 900, 'zh-CN', baseMs), '15 分钟前');
  assert.equal(formatRelativeTime(oneDayAgoSec, 'zh-CN', baseMs), '1 天前');
  assert.equal(formatRelativeTime(oneDayAgoSec, 'en', baseMs), '1 day ago');
  assert.equal(formatAbsoluteTime(oneDayAgoSec, 'zh-CN'), '2026-11-20 12:00');
  assert.equal(formatRelativeTime(NaN, 'zh-CN', baseMs), '');
  assert.equal(formatAbsoluteTime(NaN, 'zh-CN'), '');
});

test('public-bundle: 零构建经典脚本可作为 classic JS 编译运行且 HTML 禁止 type="module"', () => {
  const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../sidecars/panel/public');
  const bundle = buildPanelAppBundle(publicDir);
  assert.doesNotThrow(() => new vm.Script(bundle, { filename: 'app.classic.js' }));
  assert.doesNotMatch(bundle, /^\s*(?:import|export)\b/m);

  // 在 document.readyState === 'loading' 环境下作为经典脚本执行时应仅注册一次 DOMContentLoaded 监听器
  const listeners = [];
  const sandboxWindow = {};
  vm.runInNewContext(bundle, {
    window: sandboxWindow,
    document: {
      readyState: 'loading',
      addEventListener: (...args) => listeners.push(args),
    },
    console,
  });
  assert.equal(sandboxWindow.__agGitGraphPanelInstalled, undefined);
  assert.equal(listeners.length, 1);
  assert.equal(listeners[0][0], 'DOMContentLoaded');
  assert.equal(listeners[0][2]?.once, true);

  // 缺失主容器时执行也不应抛错或误标已挂载
  const incompleteWindow = {};
  assert.doesNotThrow(() => {
    vm.runInNewContext(bundle, {
      window: incompleteWindow,
      document: {
        readyState: 'complete',
        getElementById: () => null,
      },
      console,
    });
  });
  assert.equal(incompleteWindow.__agGitGraphPanelInstalled, undefined);

  // HTML 必须以 classic script 加载 preload.js 与带内容哈希版本参数的 app.js，严禁 type="module"
  const html = buildPanelPageHtml(publicDir);
  assert.doesNotMatch(html, /type=["']module["']/i);
  const headSection = html.slice(html.indexOf('<head>'), html.indexOf('</head>'));
  assert.match(headSection, /<script src="\/preload\.js"><\/script>/);
  assert.match(headSection, /<script defer src="\/app\.js\?v=([a-f0-9]{12})"><\/script>/);
  assert.match(headSection, /<link rel="stylesheet" href="\/styles\.css\?v=([a-f0-9]{12})"/);
  const cssVer = headSection.match(/\/styles\.css\?v=([a-f0-9]{12})/)?.[1];
  const jsVer = headSection.match(/\/app\.js\?v=([a-f0-9]{12})/)?.[1];
  assert.ok(cssVer && jsVer && cssVer === jsVer, 'styles.css 与 app.js 必须共享同一内容哈希版本');
});

test('api-client: 仓库级请求自动透传非空 workspaceUris，且不污染非仓库端点或覆盖显式传参', async () => {
  const captured = [];
  let currentUris = ['file:///D:/repo-a'];

  const client = createApiClient({
    getLocale: () => 'zh-CN',
    getWorkspaceUris: () => currentUris,
    transport: async (url, init) => {
      captured.push({ url, body: JSON.parse(init.body) });
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, data: { revision: 2 } }),
      };
    },
  });

  await client.pushBranch({ worktreePath: 'D:/repo-a' });
  await client.commitChanges({ worktreePath: 'D:/repo-a', message: 'test', autoStageAll: true });
  await client.fetchCommitDetail({ worktreePath: 'D:/repo-a', sha: '1234567' });
  await client.pushBranch({ worktreePath: 'D:/repo-a', workspaceUris: ['file:///D:/explicit'] });
  await client.waitEvents({ workspaceKey: 'k1', sinceRevision: 1 });
  await client.savePreferences({ locale: 'zh-CN' });

  currentUris = [];
  await client.pushBranch({ worktreePath: 'D:/repo-a' });

  assert.deepEqual(captured[0], {
    url: '/api/remote/push',
    body: { worktreePath: 'D:/repo-a', workspaceUris: ['file:///D:/repo-a'] },
  });
  assert.deepEqual(captured[1], {
    url: '/api/commit',
    body: { worktreePath: 'D:/repo-a', message: 'test', autoStageAll: true, workspaceUris: ['file:///D:/repo-a'] },
  });
  assert.deepEqual(captured[2], {
    url: '/api/commit/detail',
    body: { worktreePath: 'D:/repo-a', sha: '1234567', workspaceUris: ['file:///D:/repo-a'] },
  });
  assert.deepEqual(captured[3], {
    url: '/api/remote/push',
    body: { worktreePath: 'D:/repo-a', workspaceUris: ['file:///D:/explicit'] },
  });
  assert.equal('workspaceUris' in captured[4].body, false);
  assert.equal('workspaceUris' in captured[5].body, false);
  assert.equal('workspaceUris' in captured[6].body, false);
});
