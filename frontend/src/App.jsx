import { Fragment, lazy, Suspense, useCallback, useEffect, useState } from 'react'
import * as api from './api.js'
import ErrorBoundary from './ErrorBoundary.jsx'
import { useIntakeFlow } from './useIntakeFlow.js'

/* 视图按需分割：首屏只装选病例，其余步骤进入时再加载 */
const CaseSelect = lazy(() => import('./views/CaseSelect.jsx'))
const Intake = lazy(() => import('./views/Intake.jsx'))
const Dx = lazy(() => import('./views/Dx.jsx'))
const Workup = lazy(() => import('./views/Workup.jsx'))
const Report = lazy(() => import('./views/Report.jsx'))

const STEPS = [
  { key: 'cases', label: '选择病例' },
  { key: 'intake', label: '智能问诊' },
  { key: 'dx', label: '辅助诊断' },
  { key: 'workup', label: '检查建议' },
  { key: 'report', label: '病历报告' },
]

const ViewLoading = () => (
  <div className="page"><div className="card loading" role="status">加载中…</div></div>
)

export default function App() {
  const [step, setStep] = useState(0)
  const [reached, setReached] = useState(0)       // 已解锁的最大步骤
  const [cases, setCases] = useState([])
  const [patient, setPatient] = useState(null)
  const [workup, setWorkup] = useState(null)
  const [report, setReport] = useState(null)
  const [err, setErr] = useState(null)              // 错误态：只展示医生可理解文案

  const unlock = useCallback((n) => setReached((r) => Math.max(r, n)), [])

  /* hook 回调：问诊状态机在 useIntakeFlow，App 只负责跨步骤状态 */
  const onCaseStart = useCallback(() => {
    setWorkup(null); setReport(null); setErr(null)
  }, [])
  const onDxReady = useCallback(() => { setErr(null); unlock(2); setStep(2) }, [unlock])
  const intake = useIntakeFlow({ patient, onCaseStart, onDxReady })

  const retry = () => {                            // 重试当前步骤的数据加载
    const e = err
    setErr(null)
    if (!e) return
    const loaders = {
      2: () => intake.loadDx(),
      3: () => api.getWorkup(patient.id, intake.intakeHistory(), intake.dx).then((w) => { setWorkup(w); setErr(null); unlock(3) }),
      4: () => api.getReport(patient.id, intake.intakeHistory(), intake.dx).then((r) => { setReport(r); setErr(null); unlock(4) }),
    }
    const run = loaders[e.step]
    if (!run) return
    run().catch((x) => setErr({ step: e.step, msg: x.message }))
  }

  useEffect(() => {
    const ctrl = new AbortController()
    api.getCases(ctrl.signal).then(setCases).catch((e) => console.error(e))
    return () => ctrl.abort()
  }, [])

  const go = (n) => { if (n <= reached) setStep(n) }

  const startCase = (c) => {
    setPatient(c)
    unlock(1); setStep(1)
    intake.startCase(c)
  }

  /* 直接跳到某一步时的兜底加载（避免双 POST：显式导航只解锁+切换） */
  // 依赖项取 intake 的具体成员（useCallback 稳定）而非整对象：整对象每次渲染都是新字面量，纳入依赖会死循环
  const { dx: intakeDx, loadDx, intakeHistory } = intake

  useEffect(() => {
    if (!patient || step !== 2 || intakeDx) return
    loadDx().catch((e) => setErr({ step: 2, msg: e.message }))
  }, [patient, step, intakeDx, loadDx])

  useEffect(() => {
    if (!patient || step !== 3 || workup) return
    api.getWorkup(patient.id, intakeHistory(), intakeDx).then((w) => { setWorkup(w); unlock(3) }).catch((e) => setErr({ step: 3, msg: e.message }))
  }, [patient, step, workup, intakeDx, intakeHistory, unlock])

  useEffect(() => {
    if (!patient || step !== 4 || report) return
    api.getReport(patient.id, intakeHistory(), intakeDx).then((r) => { setReport(r); unlock(4) }).catch((e) => setErr({ step: 4, msg: e.message }))
  }, [patient, step, report, intakeDx, intakeHistory, unlock])

  /* 显式"下一步"导航：仅解锁+切换，数据加载交给对应 useEffect 兜底，避免双 POST */
  const goWorkup = () => { unlock(3); setStep(3) }
  const goReport = () => { unlock(4); setStep(4) }

  const renderView = () => {
    switch (step) {
      case 0: return <CaseSelect cases={cases} onPick={startCase} />
      case 1: return <Intake patient={patient} msgs={intake.msgs} chips={intake.chips} busy={intake.busy} onAsk={intake.askIntake} onRestart={() => startCase(patient)} />
      case 2: return <Dx dx={intake.dx} patient={patient} onRestart={() => startCase(patient)} onNext={goWorkup} />
      case 3: return <Workup workup={workup} onNext={goReport} />
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
            <h1>医 · 基层AI辅助诊断</h1>
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
          <Fragment key={s.key}>
            {i > 0 && <span className="step-arrow">›</span>}
            <button
              type="button"
              className={'step' + (i === step ? ' active' : i < reached ? ' done' : '')}
              onClick={() => go(i)}
              disabled={i > reached}
              aria-current={i === step ? 'step' : undefined}
            >
              <span className="step-dot">{i + 1}</span>
              <span className="step-name">{s.label}</span>
            </button>
          </Fragment>
        ))}
      </nav>

      {err && (
        <div className="banner danger banner-page" role="alert">
          <div className="banner-page-row">
            <span>{err.msg || '请求未能完成，请重试或重新问诊。'}</span>
            <button className="btn ghost" type="button" onClick={retry}>重试</button>
          </div>
        </div>
      )}

      <main className="view">
        <ErrorBoundary resetKey={`${patient?.id || "none"}-${step}`}>
          <Suspense fallback={<ViewLoading />}>{renderView()}</Suspense>
        </ErrorBoundary>
      </main>

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
