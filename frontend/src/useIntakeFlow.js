import { useCallback, useState } from 'react'
import * as api from './api.js'

/* 消息 id：优先 UUID，非安全上下文回退时间戳+随机数，防同毫秒撞 key（全应用唯一生成点） */
export const nextId = () => (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Date.now() + Math.random())

/* 问诊状态机 + 辅助诊断加载：副作用集中于此 hook，App 只做视图编排与跨步骤状态 */
export function useIntakeFlow({ patient, onCaseStart, onDxReady }) {
  const [msgs, setMsgs] = useState([])            // [{id, role:'ai'|'user', text}]
  const [chips, setChips] = useState([])
  const [busy, setBusy] = useState(false)
  const [dx, setDx] = useState(null)

  const intakeHistory = useCallback(() => msgs
    .filter((m) => m.role === 'user')
    .map((m) => ({ role: 'user', content: m.text })), [msgs])

  /* 生成辅助诊断（AC-OBS-04）；成功后回调 App 统一解锁/切步/清错 */
  const loadDx = useCallback(async (hist) => {
    const h = hist || intakeHistory()
    const d = await api.getDiagnosis(patient.id, h)
    setDx(d)
    onDxReady(d)
    return d
  }, [patient, intakeHistory, onDxReady])

  /* 进入病例：重置本轮会话并拉取第一问+chips（AC-OBS-02） */
  const startCase = useCallback((c) => {
    onCaseStart()
    setMsgs([{ id: nextId(), role: 'ai', text: c.intro }])
    setChips([])
    setDx(null)
    setBusy(false)
    api.askIntake(c.id, [])
      .then((first) => {
        setMsgs((m) => [...m, { id: nextId(), role: 'ai', text: first.reply }])
        setChips(first.chips || [])
      })
      .catch(() => { /* 保留开场白，医生仍可手动输入主诉推进 */ })
  }, [onCaseStart])

  /* 向后端推进一轮问诊（携带完整 history，后端抽取临床状态）；空输入/忙时不产生空消息 */
  const askIntake = useCallback(async (content) => {
    const text = String(content ?? '').trim()
    if (!patient || busy || !text) return
    setBusy(true)
    setMsgs((m) => [...m, { id: nextId(), role: 'user', text }])
    setChips([])
    try {
      const hist = [...msgs.map((m) => ({ role: m.role === 'ai' ? 'assistant' : 'user', content: m.text })), { role: 'user', content: text }]
      const data = await api.askIntake(patient.id, hist)
      setMsgs((m) => [...m, { id: nextId(), role: 'ai', text: data.reply }])
      setChips(data.chips || [])
      if (data.done) {
        await new Promise((r) => setTimeout(r, 500))
        await loadDx(hist)
      }
    } catch (e) {
      setMsgs((m) => [...m, { id: nextId(), role: 'ai', text: '问诊请求未能完成：' + (e.message || '请重试') }])
    } finally {
      setBusy(false)
    }
  }, [patient, busy, msgs, loadDx])

  return { msgs, chips, busy, dx, askIntake, startCase, intakeHistory, loadDx }
}
