// AI 运行模式标识：live（大模型生成）/ rule-fallback（规则降级，明确标注）
export default function ModeBadge({ mode, reason }) {
  if (!mode) return null
  const live = mode === 'live'
  return (
    <div className={'mode-badge ' + (live ? 'live' : 'fallback')}>
      <span className="mode-dot" />
      <span className="mode-label">{live ? 'AI 大模型生成（DeepSeek live）' : '规则引擎降级模式'}</span>
      {reason && <span className="mode-reason">· {reason}</span>}
      <span className="mode-note">输出均为辅助参考，医生终审</span>
    </div>
  )
}
