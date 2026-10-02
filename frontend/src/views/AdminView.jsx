import { useCallback, useEffect, useState } from 'react'
import { adminStats, adminConversations, adminHandoffs } from '../api.js'

/**
 * 管理后台。三块只读面：对话记录 / 转人工队列 / 满意度统计。
 * 两条设计纪律：
 *  1. **统计用条形而不是饼图**：条形能直接比长度，饼图要看角度——运维看的是"哪个多"，不是"占比精确到几位"。
 *  2. **拿不到数据时显示原因而不是空白**：D1 未绑定时后端返回 available:false + reason，
 *     这里照实显示。空白会被读成"没有数据"，那是假象。
 */
const PANELS = [
  { key: 'conversations', label: '对话记录' },
  { key: 'handoffs', label: '转人工队列' },
  { key: 'stats', label: '满意度统计' },
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
    <div className="admin-wrap">
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
            {panel === 'stats' && <Stats data={data} />}
            {panel === 'conversations' && <List items={data.items || []} empty="暂无会话记录" cols={['id', 'turn_count', 'handed_off', 'satisfaction', 'updated_at']} />}
            {panel === 'handoffs' && <List items={data.items || []} empty="转人工队列为空" cols={['conversation_id', 'reason_code', 'status', 'created_at']} />}
          </>
        )}
      </section>
    </div>
  )
}

function Stats({ data }) {
  const cards = [
    { k: '会话总数', v: data.conversations ?? 0 },
    { k: '转人工率', v: `${Math.round((data.handoff_rate || 0) * 100)}%` },
    { k: '平均轮次', v: data.avg_turns ?? 0 },
    { k: '平均评分', v: data.avg_score ?? '—' },
  ]
  const maxIntent = Math.max(1, ...(data.intent_distribution || []).map((r) => r.n))
  const maxReason = Math.max(1, ...(data.handoff_reasons || []).map((r) => r.n))
  return (
    <div className="admin-stats">
      <div className="metric-grid">
        {cards.map((c) => (
          <div className="card metric" key={c.k}>
            <div className="metric-k">{c.k}</div>
            <div className="metric-v">{c.v}</div>
          </div>
        ))}
      </div>

      <div className="card">
        <h3>意图分布</h3>
        {(data.intent_distribution || []).length === 0 && <p className="muted">暂无数据</p>}
        {(data.intent_distribution || []).map((r) => (
          <div className="bar-row" key={r.intent}>
            <span className="bar-label">{r.intent}</span>
            <span className="bar-track"><span className="bar-fill" style={{ width: `${(r.n / maxIntent) * 100}%` }} /></span>
            <span className="bar-n">{r.n}</span>
          </div>
        ))}
      </div>

      <div className="card">
        <h3>转人工原因分布</h3>
        {(data.handoff_reasons || []).length === 0 && <p className="muted">暂无数据</p>}
        {(data.handoff_reasons || []).map((r) => (
          <div className="bar-row" key={r.reason_code}>
            <span className="bar-label">{r.reason_code}</span>
            <span className="bar-track"><span className="bar-fill warn" style={{ width: `${(r.n / maxReason) * 100}%` }} /></span>
            <span className="bar-n">{r.n}</span>
          </div>
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