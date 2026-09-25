import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { analyzeImpact } from './impact.js';
import * as D from './decomm.js';

// 种子拓扑：sw1↔sw2 备线、db 双归属，用来体现“备用线路可达”
const seed = {
  nodes: [
    { id: 'gw', name: '核心路由器', type: 'router', x: 470, y: 200, ip: '10.0.0.1' },
    { id: 'sw1', name: '交换机 A', type: 'switch', x: 250, y: 350, ip: '10.0.1.1' },
    { id: 'sw2', name: '交换机 B', type: 'switch', x: 690, y: 350, ip: '10.0.2.1' },
    { id: 'web', name: 'Web Server', type: 'server', x: 110, y: 510, ip: '10.0.1.10' },
    { id: 'db', name: 'Database', type: 'server', x: 400, y: 540, ip: '10.0.1.20' },
    { id: 'user', name: '办公终端', type: 'device', x: 840, y: 520, ip: '10.0.2.22' },
  ],
  edges: [
    ['gw', 'sw1'], ['gw', 'sw2'], ['sw1', 'sw2'],
    ['sw1', 'web'], ['sw1', 'db'], ['sw2', 'db'], ['sw2', 'user'],
  ],
};

const load = () => {
  try {
    return JSON.parse(localStorage.getItem('topology')) || seed;
  } catch {
    return seed;
  }
};

export const icon = (t) => (t === 'router' ? '◉' : t === 'switch' ? '▦' : t === 'server' ? '▣' : '▱');
const fmt = (iso) => (iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '—');

