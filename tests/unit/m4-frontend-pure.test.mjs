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
  SWIMLANE_HEIGHT,
  SWIMLANE_WIDTH,
  LANE_COLORS,
  HISTORY_ITEM_REF_COLOR,
  HISTORY_ITEM_REMOTE_REF_COLOR,
  buildRefColorMap,
  toHistoryItemViewModels,
  computeHistoryItemGraph,
  computeCommitFilesPlaceholder,
  getHistoryItemIndex,
  groupHistoryItemBadges,
} from '../../sidecars/panel/public/modules/graph-layout.js';

import { computeMinOcclusionPopoverStyle } from '../../sidecars/panel/public/modules/popover.js';

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

import { resolveFileIconUrl } from '../../sidecars/panel/public/modules/file-icons.js';
import {
  FILE_ICON_NAMES,
  FILE_ICON_EXTENSIONS,
  FILE_ICON_LIGHT_VARIANTS,
  FOLDER_ICON_NAMES,
  FOLDER_ICON_LIGHT_VARIANTS,
} from '../../sidecars/panel/public/modules/file-icon-map.js';
import { computeToastPlacement } from '../../sidecars/panel/public/modules/toast.js';
import { parseCommitMarkdown, parseInlineMarkdown } from '../../sidecars/panel/public/modules/markdown.js';
import fs from 'node:fs';

/**
 * 解析泳道 path（仅含 M/V/H/A 绝对指令），收集落在行顶（y=0）与行底（y=行高）的连线端点及其颜色。
 */
const collectBoundarySockets = (shapes) => {
  const top = new Map();
  const bottom = new Map();
  for (const shape of shapes) {
    if (shape.type !== 'path') continue;
    const tokens = shape.d.trim().split(/\s+/);
    let x = 0;
    let y = 0;
    for (let index = 0; index < tokens.length;) {
      const command = tokens[index];
      if (command === 'M') {
        x = Number(tokens[index + 1]);
        y = Number(tokens[index + 2]);
        index += 3;
      } else if (command === 'V') {
        y = Number(tokens[index + 1]);
        index += 2;
      } else if (command === 'H') {
        x = Number(tokens[index + 1]);
        index += 2;
      } else if (command === 'A') {
        x = Number(tokens[index + 6]);
        y = Number(tokens[index + 7]);
        index += 8;
      } else {
        throw new Error(`unexpected path command ${command} in ${shape.d}`);
      }
      if (y === 0) top.set(x, shape.color);
      if (y === SWIMLANE_HEIGHT) bottom.set(x, shape.color);
    }
  }
  return { top, bottom };
};

const laneX = (laneIndex) => SWIMLANE_WIDTH * (laneIndex + 1);

const buildViewModels = (commits, { headSha = null, currentRefId = null, remoteRefId = null, scope = 'auto' } = {}) =>
  toHistoryItemViewModels(commits, {
    headSha,
    currentRefId,
    remoteRefId,
    colorMap: buildRefColorMap({ currentRefId, remoteRefId, scope, commits }),
  });

/**
 * 断言相邻提交行在行边界处的连线端点位置与颜色完全一致（无断口、无悬空线头），
 * 且每行底部端点恰好对应它的输出泳道，最后一行的泳道继续向下延伸给「加载更多」行。
 */
const assertGraphContinuity = (viewModels) => {
  const sockets = viewModels.map((viewModel) => collectBoundarySockets(computeHistoryItemGraph(viewModel).shapes));
  viewModels.forEach((viewModel, rowIndex) => {
    const expectedBottom = new Map(viewModel.outputSwimlanes.map((node, laneIndex) => [laneX(laneIndex), node.color]));
    assert.deepEqual(sockets[rowIndex].bottom, expectedBottom, `行 ${viewModel.commit.sha} 底部端点与输出泳道不一致`);
    if (rowIndex + 1 < viewModels.length) {
      assert.deepEqual(
        sockets[rowIndex + 1].top,
        sockets[rowIndex].bottom,
        `行 ${viewModel.commit.sha} 与行 ${viewModels[rowIndex + 1].commit.sha} 之间存在断口或颜色不匹配`,
      );
    }
  });
};

