// 红线组件测试：这三条产品红线不能只靠人眼验收，改样式/重构时必须仍然成立。
// ① 红旗独立于模型且明示「不可被模型覆盖」；② 全界面「辅助参考 · 医生终审」；③ 渲染异常只出可理解文案。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import Dx from './views/Dx.jsx'
import ModeBadge from './views/ModeBadge.jsx'
import CaseSelect from './views/CaseSelect.jsx'
import ErrorBoundary from './ErrorBoundary.jsx'

beforeEach(() => cleanup())

const dxWithFlags = {
  mode: 'live',
  fallback_reason: null,
  flags: ['严重危险信号：ACS 高危胸痛，立即转诊'],
  flag_details: [
    { name: '急性冠脉综合征', severity: '高', advice: '10 分钟内完成心电图并转诊胸痛中心' },
    { name: '血压异常', severity: '中', advice: '复测双上肢血压' },
  ],
  primary: [{ name: '急性冠脉综合征', strength: 'high', prob: '高', reasons: ['压榨样胸痛'], refs: ['kb-002'] }],
  differential: [{ name: '主动脉夹层', note: '撕裂样痛、双上肢血压差' }],
  faq: [{ q: '还需要做什么检查？', a: '心肌酶与心电图动态复查' }],
}

describe('红旗规则层展示', () => {
  it('命中红旗时横幅明示「不可被模型覆盖」并逐条渲染严重度', () => {
    render(<Dx dx={dxWithFlags} patient={{ name: '张建国', chief: '胸痛' }} onRestart={() => {}} onNext={() => {}} />)
    const banner = screen.getByText(/危险信号 · 规则引擎独立检出（不可被模型覆盖）/).closest(".banner.danger")
    expect(banner.textContent).toContain('不可被模型覆盖')
    expect(banner.textContent).toContain('急性冠脉综合征')
    expect(banner.textContent).toContain('10 分钟内完成心电图并转诊胸痛中心')
    expect(banner.querySelectorAll('.flag-sev').length).toBe(2)
    expect(banner.querySelector('.sev-high')).toBeTruthy()
    expect(banner.querySelector('.sev-mid')).toBeTruthy()
  })

  it('无红旗时不渲染危险横幅（避免虚假告警）', () => {
    render(<Dx dx={{ ...dxWithFlags, flags: [], flag_details: [] }} patient={{}} onRestart={() => {}} onNext={() => {}} />)
    expect(screen.queryByText(/规则引擎独立检出/)).toBeNull()
  })

  it('缺 flag_details 时回落渲染 flags 文本（向后兼容旧响应）', () => {
    render(<Dx dx={{ ...dxWithFlags, flag_details: undefined }} patient={{}} onRestart={() => {}} onNext={() => {}} />)
    expect(screen.getByText('严重危险信号：ACS 高危胸痛，立即转诊')).toBeTruthy()
  })
})

describe('辅助参考 · 医生终审 文案', () => {
  it('live 与降级两种模式都持续携带终审声明', () => {
    const { unmount } = render(<ModeBadge mode="live" />)
    expect(screen.getByText('AI 大模型生成（DeepSeek live）')).toBeTruthy()
    expect(screen.getByText('输出均为辅助参考，医生终审')).toBeTruthy()
    unmount()

    render(<ModeBadge mode="rule-fallback" reason="模型超时" />)
    expect(screen.getByText('规则引擎降级模式')).toBeTruthy()
    expect(screen.getByText(/模型超时/)).toBeTruthy()
    expect(screen.getByText('输出均为辅助参考，医生终审')).toBeTruthy()
  })

  it('病例首页声明仅用脱敏模拟病例', () => {
    render(<CaseSelect cases={[{ id: 'c1', name: '张建国', age: 58, chief: '胸痛', scene: '急症', summary: 's', intro: 'i' }]} onPick={() => {}} />)
    expect(screen.getByText(/脱敏模拟病例/).textContent).toContain('辅助参考')
  })
})