function App() {
  const [data, setData] = useState(load);
  const [records, setRecords] = useState(D.loadRecords);
  const [selected, setSelected] = useState('gw');
  const [tool, setTool] = useState('select');
  const [notice, setNotice] = useState('');
  const [drag, setDrag] = useState(null);
  const [showRecords, setShowRecords] = useState(false);
  const [reroute, setReroute] = useState('');
  const [restoreAt, setRestoreAt] = useState('');
  const board = useRef();

  useEffect(() => localStorage.setItem('topology', JSON.stringify(data)), [data]);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(''), 3500);
    return () => clearTimeout(t);
  }, [notice]);

  const edges = useMemo(() => data.edges.map((e) => [e[0], e[1]]), [data.edges]);
  const activeIds = useMemo(() => D.activeIds(records), [records]);
  const pending = D.findByNode(records, selected, D.STATUS.PENDING);
  const active = D.findByNode(records, selected, D.STATUS.ACTIVE);

  useEffect(() => {
    setReroute(pending?.reroute || '');
    setRestoreAt(pending?.restoreAt || '');
  }, [pending?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const node = data.nodes.find((n) => n.id === selected) || data.nodes[0];
  // 影响判断始终基于“当前连线 + 当前已停役设备”实时计算
  const impact =
    node && !pending && !active
      ? analyzeImpact({ nodes: data.nodes, edges, nodeId: node.id, blocked: activeIds })
      : null;

  const activeCount = records.filter((r) => r.status === D.STATUS.ACTIVE).length;
  const pendingCount = records.filter((r) => r.status === D.STATUS.PENDING).length;

  const updateNode = (k, v) =>
    setData({ ...data, nodes: data.nodes.map((n) => (n.id === selected ? { ...n, [k]: v } : n)) });

  const addNode = () => {
    const id = 'node' + Date.now();
    setData({
      ...data,
      nodes: [...data.nodes, { id, name: '新设备', type: 'device', x: 500, y: 300, ip: '192.168.0.10' }],
    });
    setSelected(id);
    setTool('select');
    setNotice('已添加设备');
  };

  const connect = () => {
    if (!selected) return;
    const other = prompt('输入要连接的设备 ID（例如 sw1）');
    if (
      other &&
      data.nodes.some((n) => n.id === other) &&
      other !== selected &&
      !data.edges.some((e) => (e[0] === selected && e[1] === other) || (e[1] === selected && e[0] === other))
    ) {
      setData({ ...data, edges: [...data.edges, [selected, other]] });
      setNotice('连接已创建');
    }
  };

  const remove = () => {
    if (active || pending) {
      setNotice('该设备存在停役记录，不能删除');
      return;
    }
    setData({
      ...data,
      nodes: data.nodes.filter((n) => n.id !== selected),
      edges: data.edges.filter((e) => !e.includes(selected)),
    });
    setSelected(data.nodes.find((n) => n.id !== selected)?.id);
    setNotice('设备已删除');
  };

  const exportJson = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    a.download = 'network-topology.json';
    a.click();
    setNotice('JSON 已导出');
  };

  const validate = () => {
    const linked = new Set(data.edges.flat());
    const isolated = data.nodes.filter((n) => !linked.has(n.id));
    setNotice(isolated.length ? `发现 ${isolated.length} 个孤立节点` : '拓扑检查通过：没有孤立节点');
  };

  // —— 停役流程 ——
  const requestStop = () => {
    if (!node || active || pending) return;
    setRecords(D.createPending(records, { node, edges, impact }));
    setNotice('已生成停役待确认记录：填写替代线路和回退时刻后才能执行');
  };

  const executeStop = () => {
    if (!pending) return;
    if (pending.impact.lostTerminals.length > 0) {
      if (!reroute.trim()) return setNotice('存在失联终端，必须先填写替代线路');
      if (!restoreAt) return setNotice('存在失联终端，必须先填写回退时刻');
    }
    try {
      setRecords(D.execute(records, pending.id, { reroute: reroute.trim(), restoreAt }));
    } catch (e) {
      return setNotice(e.message);
    }
    setNotice(`${pending.nodeName} 已停役，原连接保留；恢复时照原线接回`);
  };

  const doRestore = (rec) => {
    const r = rec || active;
    if (!r) return;
    // 照原连接快照接回（去重，避免多次恢复产生重复连线）
    const nextEdges = edges.map((e) => [e[0], e[1]]);
    const have = new Set(nextEdges.map(([a, b]) => a + '|' + b));
    for (const [a, b] of r.originalEdges) {
      if (!have.has(a + '|' + b) && !have.has(b + '|' + a)) {
        nextEdges.push([a, b]);
        have.add(a + '|' + b);
      }
    }
    setData((d) => ({ ...d, edges: nextEdges }));
    setRecords(D.restore(records, r.id));
    setSelected(r.nodeId);
    setShowRecords(false);
    setNotice(`${r.nodeName} 已恢复，${r.originalEdges.length} 条原连接已照原线接回`);
  };

  const cancelPendingRec = (rec) => {
    const r = rec || pending;
    if (!r) return;
    setRecords(D.cancelPending(records, r.id));
    setNotice('待确认记录已撤销');
  };

  const move = (e) => {
    if (!drag) return;
    const r = board.current.getBoundingClientRect();
    setData({
      ...data,
      nodes: data.nodes.map((n) =>
        n.id === drag ? { ...n, x: Math.max(35, e.clientX - r.left), y: Math.max(35, e.clientY - r.top) } : n
      ),
    });
  };

  const groups = [
    [D.STATUS.PENDING, '待确认', pendingCount],
    [D.STATUS.ACTIVE, '停役中', activeCount],
    [D.STATUS.RESTORED, '已恢复', records.filter((r) => r.status === D.STATUS.RESTORED).length],
  ];

  return (
    <div className="app">
      <header>
        <div className="brand">
          <span className="brand-mark">⌁</span>
          <div>
            <strong>NETSCAPE</strong>
            <small>OUTAGE IMPACT CONSOLE</small>
          </div>
        </div>
        <div className="file">
          <span className={'dot' + (activeCount ? ' off' : '')}></span>
          <div>
            <strong>{activeCount ? `${activeCount} 台设备停役中` : '全部设备在线'}</strong>
            <small>{pendingCount ? `${pendingCount} 份停役待确认` : '无待确认操作'}</small>
          </div>
        </div>
        <div className="top-actions">
          <button onClick={() => setShowRecords(true)}>
            停役记录{(activeCount || pendingCount) > 0 && <b className="badge">{activeCount + pendingCount}</b>}
          </button>
          <button onClick={validate}>✓ 检查</button>
          <button onClick={exportJson}>↓ 导出</button>
          <button className="save" onClick={() => setNotice('拓扑图已保存')}>保存更改</button>
        </div>
      </header>

      <div className="toolbar">
        <div className="tool-group">
          <span>工具</span>
          <button className={tool === 'select' ? 'on' : ''} onClick={() => setTool('select')}>↖ 选择</button>
          <button
            className={tool === 'connect' ? 'on' : ''}
            onClick={() => {
              setTool('connect');
              connect();
            }}
          >
            ⌁ 连接
          </button>
          <button onClick={addNode}>＋ 设备</button>
        </div>
        <div className="tool-group zoom">
          <span className="swatch live"></span>在线
          <span className="swatch backup"></span>备用可达
          <span className="swatch down"></span>停役
        </div>
      </div>

      <div className="workspace">
        <aside className="inventory">
          <div className="section-title">
            <span>设备库</span>
            <small>{data.nodes.length} 个节点</small>
          </div>
          <div className="device-types">
            {[['router', '路由器'], ['switch', '交换机'], ['server', '服务器'], ['device', '终端设备']].map(
              ([t, l]) => (
                <button
                  onClick={() => {
                    const id = 'node' + Date.now();
                    setData({
                      ...data,
                      nodes: [...data.nodes, { id, name: l, type: t, x: 500, y: 320, ip: '192.168.0.2' }],
                    });
                    setSelected(id);
                  }}
                  key={t}
                >
                  <i className={t}>{icon(t)}</i>
                  {l}
                  <span>＋</span>
                </button>
              )
            )}
          </div>
          <div className="section-title nodes-head">
            <span>图中节点</span>
            <small>点击查看</small>
          </div>
          <div className="node-list">
            {data.nodes.map((n) => {
              const st = activeIds.has(n.id) ? 'active' : D.findByNode(records, n.id, D.STATUS.PENDING) ? 'pending' : '';
              return (
                <button className={selected === n.id ? 'sel' : ''} onClick={() => setSelected(n.id)} key={n.id}>
                  <i className={n.type}>{icon(n.type)}</i>
                  <span>
                    <strong>
                      {n.name}
                      {st === 'active' && <em className="tag tag-active">停</em>}
                      {st === 'pending' && <em className="tag tag-pending">待</em>}
                    </strong>
                    <small>{n.ip}</small>
                  </span>
                  <b>›</b>
                </button>
              );
            })}
          </div>
        </aside>

        <section className="canvas-wrap">
          <div className="canvas" ref={board} onMouseMove={move} onMouseUp={() => setDrag(null)}>
            {edges.map(([a, b], i) => {
              const n1 = data.nodes.find((n) => n.id === a);
              const n2 = data.nodes.find((n) => n.id === b);
              if (!n1 || !n2) return null;
              const dx = n2.x - n1.x;
              const dy = n2.y - n1.y;
              const len = Math.hypot(dx, dy);
              const ang = (Math.atan2(dy, dx) * 180) / Math.PI;
              const cls =
                'edge' +
                (activeIds.has(a) || activeIds.has(b)
                  ? ' off'
                  : pending && (a === pending.nodeId || b === pending.nodeId)
                  ? ' pending'
                  : '');
              return (
                <div
                  className={cls}
                  key={i}
                  style={{ left: n1.x, top: n1.y, width: len, transform: `rotate(${ang}deg)` }}
                >
                  <span></span>
                </div>
              );
            })}
            {data.nodes.map((n) => {
              const isActive = activeIds.has(n.id);
              const isPending = !!D.findByNode(records, n.id, D.STATUS.PENDING);
              const onBackup = !isActive && impact?.backup.some((b) => b.id === n.id);
              const onLost = !isActive && impact?.stranded.some((s) => s.id === n.id);
              return (
                <button
                  className={
                    'node ' +
                    n.type +
                    (selected === n.id ? ' picked' : '') +
                    (isActive ? ' retired' : '') +
                    (isPending ? ' pending-node' : '') +
                    (onBackup ? ' via-backup' : '') +
                    (onLost ? ' stranded' : '')
                  }
                  style={{ left: n.x - 42, top: n.y - 31 }}
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    setSelected(n.id);
                    setDrag(n.id);
                  }}
                  onClick={() => setSelected(n.id)}
                  key={n.id}
                >
                  <i>{icon(n.type)}</i>
                  <strong>{n.name}</strong>
                  <small>{isActive ? '已停役 · 原线保留' : n.ip}</small>
                </button>
              );
            })}
            <div className="legend">
              <span><i className="router"></i>路由器</span>
              <span><i className="switch"></i>交换机</span>
              <span><i className="server"></i>服务器</span>
            </div>
          </div>
          <div className="canvas-footer">
            <span>
              拖动节点调整位置 · {edges.length} 条连接{activeCount > 0 && `（停役设备原连接保留显示）`}
            </span>
            <span>影响判断基于当前连线实时计算</span>
          </div>
        </section>

        <aside className="inspector">
          <div className="section-title">
            <span>属性</span>
            <small>{node?.type}</small>
          </div>
          {node ? (
            <>
              <label>
                设备名称
                <input value={node.name} onChange={(e) => updateNode('name', e.target.value)} />
              </label>
              <label>
                IP 地址
                <input value={node.ip} onChange={(e) => updateNode('ip', e.target.value)} />
              </label>
              <label>
                设备类型
                <select value={node.type} onChange={(e) => updateNode('type', e.target.value)}>
                  <option value="router">路由器</option>
                  <option value="switch">交换机</option>
                  <option value="server">服务器</option>
                  <option value="device">终端设备</option>
                </select>
              </label>
              <div className="inspector-actions">
                <button onClick={connect}>⌁ 添加连接</button>
                <button className="danger" onClick={remove}>删除设备</button>
              </div>

              {/* 停役影响台 */}
              <div className="impact">
                <div className="section-title">
                  <span>停役影响</span>
                  <small>{activeIds.size ? `已停役 ${activeIds.size} 台` : '现网全在线'}</small>
                </div>

                {active ? (
                  <div className="impact-card active-card">
                    <div className="card-head">
                      <strong>停役中 · {active.nodeName}</strong>
                      <span className="tag tag-active">停</span>
                    </div>
                    <p className="meta">执行时刻：{fmt(active.executedAt)}</p>
                    <p className="meta">计划回退：{fmt(active.restoreAt)}</p>
                    {active.reroute && <p className="meta reroute">替代线路：{active.reroute}</p>}
                    <p className="meta">原连接 {active.originalEdges.length} 条已保留，恢复时照原线接回</p>
                    <button className="restore-btn" onClick={() => doRestore()}>↩ 照原线恢复</button>
                  </div>
                ) : pending ? (
                  <div className="impact-card pending-card">
                    <div className="card-head">
                      <strong>停役待确认 · {pending.nodeName}</strong>
                      <span className="tag tag-pending">待</span>
                    </div>
                    <ImpactBody impact={pending.impact} snapshot />
                    <p className="meta">申请时刻：{fmt(pending.createdAt)}</p>
                    <label className="field">
                      替代线路{pending.impact.lostTerminals.length > 0 && <b>*</b>}
                      <textarea
                        rows={2}
                        placeholder="例：办公终端改接交换机 B 备线"
                        value={reroute}
                        onChange={(e) => setReroute(e.target.value)}
                      />
                    </label>
                    <label className="field">
                      回退时刻{pending.impact.lostTerminals.length > 0 && <b>*</b>}
                      <input type="datetime-local" value={restoreAt} onChange={(e) => setRestoreAt(e.target.value)} />
                    </label>
                    {pending.impact.lostTerminals.length > 0 && (
                      <p className="warn">有失联终端：两项填好后才能执行停役</p>
                    )}
                    <div className="card-actions">
                      <button className="execute-btn" onClick={executeStop}>■ 确认执行停役</button>
                      <button className="ghost" onClick={() => cancelPendingRec()}>撤销</button>
                    </div>
                  </div>
                ) : (
                  impact && (
                    <>
                      <ImpactBody impact={impact} />
                      <button className="retire-btn" onClick={requestStop}>
                        ■ 停止该设备（先待确认）
                      </button>
                    </>
                  )
                )}
              </div>

              <div className="connections">
                <div className="section-title">
                  <span>连接</span>
                  <small>{edges.filter((e) => e.includes(node.id)).length} 条</small>
                </div>
                {edges
                  .filter((e) => e.includes(node.id))
                  .map((e, i) => {
                    const other = data.nodes.find((n) => n.id === (e[0] === node.id ? e[1] : e[0]));
                    const down = activeIds.has(e[0]) || activeIds.has(e[1]);
                    return (
                      <div className="connection" key={i}>
                        <span className={'mini ' + other?.type}></span>
                        <strong>{other ? other.name : e[0] === node.id ? e[1] : e[0]}</strong>
                        <small>{down ? '停役保留' : '在线'}</small>
                      </div>
                    );
                  })}
              </div>
            </>
          ) : (
            <p>选择一个设备</p>
          )}
        </aside>
      </div>

      {showRecords && (
        <div className="modal-mask" onClick={() => setShowRecords(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <strong>停役记录</strong>
              <button className="ghost" onClick={() => setShowRecords(false)}>关闭</button>
            </div>
            {records.length === 0 && <p className="empty">还没有停役记录。选中设备后可在右侧发起停役。</p>}
            {groups.map(([status, title, count]) =>
              count > 0 ? (
                <div className="record-group" key={status}>
                  <div className="section-title">
                    <span>{title}</span>
                    <small>{count}</small>
                  </div>
                  {records
                    .filter((r) => r.status === status)
                    .map((r) => (
                      <div className={'record-card ' + status} key={r.id}>
                        <div className="card-head">
                          <strong>{r.nodeName}</strong>
                          <span className={'tag ' + (status === D.STATUS.ACTIVE ? 'tag-active' : status === D.STATUS.PENDING ? 'tag-pending' : 'tag-done')}>
                            {title}
                          </span>
                        </div>
                        <ImpactBody impact={r.impact} compact />
                        <p className="meta">
                          申请 {fmt(r.createdAt)}
                          {r.executedAt && ` · 执行 ${fmt(r.executedAt)}`}
                          {r.restoredAt && ` · 恢复 ${fmt(r.restoredAt)}`}
                        </p>
                        {r.restoreAt && <p className="meta">计划回退：{fmt(r.restoreAt)}</p>}
                        {r.reroute && <p className="meta reroute">替代线路：{r.reroute}</p>}
                        <p className="meta">原连接快照：{r.originalEdges.length} 条</p>
                        <div className="card-actions">
                          <button className="ghost" onClick={() => { setSelected(r.nodeId); setShowRecords(false); }}>
                            打开设备核对
                          </button>
                          {status === D.STATUS.ACTIVE && (
                            <button className="restore-btn" onClick={() => doRestore(r)}>↩ 照原线恢复</button>
                          )}
                          {status === D.STATUS.PENDING && (
                            <button className="ghost danger" onClick={() => cancelPendingRec(r)}>撤销记录</button>
                          )}
                        </div>
                      </div>
                    ))}
                </div>
              ) : null
            )}
          </div>
        </div>
      )}

      {notice && <div className="toast">{notice}</div>}
    </div>
  );
}

