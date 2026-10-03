import { useCallback, useEffect, useState } from 'react'
import { adminStats, adminConversations, adminConversationDetail, adminHandoffs } from '../api.js'

/**
 * 管理后台。三块只读面：对话记录 / 转人工队列 / 满意度统计。
 * 四条设计纪律（都是被坑出来的，不是审美偏好）：
 *  1. **每个数字必须带分母**：没分母的指标等于谣言——评审一问「这个 87% 是除以什么」就塌。
 *     后端 metrics.* 已把 denominator / denominator_note / recompute_sql 一起送来，这里只负责显示。
 *  2. **未评价不按 0 分显示**：满意度显示"—"而不是 0。「没打分」和「打了 0 分」是两件事，
 *     混起来会让平均分被系统性拉低，而拉低的方向恰好是没人会去查的方向。
 *  3. **拿不到数据时显示原因而不是空白**：D1 未绑定时后端返回 available:false + reason。
 *     空白会被读成「没有数据」，那是假象。
 *  4. **统计用条形不用饼图**：条形能直接比长度，饼图要看角度。
 */
const PANELS = [
  { key: 'conversations', label: '对话记录' },
  { key: 'handoffs', label: '转人工队列' },
  { key: 'stats', label: '满意度统计' },
]

/** 六个口径的展示元数据。key 必须与后端 metrics 的字段名逐字对应（对不上会显示 undefined）。 */
const METRIC_ORDER = [
  { key: 'sessions_total', label: '会话总数', fmt: (m) => String(m.value) },
  { key: 'avg_satisfaction', label: '平均满意度', fmt: (m) => (m.denominator > 0 ? `${m.value} / 5` : '—') },
  { key: 'first_contact_resolution', label: '一次解决率', fmt: (m) => (m.denominator > 0 ? `${Math.round(m.value * 100)}%` : '—') },
  { key: 'handoff_rate', label: '转人工率', fmt: (m) => (m.denominator > 0 ? `${Math.round(m.value * 100)}%` : '—') },
  { key: 'avg_first_response_ms', label: '平均首响', fmt: (m) => (m.denominator > 0 ? `${m.value} ms` : '—') },
  { key: 'avg_turns', label: '平均轮次', fmt: (m) => String(m.value) },
]

export default function AdminView() {
  const [token, setToken] = useState('')
  const [authed, setAuthed] = useState(false)
  const [panel, setPanel] = useState('stats')
  const [data, setData] = useState(null)
  const [err, setErr] = useState(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async (which, t) => {
    setLoading(true); setErr(null)
    try {
      const d = which === 'stats' ? await adminStats(t)
        : which === 'handoffs' ? await adminHandoffs(t)
        : await adminConversations(t)
      setData(d)
      setAuthed(true)
    } catch (e) {
      setErr(e.message || '加载失败')
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!authed) return undefined
    // 放进宏任务里再取：load() 会同步 setLoading，同步调用会被 react-hooks 判为
    // 「effect 内同步 setState → 级联渲染」。这不是绕过规则，是把"进入面板"当成一次真实异步加载。
    const id = setTimeout(() => load(panel, token), 0)
    return () => clearTimeout(id)
  }, [authed, panel, token, load])

  return (
    <div className="admin-wrap wide">
      <aside className="admin-nav">
        <div className="admin-nav-title">管理后台</div>
        {PANELS.map((p) => (
          <button
            key={p.key}
            type="button"
            className={`admin-nav-item ${panel === p.key ? 'active' : ''}`}
            onClick={() => setPanel(p.key)}
          >
            <span className="dot" /> {p.label}
          </button>
        ))}
        <div className="admin-nav-foot">只读视图 · 数据已脱敏</div>
      </aside>

      <section className="admin-main">
        {!authed && (
          <div className="card admin-login">
            <h3>需要管理令牌</h3>
            <p className="muted">令牌由服务器端 <code>ADMIN_TOKEN</code> 提供；未配置时后台一律返回 503。</p>
            <input
              className="admin-token"
              type="password"
              value={token}
              placeholder="粘贴管理令牌"
              onChange={(e) => setToken(e.target.value)}
            />
            <button type="button" className="btn primary" onClick={() => load(panel, token)} disabled={!token}>
              进入
            </button>
          </div>
        )}

        {authed && loading && <div className="card loading">加载中…</div>}
        {err && <div className="banner danger banner-page">{err}</div>}

        {authed && !loading && data && data.available === false && (
          <div className="banner warning banner-page">数据不可用：{data.reason}</div>
        )}

        {authed && !loading && data && data.available !== false && (
          <>
            {panel === 'stats' && <Dashboard data={data} token={token} />}
            {panel === 'conversations' && <List items={data.items || []} empty="暂无会话记录" cols={['id', 'turn_count', 'handed_off', 'satisfaction', 'updated_at']} />}
            {panel === 'handoffs' && <List items={data.items || []} empty="转人工队列为空" cols={['conversation_id', 'reason_code', 'status', 'created_at']} />}
          </>
        )}
      </section>
    </div>
  )
}

