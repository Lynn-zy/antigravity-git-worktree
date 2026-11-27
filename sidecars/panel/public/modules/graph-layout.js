/*
 * Portions of this file are adapted from Visual Studio Code
 * (src/vs/workbench/contrib/scm/browser/scmHistory.ts, https://github.com/microsoft/vscode).
 *
 * MIT License
 *
 * Copyright (c) 2015 - present Microsoft Corporation
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/**
 * 提交图谱（Commit Graph）泳道布局纯计算模块，逐段移植自 VS Code `scmHistory.ts`。
 * 与原实现的差异：直接创建 SVG DOM 改为输出图形描述（由 graph-view 落成节点，便于在 Node 中测试）；
 * 根提交处保留其余泳道（见 `toHistoryItemViewModels` 内注释）；
 * 「传入的更改」「传出的更改」虚拟行不带标题与作者，由 graph-view 按 `kind` 取本地化文案与分支名。
 * 徽标归组 `groupHistoryItemBadges` 移植自 `scmHistoryViewPane.ts` 的 `HistoryItemRenderer._renderBadges`。
 */

/** @type {number} 提交行与泳道的像素高度 */
export const SWIMLANE_HEIGHT = 22;

/** @type {number} 相邻泳道中心线的像素间距 */
export const SWIMLANE_WIDTH = 11;

/** @type {string} 「传入的更改」虚拟行的标识（对应 VS Code `SCMIncomingHistoryItemId`） */
export const INCOMING_CHANGES_ID = 'scm-graph-incoming-changes';

/** @type {string} 「传出的更改」虚拟行的标识（对应 VS Code `SCMOutgoingHistoryItemId`） */
export const OUTGOING_CHANGES_ID = 'scm-graph-outgoing-changes';

const SWIMLANE_CURVE_RADIUS = 5;
const CIRCLE_RADIUS = 4;
const CIRCLE_STROKE_WIDTH = 2;

/** @type {string} 当前分支引用及其泳道颜色（对应 VS Code `scmGraph.historyItemRefColor`） */
export const HISTORY_ITEM_REF_COLOR = 'var(--gw-graph-ref)';

/** @type {string} 当前分支上游远程引用颜色（对应 VS Code `scmGraph.historyItemRemoteRefColor`） */
export const HISTORY_ITEM_REMOTE_REF_COLOR = 'var(--gw-graph-remote-ref)';

/** @type {readonly string[]} 其余泳道轮换色（对应 VS Code `scmGraph.foreground1..5`） */
export const LANE_COLORS = Object.freeze([
  'var(--gw-graph-1)',
  'var(--gw-graph-2)',
  'var(--gw-graph-3)',
  'var(--gw-graph-4)',
  'var(--gw-graph-5)',
]);

const REF_ICON_BY_TYPE = Object.freeze({
  head: 'target',
  branch: 'gitBranch',
  remote: 'cloud',
  tag: 'tag',
});

const rotate = (value, modulo) => ((value % modulo) + modulo) % modulo;

const findLastIndex = (nodes, id) => {
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    if (nodes[index].id === id) return index;
  }
  return -1;
};

// 圆点取接续它的第一父提交泳道的颜色；根提交没有接续泳道（该列已被右侧泳道左移占用），取进入圆点的泳道颜色
const getCircleColor = (commit, inputSwimlanes, outputSwimlanes, circleIndex) => {
  if (commit.parents.length > 0 && circleIndex < outputSwimlanes.length) return outputSwimlanes[circleIndex].color;
  if (circleIndex < inputSwimlanes.length) return inputSwimlanes[circleIndex].color;
  return HISTORY_ITEM_REF_COLOR;
};

const getLabelColor = (refs, colorMap) => {
  for (const ref of refs) {
    const color = colorMap.get(ref.fullRef);
    if (color !== undefined) return color;
  }
  return undefined;
};

const getRefOrder = (ref, currentRefId, remoteRefId) => {
  if (ref.id === currentRefId) return 1;
  if (ref.id === remoteRefId) return 2;
  if (ref.color !== undefined) return 4;
  return 99;
};