// 影响结果展示：实时分析与记录快照共用，保证重新打开还能核对
function ImpactBody({ impact, snapshot, compact }) {
  const lost = impact.lostTerminals || [];
  const strandedOthers = impact.strandedOthers || [];
  const backup = impact.backup || [];
  return (
    <div className={'impact-body' + (compact ? ' compact' : '')}>
      <div className={'impact-row ' + (lost.length ? 'bad' : 'ok')}>
        <span className="ri">●</span>
        <div>
          <strong>失联终端 {lost.length}</strong>
          {lost.length > 0 && (
            <small>{lost.map((t) => `${t.name}（${t.ip}）`).join('、') || '无'}</small>
          )}
          {!lost.length && <small>断开后所有终端仍可达</small>}
        </div>
      </div>
      <div className={'impact-row ' + (strandedOthers.length ? 'warn-row' : 'ok')}>
        <span className="ri">▲</span>
        <div>
          <strong>没有别的出口 {strandedOthers.length}</strong>
          {strandedOthers.length > 0 && (
            <small>{strandedOthers.map((t) => t.name).join('、')}（非终端节点）</small>
          )}
        </div>
      </div>
      <div className={'impact-row ' + (backup.length ? 'alt' : 'ok')}>
        <span className="ri">◇</span>
        <div>
          <strong>可走备用线路 {backup.length}</strong>
          {backup.map((b) => (
            <small className="path" key={b.id}>
              {b.name}：{(b.path || []).join(' → ')}
            </small>
          ))}
        </div>
      </div>
      {snapshot && <p className="snapshot-note">以下为停役申请时留存的核对结果</p>}
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
