import ModeBadge from './ModeBadge.jsx'
const CLASS = { high: 'high', mid: 'mid', low: 'low' }
const SvgRef = () => (
  <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4}
    strokeLinecap="round" style={{ marginRight: 4, verticalAlign: '-1px' }}>
    <path d="M3 7V5a2 2 0 0 1 2-2h2" /><path d="M17 3h2a2 2 0 0 1 2 2v2" />
    <path d="M21 17v2a2 2 0 0 1-2 2h-2" /><path d="M7 21H5a2 2 0 0 1-2-2v-2" /><path d="M7 12h10" />
  </svg>
)

export default function Dx({ dx, patient, onRestart, onNext }) {
  if (!dx) return <section className="page"><div className="card loading" role="status">正在生成鉴别诊断与依据…</div></section>

  return (
    <section className="page">
      <div className="page-head-with-action">
        <div>
          <h2>辅助诊断</h2>
          <p className="page-sub">基于问诊信息的鉴别诊断与依据，附来源引用 · 患者：{patient?.name}，主诉：{patient?.chief}</p>
        </div>
        <div className="head-actions">
          <button className="btn ghost" type="button" onClick={onRestart}>重新问诊</button>
          <button className="btn primary" type="button" onClick={onNext}>下一步：检查建议 ›</button>
        </div>
      </div>

      <ModeBadge mode={dx.mode} reason={dx.fallback_reason} />

      {dx.flags.length > 0 && (
        <div className="banner danger">
          <div>
            <h4>危险信号 · 规则引擎独立检出（不可被模型覆盖）</h4>
            <ul>{dx.flags.map((f, i) => <li key={i}>{f}</li>)}</ul>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-title">疑似诊断（按优先级排序）</div>
        {dx.primary.map((p, i) => (
          <div key={p.name} className={'dx-row' + (p.strength === 'high' && dx.flags.length ? ' dx-danger' : '')}>
            <div className="dx-primary">
              <h3>{i + 1}. {p.name}</h3>
              <span className={'conf-badge ' + CLASS[p.strength]}>{p.prob}</span>
            </div>
            <ul className="reason-list">{p.reasons.map((r) => <li key={r} className="reason-tag">{r}</li>)}</ul>
            <div className="ref-list">{p.refs.map((r) => <span key={r} className="ref-tag"><SvgRef /> {r}</span>)}</div>
          </div>
        ))}
      </div>

      <div className="card">
        <div className="card-title">鉴别诊断</div>
        <table className="diff-table">
          <thead><tr><th style={{ width: '30%' }}>需排除</th><th>鉴别要点</th></tr></thead>
          <tbody>{dx.differential.map((d) => (
            <tr key={d.name}><td><b>{d.name}</b></td><td>{d.note}</td></tr>
          ))}</tbody>
        </table>
      </div>

      <div className="card">
        <div className="card-title">可能关心的追问</div>
        {dx.faq.map((f) => (
          <div key={`${f.q}${f.a}`} className="faq-item">
            <div className="faq-q"><span className="q-mark">Q</span>{f.q}</div>
            <div className="faq-a">{f.a}</div>
          </div>
        ))}
      </div>
    </section>
  )
}