const Boom = () => {
  const [go, setGo] = useState(false)
  if (go) throw new Error('Cannot read properties of undefined at run (C:\\Users\\x\\app\\engine.js:1:1)')
  return <button type="button" onClick={() => setGo(true)}>触发渲染异常</button>
}

describe('渲染兜底', () => {
  beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}) })

  it('子视图抛错不白屏，只出医生可理解文案且不外泄堆栈/路径', async () => {
    render(<ErrorBoundary><Boom /></ErrorBoundary>)
    await userEvent.click(screen.getByText('触发渲染异常'))
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('页面内容渲染出现问题')
    expect(alert.textContent).not.toMatch(/Traceback|Cannot read properties|engine\.js|C:\\|at run/)
    expect(screen.getByText('刷新页面')).toBeTruthy()
  })

  it('未出错时原样渲染子节点', () => {
    render(<ErrorBoundary><p>正常内容</p></ErrorBoundary>)
    expect(screen.getByText('正常内容')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

// 第三态（#52 第二十八轮）：弃权不许吞掉红旗，也不许顺便编一个鉴别诊断。
// 这条的形状抄自 peer 实测：`kheireddinedev00/Medico` 有具名测试
// test_out_of_scope_still_honours_red_flags（弃权时红旗仍抬优先级），`dmustapha/triage-0` 用三条决定性体征禁止弃权。
const dxAbstainWithFlags = {
  mode: 'rule-fallback', fallback_reason: '未配置 LLM Key，使用规则引擎',
  abstain: true, scope_status: 'insufficient-information', top_evidence_score: 31.109,
  abstain_reason: '现有问诊信息不足以支撑鉴别，请补充问诊后重试；本系统仅作用药与鉴别参考，最终判断由执业医生作出',
  flags: ['严重危险信号：ACS 高危胸痛，立即转诊'],
  flag_details: [{ name: '急性冠脉综合征', severity: '高', advice: '10 分钟内完成心电图并转诊胸痛中心' }],
  primary: [{ name: '信息不足，建议补充问诊', strength: 'low', prob: '信息不足', reasons: [], refs: [] }],
  differential: [], faq: [], evidence: [{ id: 'kb-001', title: '急性胸痛分诊共识', source: '中国胸痛中心联盟', year: '2025' }],
}
const dxNoAbstain = { ...dxAbstainWithFlags, abstain: false, scope_status: 'in-scope', differential: [{ name: '主动脉夹层', note: '撕裂样痛' }] }

describe('弃权第三态展示', () => {
  it('弃权时弃权卡在场，且红旗横幅照常渲染（红线：弃权不得吞掉危险信号）', () => {
    render(<Dx dx={dxAbstainWithFlags} patient={{ name: '张建国', chief: '胸痛' }} onRestart={() => {}} onNext={() => {}} />)
    expect(screen.getByTestId('abstain-card')).toBeTruthy()
    expect(screen.getByText(/危险信号 · 规则引擎独立检出（不可被模型覆盖）/)).toBeTruthy()
    expect(screen.getByText(/请补充问诊后重试/)).toBeTruthy()
  })
  it('弃权卡只说"信息不足/适用范围"，不出现任何倾向性诊断名', () => {
    render(<Dx dx={dxAbstainWithFlags} patient={{ name: '李', chief: '胸闷' }} onRestart={() => {}} onNext={() => {}} />)
    expect(screen.getByText(/信息不足，建议补充问诊/)).toBeTruthy()
    expect(screen.queryByText('主动脉夹层')).toBeNull()
    expect(screen.getByText(/问诊信息不足，建议补充后再评估/)).toBeTruthy()
  })
  it('未弃权时不出弃权卡（反向对照，防"常驻渲染"假通过）', () => {
    render(<Dx dx={dxNoAbstain} patient={{ name: '王', chief: '胸痛' }} onRestart={() => {}} onNext={() => {}} />)
    expect(screen.queryByTestId('abstain-card')).toBeNull()
    expect(screen.getByText('主动脉夹层')).toBeTruthy()
  })
})