/**
 * 构造引用到泳道颜色的映射，规则同 VS Code `_getGraphColorMap`：
 * 当前分支固定蓝色、其上游固定紫色；`scope === 'all'` 时其余引用登记为 `undefined`，表示沿用所在泳道颜色。
 * `auto` 视图下未登记的引用不显示徽标。
 *
 * @param {{ currentRefId: string | null, remoteRefId: string | null, scope: 'auto' | 'all', commits: Array<{ refs?: Array<{ fullRef: string }> }> }} params 当前分支与上游的完整引用名、图表范围与提交列表
 * @returns {Map<string, string | undefined>} 以完整引用名为键的颜色映射（无副作用）
 */
export const buildRefColorMap = ({ currentRefId, remoteRefId, scope, commits }) => {
  const colorMap = new Map();
  if (currentRefId) {
    colorMap.set(currentRefId, HISTORY_ITEM_REF_COLOR);
    if (remoteRefId) colorMap.set(remoteRefId, HISTORY_ITEM_REMOTE_REF_COLOR);
  }
  if (scope === 'all') {
    for (const commit of commits) {
      for (const ref of commit.refs ?? []) {
        if (!colorMap.has(ref.fullRef)) colorMap.set(ref.fullRef, undefined);
      }
    }
  }
  return colorMap;
};

/**
 * 逐行推导每个提交的输入/输出泳道（`toISCMHistoryItemViewModelArray` 的移植）。
 * 每条泳道以它等待的提交 sha 标识；父提交不在列表内时泳道一直延伸到列表末尾（分页边界由「加载更多」行承接）。
 * 传入 `mergeBase` 时按 VS Code 规则插入「传入的更改」「传出的更改」虚拟行。
 *
 * @param {Array<{ sha: string, parents: string[], refs?: Array<{ type: string, name: string, fullRef: string }> }>} commits 按拓扑顺序从新到旧排列的提交
 * @param {{ headSha: string | null, currentRefId: string | null, remoteRefId: string | null, colorMap: Map<string, string | undefined>, mergeBase?: string | null }} options
 *   HEAD 提交、当前分支与上游的完整引用名、`buildRefColorMap` 的结果，以及当前分支与上游的合并基（与上游一致时为 null）
 * @returns {Array<{
 *   commit: { sha: string, parents: string[] },
 *   kind: 'HEAD' | 'node' | 'incoming-changes' | 'outgoing-changes',
 *   inputSwimlanes: Array<{ id: string, color: string }>,
 *   outputSwimlanes: Array<{ id: string, color: string }>,
 *   references: Array<{ id: string, name: string, icon: string, color: string | undefined }>,
 *   compare?: { sha: string, parentSha: string }
 * }>} 行视图模型（无副作用）；虚拟行的 `compare` 是展开文件列表时比较的两端
 */
