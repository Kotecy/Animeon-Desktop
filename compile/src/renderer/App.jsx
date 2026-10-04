import { useEffect, useRef, useState } from 'react'
import Titlebar from './components/Titlebar'
import TabStrip from './components/TabStrip'
import Dashboard from './pages/Dashboard'
import Secrets from './pages/Secrets'
import Settings from './pages/Settings'
import UpdateModal from './components/UpdateModal'
import { moscowTime } from './components/MoscowClock'

// Inline SVG icons to avoid import issues
export const HomeIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="20" height="20">
    <path d="M4 10V3l5 4a13 13 0 0 1 6 0l5-4v7a7 7 0 0 1 1 4c0 4-4 7-9 7s-9-3-9-7a7 7 0 0 1 1-4Z"/>
    <path d="M8 12v1m8-1v1m-5 3 1 1 1-1M2 15l4 1m12 0 4-1"/>
  </svg>
)

export const SecretsIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="20" height="20">
    <path d="M5 4.5h14a1.5 1.5 0 0 1 1.5 1.5v12A1.5 1.5 0 0 1 19 19.5H5A1.5 1.5 0 0 1 3.5 18v-12A1.5 1.5 0 0 1 5 4.5Z"/><path d="M7 9h10M7 13h6"/><path d="m16 14 .8 1.6 1.7.2-1.2 1.2.3 1.7-1.6-.8-1.6.8.3-1.7-1.2-1.2 1.7-.2L16 14Z"/>
  </svg>
)

