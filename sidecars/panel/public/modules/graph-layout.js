/**
 * 提交图谱（Commit Graph）SVG 动态拓扑车道纯计算模块。
 * 按当前可见提交序列实时推导车道槽位、收敛弧线与分叉贝塞尔曲线，
 * 不硬编码主干通道，且不为不可见父提交占用悬空线槽。
 */

/** @type {number} 单条提交行的固定像素高度 */
export const GRAPH_ROW_HEIGHT = 24;

/** @type {number} 相邻泳道中心线的标准水平间距（像素） */
export const LANE_STEP = 12;

/** @type {number} 窄幅辅助栏下不压缩时的最大泳道列数上限 */
export const MAX_LANES = 6;

/** @type {readonly string[]} 泳道调色板（优先消费宿主/面板 CSS 变量并附带回退色） */
export const LANE_COLORS = Object.freeze([
  'var(--lane-0, #3794ff)',
  'var(--lane-1, #73c991)',
  'var(--lane-2, #c586c0)',
  'var(--lane-3, #e2b969)',
  'var(--lane-4, #4ec9b0)',
  'var(--lane-5, #f48771)',
]);

const DEFAULT_PAD_X = 6;

const findFirstFreeLaneIndex = (activeLanes) => {
  const freeIndex = activeLanes.findIndex((slot) => slot === null);
  return freeIndex === -1 ? activeLanes.length : freeIndex;
};

const findLaneByExpectedSha = (activeLanes, targetSha) =>
  activeLanes.findIndex((slot) => slot !== null && slot.expectedSha === targetSha);

const trimTrailingEmptyLanes = (activeLanes) => {
  while (activeLanes.length > 0 && activeLanes[activeLanes.length - 1] === null) {
    activeLanes.pop();
  }
};

const collectVisibleParents = (parents, visibleShaSet) => {
  const visibleParents = [];
  const seen = new Set();
  let hasHiddenParent = false;

  for (const parentSha of parents) {
    if (typeof parentSha !== 'string' || !parentSha) continue;
    if (!visibleShaSet.has(parentSha)) {
      hasHiddenParent = true;
      continue;
    }
    if (!seen.has(parentSha)) {
      seen.add(parentSha);
      visibleParents.push(parentSha);
    }
  }

  return { visibleParents, hasHiddenParent };
};

const snapshotPassThroughBefore = (activeLanes) => {
  const lanes = [];
  for (let laneIndex = 0; laneIndex < activeLanes.length; laneIndex += 1) {
    const slot = activeLanes[laneIndex];
    if (slot === null) continue;
    lanes.push({
      lane: laneIndex,
      colorIndex: slot.colorIndex,
      color: LANE_COLORS[slot.colorIndex],
    });
  }
  return lanes;
};

const snapshotPassThroughAfter = (activeLanes) => {
  const lanes = [];
  for (let laneIndex = 0; laneIndex < activeLanes.length; laneIndex += 1) {
    const slot = activeLanes[laneIndex];
    if (slot === null) continue;
    lanes.push({
      lane: laneIndex,
      expectedSha: slot.expectedSha,
      colorIndex: slot.colorIndex,
      color: LANE_COLORS[slot.colorIndex],
    });
  }
  return lanes;
};

/**
 * 基于当前可见提交列表动态计算每一行的拓扑车道与连线关系。
 *
 * @param {Array<{ sha: string, parents?: string[] }>} commits 当前可见的提交数组（按拓扑显示顺序从新到旧排列）
 * @returns {Array<{
 *   sha: string,
 *   ownLane: number,
 *   ownColorIndex: number,
 *   ownColor: string,
 *   incomingOnOwnLane: boolean,
 *   passThroughLanesBefore: Array<{ lane: number, colorIndex: number, color: string }>,
 *   exitingLanes: Array<{ lane: number, fromLane: number, toLane: number, colorIndex: number, color: string }>,
 *   outgoingEdges: Array<{ fromLane: number, toLane: number, targetSha: string, colorIndex: number, color: string, isMerge: boolean }>,
 *   passThroughLanesAfter: Array<{ lane: number, expectedSha: string, colorIndex: number, color: string }>,
 *   hasHiddenParent: boolean,
 *   isMerge: boolean,
 *   laneCount: number
 * }>} 与输入 `commits` 一一对应的拓扑行描述数组（无副作用）
 */
