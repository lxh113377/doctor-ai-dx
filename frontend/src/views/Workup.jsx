import ModeBadge from './ModeBadge.jsx'
const GROUPS = [
  { key: 'essential', label: '必查（优先）', cls: 'essential', tag: '高优先' },
  { key: 'suggested', label: '建议检查', cls: 'suggested', tag: '中优先' },
  { key: 'optional', label: '可选补充', cls: 'optional', tag: '低优先' },
]

export default function Workup({ workup, onNext }) {
  if (!workup) return <section className="page"><div className="card loading" role="status">正在整理检查方案…</div></section>

  return (
    <section className="page">
      <div className="page-head-with-action">
        <div>
          <h2>检查与检验建议</h2>
          <p className="page-sub">按优先级分组，说明临床意义与提示</p>
        </div>
        <button className="btn primary" type="button" onClick={onNext}>下一步：病历报告 ›</button>
      </div>
      <ModeBadge mode={workup.mode} reason={workup.fallback_reason} />
      {GROUPS.map((g) => (
        <div key={g.key} className="workup-group">
          <h3>{g.label} <span className={'tag-lv ' + g.cls}>{g.tag}</span></h3>
          {workup[g.key].map((it) => (
            <div key={it.item} className={'wu-item ' + g.cls}><b>{it.item}</b><p>{it.why}</p></div>
          ))}
        </div>
      ))}
      <div className="banner info"><div><h4>检查解读提醒</h4><p>检查项目与顺序供接诊医生决策参考；异常结果请结合完整临床资料综合判读。</p></div></div>
    </section>
  )
}