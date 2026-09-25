// ============================================================
// 影响判断模块（纯图计算，不依赖页面 / 存储）
// 输入拓扑 { nodes, edges } 与在役设备集合，输出停役影响分析结果。
// 约定：
//   - type === 'device' 视为「终端」
//   - type === 'router' 视为「出口」，连通性以能否到达任一在役出口为准
//   - 已停役设备在计算中视为不可通行（其连线保留但不再转发）
// ============================================================

export const TERMINAL_TYPE = 'device';
export const EXIT_TYPE = 'router';

/** 由边表构建邻接表：Map<nodeId, Set<nodeId>> */
export function buildAdjacency(edges) {
  const adj = new Map();
  for (const [a, b] of edges) {
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a).add(b);
    adj.get(b).add(a);
  }
  return adj;
}

/**
 * 从所有出口节点做 BFS，返回可到达出口的节点集合。
 * @param {Map} adj 邻接表
 * @param {Set} passable 可通行节点 id 集合（在役设备）
 * @param {string[]} exits 出口节点 id 列表
 */
export function reachableFromExits(adj, passable, exits) {
  const seen = new Set();
  const queue = [];
  for (const id of exits) {
    if (passable.has(id) && !seen.has(id)) {
      seen.add(id);
      queue.push(id);
    }
  }
  while (queue.length) {
    const cur = queue.shift();
    for (const next of adj.get(cur) || []) {
      if (passable.has(next) && !seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

/**
 * 求 from 到任一出口的一条最短路径（BFS），用于展示备用线路走向。
 * @returns {string[]|null} 节点 id 组成的路径，不可达返回 null
 */
export function findPathToExit(adj, passable, exits, from) {
  if (!passable.has(from)) return null;
  const exitSet = new Set(exits.filter((id) => passable.has(id)));
  if (exitSet.has(from)) return [from];
  const prev = new Map([[from, null]]);
  const queue = [from];
  while (queue.length) {
    const cur = queue.shift();
    for (const next of adj.get(cur) || []) {
      if (!passable.has(next) || prev.has(next)) continue;
      prev.set(next, cur);
      if (exitSet.has(next)) {
        const path = [next];
        let p = cur;
        while (p) { path.unshift(p); p = prev.get(p); }
        return path;
      }
      queue.push(next);
    }
  }
  return null;
}

/**
 * 停役影响分析：模拟 targetId 停役（从在役集合中移除）后的连通性变化。
 * @param {{nodes:Array, edges:Array}} topology 拓扑
 * @param {string} targetId 拟停役设备 id
 * @param {Set<string>|string[]} [outOfServiceIds] 当前已停役设备 id（不含目标）
 * @returns 影响分析结果（可直接作为停役记录的影响快照）
 */
export function analyzeImpact(topology, targetId, outOfServiceIds = []) {
  const { nodes, edges } = topology;
  const out = new Set(outOfServiceIds);
  const target = nodes.find((n) => n.id === targetId) || null;
  const byId = new Map(nodes.map((n) => [n.id, n]));

  // 在役集合：当前 / 模拟停役后
  const passableNow = new Set(nodes.filter((n) => !out.has(n.id)).map((n) => n.id));
  const passableAfter = new Set(passableNow);
  passableAfter.delete(targetId);

  const exits = nodes
    .filter((n) => n.type === EXIT_TYPE && n.id !== targetId && !out.has(n.id))
    .map((n) => n.id);

  const adj = buildAdjacency(edges);
  const reachNow = reachableFromExits(adj, passableNow, exits);
  const reachAfter = reachableFromExits(adj, passableAfter, exits);

  const pick = (ids) =>
    [...ids]
      .filter((id) => byId.has(id))
      .sort()
      .map((id) => ({ id, name: byId.get(id).name, type: byId.get(id).type }));

  // 停役后失去出口的节点（不含目标自身与已停役设备）
  const lostIds = new Set(
    [...passableAfter].filter((id) => id !== targetId && !reachAfter.has(id))
  );

  // ① 会失联的终端
  const lostTerminals = pick(
    [...lostIds].filter((id) => byId.get(id)?.type === TERMINAL_TYPE)
  );

  // ③ 断开后没有别的出口的节点（全部失联节点，含终端/服务器/交换机等）
  const noExitNodes = pick([...lostIds]);

  // ② 还能走备用线路的设备：与目标直接相连、目标停役后仍能到达出口的在役设备
  const backupDevices = [];
  for (const peerId of adj.get(targetId) || []) {
    if (!passableAfter.has(peerId) || !reachAfter.has(peerId)) continue;
    const peer = byId.get(peerId);
    if (!peer) continue;
    const pathIds = findPathToExit(adj, passableAfter, exits, peerId) || [];
    backupDevices.push({
      id: peer.id,
      name: peer.name,
      type: peer.type,
      isExit: peer.type === EXIT_TYPE,
      pathIds,
      path: pathIds.map((id) => byId.get(id)?.name || id),
    });
  }
  backupDevices.sort((a, b) => a.id.localeCompare(b.id));

  return {
    targetId,
    targetName: target ? target.name : targetId,
    targetType: target ? target.type : '',
    computedAt: new Date().toISOString(),
    lostTerminals,
    backupDevices,
    noExitNodes,
  };
}

/** 影响结果是否为空（无失联、无备用线路可言） */
export function isImpactEmpty(impact) {
  return (
    impact.lostTerminals.length === 0 &&
    impact.backupDevices.length === 0 &&
    impact.noExitNodes.length === 0
  );
}

const idList = (list) => list.map((x) => x.id).sort();

/**
 * 核对两次影响分析结果是否一致（按节点 id 集合比较）。
 * @returns {{same:boolean, changes:string[]}}
 */
export function diffImpact(before, after) {
  const groups = [
    ['lostTerminals', '失联终端'],
    ['backupDevices', '备用线路设备'],
    ['noExitNodes', '无出口节点'],
  ];
  const changes = [];
  for (const [key, label] of groups) {
    const a = idList(before?.[key] || []);
    const b = idList(after?.[key] || []);
    const added = b.filter((id) => !a.includes(id));
    const removed = a.filter((id) => !b.includes(id));
    if (added.length) changes.push(`${label}新增：${added.join('、')}`);
    if (removed.length) changes.push(`${label}减少：${removed.join('、')}`);
  }
  return { same: changes.length === 0, changes };
}
