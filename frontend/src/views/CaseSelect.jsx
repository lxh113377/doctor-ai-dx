export default function CaseSelect({ cases, onPick }) {
  return (
    <section className="page">
      <div className="page-head">
        <h2>开始一次辅助问诊</h2>
        <p className="page-sub">选择演示病例（脱敏模拟数据），引导完成 问诊 → 诊断 → 检查 → 报告 全流程</p>
      </div>
      <div className="case-grid">
        {cases.map((c) => (
          <div key={c.id} className="case-card" role="button" tabIndex={0}
            onClick={() => onPick(c)} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onPick(c)}>
            <span className="case-scene">{c.scene}</span>
            <div className="case-name">{c.name}</div>
            <div className="case-meta"><span>{c.age} 岁 · {c.gender}</span><span>{c.occupation}</span></div>
            <p className="case-chief">主诉：{c.chief}</p>
          </div>
        ))}
      </div>
      <div className="safety-box">
        <b style={{ flex: 'none' }}>安全边界</b>
        <p>本演示仅使用脱敏模拟病例；所有诊断建议均为 AI 辅助参考，须由接诊医生最终审核决定。</p>
      </div>
    </section>
  )
}