export const SettingsIcon = () => (
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
  const [siteNotice, setSiteNotice] = useState(null)
  const [utilities, setUtilities] = useState([])
  const [updateModalInfo, setUpdateModalInfo] = useState(null)
  const limitTimer = useRef(null)
  const siteNoticeTimer = useRef(null)

  const pushEvent = (text) =>
    setEvents((prev) => [{ id: Date.now() + Math.random(), text, time: moscowTime() }, ...prev].slice(0, 40))

  // Проверка обновлений один раз при запуске
  useEffect(() => {
    const checkTimer = setTimeout(async () => {
      try {
        const res = await window.api?.appCheckUpdate?.()
        if (res?.ok && res.newer && res.latest) {
          const dismissed = localStorage.getItem('animeon_dismissed_update_version')
          if (dismissed !== res.latest) {
            setUpdateModalInfo({
              current: res.current,
              latest: res.latest,
              url: res.url
            })
          }
        }
      } catch {}
    }, 1500)

    return () => clearTimeout(checkTimer)
  }, [])

  const handleConfirmUpdate = () => {
    if (updateModalInfo?.latest) {
      localStorage.setItem('animeon_dismissed_update_version', updateModalInfo.latest)
    }
    if (updateModalInfo?.url) {
      window.api?.appOpenUrl?.(updateModalInfo.url)
    }
    setUpdateModalInfo(null)
  }

  const handleDismissUpdate = () => {
    if (updateModalInfo?.latest) {
      localStorage.setItem('animeon_dismissed_update_version', updateModalInfo.latest)
    }
    setUpdateModalInfo(null)
  }

  useEffect(() => {
    const clear = window.api?.onJournalClear?.(() => {
      setEvents([])
    })
    return () => {
      clear?.()
    }
  }, [])

  useEffect(() => {
    const unsubscribeTabsLimit = window.api?.onTabsLimit?.(() => {
      if (limitTimer.current) return
      setLimitWarn(true)
      limitTimer.current = setTimeout(() => {
        setLimitWarn(false)
        limitTimer.current = null
      }, 2500)
    })

    window.api?.appVersion?.().then((v) => setVersion(v || ''))
    window.api?.utilitiesList?.().then((items) => {
      if (Array.isArray(items)) setUtilities(items)
    }).catch(() => {})

    const unsubscribeUtilities = window.api?.onUtilitiesUpdated?.((items) =>
      setUtilities(Array.isArray(items) ? items : [])
    )

    window.api?.storeGetAll().then((s) => {
      if (s?.tabs) setTabs(s.tabs)
      if (s?.tabOrder) setOrder(s.tabOrder)
      if (s?.activeTabId) setActiveId(s.activeTabId)
      if (s?.activeView) setView(s.activeView)
      if (s?.baseUrl) setBaseUrl(s.baseUrl)
      if (typeof s?.sidebarCollapsed === 'boolean') setCollapsed(s.sidebarCollapsed)
    })

    const unsubscribeTabs = window.api?.onTabsUpdated?.((t, activeTabId) => {
      setTabs(t)
      setOrder((prev) =>
        prev.filter((id) => t.find((x) => x.id === id)).concat(t.filter((x) => !prev.includes(x.id)).map((x) => x.id))
      )
      if (activeTabId) setActiveId(activeTabId)
    })

    const unsubscribeNavigationBlocked = window.api?.onSiteNavigationBlocked?.(() => {
      setSiteNotice('Введите корректный адрес AnimeOn: animeon.cc, animeon.co, v1.animeon.co или v2.animeon.co.')
      if (siteNoticeTimer.current) clearTimeout(siteNoticeTimer.current)
      siteNoticeTimer.current = setTimeout(() => setSiteNotice(null), 5000)
    })

    return () => {
      for (const unsubscribe of [unsubscribeTabsLimit, unsubscribeTabs, unsubscribeNavigationBlocked, unsubscribeUtilities]) {
        if (typeof unsubscribe === 'function') unsubscribe()
      }
      if (limitTimer.current) clearTimeout(limitTimer.current)
      if (siteNoticeTimer.current) clearTimeout(siteNoticeTimer.current)
    }
  }, [])

  const switchSiteTab = (id) => {
    setActiveId(id)
    setView('site')
    window.api?.tabsSwitch(id)
    window.api?.viewSet('site')
  }

  const setAppView = (v) => {
    setView(v)
    window.api?.viewSet(v)
  }

  useEffect(() => {
    const key = (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setCommandsOpen((open) => !open)
        setCommandQuery('')
        setCommandError('')
      }
      if (event.key === 'Escape') {
        setCommandsOpen(false)
        setUpdateModalInfo(null)
      }
    }
    window.addEventListener('keydown', key)
    const unsub = window.api?.onCommandsToggle?.(() => {
      setCommandsOpen((open) => !open)
      setCommandQuery('')
      setCommandError('')
    })
    return () => {
      window.removeEventListener('keydown', key)
      unsub?.()
    }
  }, [version])

  useEffect(() => {
    if (updateModalInfo || commandsOpen) window.api?.viewSet('modal')
    else window.api?.viewSet(view)
  }, [updateModalInfo, commandsOpen, view])

  const commands = [
    ...utilities.map((item) => ({
      name: item.name,
      description: item.description || 'Пользовательский скрипт',
      run: async () => {
        try {
          const result = await window.api?.utilitiesToggle(item.id)
          if (!result?.ok) {
            const err = result?.error || 'не удалось изменить состояние'
            setCommandError(err)
            pushEvent(`${item.name}: ${err}`)
            return
          }
          pushEvent(`${item.name}: ${result.active ? 'включён' : 'выключен'}`)
          setCommandsOpen(false)
        } catch {
          setCommandError('Не удалось переключить скрипт')
          pushEvent(`${item.name}: не удалось изменить состояние`)
        }
      }
    }))
  ].filter((command) => command.name.toLowerCase().includes(commandQuery.trim().toLowerCase()))

  const isSite = view === 'site'

  return (
    <>
      <div className="h-full flex flex-col bg-[#0b0c12] text-white rounded-[16px] overflow-hidden">
        <Titlebar version={version} onCommands={() => { setCommandsOpen(true); setCommandQuery(''); setCommandError('') }} />
        <div className="flex flex-1 min-h-0">
          <nav className="signal-rail">
            {[
              { id: 'site', label: 'Главная' },
              { id: 'dashboard', label: 'Функции' },
              { id: 'secrets', label: 'Секреты' },
              { id: 'settings', label: 'Настройки' },
            ].map((item) => (
              <button
                key={item.id}
                onClick={() => setAppView(item.id)}
                className={view === item.id ? 'active' : ''}
                title={item.label}
              >
                <span className="nav-symbol" aria-hidden="true">
                  {item.id === 'site' ? <HomeIcon /> : { dashboard: '◎', secrets: '✦', settings: '⚙' }[item.id]}
                </span>
                <span>{item.label}</span>
              </button>
            ))}
            <small>v{version || '0.4.10'}</small>
          </nav>
          <main className="flex-1 min-w-0 bg-[#0b0c12] flex flex-col overflow-hidden">
            <TabStrip
              tabs={tabs}
              order={order}
              activeId={activeId}
              onReorder={setOrder}
              onSwitch={switchSiteTab}
              isSite={isSite}
              baseUrl={baseUrl}
            />
            <div className="flex-1 min-h-0 overflow-auto relative bg-[#0b0c12]">
              {isSite ? (
                tabs.length > 0 && activeId ? null : (
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
              ) : view === 'dashboard' ? (
                <Dashboard events={events} pushEvent={pushEvent} />
              ) : view === 'secrets' ? (
                <Secrets />
              ) : (
                <Settings baseUrl={baseUrl} onBaseUrl={setBaseUrl} />
              )}
            </div>
          </main>
        </div>
      </div>

      {commandsOpen && (
        <div className="signal-overlay" onClick={() => setCommandsOpen(false)}>
          <section
            role="dialog"
            aria-modal="true"
            aria-label="Найти функцию"
            className="signal-palette"
            onClick={(event) => event.stopPropagation()}
          >
            <input
              autoFocus
              value={commandQuery}
              onChange={(event) => setCommandQuery(event.target.value)}
              placeholder="Найти скрипт…"
            />
            {commands.map((command) => (
              <button className="signal-command-item" key={command.name} onClick={command.run}>
                <span className="signal-command-glyph" aria-hidden="true">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M18 3a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3 3 3 0 0 0 3-3 3 3 0 0 0-3-3H6a3 3 0 0 0-3 3 3 3 0 0 0 3 3 3 3 0 0 0 3-3V6a3 3 0 0 0-3-3 3 3 0 0 0 3 3h12a3 3 0 0 0 3-3 3 3 0 0 0-3-3z"/>
                  </svg>
                </span>
                <span>
                  <b>{command.name}</b>
                  <small>{command.description}</small>
                </span>
              </button>
            ))}
            {!commands.length && <p>Ничего не найдено</p>}
            {commandError && <p role="alert">{commandError}</p>}
          </section>
        </div>
      )}

      {/* Централизованное уведомление о новой версии */}
      {updateModalInfo && (
        <UpdateModal
          info={updateModalInfo}
          onUpdate={handleConfirmUpdate}
          onClose={handleDismissUpdate}
        />
      )}

      {/* Тосты уровня приложения */}
      <div className="pointer-events-none fixed left-1/2 top-14 z-50 flex -translate-x-1/2 flex-col items-center gap-2">
        {!isSite && (
          <div className={`transition-all duration-300 ${limitWarn ? 'translate-y-0 opacity-100' : '-translate-y-2 opacity-0'}`}>
            <div className="flex items-center gap-2 rounded-[10px] border border-violet-400/25 bg-[#0f101a]/80 px-3.5 py-2 text-xs font-medium text-zinc-200 shadow-[0_12px_32px_rgba(0,0,0,.45)] backdrop-blur-md">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="4" width="14" height="12" rx="2" />
                <path d="M7 20h7M17 8h4a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-4" />
              </svg>
              <span>Достигнут лимит вкладок</span>
            </div>
          </div>
        )}
        {siteNotice && (
          <div className="rounded-xl border border-amber-300/30 bg-[#1a1710]/95 px-4 py-2.5 text-xs text-amber-100 shadow-[0_10px_30px_rgba(0,0,0,.5)]">
            {siteNotice}
          </div>
        )}
      </div>
    </>
  )
}