export const toHistoryItemViewModels = (commits, { headSha, currentRefId, remoteRefId, colorMap, mergeBase = null }) => {
  const commitBySha = new Map(commits.map((commit) => [commit.sha, commit]));
  const viewModels = [];
  let colorIndex = -1;

  for (const commit of commits) {
    const refs = commit.refs ?? [];
    const parentIds = commit.parents;
    const inputSwimlanes = viewModels.at(-1)?.outputSwimlanes.slice() ?? [];
    const outputSwimlanes = [];
    let firstParentAdded = false;

    // 原实现仅在有父提交时才保留其余泳道，导致多根仓库在根提交处截断其他分支的泳道
    for (const node of inputSwimlanes) {
      if (node.id === commit.sha) {
        if (!firstParentAdded && parentIds.length > 0) {
          outputSwimlanes.push({ id: parentIds[0], color: getLabelColor(refs, colorMap) ?? node.color });
          firstParentAdded = true;
        }
        continue;
      }
      outputSwimlanes.push(node);
    }

    for (let parentIndex = firstParentAdded ? 1 : 0; parentIndex < parentIds.length; parentIndex += 1) {
      let color;
      if (parentIndex === 0) {
        color = getLabelColor(refs, colorMap);
      } else {
        const parentCommit = commitBySha.get(parentIds[parentIndex]);
        color = parentCommit ? getLabelColor(parentCommit.refs ?? [], colorMap) : undefined;
      }
      if (!color) {
        colorIndex = rotate(colorIndex + 1, LANE_COLORS.length);
        color = LANE_COLORS[colorIndex];
      }
      outputSwimlanes.push({ id: parentIds[parentIndex], color });
    }

    const inputIndex = inputSwimlanes.findIndex((node) => node.id === commit.sha);
    const circleIndex = inputIndex !== -1 ? inputIndex : inputSwimlanes.length;
    const circleColor = getCircleColor(commit, inputSwimlanes, outputSwimlanes, circleIndex);

    const references = refs
      .filter((ref) => ref.fullRef !== 'HEAD')
      .map((ref) => ({
        id: ref.fullRef,
        name: ref.name,
        icon: ref.fullRef === currentRefId ? 'target' : (REF_ICON_BY_TYPE[ref.type] ?? 'gitBranch'),
        color: colorMap.has(ref.fullRef) ? (colorMap.get(ref.fullRef) ?? circleColor) : undefined,
      }))
      .sort((a, b) => getRefOrder(a, currentRefId, remoteRefId) - getRefOrder(b, currentRefId, remoteRefId));

    viewModels.push({
      commit,
      kind: commit.sha === headSha ? 'HEAD' : 'node',
      inputSwimlanes,
      outputSwimlanes,
      references,
    });
  }

  // 同原实现：先算完全部行的泳道，再借用泳道颜色把虚拟行插到正确的泳道上
  const remoteSha = remoteRefId ? commits.find((commit) => commit.refs?.some((ref) => ref.fullRef === remoteRefId))?.sha : undefined;
  addIncomingOutgoingChanges(viewModels, { headSha, remoteSha, mergeBase });
  return viewModels;
};

// `addIncomingOutgoingChangesHistoryItems` 的移植，原地修改 viewModels
const addIncomingOutgoingChanges = (viewModels, { headSha, remoteSha, mergeBase }) => {
  if (headSha === remoteSha || !mergeBase) return;

  if (remoteSha && remoteSha !== mergeBase) {
    // 合并基可能还没加载到，这时不显示
    const beforeIndex = viewModels.reduce(
      (lastIndex, viewModel, index) => (viewModel.outputSwimlanes.some((node) => node.id === mergeBase) ? index : lastIndex),
      -1,
    );
    const afterIndex = viewModels.findIndex((viewModel) => viewModel.commit.sha === mergeBase);
    const before = viewModels[beforeIndex];
    // 传入的更改已被合并进当前分支时不显示（VS Code #276064）
    const incomingMerged = before?.commit.parents.length === 2 && before.commit.parents.includes(mergeBase);

    if (beforeIndex !== -1 && afterIndex !== -1 && !incomingMerged) {
      // 上游泳道改为止于「传入的更改」，不再连到合并基
      const redirect = (node) => (node.id === mergeBase && node.color === HISTORY_ITEM_REMOTE_REF_COLOR
        ? { ...node, id: INCOMING_CHANGES_ID }
        : node);
      viewModels[beforeIndex] = {
        ...before,
        inputSwimlanes: before.inputSwimlanes.map(redirect),
        outputSwimlanes: before.outputSwimlanes.map(redirect),
      };
      viewModels.splice(afterIndex, 0, {
        commit: { sha: INCOMING_CHANGES_ID, parents: [mergeBase] },
        kind: 'incoming-changes',
        inputSwimlanes: viewModels[beforeIndex].outputSwimlanes.slice(),
        outputSwimlanes: viewModels[afterIndex].inputSwimlanes.slice(),
        references: [],
        compare: { sha: remoteSha, parentSha: mergeBase },
      });
    }
  }

  if (headSha && headSha !== mergeBase) {
    // HEAD 可能还没加载到，这时不显示
    const headIndex = viewModels.findIndex((viewModel) => viewModel.kind === 'HEAD' && viewModel.commit.sha === headSha);
    if (headIndex !== -1) {
      const headLane = { id: headSha, color: HISTORY_ITEM_REF_COLOR };
      const inputSwimlanes = viewModels[headIndex].inputSwimlanes.slice();
      viewModels.splice(headIndex, 0, {
        commit: { sha: OUTGOING_CHANGES_ID, parents: [headSha] },
        kind: 'outgoing-changes',
        inputSwimlanes,
        outputSwimlanes: [...inputSwimlanes, headLane],
        references: [],
        compare: { sha: headSha, parentSha: mergeBase },
      });
      // HEAD 行多一条从「传出的更改」进入的泳道
      viewModels[headIndex + 1] = {
        ...viewModels[headIndex + 1],
        inputSwimlanes: [...viewModels[headIndex + 1].inputSwimlanes, headLane],
      };
    }
  }
};

