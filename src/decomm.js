// 停役记录：状态流转 + 持久化，独立于拓扑图和页面。
// 记录保存了停役时刻的原连接快照，恢复时照原线接回。

const KEY = 'decommission-records-v1';

export const STATUS = { PENDING: 'pending', ACTIVE: 'active', RESTORED: 'restored' };

export function loadRecords() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function saveRecords(records) {
  localStorage.setItem(KEY, JSON.stringify(records));
}

export const activeIds = (records) =>
  new Set(records.filter((r) => r.status === STATUS.ACTIVE).map((r) => r.nodeId));

export const findByNode = (records, nodeId, status) =>
  records.find((r) => r.nodeId === nodeId && r.status === status);

// 停役前先建待确认记录：留存影响结果与原连接，等待填替代线路和回退时刻
export function createPending(records, { node, edges, impact, createdAt = new Date().toISOString() }) {
  const others = new Set(records.filter((r) => r.status === STATUS.ACTIVE).map((r) => r.nodeId));
  const snapshot = edges
    .filter(([a, b]) => (a === node.id || b === node.id) && !others.has(a) && !others.has(b))
    .map(([a, b]) => [a, b]);
  const record = {
    id: 'dc-' + Date.now(),
    nodeId: node.id,
    nodeName: node.name,
    status: STATUS.PENDING,
    createdAt,
    executedAt: null,
    restoreAt: null,
    restoredAt: null,
    reroute: '',
    impact: {
      lostTerminals: impact.lostTerminals.map((t) => ({ id: t.id, name: t.name, ip: t.ip })),
      strandedOthers: impact.strandedOthers.map((t) => ({ id: t.id, name: t.name, ip: t.ip })),
      backup: impact.backup.map((t) => ({ id: t.id, name: t.name, ip: t.ip, path: t.path })),
    },
    originalEdges: snapshot,
  };
  const next = [record, ...records];
  saveRecords(next);
  return next;
}

// 执行停役：必须填好替代线路（有失联终端时）和回退时刻
export function execute(records, id, { reroute, restoreAt, executedAt = new Date().toISOString() }) {
  const rec = records.find((r) => r.id === id);
  if (!rec || rec.status !== STATUS.PENDING) {
    throw new Error('停役记录不存在或不是待确认状态');
  }
  if (rec.impact.lostTerminals.length > 0 && (!reroute || !reroute.trim() || !restoreAt)) {
    throw new Error('存在失联终端：替代线路和回退时刻填好后才能执行');
  }
  const next = records.map((r) =>
    r.id === id
      ? { ...r, status: STATUS.ACTIVE, reroute: (reroute || '').trim(), restoreAt: restoreAt || null, executedAt }
      : r
  );
  saveRecords(next);
  return next;
}

// 撤销待确认（尚未执行，不影响拓扑）
export function cancelPending(records, id) {
  const next = records.filter((r) => !(r.id === id && r.status === STATUS.PENDING));
  saveRecords(next);
  return next;
}

// 恢复：照原连接快照接回，记录留档
export function restore(records, id, restoredAt = new Date().toISOString()) {
  const next = records.map((r) =>
    r.id === id && r.status === STATUS.ACTIVE ? { ...r, status: STATUS.RESTORED, restoredAt } : r
  );
  saveRecords(next);
  return next;
}