const findCircles = (viewModel) => computeHistoryItemGraph(viewModel).shapes.filter((shape) => shape.type === 'circle');

test('纯模块在无 window/document 的 Node.js 环境下直接导入且无顶层副作用', () => {
  assert.equal(typeof globalThis.window, 'undefined');
  assert.equal(typeof globalThis.document, 'undefined');
  assert.equal(SWIMLANE_HEIGHT, 22);
  assert.equal(SWIMLANE_WIDTH, 11);
  assert.deepEqual(LANE_COLORS, [
    'var(--gw-graph-1)',
    'var(--gw-graph-2)',
    'var(--gw-graph-3)',
    'var(--gw-graph-4)',
    'var(--gw-graph-5)',
  ]);
});

test('graph-layout: 线性提交单泳道、行宽与 HEAD 空心圆点', () => {
  assert.deepEqual(buildViewModels([]), []);

  const commits = [
    { sha: 'c3', parents: ['c2'] },
    { sha: 'c2', parents: ['c1'] },
    { sha: 'c1', parents: [] },
  ];
  const viewModels = buildViewModels(commits, { headSha: 'c3' });
  assertGraphContinuity(viewModels);

  for (const viewModel of viewModels) {
    assert.equal(computeHistoryItemGraph(viewModel).width, 22, '单泳道行宽为 11 × (1 + 1)');
    assert.equal(getHistoryItemIndex(viewModel), 0);
  }
  assert.deepEqual(viewModels.map((viewModel) => viewModel.kind), ['HEAD', 'node', 'node']);
  assert.deepEqual(findCircles(viewModels[0]).map((circle) => [circle.r, circle.strokeWidth, circle.fill]), [
    [7, 2, viewModels[0].outputSwimlanes[0].color],
    [2, 4, undefined],
  ]);
  assert.deepEqual(findCircles(viewModels[1]).map((circle) => [circle.cx, circle.cy, circle.r]), [[11, 11, 5]]);
  assert.deepEqual(viewModels[2].outputSwimlanes, []);
});

test('graph-layout: 合并提交画同心圆与圆弧拐入，侧分支在共同祖先处以圆弧收拢', () => {
  for (const commits of [
    [
      { sha: 'm2', parents: ['m1', 'f1'] },
      { sha: 'm1', parents: ['m0'] },
      { sha: 'f1', parents: ['m0'] },
      { sha: 'm0', parents: [] },
    ],
    [
      { sha: 'm2', parents: ['m1', 'f1'] },
      { sha: 'f1', parents: ['m0'] },
      { sha: 'm1', parents: ['m0'] },
      { sha: 'm0', parents: [] },
    ],
  ]) {
    const viewModels = buildViewModels(commits);
    assertGraphContinuity(viewModels);

    const mergeGraph = computeHistoryItemGraph(viewModels[0]);
    assert.ok(
      mergeGraph.shapes.some((shape) => shape.d === 'M 11 11 A 11 11 0 0 1 22 22 M 11 11 H 11'),
      '第二父提交从圆点水平引出并以半径 11 的圆弧拐入右侧泳道',
    );
    assert.deepEqual(findCircles(viewModels[0]).map((circle) => circle.r), [6, 3], '合并节点为外 6 内 3 的同心圆');
    assert.equal(mergeGraph.width, 33);

    const rootGraph = computeHistoryItemGraph(viewModels[3]);
    assert.ok(
      rootGraph.shapes.some((shape) => shape.d === 'M 22 0 A 11 11 0 0 1 11 11 H 11'),
      '等待同一祖先的右侧泳道以圆弧收拢到圆点',
    );
  }
});

test('graph-layout: 泳道结束后右侧泳道以两段半径 5 的圆角左移', () => {
  const commits = [
    { sha: 'h1', parents: ['a1', 'b1'] },
    { sha: 'h2', parents: ['c1'] },
    { sha: 'b1', parents: ['a1'] },
    { sha: 'a1', parents: ['z'] },
    { sha: 'c1', parents: ['z'] },
    { sha: 'z', parents: [] },
  ];
  const viewModels = buildViewModels(commits);
  assertGraphContinuity(viewModels);

  assert.equal(getHistoryItemIndex(viewModels[1]), 2, '不在已有泳道上的新分支提交追加到最右侧');
  assert.ok(
    computeHistoryItemGraph(viewModels[3]).shapes.some(
      (shape) => shape.d === 'M 33 0 V 6 A 5 5 0 0 1 28 11 H 27 A 5 5 0 0 0 22 16 V 22',
    ),
    'a1 收拢后 c1 泳道从第 3 列平移到第 2 列',
  );
});