/**
 * 把引用归并为行尾徽标（`HistoryItemRenderer._renderBadges` 的移植）：
 * 排序后的首个有色引用单独成徽标并显示名称；其余有色引用按颜色、再按图标归组，只显示图标与数量；无色引用不显示。
 *
 * @param {Array<{ id: string, name: string, icon: string, color: string | undefined }>} references 已排序的行引用
 * @returns {Array<{ color: string, icon: string, count: number, name: string | null }>} 按显示顺序排列的徽标（无副作用）
 */
export const groupHistoryItemBadges = (references) => {
  const badges = [];
  const rest = references.slice();
  if (rest.length > 0 && rest[0].color) {
    const [first] = rest.splice(0, 1);
    badges.push({ color: first.color, icon: first.icon, count: 1, name: first.name });
  }

  const groups = new Map();
  for (const ref of rest) {
    if (!ref.color) continue;
    const key = `${ref.color}\u0000${ref.icon}`;
    const group = groups.get(key);
    if (group) {
      group.count += 1;
    } else {
      groups.set(key, { color: ref.color, icon: ref.icon, count: 1, name: null });
    }
  }
  // 原实现先按颜色再按图标两级分组，展开顺序等价于按「颜色首次出现」排序
  const colorOrder = [...new Set([...groups.values()].map((group) => group.color))];
  for (const color of colorOrder) {
    for (const group of groups.values()) {
      if (group.color === color) badges.push(group);
    }
  }
  return badges;
};

/**
 * 计算提交圆点所在的泳道序号（`getHistoryItemIndex` 的移植）。
 *
 * @param {{ commit: { sha: string }, inputSwimlanes: Array<{ id: string }> }} viewModel 行视图模型
 * @returns {number} 圆点泳道序号（无副作用）
 */
export const getHistoryItemIndex = (viewModel) => {
  const inputIndex = viewModel.inputSwimlanes.findIndex((node) => node.id === viewModel.commit.sha);
  return inputIndex !== -1 ? inputIndex : viewModel.inputSwimlanes.length;
};

const pathShape = (d, color, strokeWidth = 1) => ({ type: 'path', d, color, strokeWidth });

const verticalLine = (x, y1, y2, color, strokeWidth = 1) => pathShape(`M ${x} ${y1} V ${y2}`, color, strokeWidth);

const circleShape = (index, r, strokeWidth, fill) => ({
  type: 'circle',
  cx: SWIMLANE_WIDTH * (index + 1),
  cy: SWIMLANE_WIDTH,
  r,
  strokeWidth,
  fill,
});

const dashedCircleShape = (index, strokeWidth, stroke) => ({
  ...circleShape(index, CIRCLE_RADIUS + 1, strokeWidth, undefined),
  stroke,
  dashArray: '4,2',
});

/**
 * 生成单个提交行的 SVG 图形描述（`renderSCMHistoryItemGraph` 的移植）。
 * 形状顺序与原实现一致，样式表依赖「第一个/第二个/最后一个 circle」做悬停效果；
 * 从圆点向下接续第一父提交的竖线标记 `isOutgoing`，展开提交时加粗。
 *
 * @param {ReturnType<typeof toHistoryItemViewModels>[number]} viewModel 行视图模型
 * @returns {{
 *   width: number,
 *   shapes: Array<
 *     { type: 'path', d: string, color: string, strokeWidth: number, isOutgoing?: true } |
 *     { type: 'circle', cx: number, cy: number, r: number, strokeWidth: number, fill: string | undefined, stroke?: string, dashArray?: string }
 *   >
 * }} SVG 宽度与按绘制顺序排列的形状（无副作用）；只有虚拟行的虚线圆带 `stroke` 与 `dashArray`
 */
