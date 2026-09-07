import { useEffect, useRef, useState } from 'react'
import Titlebar from './components/Titlebar'
import TabStrip from './components/TabStrip'
import Dashboard from './pages/Dashboard'
import Secrets from './pages/Secrets'
import Settings from './pages/Settings'
import { moscowTime } from './components/MoscowClock'
import anomalySoundUrl from './assets/AnomalyDetected.mp3?inline'

// Inline SVG icons to avoid import issues
const HomeIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="20" height="20">
    <path d="M4 10V3l5 4a13 13 0 0 1 6 0l5-4v7a7 7 0 0 1 1 4c0 4-4 7-9 7s-9-3-9-7a7 7 0 0 1 1-4Z"/>
    <path d="M8 12v1m8-1v1m-5 3 1 1 1-1M2 15l4 1m12 0 4-1"/>
  </svg>
)

const BubbleIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="20" height="20">
    <circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/><path d="M7.5 3.8 5.8 2.4M16.5 3.8l1.7-1.4"/>
  </svg>
)

const SecretsIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="20" height="20">
    <path d="M5 4.5h14a1.5 1.5 0 0 1 1.5 1.5v12A1.5 1.5 0 0 1 19 19.5H5A1.5 1.5 0 0 1 3.5 18v-12A1.5 1.5 0 0 1 5 4.5Z"/><path d="M7 9h10M7 13h6"/><path d="m16 14 .8 1.6 1.7.2-1.2 1.2.3 1.7-1.6-.8-1.6.8.3-1.7-1.2-1.2 1.7-.2L16 14Z"/>
  </svg>
)

const SettingsIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="20" height="20">
    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
    <circle cx="12" cy="12" r="3"/>
  </svg>
)

