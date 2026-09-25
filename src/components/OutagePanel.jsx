// ============================================================
// 页面模块：停役影响台面板
//   <OutagePanel />       选中设备的停役影响视图（分析 / 待确认 / 停役中）
//   <OutageRecordsList /> 全部停役记录列表（重新打开后可核对）
// 纯展示与交互，计算与存储分别走 topology/impact.js 与 topology/outageRecords.js
// ============================================================

import React from 'react';
import { STATUS_LABEL, formatTime, summarizeImpact } from '../topology/outageRecords';

const TYPE_LABEL = { router: '路由器', switch: '交换机', server: '服务器', device: '终端设备' };

/** 三类影响分组展示：失联终端 / 备用线路设备 / 无出口节点 */
function ImpactGroups({ impact }) {
  if (!impact) return null;
  const empty =
    !impact.lostTerminals.length &&
    !impact.backupDevices.length &&
    !impact.noExitNodes.length;
  return (
    <div className="impact-groups">
      <div className="impact-group lost">
        <header>
          <b>会失联的终端</b>
          <span>{impact.lostTerminals.length}</span>
        </header>
        {impact.lostTerminals.length ? (
          <ul>
            {impact.lostTerminals.map((t) => (
              <li key={t.id}>
                <i className={`mini ${t.type}`}></i>
                {t.name}
                <small>{t.id}</small>
              </li>
            ))}
          </ul>
        ) : (
          <p className="impact-none">无</p>
        )}
      </div>

      <div className="impact-group backup">
        <header>
          <b>还能走备用线路的设备</b>
          <span>{impact.backupDevices.length}</span>
        </header>
        {impact.backupDevices.length ? (
          <ul>
            {impact.backupDevices.map((d) => (
              <li key={d.id}>
                <i className={`mini ${d.type}`}></i>
                <span className="backup-name">
                  {d.name}
                  {d.isExit && <em>（本身就是出口）</em>}
                </span>
                {!d.isExit && d.path.length > 0 && (
                  <small className="backup-path">备用路径：{d.path.join(' → ')}</small>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="impact-none">无</p>
        )}
      </div>

      <div className="impact-group noexit">
        <header>
          <b>断开后没有别的出口的节点</b>
          <span>{impact.noExitNodes.length}</span>
        </header>
        {impact.noExitNodes.length ? (
          <ul>
            {impact.noExitNodes.map((n) => (
              <li key={n.id}>
                <i className={`mini ${n.type}`}></i>
                {n.name}
                <small>{TYPE_LABEL[n.type] || n.type}</small>
              </li>
            ))}
          </ul>
        ) : (
          <p className="impact-none">无</p>
        )}
      </div>

      {empty && <p className="impact-empty">该设备停役不影响任何节点的出口连通性</p>}
    </div>
  );
}

/** 原连接快照（停役中保留，恢复时照此接回） */
function OriginalEdges({ edges }) {
  if (!edges?.length) return <p className="impact-none">原无连接</p>;
  return (
    <ul className="original-edges">
      {edges.map((e, i) => (
        <li key={i}>
          <span className="edge-chip">
            {e.aName} ⇋ {e.bName}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** 选中设备的停役影响视图 */
export function OutagePanel({
  node,
  record,
  liveImpact,
  onCreate,
  onUpdatePlan,
  onExecute,
  onRestore,
  onCancel,
  onRecheck,
  notice,
}) {
  if (!node) return <p className="panel-hint">选择一个设备后评估停役影响</p>;

  // ---------- 待确认 ----------
  if (record && record.status === 'pending') {
    const lostCount = record.impact?.lostTerminals?.length || 0;
    const needPlan = lostCount > 0;
    const ready =
      !needPlan ||
      (record.alternateRoute.trim().length >= 2 && record.rollbackAt);
    return (
      <div className="outage-panel">
        <div className="outage-status pending">
          <b>停役待确认</b>
          <small>创建于 {formatTime(record.createdAt)}</small>
        </div>
        {needPlan && (
          <div className="outage-warning">
            存在 {lostCount} 个失联终端，须填好替代线路与回退时刻才能执行停役
          </div>
        )}
        <ImpactGroups impact={record.impact} />
        <label className="outage-field">
          替代线路{needPlan && <em>*</em>}
          <textarea
            rows="2"
            placeholder="例如：办公终端临时改接 交换机A，经 核心路由器 上联"
            value={record.alternateRoute}
            onChange={(e) => onUpdatePlan(record.id, { alternateRoute: e.target.value })}
          />
        </label>
        <label className="outage-field">
          回退时刻{needPlan && <em>*</em>}
          <input
            type="datetime-local"
            value={record.rollbackAt}
            onChange={(e) => onUpdatePlan(record.id, { rollbackAt: e.target.value })}
          />
        </label>
        <div className="outage-actions">
          <button
            className="execute"
            disabled={!ready}
            title={ready ? '' : '存在失联终端，须先填好替代线路与回退时刻'}
            onClick={() => onExecute(record.id)}
          >
            ⏻ 执行停役
          </button>
          <button onClick={() => onCancel(record.id)}>取消</button>
        </div>
        {notice && <p className="outage-notice">{notice}</p>}
      </div>
    );
  }

  // ---------- 停役中 ----------
  if (record && record.status === 'active') {
    return (
      <div className="outage-panel">
        <div className="outage-status active">
          <b>停役中</b>
          <small>执行于 {formatTime(record.executedAt)}</small>
        </div>
        <div className="outage-detail">
          <div>
            <span>替代线路</span>
            <p>{record.alternateRoute || '（未填写）'}</p>
          </div>
          <div>
            <span>回退时刻</span>
            <p>{formatTime(record.rollbackAt)}</p>
          </div>
        </div>
        <div className="section-title sub">
          <span>原连接（保留，恢复时照原线接回）</span>
          <small>{record.originalEdges.length} 条</small>
        </div>
        <OriginalEdges edges={record.originalEdges} />
        <div className="section-title sub">
          <span>停役前影响快照</span>
          <small>{formatTime(record.impact?.computedAt)}</small>
        </div>
        <ImpactGroups impact={record.impact} />
        {record.recheck && (
          <p className={`recheck ${record.recheck.same ? 'ok' : 'bad'}`}>
            核对于 {formatTime(record.recheck.at)}：{record.recheck.summary}
          </p>
        )}
        <div className="outage-actions">
          <button className="restore" onClick={() => onRestore(record.id)}>
            ⇄ 恢复（照原线接回）
          </button>
          <button onClick={() => onRecheck(record.id)}>核对影响</button>
        </div>
        {notice && <p className="outage-notice">{notice}</p>}
      </div>
    );
  }

  // ---------- 无记录：实时影响分析 ----------
  return (
    <div className="outage-panel">
      <div className="outage-status analysis">
        <b>停役影响分析</b>
        <small>按当前连线实时计算</small>
      </div>
      <ImpactGroups impact={liveImpact} />
      <div className="outage-actions">
        <button className="execute" onClick={onCreate}>
          ⏻ 申请停役（生成待确认单）
        </button>
      </div>
      {notice && <p className="outage-notice">{notice}</p>}
    </div>
  );
}

/** 全部停役记录列表 */
export function OutageRecordsList({ records, nodes, onLocate }) {
  const count = (s) => records.filter((r) => r.status === s).length;
  return (
    <div className="outage-records">
      <div className="record-summary">
        <span>
          待确认 <b>{count('pending')}</b>
        </span>
        <span>
          停役中 <b>{count('active')}</b>
        </span>
        <span>
          已恢复 <b>{count('restored')}</b>
        </span>
        <span>
          已取消 <b>{count('cancelled')}</b>
        </span>
      </div>
      {records.length === 0 && <p className="panel-hint">暂无停役记录</p>}
      {records.map((r) => {
        const nodeExists = nodes.some((n) => n.id === r.nodeId);
        return (
          <button
            key={r.id}
            className={`record-item ${r.status}`}
            onClick={() => nodeExists && onLocate(r.nodeId)}
            title={nodeExists ? '点击定位到设备' : '设备已不在拓扑中'}
          >
            <div className="record-head">
              <b>{r.nodeName}</b>
              <span className={`chip ${r.status}`}>{STATUS_LABEL[r.status]}</span>
            </div>
            <small>
              {r.nodeId} · {summarizeImpact(r.impact)}
            </small>
            <small>
              创建 {formatTime(r.createdAt)}
              {r.executedAt && ` · 执行 ${formatTime(r.executedAt)}`}
              {r.restoredAt && ` · 恢复 ${formatTime(r.restoredAt)}`}
            </small>
            {r.recheck && (
              <small className={r.recheck.same ? 'recheck-ok' : 'recheck-bad'}>
                核对：{r.recheck.summary}
              </small>
            )}
            {!nodeExists && <small className="recheck-bad">设备已删除，记录留档</small>}
          </button>
        );
      })}
    </div>
  );
}