/**
 * 三栏看板：左＝会话列表，中＝对话回放，右＝统计面板。
 * 分栏而非堆叠的原因：回放与统计必须**并排**才能看出「这条低分对应哪个 provider 偏慢」；
 * 堆叠后要来回滚，运营就只看得见数字、看不见因果。
 */
function Dashboard({ data, token }) {
  const m = data.metrics || {}
  const [list, setList] = useState(null)
  const [selected, setSelected] = useState(null)
  const [detail, setDetail] = useState(null)
  const [detailErr, setDetailErr] = useState('')

  useEffect(() => {
    let alive = true
    adminConversations(token)
      .then((d) => { if (alive) setList(d.items || []) })
      .catch((e) => { if (alive) setDetailErr(e.message || '会话列表加载失败') })
    return () => { alive = false }
  }, [token])

  const open = useCallback((id) => {
    setSelected(id); setDetail(null); setDetailErr('')
  }, [])

  // 低分清单直达：≤2 分的会话自动进回放，运营不用自己在列表里找。
  //
  // 为什么**不在 effect 里 setState**：`react-hooks/set-state-in-effect` 判它为级联渲染
  // （同步 setState 触发额外一遍渲染）。旧写法正是那个形状。此处改为
  // **渲染期派生默认选中 + 副作用只留网络读取**，两条职责分开。
  // 行为差异（唯一一处，如实登记）：旧实现在自动选中一次后把 id 写进 state，
  // 因此 metrics 再刷新也不会跟着漂；新实现未锁存，若用户**从未手动选过**，
  // 低分清单变化时默认选中会跟随新的首条。用户一旦点过任何一条（selected 非空）即固定。
  const firstLow = (m.low_score_sessions || [])[0]
  const activeId = selected || (firstLow ? firstLow.conversation_id : null)

  useEffect(() => {
    if (!activeId) return undefined
    let alive = true
    adminConversationDetail(activeId, token)
      .then((d) => { if (alive) setDetail(d.available === false ? { available: false, reason: d.reason } : d) })
      .catch((e) => { if (alive) setDetailErr(e.message || '回放加载失败') })
    return () => { alive = false }
  }, [activeId, token])

  return (
    <div className="dash">
      <div className="dash-col dash-list card">
        <h3>会话列表</h3>
        <p className="muted">按最近更新排序；点任一条看逐条回放。未评价不显示为 0 分。</p>
        {list === null && <p className="muted">加载中…</p>}
        {list !== null && list.length === 0 && <p className="muted">暂无会话记录</p>}
        {(list || []).map((it) => (
          <button
            type="button"
            key={it.id}
            className={`dash-row ${activeId === it.id ? 'active' : ''}`}
            onClick={() => open(it.id)}
          >
            <span className="dash-row-id">{it.id}</span>
            <span className="dash-row-meta">
              {it.turn_count ?? 0} 轮
              {it.handed_off ? ' · 已转人工' : ''}
              {it.satisfaction == null ? ' · 未评价' : ` · ${it.satisfaction} 星`}
            </span>
          </button>
        ))}
      </div>

      <div className="dash-col dash-replay card">
        <h3>对话回放</h3>
        {!activeId && <p className="muted">从左侧选一条会话，或点右下角低分清单里的任意一条。</p>}
        {detailErr && <div className="banner warning banner-page">{detailErr}</div>}
        {detail && detail.available === false && <div className="banner warning banner-page">回放不可用：{detail.reason}</div>}
        {detail && detail.found === false && <p className="muted">该会话不存在或已被 TTL 清理。</p>}
        {detail && detail.found && (
          <>
            <div className="replay-head">
              <code>{detail.conversation?.id}</code>
              <span className="muted">
                {detail.conversation?.turn_count ?? 0} 轮 · 满意度{' '}
                {detail.conversation?.satisfaction == null ? '未评价' : `${detail.conversation.satisfaction} 星`}
              </span>
            </div>
            {(detail.messages || []).map((msg, i) => (
              <div className={`replay-msg ${msg.role}`} key={i}>
                <div className="replay-role">{msg.role === 'user' ? '医生' : '系统回复'}</div>
                <div className="replay-text">{msg.content}</div>
                <Attribution msg={msg} />
              </div>
            ))}
            {(detail.handoffs || []).length > 0 && (
              <div className="replay-handoff">
                转人工工单：{detail.handoffs.map((h) => `${h.reason_code}(${h.status})`).join('、')}
              </div>
            )}
          </>
        )}
      </div>

      <div className="dash-col dash-stats">
        <div className="card">
          <h3>六个口径（含分母）</h3>
          <div className="metric-grid">
            {METRIC_ORDER.map((x) => {
              const v = m[x.key]
              if (!v) return null
              return (
                <div className="card metric" key={x.key} title={`回算 SQL：${v.recompute_sql}`}>
                  <div className="metric-k">{x.label}</div>
                  <div className="metric-v">{x.fmt(v)}</div>
                  <div className="metric-d">分母 {v.denominator} · {v.denominator_note}</div>
                </div>
              )
            })}
          </div>
          {data.ended_proxy_note && <p className="muted metric-note">口径声明：{data.ended_proxy_note}</p>}
        </div>

        <Bars title="意图分布" rows={(m.intent_distribution || []).map((r) => ({ k: r.intent, n: r.count }))} empty="暂无数据" />
        <Bars title="回答来源（provider）分布" rows={(m.provider_distribution || []).map((r) => ({ k: r.provider, n: r.count, note: `均 ${r.avg_latency_ms}ms` }))} empty="暂无数据" />
        <Bars title="满意度分布" rows={(m.score_distribution || []).map((r) => ({ k: `${r.score} 星`, n: r.n }))} empty="暂无评分" warn={(r) => r.k.startsWith('1') || r.k.startsWith('2')} />

        <div className="card">
          <h3>低分清单（≤2 星，直达回放）</h3>
          {(m.low_score_sessions || []).length === 0 && <p className="muted">暂无低分会话</p>}
          {(m.low_score_sessions || []).map((r) => (
            <button type="button" key={r.conversation_id} className="dash-row" onClick={() => open(r.conversation_id)}>
              <span className="dash-row-id">{r.conversation_id}</span>
              <span className="dash-row-meta">{r.score} 星 · {String(r.created_at || '').slice(0, 19).replace('T', ' ')}</span>
            </button>
          ))}
        </div>

        <div className="card">
          <h3>Top 未解决（原因 × 意图）</h3>
          <p className="muted">这张表是知识库维护的输入：把高频未解决项补进知识库，或补进意图关键词表。</p>
          {(data.top_unresolved || []).length === 0 && <p className="muted">暂无数据</p>}
          {(data.top_unresolved || []).map((r, i) => (
            <div className="unresolved-row" key={`${r.reason_code}-${r.intent}-${i}`}>
              <code>{r.reason_code}</code> × <code>{r.intent || '—'}</code> <b>{r.n}</b>
            </div>
          ))}
        </div>

        <p className="muted dash-foot">
          统计口径与消息表逐条对账：对账命令 <code>node frontend/tests/stats_reconcile_guard.mjs</code>，
          同一批 SQL 在内存 SQLite 上与逐行扫描两算，不一致即红。
        </p>
      </div>
    </div>
  )
}

