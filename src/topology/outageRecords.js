// ============================================================
// 停役记录模块（数据与持久化，不依赖页面）
// 记录生命周期：pending（待确认）→ active（停役中）→ restored（已恢复）
//                                                    ↘ cancelled（已取消）
// 持久化在 localStorage，与拓扑数据分开存放，重新打开页面可核对。
// ============================================================

import { analyzeImpact, diffImpact } from './impact.js';

export const OUTAGE_STORAGE_KEY = 'topology-outage-records-v1';

export const STATUS_LABEL = {
  pending: '待确认',
  active: '停役中',
  restored: '已恢复',
  cancelled: '已取消',
};

/** 读取全部停役记录（按创建时间倒序） */
export function loadOutageRecords() {
  try {
    const list = JSON.parse(localStorage.getItem(OUTAGE_STORAGE_KEY));
    if (!Array.isArray(list)) return [];
    return list.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  } catch {
    return [];
  }
}

/** 保存全部停役记录 */
export function saveOutageRecords(records) {
  localStorage.setItem(OUTAGE_STORAGE_KEY, JSON.stringify(records));
}

/** 当前占用设备的记录 id 集合：待确认 + 停役中（用于在役状态计算） */
export function activeOutageIds(records) {
  return new Set(
    records
      .filter((r) => r.status === 'pending' || r.status === 'active')
      .map((r) => r.nodeId)
  );
}

/** 当前处于停役中的设备 id 集合 */
export function outOfServiceIds(records) {
  return new Set(records.filter((r) => r.status === 'active').map((r) => r.nodeId));
}

/** 某设备当前生效中的记录（待确认或停役中），没有则返回 null */
export function recordForNode(records, nodeId) {
  return (
    records.find(
      (r) => r.nodeId === nodeId && (r.status === 'pending' || r.status === 'active')
    ) || null
  );
}

function newRecordId() {
  return `outage-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * 基于当前影响分析创建停役记录。
 * 有失联终端时状态为 pending（待确认），否则直接可执行（仍为 pending，
 * 但执行时不强制填写替代线路与回退时刻）。
 */
export function createOutageRecord(records, impact, topology) {
  if (recordForNode(records, impact.targetId)) {
    return { records, record: null, error: '该设备已存在待确认或停役中的记录' };
  }
  const record = {
    id: newRecordId(),
    nodeId: impact.targetId,
    nodeName: impact.targetName,
    nodeType: impact.targetType,
    status: 'pending',
    createdAt: new Date().toISOString(),
    executedAt: null,
    restoredAt: null,
    cancelledAt: null,
    // 执行前必须填写的恢复方案
    alternateRoute: '',
    rollbackAt: '',
    // 影响快照：创建时存档，供执行后核对
    impact,
    // 执行时保留的原连接快照（含端点名称，恢复时照原线接回）
    originalEdges: topology.edges
      .filter((e) => e.includes(impact.targetId))
      .map(([a, b]) => ({
        a,
        b,
        aName: topology.nodes.find((n) => n.id === a)?.name || a,
        bName: topology.nodes.find((n) => n.id === b)?.name || b,
      })),
    // 最近一次核对结论
    recheck: null,
  };
  return { records: [record, ...records], record, error: null };
}

/** 更新待确认记录的恢复方案字段 */
export function updateOutagePlan(records, id, patch) {
  return records.map((r) =>
    r.id === id && r.status === 'pending' ? { ...r, ...patch } : r
  );
}

/**
 * 校验并执行停役。
 * 规则：存在失联终端时，必须填好替代线路与回退时刻才能执行。
 * @returns {{records:Array, error:string|null}}
 */
export function executeOutage(records, id) {
  const record = records.find((r) => r.id === id);
  if (!record) return { records, error: '记录不存在' };
  if (record.status !== 'pending') return { records, error: '仅待确认记录可以执行' };

  const hasLostTerminals = (record.impact?.lostTerminals || []).length > 0;
  if (hasLostTerminals) {
    if (!record.alternateRoute || record.alternateRoute.trim().length < 2) {
      return { records, error: '存在失联终端，请先填写替代线路' };
    }
    if (!record.rollbackAt || Number.isNaN(Date.parse(record.rollbackAt))) {
      return { records, error: '存在失联终端，请先填写回退时刻' };
    }
  }
  const done = records.map((r) =>
    r.id === id
      ? { ...r, status: 'active', executedAt: new Date().toISOString() }
      : r
  );
  return { records: done, error: null };
}

/**
 * 恢复：设备照原线接回，记录转为「已恢复」。
 * 返回需要补回的连线（原连接快照中当前拓扑缺失的部分），由调用方合并进拓扑。
 */
export function restoreOutage(records, id, topology) {
  const record = records.find((r) => r.id === id);
  if (!record) return { records, error: '记录不存在', edgesToAdd: [] };
  if (record.status !== 'active') return { records, error: '仅停役中的记录可以恢复', edgesToAdd: [] };

  const nodeExists = topology.nodes.some((n) => n.id === record.nodeId);
  const hasEdge = (a, b) =>
    topology.edges.some(
      (e) => (e[0] === a && e[1] === b) || (e[0] === b && e[1] === a)
    );
  const edgesToAdd = nodeExists
    ? record.originalEdges
        .filter(({ a, b }) => !hasEdge(a, b))
        .map(({ a, b }) => [a, b])
    : [];

  const done = records.map((r) =>
    r.id === id
      ? { ...r, status: 'restored', restoredAt: new Date().toISOString() }
      : r
  );
  return {
    records: done,
    error: null,
    edgesToAdd,
    warning: nodeExists ? null : '设备已不在拓扑中，原连接无法接回',
  };
}

/** 取消待确认记录（不执行停役） */
export function cancelOutage(records, id) {
  return records.map((r) =>
    r.id === id && r.status === 'pending'
      ? { ...r, status: 'cancelled', cancelledAt: new Date().toISOString() }
      : r
  );
}

/**
 * 按当前拓扑重新计算影响，与记录快照核对，结论写回记录。
 * 供「重新打开还能核对结果」使用。
 */
export function recheckOutage(records, id, topology, outIds) {
  const record = records.find((r) => r.id === id);
  if (!record) return { records, result: null };
  const othersOut = [...outIds].filter((nid) => nid !== record.nodeId);
  const current = analyzeImpact(topology, record.nodeId, othersOut);
  const { same, changes } = diffImpact(record.impact, current);
  const result = {
    at: new Date().toISOString(),
    same,
    changes,
    summary: same
      ? '与停役前分析一致'
      : `与停役前分析不一致：${changes.join('；')}`,
  };
  return {
    records: records.map((r) => (r.id === id ? { ...r, recheck: result } : r)),
    result,
  };
}

/** 影响快照格式化（记录列表里展示用） */
export function summarizeImpact(impact) {
  if (!impact) return '无影响快照';
  const parts = [];
  if (impact.lostTerminals.length) parts.push(`失联终端 ${impact.lostTerminals.length}`);
  if (impact.backupDevices.length) parts.push(`备用线路 ${impact.backupDevices.length}`);
  if (impact.noExitNodes.length) parts.push(`无出口节点 ${impact.noExitNodes.length}`);
  return parts.length ? parts.join(' · ') : '无影响';
}

/** 时间展示格式 */
export function formatTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