export const computeGraphTopology = (commits) => {
  if (!Array.isArray(commits) || commits.length === 0) {
    return [];
  }

  const visibleShaSet = new Set();
  for (const commit of commits) {
    if (commit && typeof commit.sha === 'string' && commit.sha) {
      visibleShaSet.add(commit.sha);
    }
  }

  const activeLanes = [];
  let nextColorCursor = 0;

  const allocateColorIndex = (avoidColorIndex = -1) => {
    let candidate = nextColorCursor % LANE_COLORS.length;
    nextColorCursor += 1;
    if (candidate === avoidColorIndex && LANE_COLORS.length > 1) {
      candidate = nextColorCursor % LANE_COLORS.length;
      nextColorCursor += 1;
    }
    return candidate;
  };

  return commits.map((commit) => {
    const sha = typeof commit?.sha === 'string' ? commit.sha : '';
    const rawParents = Array.isArray(commit?.parents) ? commit.parents : [];

    const matchingSlotIndices = [];
    for (let laneIndex = 0; laneIndex < activeLanes.length; laneIndex += 1) {
      const slot = activeLanes[laneIndex];
      if (slot !== null && slot.expectedSha === sha) {
        matchingSlotIndices.push(laneIndex);
      }
    }

    let ownLane = 0;
    let ownColorIndex = 0;
    let incomingOnOwnLane = false;
    const exitingLanes = [];

    if (matchingSlotIndices.length > 0) {
      ownLane = matchingSlotIndices[0];
      ownColorIndex = activeLanes[ownLane].colorIndex;
      incomingOnOwnLane = true;

      for (let matchPos = 1; matchPos < matchingSlotIndices.length; matchPos += 1) {
        const duplicateLane = matchingSlotIndices[matchPos];
        const duplicateColorIndex = activeLanes[duplicateLane].colorIndex;
        exitingLanes.push({
          lane: duplicateLane,
          fromLane: duplicateLane,
          toLane: ownLane,
          colorIndex: duplicateColorIndex,
          color: LANE_COLORS[duplicateColorIndex],
        });
      }

      // 命中节点后释放所有等待本提交的车道，后续再按可见父提交重新占槽
      for (const matchedLane of matchingSlotIndices) {
        activeLanes[matchedLane] = null;
      }
    } else {
      ownLane = findFirstFreeLaneIndex(activeLanes);
      ownColorIndex = allocateColorIndex();
    }

    const passThroughLanesBefore = snapshotPassThroughBefore(activeLanes);
    const { visibleParents, hasHiddenParent } = collectVisibleParents(rawParents, visibleShaSet);
    const outgoingEdges = [];

    visibleParents.forEach((parentSha, parentOrder) => {
      const existingLane = findLaneByExpectedSha(activeLanes, parentSha);

      if (parentOrder === 0) {
        if (existingLane === -1) {
          activeLanes[ownLane] = { expectedSha: parentSha, colorIndex: ownColorIndex };
          outgoingEdges.push({
            fromLane: ownLane,
            toLane: ownLane,
            targetSha: parentSha,
            colorIndex: ownColorIndex,
            color: LANE_COLORS[ownColorIndex],
            isMerge: false,
          });
          return;
        }

        if (existingLane < ownLane) {
          // 已有更靠左的车道在等待该第一父提交，从当前车道向左收束并释放当前车道
          outgoingEdges.push({
            fromLane: ownLane,
            toLane: existingLane,
            targetSha: parentSha,
            colorIndex: ownColorIndex,
            color: LANE_COLORS[ownColorIndex],
            isMerge: false,
          });
          return;
        }

        // 保留当前更靠左的主线车道，右侧重复槽位将在抵达该父提交时通过 exitingLanes 收束
        activeLanes[ownLane] = { expectedSha: parentSha, colorIndex: ownColorIndex };
        outgoingEdges.push({
          fromLane: ownLane,
          toLane: ownLane,
          targetSha: parentSha,
          colorIndex: ownColorIndex,
          color: LANE_COLORS[ownColorIndex],
          isMerge: false,
        });
        return;
      }

      if (existingLane !== -1) {
        const targetColorIndex = activeLanes[existingLane].colorIndex;
        outgoingEdges.push({
          fromLane: ownLane,
          toLane: existingLane,
          targetSha: parentSha,
          colorIndex: targetColorIndex,
          color: LANE_COLORS[targetColorIndex],
          isMerge: true,
        });
        return;
      }

      const forkLane = findFirstFreeLaneIndex(activeLanes);
      const forkColorIndex = allocateColorIndex(ownColorIndex);
      activeLanes[forkLane] = { expectedSha: parentSha, colorIndex: forkColorIndex };
      outgoingEdges.push({
        fromLane: ownLane,
        toLane: forkLane,
        targetSha: parentSha,
        colorIndex: forkColorIndex,
        color: LANE_COLORS[forkColorIndex],
        isMerge: true,
      });
    });

    trimTrailingEmptyLanes(activeLanes);
    const passThroughLanesAfter = snapshotPassThroughAfter(activeLanes);

    let maxUsedLane = ownLane;
    for (const item of passThroughLanesBefore) {
      if (item.lane > maxUsedLane) maxUsedLane = item.lane;
    }
    for (const item of exitingLanes) {
      if (item.lane > maxUsedLane) maxUsedLane = item.lane;
    }
    for (const edge of outgoingEdges) {
      if (edge.toLane > maxUsedLane) maxUsedLane = edge.toLane;
    }
    for (const item of passThroughLanesAfter) {
      if (item.lane > maxUsedLane) maxUsedLane = item.lane;
    }

    return {
      sha,
      ownLane,
      ownColorIndex,
      ownColor: LANE_COLORS[ownColorIndex],
      incomingOnOwnLane,
      passThroughLanesBefore,
      exitingLanes,
      outgoingEdges,
      passThroughLanesAfter,
      hasHiddenParent,
      isMerge: rawParents.length > 1,
      laneCount: maxUsedLane + 1,
    };
  });
};