/** 消息级归因徽标：谁给的 / 依据什么 / 花了多久。缺字段时显式说「未计量」而不是 0。 */
function Attribution({ msg }) {
  if (msg.role !== 'assistant') return null
  let hits = []
  try { hits = JSON.parse(msg.kb_hits || '[]') } catch { hits = [] }
  return (
    <div className="attr">
      <span className="attr-chip">来源 {msg.provider || '—'}</span>
      <span className="attr-chip">{msg.latency_ms > 0 ? `${msg.latency_ms} ms` : '延迟未计量'}</span>
      {msg.confidence > 0 && <span className="attr-chip">置信度 {msg.confidence}</span>}
      {msg.red_flag ? <span className="attr-chip danger">红旗命中</span> : null}
      {hits.map((h) => (
        <span className="attr-chip ref" key={h} title="知识库命中条目">来源：{h}</span>
      ))}
    </div>
  )
}

function Bars({ title, rows, empty, warn }) {
  const max = Math.max(1, ...rows.map((r) => r.n))
  return (
    <div className="card">
      <h3>{title}</h3>
      {rows.length === 0 && <p className="muted">{empty}</p>}
      {rows.map((r) => (
        <div className="bar-row" key={r.k}>
          <span className="bar-label" title={r.note || r.k}>{r.k}</span>
          <span className="bar-track">
            <span className={`bar-fill ${warn && warn(r) ? 'warn' : ''}`} style={{ width: `${(r.n / max) * 100}%` }} />
          </span>
          <span className="bar-n">{r.n}</span>
        </div>
      ))}
    </div>
  )
}

function List({ items, cols, empty }) {
  if (!items.length) return <div className="card muted">{empty}</div>
  return (
    <div className="card table-card">
      <table className="admin-table">
        <thead>
          <tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr>
        </thead>
        <tbody>
          {items.map((it, i) => (
            <tr key={it.id || i}>
              {cols.map((c) => <td key={c}>{String(it[c] ?? '—')}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
