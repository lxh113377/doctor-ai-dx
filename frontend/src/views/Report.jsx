import ModeBadge from './ModeBadge.jsx'
const SOAP_KEYS = [
  ['subjective', 'S 主观资料（主诉与现病史）'],
  ['objective', 'O 客观检查'],
  ['assessment', 'A 评估（疑似诊断）'],
  ['plan', 'P 处置计划'],
]

export default function Report({ report, patient }) {
  if (!report) return <section className="page"><div className="card loading">正在生成 SOAP 病历报告…</div></section>

  const now = new Date()
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`

  return (
    <section className="page">
      <div className="report-toolbar">
        <div>
          <h2>电子病历报告</h2>
          <p className="page-sub">结构化 SOAP 摘要，可打印归档</p>
        </div>
        <button className="btn primary" type="button" onClick={() => window.print()}>打印 / 导出 PDF</button>
      </div>

      <ModeBadge mode={report.mode} reason={report.fallback_reason} />

      <div className="report-sheet">
        <div className="report-head">
          <h3>医 · 基层AI辅助诊断系统 — 电子病历报告</h3>
          <span>生成时间 {dateStr} ｜ {patient?.name} · {patient?.age}岁 {patient?.gender}</span>
        </div>
        {SOAP_KEYS.map(([k, label]) => (
          <div key={k} className="soap-block"><h4>{label}</h4><p>{report.soap[k]}</p></div>
        ))}
        <div className="report-dx"><b>诊断结论：</b>{report.conclusion}</div>
        <div className="report-disclaimer">AI 辅助参考 · 医生终审 ｜ {report.disclaimer}</div>
      </div>
    </section>
  )
}