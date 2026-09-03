import { useEffect, useState } from 'react'
import * as api from './api.js'
import CaseSelect from './views/CaseSelect.jsx'
import Intake from './views/Intake.jsx'
import Dx from './views/Dx.jsx'
import Workup from './views/Workup.jsx'
import Report from './views/Report.jsx'

const STEPS = [
  { key: 'cases', label: '选择病例' },
  { key: 'intake', label: '智能问诊' },
  { key: 'dx', label: '辅助诊断' },
  { key: 'workup', label: '检查建议' },
  { key: 'report', label: '病历报告' },
]

export default function App() {
  const [step, setStep] = useState(0)
  const [reached, setReached] = useState(0)       // 已解锁的最大步骤
  const [cases, setCases] = useState([])
  const [patient, setPatient] = useState(null)
  const [msgs, setMsgs] = useState([])            // [{id, role:'ai'|'user', text, pending?}]
  const [chips, setChips] = useState([])
  const [busy, setBusy] = useState(false)
  const [dx, setDx] = useState(null)
  const [workup, setWorkup] = useState(null)
  const [report, setReport] = useState(null)

  useEffect(() => {
    api.getCases().then(setCases).catch((e) => console.error(e))
  }, [])

  const unlock = (n) => setReached((r) => Math.max(r, n))
  const go = (n) => { if (n <= reached) setStep(n) }

  const startCase = async (c) => {
    setPatient(c); setMsgs([]); setChips([]); setDx(null); setWorkup(null); setReport(null)
    unlock(1); setStep(1)
    setMsgs([{ id: Date.now(), role: 'ai', text: c.intro }])
  }

  /* 向后端推进一轮问诊 */
  const askIntake = async (content) => {
    if (!patient || busy) return
    setBusy(true)
    setMsgs((m) => [...m, { id: Date.now(), role: 'user', text: content }])
    setChips([])
    try {
      const hist = [...msgs.map((m) => ({ role: m.role, content: m.text })), { role: 'user', content }]
      const data = await api.askIntake(patient.id, content, hist)
      setMsgs((m) => [...m, { id: Date.now(), role: 'ai', text: data.reply }])
      setChips(data.chips || [])
      if (data.done) {
        await new Promise((r) => setTimeout(r, 500))
        await loadDx()
      }
    } finally {
      setBusy(false)
    }
  }

  const loadDx = async () => {
    const summary = msgs.map((m) => (m.role === 'user' ? m.text : '')).filter(Boolean).join('；')
    const d = await api.getDiagnosis(patient.id, summary)
    setDx(d); unlock(2); setStep(2)
  }

  useEffect(() => {
    if (!patient || step !== 2 || dx) return
    loadDx().catch(console.error)                // 直接跳到诊断页时兜底加载
  }, [patient, step])                            // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!patient || step !== 3 || workup) return
    api.getWorkup(patient.id).then(setWorkup).then(unlock(3)).catch(console.error)
  }, [patient, step])                            // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!patient || step !== 4 || report) return
    api.getReport(patient.id).then(setReport).then(unlock(4)).catch(console.error)
  }, [patient, step])                            // eslint-disable-line react-hooks/exhaustive-deps

  const renderView = () => {
    switch (step) {
      case 0: return <CaseSelect cases={cases} onPick={startCase} />
      case 1: return <Intake patient={patient} msgs={msgs} chips={chips} busy={busy} onAsk={askIntake} onRestart={() => startCase(patient)} />
      case 2: return <Dx dx={dx} patient={patient} onRestart={() => startCase(patient)} />
      case 3: return <Workup workup={workup} />
      case 4: return <Report report={report} patient={patient} />
      default: return null
    }
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">听诊</span>
          <div className="brand-txt">
            <h1>医 · AI 辅助诊断</h1>
            <p>基层全科智能助手</p>
          </div>
        </div>
        <div className="patient-strip">
          {patient
            ? <span className="patient-chip">{patient.name} · {patient.age}岁 {patient.gender} ｜ {patient.chief}</span>
            : <span className="strip-empty">尚未选择患者</span>}
        </div>
      </header>

      <nav className="steps">
        {STEPS.map((s, i) => (
          <React.Fragment key={s.key}>
            {i > 0 && <span className="step-arrow">›</span>}
            <button
              type="button"
              className={'step' + (i === step ? ' active' : i < reached ? ' done' : '')}
              onClick={() => go(i)}
              disabled={i > reached}
            >
              <span className="step-dot">{i + 1}</span>
              <span className="step-name">{s.label}</span>
            </button>
          </React.Fragment>
        ))}
      </nav>

      <main className="view">{renderView()}</main>

      <footer className="app-footer">
        <span><SvgShield /> AI 辅助参考 · 医生终审</span>
        <span><SvgScan /> RAG 知识库引用溯源</span>
        <span><SvgFlask /> 演示环境 · 脱敏模拟病例</span>
      </footer>
    </div>
  )
}

const svgProps = { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', style: { verticalAlign: '-2px', marginRight: 6 } }
const SvgShield = () => (<svg {...svgProps}><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" /><path d="m9 12 2 2 4-4" /></svg>)
const SvgScan = () => (<svg {...svgProps}><path d="M3 7V5a2 2 0 0 1 2-2h2" /><path d="M17 3h2a2 2 0 0 1 2 2v2" /><path d="M21 17v2a2 2 0 0 1-2 2h-2" /><path d="M7 21H5a2 2 0 0 1-2-2v-2" /><path d="M7 12h10" /></svg>)
const SvgFlask = () => (<svg {...svgProps}><path d="M9 3h6" /><path d="M10 3v6L4.5 17a2 2 0 0 0 1.7 3h11.6a2 2 0 0 0 1.7-3L14 9V3" /></svg>)