test('graph-layout: 章鱼合并与多个独立根提交的泳道连续，根提交不截断其他泳道', () => {
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
  assertGraphContinuity(buildViewModels(commits));

  const interleavedRoots = [
    { sha: 't1', parents: ['r1'] },
    { sha: 't2', parents: ['r2'] },
    { sha: 'r1', parents: [] },
    { sha: 'r2', parents: [] },
  ];
  const viewModels = buildViewModels(interleavedRoots);
  assertGraphContinuity(viewModels);
  assert.deepEqual(viewModels[2].outputSwimlanes.map((node) => node.id), ['r2'], '根提交 r1 处保留等待 r2 的泳道');
  assert.equal(getHistoryItemIndex(viewModels[3]), 0);
  const rootShapes = computeHistoryItemGraph(viewModels[2]).shapes;
  assert.equal(
    rootShapes.find((shape) => shape.type === 'circle').fill,
    rootShapes.find((shape) => shape.d === 'M 11 0 V 11').color,
    '根提交圆点与进入它的泳道同色，而不是左移过来的相邻泳道颜色',
  );
});

test('graph-layout: 父提交不在列表内时泳道延伸到列表末尾', () => {
  const viewModels = buildViewModels([
    { sha: 'head-2', parents: ['head-1', 'next-page-topic'] },
    { sha: 'head-1', parents: ['next-page-ancestor'] },
  ]);
  assertGraphContinuity(viewModels);
  assert.deepEqual(viewModels[1].outputSwimlanes.map((node) => node.id), ['next-page-ancestor', 'next-page-topic']);
});

test('graph-layout: 当前分支泳道固定蓝色、上游泳道固定紫色，其余泳道按 5 色轮换', () => {
  const commits = [
    { sha: 'h', parents: ['u', 'side'], refs: [{ type: 'head', name: 'main', fullRef: 'refs/heads/main' }] },
    { sha: 'side', parents: ['u'] },
    { sha: 'u', parents: ['root'], refs: [{ type: 'remote', name: 'origin/main', fullRef: 'refs/remotes/origin/main' }] },
    { sha: 'root', parents: [] },
  ];
  const viewModels = buildViewModels(commits, {
    headSha: 'h',
    currentRefId: 'refs/heads/main',
    remoteRefId: 'refs/remotes/origin/main',
  });
  assertGraphContinuity(viewModels);
  assert.deepEqual(viewModels[0].outputSwimlanes.map((node) => node.color), [HISTORY_ITEM_REF_COLOR, LANE_COLORS[0]]);
  assert.equal(viewModels[2].outputSwimlanes[0].color, HISTORY_ITEM_REMOTE_REF_COLOR, '上游提交以下的泳道换成远程色');
});