export default function App() {
  const [commandsOpen, setCommandsOpen] = useState(false)
  const [commandQuery, setCommandQuery] = useState('')
  const [commandError, setCommandError] = useState('')
  const [view, setView] = useState('site')
  const [tabs, setTabs] = useState([])
  const [order, setOrder] = useState([])
  const [activeId, setActiveId] = useState(null)
  const [baseUrl, setBaseUrl] = useState('https://v2.animeon.co')
  const [collapsed, setCollapsed] = useState(false)
  const [version, setVersion] = useState('')
  const [events, setEvents] = useState([])
  const [limitWarn, setLimitWarn] = useState(false)
  const [followToast, setFollowToast] = useState(null)
  const [siteNotice, setSiteNotice] = useState(null)
  const limitTimer = useRef(null)
  const followTimer = useRef(null)
  const followQueue = useRef([])
  const followToastRef = useRef(null)
  const siteNoticeTimer = useRef(null)
  const pushEvent = (text) => setEvents(prev => [{ id: Date.now() + Math.random(), text, time: moscowTime() }, ...prev].slice(0, 10))
  // Очередь тостов подписки: по одному 6с; клик — пропуск к следующему.
  // В журнал — отдельная строка «Подписка: Ник» на каждый показ.
  const pumpFollow = () => {
    const next = followQueue.current.shift()
    if (!next) { followToastRef.current = null; setFollowToast(null); return }
    const cur = { name: next, key: Date.now() + Math.random() }
    followToastRef.current = cur
    setFollowToast(cur)
    pushEvent(`Подписка: ${next}`)
    if (followTimer.current) clearTimeout(followTimer.current)
    followTimer.current = setTimeout(pumpFollow, 6000)
  }
  const skipFollow = () => { if (followTimer.current) clearTimeout(followTimer.current); pumpFollow() }
  // Realtime-статус автоподписки: время и сводка последнего прогона.
  const [fbCheck, setFbCheck] = useState(0)
  const [fbSummary, setFbSummary] = useState(null)
  const lastSummaryTs = useRef(0)
  // Детектор аномалий: тост + тройной звук. Звук праймим первым кликом
  // по окну (иначе автоплей браузера его заблокирует).
  const [anomalyToast, setAnomalyToast] = useState(null)
  const anomalyTimer = useRef(null)
  const soundBlockedRef = useRef(false)
  useEffect(() => window.api?.onAnomalyCollected?.(result => {
    const prefix = 'Автосбор: '
    if (result.status === 'accepted') pushEvent(prefix + 'сервер принял запрос на сбор')
    else if (result.status === 'failed') pushEvent(prefix + `сервер отклонил сбор (HTTP ${result.httpStatus || '—'})`)
    else pushEvent(prefix + 'результат запроса неизвестен; повторная проверка через минуту')
  }), [])
  const soundEpoch = useRef(0)
  const playingAudio = useRef(null)
  useEffect(() => {
    const stop = () => { soundEpoch.current++; playingAudio.current?.pause(); setAnomalyToast(null); clearTimeout(anomalyTimer.current) }
    const clear = window.api?.onJournalClear?.(() => {
      stop(); setEvents([]); setFbCheck(0); setFbSummary(null); lastSummaryTs.current = 0
      clearTimeout(followTimer.current); followQueue.current = []; followToastRef.current = null; setFollowToast(null)
    })
    const detector = window.api?.onDetectorUpdated?.(d => { if (!d.watching || d.sound === false) stop() })
    return () => { stop(); clear?.(); detector?.() }
  }, [])
  const playAnomalySound = async () => {
    const epoch = soundEpoch.current
    for (let i = 0; i < 3; i++) {
      if (epoch !== soundEpoch.current) break
      try {
        const a = new Audio(anomalySoundUrl)
        a.volume = 0.1
        playingAudio.current = a
        await a.play()
      } catch {
        if (!soundBlockedRef.current) { soundBlockedRef.current = true; pushEvent('Звук заблокирован — кликни по окну один раз') }
        break
      }
      if (i < 2) await new Promise(r => setTimeout(r, 950))
    }
  }

  useEffect(() => {
    const unsubscribeTabsLimit = window.api?.onTabsLimit?.(() => {
      // Синглтон: пока пилюля висит — спам-вызовы игнорируются.
      if (limitTimer.current) return
      setLimitWarn(true)
      limitTimer.current = setTimeout(() => { setLimitWarn(false); limitTimer.current = null }, 2500)
    })
    const unsubscribeFollowbackDone = window.api?.onFollowbackDone?.((names) => {
      const list = Array.isArray(names) ? names.map(String).filter(Boolean).slice(0, 10) : []
      if (!list.length) return
      followQueue.current.push(...list)
      if (followQueue.current.length > 10) followQueue.current.splice(0, followQueue.current.length - 10)
      if (!followToastRef.current) pumpFollow()
    })
    const unsubscribeFollowbackTick = window.api?.onFollowbackTick?.((ts, summary) => {
      if (ts) setFbCheck(ts)
      if (summary && summary.ts > lastSummaryTs.current) {
        lastSummaryTs.current = summary.ts
        setFbSummary(summary)
        const un = Array.isArray(summary.unfollowedNames) ? summary.unfollowedNames.filter(Boolean) : []
        for (const n of un) pushEvent(`Отписка: ${n}`)
      }
    })
    // Уведомления детектора живут здесь (App смонтирован всегда): звук,
    // тост и журнал — даже когда открыта другая вкладка или раздел.
    const primeAnomalyAudio = () => {
      try {
        const a = new Audio(anomalySoundUrl)
        a.volume = 0
        const p = a.play()
        if (p && p.then) p.then(() => { try { a.pause() } catch {} }).catch(() => {})
      } catch {}
    }
    window.addEventListener('pointerdown', primeAnomalyAudio, { once: true })
    window.addEventListener('keydown', primeAnomalyAudio, { once: true })
    const unsubscribeAnomaly = window.api?.onAnomalyDetected?.(async (info) => {
      const epoch = soundEpoch.current
      const time = moscowTime()
      pushEvent('Нашли аномалию')
      if (!info || info.toast !== false) {
        setAnomalyToast({ key: Date.now() + Math.random(), time })
        if (anomalyTimer.current) clearTimeout(anomalyTimer.current)
        anomalyTimer.current = setTimeout(() => setAnomalyToast(null), 6000)
      }
      try {
        const d = await window.api?.storeGet('detector')
        if (!d?.watching || d.sound === false || epoch !== soundEpoch.current) return
        playAnomalySound()
      } catch {}
    })
    window.api?.appVersion?.().then(v => setVersion(v || ''))
    window.api?.storeGetAll().then(s => {
      if (s?.tabs) setTabs(s.tabs)
      if (s?.tabOrder) setOrder(s.tabOrder)
      if (s?.activeTabId) setActiveId(s.activeTabId)
      if (s?.activeView) setView(s.activeView)
      if (s?.baseUrl) setBaseUrl(s.baseUrl)
      if (typeof s?.sidebarCollapsed === 'boolean') setCollapsed(s.sidebarCollapsed)
      if (Number(s?.followbackLastCheck)) setFbCheck(Number(s.followbackLastCheck))
      if (s?.followbackLastSummary) { setFbSummary(s.followbackLastSummary); lastSummaryTs.current = Number(s.followbackLastSummary.ts) || 0 }
    })
    const unsubscribeTabs = window.api?.onTabsUpdated?.((t, activeTabId) => {
      setTabs(t)
      setOrder(prev => prev.filter(id => t.find(x=>x.id===id)).concat(t.filter(x=>!prev.includes(x.id)).map(x=>x.id)))
      if (activeTabId) setActiveId(activeTabId)
    })
    const unsubscribeNavigationBlocked = window.api?.onSiteNavigationBlocked?.(() => {
      setSiteNotice('Введите корректный адрес AnimeOn: animeon.cc, animeon.co, v1.animeon.co или v2.animeon.co.')
      if (siteNoticeTimer.current) clearTimeout(siteNoticeTimer.current)
      siteNoticeTimer.current = setTimeout(() => setSiteNotice(null), 5000)
    })
    return () => {
      for (const unsubscribe of [unsubscribeTabsLimit, unsubscribeFollowbackDone, unsubscribeFollowbackTick, unsubscribeAnomaly, unsubscribeTabs, unsubscribeNavigationBlocked]) {
        if (typeof unsubscribe === 'function') unsubscribe()
      }
      window.removeEventListener('pointerdown', primeAnomalyAudio)
      window.removeEventListener('keydown', primeAnomalyAudio)
      if (limitTimer.current) clearTimeout(limitTimer.current)
      if (followTimer.current) clearTimeout(followTimer.current)
      if (anomalyTimer.current) clearTimeout(anomalyTimer.current)
      if (siteNoticeTimer.current) clearTimeout(siteNoticeTimer.current)
    }
  }, [])

  const switchSiteTab = (id) => {
    setActiveId(id); setView('site')
    window.api?.tabsSwitch(id)
    window.api?.viewSet('site')
  }
  const setAppView = (v) => {
    setView(v)
    window.api?.viewSet(v)
  }
  const toggleSidebar = () => {
    const next = !collapsed
    setCollapsed(next)
    window.api?.sidebarSetCollapsed(next)
  }

  useEffect(() => {
    const key = event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault(); setCommandsOpen(open => !open); setCommandQuery('')
      }
      if (event.key === 'Escape') setCommandsOpen(false)
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])
  // Native website view must be hidden while an HTML overlay is open.
  useEffect(() => {
    if (commandsOpen) window.api?.viewSet('commands')
    else window.api?.viewSet(view)
  }, [commandsOpen, view])
  const commands = [
    { name: 'Детектор', run: async () => { try { const result = await window.api?.detectorToggle(true); if (result?.error) { setCommandError(result.error); return } setCommandsOpen(false) } catch { setCommandError('Не удалось включить детектор') } } },
    { name: 'XP Чекер', run: async () => { try { const result = await window.api?.utilitiesToggle('xp-checker'); if (!result?.ok) { setCommandError(result?.error || 'Не удалось переключить инструмент'); return } setCommandsOpen(false) } catch { setCommandError('Не удалось переключить инструмент') } } }
  ].filter(command => command.name.toLowerCase().includes(commandQuery.trim().toLowerCase()))
  const isSite = view === 'site'

  return (
    <>
    <div className="h-full flex flex-col bg-[#0b0c12] text-white rounded-[16px] overflow-hidden">
      <Titlebar version={version} onCommands={() => { setCommandsOpen(true); setCommandQuery(''); setCommandError('') }} />
      <div className="flex flex-1 min-h-0">
        <nav className="signal-rail">
          {[
            { id: 'site', label: 'Главная', icon: HomeIcon },
            { id: 'dashboard', label: 'Функции', icon: BubbleIcon },
            { id: 'secrets', label: 'Секреты', icon: SecretsIcon },
            { id: 'settings', label: 'Настройки', icon: SettingsIcon },
          ].map(item => <button key={item.id} onClick={() => setAppView(item.id)} className={view === item.id ? 'active' : ''} title={item.label}><span className="nav-symbol" aria-hidden="true">{item.id === 'site' ? <HomeIcon /> : {dashboard:'◎',secrets:'✦',settings:'⚙'}[item.id]}</span><span>{item.label}</span></button>)}
          <small>v{version || '0.4.0'}</small>
        </nav>
        <main className="flex-1 min-w-0 bg-[#0b0c12] flex flex-col overflow-hidden">
          <TabStrip tabs={tabs} order={order} activeId={activeId} onReorder={setOrder} onSwitch={switchSiteTab} isSite={isSite} baseUrl={baseUrl} />
          <div className="flex-1 min-h-0 overflow-auto relative bg-[#0b0c12]">
            {isSite ? (
              (tabs.length > 0 && activeId) ? null : (
                <div className="absolute inset-0 grid place-items-center bg-[#0a0a0a]">
                  {tabs.length === 0 ? (
                    <div className="text-center space-y-3">
                      <div className="w-14 h-14 mx-auto rounded-2xl bg-white/[0.04] border border-white/10 grid place-items-center text-xl">＋</div>
                      <div className="text-white font-medium">Нет вкладок</div>
                    </div>
                  ) : (
                    <div className="text-center space-y-2 text-sm">
                      <div className="text-white font-medium">Сайт во встроенном просмотре</div>
                      <div className="text-xs text-zinc-500">Выбери вкладку выше</div>
                    </div>
                  )}
                </div>
              )
            ) : view === 'dashboard' ? <Dashboard events={events} pushEvent={pushEvent} fbCheck={fbCheck} fbSummary={fbSummary} /> : view === 'secrets' ? <Secrets /> : <Settings baseUrl={baseUrl} onBaseUrl={setBaseUrl} />}
          </div>
        </main>
      </div>
    </div>
    {commandsOpen && <div className="signal-overlay" onClick={() => setCommandsOpen(false)}><section role="dialog" aria-modal="true" aria-label="Найти функцию" className="signal-palette" onClick={event => event.stopPropagation()}><input autoFocus value={commandQuery} onChange={event => setCommandQuery(event.target.value)} placeholder="Найти функцию…" />{commands.map(command => <button key={command.name} onClick={command.run}>{command.name}</button>)}{!commands.length && <p>Ничего не найдено</p>}{commandError && <p role="alert">{commandError}</p>}</section></div>}
    {/* Тосты уровня приложения — сверху по центру (y < 88): зону ниже
        перекрывает нативный BrowserView сайта, там их не видно. */}
    <div className="pointer-events-none fixed left-1/2 top-14 z-50 flex -translate-x-1/2 flex-col items-center gap-2">
      {!isSite && (
      <div className={`transition-all duration-300 ${limitWarn ? 'translate-y-0 opacity-100' : '-translate-y-2 opacity-0'}`}>
        <div className="flex items-center gap-2 rounded-[10px] border border-violet-400/25 bg-[#0f101a]/80 px-3.5 py-2 text-xs font-medium text-zinc-200 shadow-[0_12px_32px_rgba(0,0,0,.45)] backdrop-blur-md">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="14" height="12" rx="2" /><path d="M7 20h7M17 8h4a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-4" /></svg>
          <span>Достигнут лимит вкладок</span>
        </div>
      </div>
      )}
      {followToast && (
        <div key={followToast.key} onClick={skipFollow} className="pointer-events-auto flex cursor-pointer items-center gap-2.5 rounded-xl border border-violet-400/30 border-l-[3px] border-l-violet-400 bg-[#141521]/95 py-2.5 pl-3 pr-4 text-xs text-zinc-200 shadow-[0_10px_30px_rgba(0,0,0,.5)]">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-violet-400/30 bg-violet-500/10 text-violet-300">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><circle cx="10" cy="8" r="3.5" /><path d="M4 20c.7-3.2 3-5 6-5s5.3 1.8 6 5" /><path d="M18.5 8v6M15.5 11h6" /></svg>
          </span>
          <span>
            <span className="block font-semibold text-white">{followToast.name}</span>
            <span className="mt-0.5 block text-zinc-400">Подписался в ответ</span>
          </span>
        </div>
      )}
      {siteNotice && (
        <div className="rounded-xl border border-amber-300/30 bg-[#1a1710]/95 px-4 py-2.5 text-xs text-amber-100 shadow-[0_10px_30px_rgba(0,0,0,.5)]">{siteNotice}</div>
      )}
      {anomalyToast && !isSite && (
        <div key={anomalyToast.key} onClick={() => { if (anomalyTimer.current) clearTimeout(anomalyTimer.current); setAnomalyToast(null) }} className="pointer-events-auto flex cursor-pointer items-center gap-2.5 rounded-xl border border-emerald-400/50 bg-[#101814]/95 py-2.5 pl-3 pr-4 text-xs text-zinc-200 shadow-[0_10px_30px_rgba(0,0,0,.5)]">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-emerald-400/40 bg-emerald-500/15 text-emerald-200">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="8.5" /><path d="M12 12 18.3 5.7" /><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" /></svg>
          </span>
          <span>
            <span className="block font-bold text-white drop-shadow-[0_1px_2px_rgba(0,0,0,.8)]">Нашли аномалию!</span>
            <span className="mt-0.5 block text-zinc-200">Загляни на вкладку и забери награду</span>
          </span>
        </div>
      )}
    </div>
    </>
  )
}
