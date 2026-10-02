import { useCallback, useEffect, useRef, useState } from 'react'
import { askChat, rateChat, SERVICE_CHIPS } from '../api.js'

/**
 * 对话页。设计取向与既有辅诊页一致：白底、teal 主色、卡片轻投影、10-14px 圆角。
 * 三处**不能省**的呈现（它们是产品可信度的载体，不是装饰）：
 *   1. 顶部常驻「AI 辅助参考 · 医生终审」（红线 2）
 *   2. 红旗命中时整块换成高对比警示卡，而不是普通气泡
 *   3. 转人工时给出原因与工单号，让用户知道"没被丢出去"
 */
export default function ChatView() {
  const [messages, setMessages] = useState([])
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [mode, setMode] = useState(null)
  const [persisted, setPersisted] = useState(null)
  const [score, setScore] = useState(0)
  // 会话 id 同时存 state 与 ref：渲染要用 state（读 ref 属于渲染期副作用），
  // 发送回调要用 ref（避免把 cid 塞进 send 的依赖里导致历史重建）。
  const [cid, setCid] = useState(null)
  const cidRef = useRef(null)
  const endRef = useRef(null)

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])

  const send = useCallback(async (raw) => {
    const content = String(raw || '').trim()
    if (!content || busy) return
    setBusy(true); setError(null); setText('')
    const history = messages.map((m) => ({ role: m.role, content: m.content }))
    setMessages((prev) => [...prev, { role: 'user', content }])
    try {
      const d = await askChat({ text: content, history, conversation_id: cidRef.current })
      cidRef.current = d.conversation_id || cidRef.current
      setCid(cidRef.current)
      setMode(d.mode); setPersisted(d.persisted)
      setMessages((prev) => [...prev, {
        role: 'assistant',
        content: d.answer?.text || '',
        citations: d.answer?.citations || [],
        redFlag: d.red_flag || null,
        handoff: d.handoff || null,
      }])
    } catch (e) {
      setError('对话服务暂时不可用，请稍后重试或直接前往线下就诊')
      console.error('[ChatView] 发送失败', e)
    } finally {
      setBusy(false)
    }
  }, [messages, busy])

  const submitRating = async (n) => {
    setScore(n)
    if (!cidRef.current) return
    try { await rateChat(cidRef.current, { score: n }) }
    catch (e) { console.error('[ChatView] 评分提交失败', e) }
  }

  return (
    <div className="chat-wrap">
      <div className="chat-topbar">
        <div className="chat-title">对话式辅诊入口</div>
        <div className="chat-compliance">AI 辅助参考 · 医生终审</div>
        {mode && (
          <div className={`mode-badge ${mode === 'deterministic' ? 'mode-det' : 'mode-live'}`}>
            {mode === 'deterministic' ? '确定性判定链' : mode}
          </div>
        )}
      </div>

      {persisted === false && (
        <div className="banner warning banner-page">
          当前部署未绑定数据库，本轮对话**不会落库**（后台与历史不可查）。这是配置状态，不是故障。
        </div>
      )}

      <div className="chat-stream">
        {messages.length === 0 && (
          <div className="card chat-hint">
            <p>可以这样问：</p>
            <ul>
              <li>描述症状与持续时间（例如「孩子高热惊厥怎么办」）</li>
              <li>服务类：挂号退费与退号、检查报告查询、系统使用故障</li>
              <li>任何疑似急症的描述都会**优先按急诊提示处理**，不会进入客服流程</li>
            </ul>
          </div>
        )}
        {messages.map((m, i) => (
          <Message key={i} m={m} />
        ))}
        {busy && <div className="chat-typing card">正在判定…</div>}
        <div ref={endRef} />
      </div>

      <div className="chat-chips">
        {SERVICE_CHIPS.map((c) => (
          <button key={c.label} type="button" className="patient-chip" onClick={() => send(c.q)} disabled={busy}>
            {c.label}
          </button>
        ))}
        <button type="button" className="patient-chip" onClick={() => send('我要转人工客服')} disabled={busy}>转人工</button>
      </div>

      {error && <div className="banner danger banner-page">{error}</div>}

      <div className="chat-inputrow">
        <textarea
          className="chat-input"
          value={text}
          placeholder="描述你的情况或遇到的问题…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(text) } }}
          rows={2}
        />
        <button type="button" className="btn primary" onClick={() => send(text)} disabled={busy || !text.trim()}>
          {busy ? '发送中…' : '发送'}
        </button>
      </div>

      {score === 0 && cid && (
        <div className="chat-rating">
          <span>本轮是否解决了你的问题？</span>
          {[1, 2, 3, 4, 5].map((n) => (
            <button key={n} type="button" className="star" onClick={() => submitRating(n)} aria-label={`${n} 星`}>★</button>
          ))}
        </div>
      )}
      {score > 0 && <div className="chat-rating-done">已记录评分 {score} 星，谢谢</div>}
    </div>
  )
}

function Message({ m }) {
  if (m.role === 'user') {
    return <div className="msg msg-user"><div className="bubble bubble-user">{m.content}</div></div>
  }
  // 红旗整块换成警示卡：这是红线 1 的**视觉**落点，不是一般高亮。
  if (m.redFlag) {
    return (
      <div className="msg msg-assistant">
        <div className="redflag-card">
          <div className="redflag-head">严重危险信号：{m.redFlag.name}</div>
          <div className="redflag-advice">{m.redFlag.advice}</div>
          <pre className="redflag-text">{m.content}</pre>
        </div>
      </div>
    )
  }
  return (
    <div className="msg msg-assistant">
      <div className="bubble bubble-assistant">
        <pre className="bubble-text">{m.content}</pre>
        {!!(m.citations || []).length && (
          <div className="cites">
            引用来源：
            {m.citations.map((c) => (
              <span key={c.evidence_id} className="cite">
                {c.title}（{c.source}{c.year ? ` ${c.year}` : ''}）
              </span>
            ))}
          </div>
        )}
        {m.handoff && (
          <div className="handoff-bar">
            <strong>已转人工客服</strong>：{m.handoff.reason_text}｜工单号 {m.handoff.ticket_id}
          </div>
        )}
      </div>
    </div>
  )
}