test('graph-layout: 引用徽标按 VS Code 规则排序、着色与归组，auto 范围隐藏无关引用', () => {
  // 与 git log --decorate 输出顺序一致：HEAD -> 当前分支总在最前
  const refs = [
    { type: 'head', name: 'main', fullRef: 'refs/heads/main' },
    { type: 'tag', name: 'v1', fullRef: 'refs/tags/v1' },
    { type: 'remote', name: 'origin/main', fullRef: 'refs/remotes/origin/main' },
    { type: 'branch', name: 'feature', fullRef: 'refs/heads/feature' },
    { type: 'tag', name: 'v1.0.1', fullRef: 'refs/tags/v1.0.1' },
  ];
  const commits = [{ sha: 'h', parents: ['p'], refs }, { sha: 'p', parents: [] }];
  const options = { headSha: 'h', currentRefId: 'refs/heads/main', remoteRefId: 'refs/remotes/origin/main' };

  const [autoRow] = buildViewModels(commits, { ...options, scope: 'auto' });
  assert.deepEqual(autoRow.references.map((ref) => ref.name).slice(0, 2), ['main', 'origin/main']);
  assert.deepEqual(groupHistoryItemBadges(autoRow.references), [
    { color: HISTORY_ITEM_REF_COLOR, icon: 'target', count: 1, name: 'main' },
    { color: HISTORY_ITEM_REMOTE_REF_COLOR, icon: 'cloud', count: 1, name: null },
  ]);

  const [allRow] = buildViewModels(commits, { ...options, scope: 'all' });
  assert.deepEqual(groupHistoryItemBadges(allRow.references), [
    { color: HISTORY_ITEM_REF_COLOR, icon: 'target', count: 1, name: 'main' },
    { color: HISTORY_ITEM_REMOTE_REF_COLOR, icon: 'cloud', count: 1, name: null },
    { color: HISTORY_ITEM_REF_COLOR, icon: 'tag', count: 2, name: null },
    { color: HISTORY_ITEM_REF_COLOR, icon: 'gitBranch', count: 1, name: null },
  ]);

  const detachedRefs = [{ type: 'head', name: 'HEAD', fullRef: 'HEAD' }];
  const [detachedRow] = buildViewModels([{ sha: 'd', parents: [], refs: detachedRefs }], { headSha: 'd', scope: 'all' });
  assert.deepEqual(detachedRow.references, [], '游离 HEAD 不显示 HEAD 徽标');
});

test('graph-layout: 文件子行贯穿泳道加粗所属提交接续的泳道，与展开提交的加粗下行线同列', () => {
  const viewModels = buildViewModels([
    { sha: 'm', parents: ['a', 'b'] },
    { sha: 'b', parents: ['a'] },
    { sha: 'a', parents: [] },
  ]);
  const placeholder = computeCommitFilesPlaceholder(viewModels[1]);
  assert.equal(placeholder.width, 33);
  assert.deepEqual(
    placeholder.shapes.map((shape) => [shape.d, shape.strokeWidth]),
    [['M 11 0 V 22', 1], ['M 22 0 V 22', 3]],
  );
  assert.deepEqual(
    computeHistoryItemGraph(viewModels[1]).shapes.filter((shape) => shape.isOutgoing).map((shape) => shape.d),
    ['M 22 11 V 22'],
    '展开时加粗的下行线与文件子行加粗泳道同在第 2 列',
  );
  assert.deepEqual(
    collectBoundarySockets(placeholder.shapes).top,
    collectBoundarySockets(computeHistoryItemGraph(viewModels[2]).shapes).top,
    '文件子行竖线与下一提交行顶部端点对齐',
  );
});

