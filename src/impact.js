// 停役影响判断（纯函数模块）
// 只根据“节点 + 连线”做图计算，不依赖 React、localStorage，可单独核对/复用。

export const TERMINAL = 'device'; // 终端设备类型

const brief = (n) => ({ id: n.id, name: n.name, ip: n.ip, type: n.type });

// 边数组 -> 邻接表
export function buildAdjacency(edges) {
  const adj = new Map();
  const link = (a, b) => {
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a).push(b);
  };
  for (const [a, b] of edges) {
    if (!a || !b || a === b) continue;
    link(a, b);
    link(b, a);
  }
  return adj;
}

// 从所有出口（路由器）做多源 BFS，返回距离与上游节点
function bfs(adj, roots, blocked) {
  const dist = new Map();
  const prev = new Map();
  const queue = [];
  for (const r of roots) {
    if (r && !blocked.has(r) && !dist.has(r)) {
      dist.set(r, 0);
      queue.push(r);
    }
  }
  for (let h = 0; h < queue.length; h++) {
    const cur = queue[h];
    for (const nb of adj.get(cur) || []) {
      if (blocked.has(nb) || dist.has(nb)) continue;
      dist.set(nb, dist.get(cur) + 1);
      prev.set(nb, cur);
      queue.push(nb);
    }
  }
  return { dist, prev };
}

// 还原 after 图中 node 到出口的路径（节点名称，方向：本机 -> 出口）
function pathToRoot(prev, startId, byId) {
  const path = [];
  let cur = startId;
  while (cur != null) {
    path.push(byId.get(cur)?.name || cur);
    if (!prev.has(cur)) break;
    cur = prev.get(cur);
  }
  return path;
}

/**
 * 计算停役 nodeId 后的影响。
 * @param nodes  全部节点
 * @param edges  全部连线（含停役设备保留的原线）
 * @param nodeId 拟停役设备
 * @param blocked 已处于停役状态的设备 id 集合（计算时视为断开）
 * @returns {{
 *   lostTerminals: Array  会失联的终端
 *   strandedOthers: Array 断开后没有别的出口的非终端节点
 *   stranded: Array       全部失去出口的节点（含终端）
 *   backup: Array<{node, path}> 仍能经备用线路到达出口的设备及现行路径
 * }}
 */
export function analyzeImpact({ nodes, edges, nodeId, blocked = new Set() }) {
  const adj = buildAdjacency(edges);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  if (!byId.has(nodeId)) {
    return { lostTerminals: [], strandedOthers: [], stranded: [], backup: [] };
  }

  const roots = nodes.filter((n) => n.type === 'router' && !blocked.has(n.id)).map((n) => n.id);

  const before = bfs(adj, roots, blocked);
  const afterBlocked = new Set(blocked);
  afterBlocked.add(nodeId);
  const after = bfs(adj, roots, afterBlocked);

  // 以拟停设备为起点的距离，用于判断“原来是否有经由它的最短路径”
  const fromX = bfs(adj, [nodeId], blocked);
  const dx = before.dist.get(nodeId);

  const stranded = [];
  const backup = [];

  for (const n of nodes) {
    if (n.id === nodeId || blocked.has(n.id)) continue;
    const reachableBefore = before.dist.has(n.id);
    const reachableAfter = after.dist.has(n.id);

    if (reachableBefore && !reachableAfter) {
      // 断开后没有别的出口
      stranded.push(brief(n));
      continue;
    }
    if (
      reachableBefore &&
      reachableAfter &&
      dx != null &&
      fromX.dist.has(n.id) &&
      dx + fromX.dist.get(n.id) === before.dist.get(n.id)
    ) {
      // 原来借道拟停设备，断开后仍可经备用线路到达出口
      backup.push({ ...brief(n), path: pathToRoot(after.prev, n.id, byId) });
    }
  }

  return {
    lostTerminals: stranded.filter((s) => s.type === TERMINAL),
    strandedOthers: stranded.filter((s) => s.type !== TERMINAL),
    stranded,
    backup,
  };
}