export const computeHistoryItemGraph = (viewModel) => {
  const { commit, kind, inputSwimlanes, outputSwimlanes } = viewModel;
  const parentIds = commit.parents;
  const shapes = [];

  const inputIndex = inputSwimlanes.findIndex((node) => node.id === commit.sha);
  const circleIndex = inputIndex !== -1 ? inputIndex : inputSwimlanes.length;
  const circleColor = getCircleColor(commit, inputSwimlanes, outputSwimlanes, circleIndex);

  let outputSwimlaneIndex = 0;
  for (let index = 0; index < inputSwimlanes.length; index += 1) {
    const color = inputSwimlanes[index].color;

    if (inputSwimlanes[index].id === commit.sha) {
      if (index !== circleIndex) {
        // 同一提交的重复泳道：画 / 收拢后水平连到圆点
        shapes.push(pathShape([
          `M ${SWIMLANE_WIDTH * (index + 1)} 0`,
          `A ${SWIMLANE_WIDTH} ${SWIMLANE_WIDTH} 0 0 1 ${SWIMLANE_WIDTH * index} ${SWIMLANE_WIDTH}`,
          `H ${SWIMLANE_WIDTH * (circleIndex + 1)}`,
        ].join(' '), color));
      } else if (parentIds.length > 0) {
        // 圆点泳道由第一父提交接续；根提交没有接续泳道，右侧泳道需整体左移
        outputSwimlaneIndex += 1;
      }
      continue;
    }

    if (outputSwimlaneIndex < outputSwimlanes.length
      && inputSwimlanes[index].id === outputSwimlanes[outputSwimlaneIndex].id) {
      if (index === outputSwimlaneIndex) {
        shapes.push(verticalLine(SWIMLANE_WIDTH * (index + 1), 0, SWIMLANE_HEIGHT, color));
      } else {
        // 泳道左移：| 下行、/ 圆角、- 水平、/ 圆角、| 下行
        shapes.push(pathShape([
          `M ${SWIMLANE_WIDTH * (index + 1)} 0`,
          'V 6',
          `A ${SWIMLANE_CURVE_RADIUS} ${SWIMLANE_CURVE_RADIUS} 0 0 1 ${(SWIMLANE_WIDTH * (index + 1)) - SWIMLANE_CURVE_RADIUS} ${SWIMLANE_HEIGHT / 2}`,
          `H ${(SWIMLANE_WIDTH * (outputSwimlaneIndex + 1)) + SWIMLANE_CURVE_RADIUS}`,
          `A ${SWIMLANE_CURVE_RADIUS} ${SWIMLANE_CURVE_RADIUS} 0 0 0 ${SWIMLANE_WIDTH * (outputSwimlaneIndex + 1)} ${(SWIMLANE_HEIGHT / 2) + SWIMLANE_CURVE_RADIUS}`,
          `V ${SWIMLANE_HEIGHT}`,
        ].join(' '), color));
      }
      outputSwimlaneIndex += 1;
    }
  }

  for (let parentIndex = 1; parentIndex < parentIds.length; parentIndex += 1) {
    const parentOutputIndex = findLastIndex(outputSwimlanes, parentIds[parentIndex]);
    if (parentOutputIndex === -1) continue;

    // 合并父提交：从圆点水平引出，再以 \ 圆弧拐入父提交泳道
    shapes.push(pathShape([
      `M ${SWIMLANE_WIDTH * parentOutputIndex} ${SWIMLANE_HEIGHT / 2}`,
      `A ${SWIMLANE_WIDTH} ${SWIMLANE_WIDTH} 0 0 1 ${SWIMLANE_WIDTH * (parentOutputIndex + 1)} ${SWIMLANE_HEIGHT}`,
      `M ${SWIMLANE_WIDTH * parentOutputIndex} ${SWIMLANE_HEIGHT / 2}`,
      `H ${SWIMLANE_WIDTH * (circleIndex + 1)}`,
    ].join(' '), outputSwimlanes[parentOutputIndex].color));
  }

  if (inputIndex !== -1) {
    shapes.push(verticalLine(SWIMLANE_WIDTH * (circleIndex + 1), 0, SWIMLANE_HEIGHT / 2, inputSwimlanes[inputIndex].color));
  }

  if (parentIds.length > 0) {
    shapes.push({
      ...verticalLine(SWIMLANE_WIDTH * (circleIndex + 1), SWIMLANE_HEIGHT / 2, SWIMLANE_HEIGHT, circleColor),
      isOutgoing: true,
    });
  }

  if (kind === 'HEAD') {
    shapes.push(circleShape(circleIndex, CIRCLE_RADIUS + 3, CIRCLE_STROKE_WIDTH, circleColor));
    shapes.push(circleShape(circleIndex, CIRCLE_STROKE_WIDTH, CIRCLE_RADIUS, undefined));
  } else if (kind === 'incoming-changes' || kind === 'outgoing-changes') {
    shapes.push(circleShape(circleIndex, CIRCLE_RADIUS + 3, CIRCLE_STROKE_WIDTH, circleColor));
    shapes.push(circleShape(circleIndex, CIRCLE_RADIUS + 1, CIRCLE_STROKE_WIDTH + 1, undefined));
    shapes.push(dashedCircleShape(circleIndex, CIRCLE_STROKE_WIDTH - 1, circleColor));
  } else if (parentIds.length > 1) {
    shapes.push(circleShape(circleIndex, CIRCLE_RADIUS + 2, CIRCLE_STROKE_WIDTH, circleColor));
    shapes.push(circleShape(circleIndex, CIRCLE_RADIUS - 1, CIRCLE_STROKE_WIDTH, circleColor));
  } else {
    shapes.push(circleShape(circleIndex, CIRCLE_RADIUS + 1, CIRCLE_STROKE_WIDTH, circleColor));
  }

  return {
    width: SWIMLANE_WIDTH * (Math.max(inputSwimlanes.length, outputSwimlanes.length, 1) + 1),
    shapes,
  };
};

