import { useEffect, useRef, useState } from 'react'

export default function Intake({ patient, msgs, chips, busy, onAsk, onRestart }) {
  const [input, setInput] = useState('')
  const endRef = useRef(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' })
  }, [msgs, busy])

  const choose = (text) => { onAsk(text) }
  const submit = (e) => { e.preventDefault(); if (!busy && input.trim()) { onAsk(input.trim()); setInput('') } }

  return (
    <section className="page">
      <div className="intake-head">
        <strong>{patient.name} · {patient.chief}</strong>
        {patient.vitals.map((v) => <span key={v.key} className="vital"><b>{v.value}</b><span>{v.key}</span></span>)}
      </div>

      <div className="chat">
        {msgs.map((m) => (
          <div key={m.id} className={'msg ' + m.role}>
            <span className="msg-avatar">{m.role === 'ai' ? '问' : '患'}</span>
            <div className="msg-bubble">{m.text}</div>
          </div>
        ))}
        {busy && <div className="msg ai"><span className="msg-avatar">问</span><div className="msg-bubble typing">…</div></div>}
        <div ref={endRef} />
      </div>

      <div className="chat-input">
        {chips.length > 0 && (
          <div className="chip-row">
            {chips.map((c) => (
              <button key={c} type="button" className="chip" onClick={() => choose(c)}>{c}</button>
            ))}
          </div>
        )}
        <form className="ask-form" onSubmit={submit}>
          <input className="ask-input" value={input} disabled={busy}
            onChange={(e) => setInput(e.target.value)}
            placeholder="补充描述症状、诱因、伴随情况…" />
          <button className="btn primary" type="submit" disabled={busy}>发送</button>
        </form>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}>
          <button className="btn ghost" type="button" onClick={onRestart} style={{ padding: '6px 12px', fontSize: 12 }}>重新问诊</button>
          <span className="page-sub" style={{ fontSize: 12 }}>AI 问诊助手 · 辅助参考</span>
        </div>
      </div>
    </section>
  )
}