/**
 * 根据拓扑结果或车道数计算窄幅 SVG 泳道列的几何尺寸与坐标映射。
 * 车道数超过 `MAX_LANES`（6 列）时自动横向压缩间距，将总宽度限制在 `MAX_LANES * LANE_STEP`（72px）以内。
 *
 * @param {Array<{ laneCount?: number }> | number} topologyOrLaneCount `computeGraphTopology` 返回数组或总车道数
 * @param {{ padX?: number, rowHeight?: number }} [options] 可选左右留白与行高覆盖
 * @returns {{
 *   laneCount: number,
 *   width: number,
 *   laneStep: number,
 *   padX: number,
 *   rowHeight: number,
 *   getLaneX: (laneIndex: number) => number
 * }} 几何度量与车道 X 坐标换算函数（无副作用）
 */
export const computeGraphMetrics = (topologyOrLaneCount, options = {}) => {
  let rawLaneCount = 1;
  if (typeof topologyOrLaneCount === 'number' && Number.isFinite(topologyOrLaneCount)) {
    rawLaneCount = Math.max(1, Math.floor(topologyOrLaneCount));
  } else if (Array.isArray(topologyOrLaneCount) && topologyOrLaneCount.length > 0) {
    for (const row of topologyOrLaneCount) {
      if (typeof row?.laneCount === 'number' && row.laneCount > rawLaneCount) {
        rawLaneCount = row.laneCount;
      }
    }
  }

  const rowHeight = typeof options.rowHeight === 'number' && options.rowHeight > 0
    ? options.rowHeight
    : GRAPH_ROW_HEIGHT;
  const maxWidth = MAX_LANES * LANE_STEP;
  const padX = typeof options.padX === 'number' && options.padX >= 0
    ? options.padX
    : DEFAULT_PAD_X;

  if (rawLaneCount === 1) {
    const width = padX * 2;
    return {
      laneCount: 1,
      width,
      laneStep: LANE_STEP,
      padX,
      rowHeight,
      getLaneX: () => padX,
    };
  }

  const naturalWidth = padX * 2 + (rawLaneCount - 1) * LANE_STEP;
  const width = Math.min(maxWidth, naturalWidth);
  const effectivePadX = Math.max(2, Math.min(padX, Math.floor((width - rawLaneCount) / 2)));
  const laneStep = (width - effectivePadX * 2) / (rawLaneCount - 1);

  return {
    laneCount: rawLaneCount,
    width,
    laneStep,
    padX: effectivePadX,
    rowHeight,
    getLaneX: (laneIndex) => Number((effectivePadX + laneIndex * laneStep).toFixed(2)),
  };
};

/**
 * 生成起止两端均保持垂直切线的三阶贝塞尔连线路径 `d` 字符串，确保与上下行竖线平滑无折角衔接。
 *
 * @param {number} fromX 起点 X 坐标
 * @param {number} fromY 起点 Y 坐标
 * @param {number} toX 终点 X 坐标
 * @param {number} toY 终点 Y 坐标
 * @returns {string} SVG `<path>` 的 `d` 属性字符串（无副作用）
 */
export const buildCurvePath = (fromX, fromY, toX, toY) => {
  if (fromX === toX) {
    return `M ${fromX} ${fromY} L ${toX} ${toY}`;
  }
  const midY = Number(((fromY + toY) / 2).toFixed(2));
  return `M ${fromX} ${fromY} C ${fromX} ${midY}, ${toX} ${midY}, ${toX} ${toY}`;
};