test('graph-layout: 展开根提交时不加粗任何泳道（圆点列已被其他分支泳道左移占用）', () => {
  const viewModels = buildViewModels([
    { sha: 't1', parents: ['r1'] },
    { sha: 't2', parents: ['r2'] },
    { sha: 'r1', parents: [] },
    { sha: 'r2', parents: [] },
  ]);
  const rootRow = viewModels[2];
  assert.deepEqual(
    computeCommitFilesPlaceholder(rootRow).shapes.map((shape) => [shape.d, shape.strokeWidth]),
    [['M 11 0 V 22', 1]],
  );
  assert.equal(computeHistoryItemGraph(rootRow).shapes.some((shape) => shape.isOutgoing), false);
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
  assert.equal(formatAbsoluteTime(oneDayAgoSec, 'zh-CN'), '2026年11月20日 12:00');
  assert.equal(formatAbsoluteTime(oneDayAgoSec, 'en'), 'November 20, 2026 at 12:00 PM');
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

test('file-icons: 按 VS Code 图标主题顺序解析：完整文件名 > 最长扩展名 > 默认图标，大小写不敏感', () => {
  assert.equal(resolveFileIconUrl('sidecars/panel/package.json', 'dark'), '/file-icons/file_type_npm.svg', '文件名优先于 json 扩展名');
  assert.equal(resolveFileIconUrl('src/types/index.d.ts', 'dark'), '/file-icons/file_type_typescriptdef.svg', 'd.ts 优先于 ts');
  assert.equal(resolveFileIconUrl('src/app.ts', 'dark'), '/file-icons/file_type_typescript.svg');
  assert.equal(resolveFileIconUrl('tests/unit/panel.test.mjs', 'dark'), '/file-icons/file_type_testjs.svg');
  assert.equal(resolveFileIconUrl('docs/Dockerfile', 'dark'), '/file-icons/file_type_docker.svg');
  assert.equal(resolveFileIconUrl('README.MD', 'dark'), '/file-icons/file_type_readme.svg');
  assert.equal(resolveFileIconUrl('notes/unknown.zzqq', 'dark'), '/file-icons/default_file.svg');
  assert.equal(resolveFileIconUrl('constructor', 'dark'), '/file-icons/default_file.svg', '不得命中 Object 原型属性');
  assert.equal(resolveFileIconUrl('a.hasownproperty', 'dark'), '/file-icons/default_file.svg');
});

test('file-icons: 浅色主题使用浅色变体，没有浅色变体的图标在两种主题下相同', () => {
  assert.equal(resolveFileIconUrl('.babelrc', 'light'), '/file-icons/file_type_light_babel.svg');
  assert.equal(resolveFileIconUrl('.babelrc', 'dark'), '/file-icons/file_type_babel.svg');
  assert.equal(resolveFileIconUrl('main.py', 'light'), resolveFileIconUrl('main.py', 'dark'));
});

test('file-icons: 以 / 结尾的未跟踪目录按文件夹名取文件夹图标，未命中时回退默认文件夹图标', () => {
  assert.equal(resolveFileIconUrl('tests/', 'dark'), '/file-icons/folder_type_test.svg');
  assert.equal(resolveFileIconUrl('sidecars/panel/public/', 'dark'), '/file-icons/folder_type_public.svg');
  assert.equal(resolveFileIconUrl('Node_Modules/', 'dark'), '/file-icons/folder_type_node.svg', '文件夹名大小写不敏感');
  assert.equal(resolveFileIconUrl('assets/fonts/', 'light'), '/file-icons/folder_type_light_fonts.svg');
  assert.equal(resolveFileIconUrl('sidecars/panel/public/file-icons/', 'dark'), '/file-icons/default_folder.svg');
  assert.equal(resolveFileIconUrl('constructor/', 'dark'), '/file-icons/default_folder.svg', '不得命中 Object 原型属性');
  assert.equal(resolveFileIconUrl('src/package.json', 'dark'), '/file-icons/file_type_npm.svg', '不以 / 结尾的仍按文件解析');
});

test('file-icons: 带父文件夹的文件名规则只在直接父文件夹同名时生效，且优先于同名文件规则', () => {
  assert.equal(resolveFileIconUrl('.husky/pre-commit', 'dark'), '/file-icons/file_type_husky.svg');
  assert.equal(resolveFileIconUrl('web/.husky/pre-commit', 'dark'), '/file-icons/file_type_husky.svg', '父文件夹只看直接上一级');
  assert.equal(resolveFileIconUrl('pre-commit', 'dark'), '/file-icons/default_file.svg');
  assert.equal(resolveFileIconUrl('.VSCode/Tasks.json', 'dark'), '/file-icons/file_type_vscode.svg', '父文件夹名大小写不敏感');
  assert.equal(resolveFileIconUrl('src/launch.json', 'dark'), '/file-icons/file_type_json.svg', '父文件夹不同时按扩展名解析');
});

test('file-icons: 映射表里的每条文件名、扩展名规则都能被对应路径命中', () => {
  const unreachable = [];
  for (const [key, icon] of Object.entries(FILE_ICON_NAMES)) {
    if (resolveFileIconUrl(key, 'dark') !== `/file-icons/file_type_${icon}.svg`) unreachable.push(key);
  }
  for (const [extension, icon] of Object.entries(FILE_ICON_EXTENSIONS)) {
    if (resolveFileIconUrl(`probe.${extension}`, 'dark') !== `/file-icons/file_type_${icon}.svg`) unreachable.push(`*.${extension}`);
  }
  assert.deepEqual(unreachable, []);
});

test('file-icons: 映射表引用的每个图标（含浅色变体）都随插件分发', () => {
  const iconsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../sidecars/panel/public/file-icons');
  const shipped = new Set(fs.readdirSync(iconsDir));
  const missing = [];
  for (const icon of new Set([...Object.values(FILE_ICON_NAMES), ...Object.values(FILE_ICON_EXTENSIONS)])) {
    if (!shipped.has(`file_type_${icon}.svg`)) missing.push(`file_type_${icon}.svg`);
  }
  for (const icon of FILE_ICON_LIGHT_VARIANTS) {
    if (!shipped.has(`file_type_light_${icon}.svg`)) missing.push(`file_type_light_${icon}.svg`);
  }
  for (const icon of new Set(Object.values(FOLDER_ICON_NAMES))) {
    if (!shipped.has(`folder_type_${icon}.svg`)) missing.push(`folder_type_${icon}.svg`);
  }
  for (const icon of FOLDER_ICON_LIGHT_VARIANTS) {
    if (!shipped.has(`folder_type_light_${icon}.svg`)) missing.push(`folder_type_light_${icon}.svg`);
  }
  for (const name of ['default_file.svg', 'default_folder.svg']) {
    if (!shipped.has(name)) missing.push(name);
  }
  assert.deepEqual(missing, []);
});

const text = (value) => ({ type: 'text', text: value });

test('markdown: 提交说明每行各自成块，空行标记段落间隔，列表项、续行与嵌套列表归入同一列表', () => {
  const message = [
    'fix(sidecar): 修复推送误报',
    '',
    '- 根因：授权表被清空',
    '- api-client.js：透传 workspaceUris',
    '  续行说明',
    '  - 嵌套项',
    '- tests：补充回归测试',
    '',
    'Closes #14',
  ].join('\n');
  const item = (inlines, blocks = [], spaced = false) => ({ inlines, blocks, spaced });
  assert.deepEqual(parseCommitMarkdown(message), [
    { type: 'paragraph', inlines: [text('fix(sidecar): 修复推送误报')], spaced: false },
    {
      type: 'list',
      ordered: false,
      start: 1,
      spaced: true,
      items: [
        item([text('根因：授权表被清空')]),
        item([text('api-client.js：透传 workspaceUris')], [
          { type: 'paragraph', inlines: [text('续行说明')], spaced: false },
          { type: 'list', ordered: false, start: 1, spaced: false, items: [item([text('嵌套项')])] },
        ]),
        item([text('tests：补充回归测试')]),
      ],
    },
    { type: 'paragraph', inlines: [text('Closes #14')], spaced: true },
  ]);
});

test('markdown: 行内代码、强调与安全链接按 Markdown 渲染，HTML、图片语法与不安全链接保留为文本', () => {
  assert.deepEqual(parseInlineMarkdown('修复 `a_b` 与 **粗体**、*斜体*、~~删除~~'), [
    text('修复 '),
    { type: 'code', text: 'a_b' },
    text(' 与 '),
    { type: 'strong', children: [text('粗体')] },
    text('、'),
    { type: 'em', children: [text('斜体')] },
    text('、'),
    { type: 'del', children: [text('删除')] },
  ]);
  assert.deepEqual(parseInlineMarkdown('parse_commit_message 与 \\*字面星号\\*'), [text('parse_commit_message 与 *字面星号*')]);
  assert.deepEqual(parseInlineMarkdown('[文档](https://a.dev/x "标题") [坏](javascript:alert(1))'), [
    { type: 'link', href: 'https://a.dev/x', children: [text('文档')] },
    text(' 坏'),
  ]);
  assert.deepEqual(parseInlineMarkdown('<div> ![图](x.png) <me@x.io>'), [
    text('<div> ![图](x.png) '),
    { type: 'link', href: 'mailto:me@x.io', children: [text('me@x.io')] },
  ]);
  assert.deepEqual(parseInlineMarkdown('见 https://github.com/a/b。另见 (https://x.dev/y_(z)).'), [
    text('见 '),
    { type: 'link', href: 'https://github.com/a/b', children: [text('https://github.com/a/b')] },
    text('。另见 ('),
    { type: 'link', href: 'https://x.dev/y_(z)', children: [text('https://x.dev/y_(z)')] },
    text(').'),
  ]);
  assert.deepEqual(parseInlineMarkdown('[见 https://a.com 与 <https://c.com>](https://b.com)'), [
    { type: 'link', href: 'https://b.com', children: [text('见 https://a.com 与 <https://c.com>')] },
  ], '链接文字里的裸链接与尖括号链接不再嵌套成链接');
  assert.deepEqual(parseInlineMarkdown('[https://a.com](./docs/x.md)'), [
    { type: 'link', href: 'https://a.com', children: [text('https://a.com')] },
  ], '不安全的外层链接被丢弃时，文字里的裸链接照常可点');
});

test('markdown: 围栏与缩进代码块整体保留内部空行，未闭合的围栏延续到结尾', () => {
  assert.deepEqual(parseCommitMarkdown('说明\n\n    a = 1\n\n    b = 2\n结束\n```js\nx\n\n  y'), [
    { type: 'paragraph', inlines: [text('说明')], spaced: false },
    { type: 'code', text: 'a = 1\n\nb = 2', spaced: true },
    { type: 'paragraph', inlines: [text('结束')], spaced: false },
    { type: 'code', text: 'x\n\n  y', spaced: false },
  ]);
  assert.deepEqual(parseCommitMarkdown('```x``` 是行内代码\n第二行'), [
    { type: 'paragraph', inlines: [{ type: 'code', text: 'x' }, text(' 是行内代码')], spaced: false },
    { type: 'paragraph', inlines: [text('第二行')], spaced: false },
  ], '反引号后同一行还有反引号时不是围栏');
  assert.deepEqual(parseCommitMarkdown('示例：\n\n    - 不是列表\n    * 也是代码'), [
    { type: 'paragraph', inlines: [text('示例：')], spaced: false },
    { type: 'code', text: '- 不是列表\n* 也是代码', spaced: true },
  ]);
  assert.deepEqual(
    parseCommitMarkdown('# 标题\n---\n> 引用\n2. 第二\n3. 第三').map(({ type, level, start }) => ({ type, level, start })),
    [
      { type: 'heading', level: 1, start: undefined },
      { type: 'rule', level: undefined, start: undefined },
      { type: 'quote', level: undefined, start: undefined },
      { type: 'list', level: undefined, start: 2 },
    ],
  );
});

test('toast: 锚点下方放得下时贴在下方，放不下时改到上方，无锚点或锚点不可见时停靠底部', () => {
  const viewportHeight = 800;
  assert.deepEqual(computeToastPlacement({ top: 100, bottom: 126, width: 300, height: 26 }, viewportHeight), { edge: 'top', offset: 130 });
  assert.deepEqual(computeToastPlacement({ top: 740, bottom: 762, width: 300, height: 22 }, viewportHeight), { edge: 'bottom', offset: 64 });
  assert.deepEqual(computeToastPlacement(null, viewportHeight), { edge: 'bottom', offset: 8 });
  assert.deepEqual(computeToastPlacement({ top: 0, bottom: 0, width: 0, height: 0 }, viewportHeight), { edge: 'bottom', offset: 8 }, '折叠隐藏的锚点');
  assert.deepEqual(computeToastPlacement({ top: -40, bottom: -14, width: 300, height: 26 }, viewportHeight), { edge: 'bottom', offset: 8 }, '滚出视口的锚点');
  assert.deepEqual(
    computeToastPlacement({ top: 10, bottom: 70, width: 300, height: 60 }, 150),
    { edge: 'top', offset: 74 },
    '矮面板里上下都放不下时选空间更大的下方，不把提示推出视口顶部',
  );
  // 更改区（视口 y=60–400）滚动后，提交按钮（y=20–46）在视口内但已被该区裁掉
  const changesBody = { top: 60, bottom: 400 };
  assert.deepEqual(
    computeToastPlacement({ top: 20, bottom: 46, width: 300, height: 26 }, viewportHeight, [changesBody]),
    { edge: 'bottom', offset: 8 },
    '被滚动容器完全裁掉的锚点按不可见处理',
  );
  assert.deepEqual(
    computeToastPlacement({ top: 50, bottom: 76, width: 300, height: 26 }, viewportHeight, [changesBody]),
    { edge: 'top', offset: 80 },
    '部分可见的锚点贴在可见部分下方',
  );
});