/**
 * 生成展开提交文件子行左侧的贯穿竖线：沿用所属提交的输出泳道，并加粗由它接续的第一父提交泳道。
 * 根提交没有接续泳道，不加粗任何一条（圆点列已被右侧泳道左移占用）。
 *
 * @param {ReturnType<typeof toHistoryItemViewModels>[number]} viewModel 所属提交的行视图模型
 * @returns {ReturnType<typeof computeGraphPlaceholder>} SVG 宽度与竖线形状（无副作用）
 */
export const computeCommitFilesPlaceholder = (viewModel) => computeGraphPlaceholder(
  viewModel.outputSwimlanes,
  viewModel.commit.parents.length > 0 ? getHistoryItemIndex(viewModel) : undefined,
);

/**
 * 生成展开文件子行与「加载更多」行左侧的贯穿竖线（`renderSCMHistoryGraphPlaceholder` 的移植）。
 *
 * @param {Array<{ color: string }>} columns 需要贯穿的泳道（通常为所属提交的输出泳道）
 * @param {number} [highlightIndex] 加粗显示的泳道序号（所属提交的圆点泳道）
 * @returns {{ width: number, shapes: Array<{ type: 'path', d: string, color: string, strokeWidth: number }> }} SVG 宽度与竖线形状（无副作用）
 */
export const computeGraphPlaceholder = (columns, highlightIndex) => ({
  width: SWIMLANE_WIDTH * (columns.length + 1),
  shapes: columns.map((column, index) => verticalLine(
    SWIMLANE_WIDTH * (index + 1),
    0,
    SWIMLANE_HEIGHT,
    column.color,
    index === highlightIndex ? 3 : 1,
  )),
});
