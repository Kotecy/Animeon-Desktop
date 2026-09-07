import { AUTO_COLLECT_AVAILABLE } from '../../shared/buildFlags'
import { useEffect, useRef, useState } from 'react'
import { moscowTime } from '../components/MoscowClock'
import anomalySoundUrl from '../assets/AnomalyDetected.mp3?inline'

const RadarIcon = ({ size = 20 }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5" /><path d="M12 12 18.3 5.7" /><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" /><path d="M12 3.5v1M3.5 12h1M19.5 12h1M12 19.5v1" /></svg>
const BellIcon = ({ size = 18 }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6" /><path d="M10 20a2 2 0 0 0 4 0" /></svg>
const SparkIcon = ({ size = 18 }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m12 3 1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5L12 3Z" /><path d="M19 16 .7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7L19 16Z" /></svg>
const CodeIcon = ({ size = 18 }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m8 9-3 3 3 3M16 9l3 3-3 3M14 5l-4 14" /></svg>
const TerminalIcon = ({ size = 18 }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3M13 15h4" /></svg>

function Toggle({ checked, onClick, label, disabled = false }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={(event) => { event.stopPropagation(); onClick(event) }} className="signal-switch signal-function-switch"><i aria-hidden="true" /></button>
}

function UtilityCard({ icon, title, description, active, busy, onToggle, note, children }) {
  return <section className="signal-card signal-tool"><div className="signal-face">{icon}</div><h2>{title}</h2><p className="signal-note">{description}</p><div className="signal-tool-footer">{onToggle ? <><small>{busy ? 'Загрузка…' : active ? 'включён' : 'выкл'}</small><Toggle checked={active} onClick={onToggle} label={'Переключить ' + title} disabled={busy} /></> : children}</div>{note && <p role="status" className="signal-note">{note}</p>}</section>
}

export default function Dashboard({ events = [], pushEvent = () => {}, fbCheck = 0 }) {
  const [authorized, setAuthorized] = useState(null)
  useEffect(() => {
    let alive = true, revision = 0
    const refresh = async (reset = false) => {
      const current = ++revision
      if (reset) setAuthorized(null)
      try {
        const state = await window.api?.authState?.()
        if (alive && current === revision) setAuthorized(state?.authenticated === true)
      } catch { if (alive && current === revision) setAuthorized(false) }
    }
    const auth = window.api?.onAuthUpdated?.(state => { revision++; if (alive) setAuthorized(state?.authenticated === true) })
    const account = window.api?.onAccountsUpdated?.(() => refresh(true))
    const tabs = window.api?.onTabsUpdated?.(() => refresh())
    refresh()
    const timer = setInterval(() => refresh(), 15000)
    return () => { alive = false; revision++; clearInterval(timer); auth?.(); account?.(); tabs?.() }
  }, [])
  const authHint = authorized === null ? 'Проверяем авторизацию…' : !authorized ? 'Войдите в аккаунт' : ''
  const [remaining, setRemaining] = useState(null)
  const [remainingError, setRemainingError] = useState('')
  useEffect(() => {
    let alive = true, generation = 0
    const refresh = async () => {
      const current = ++generation
      setRemaining(null); setRemainingError('Загрузка…')
      try {
        const result = await window.api?.anomalyState?.()
        if (!alive || current !== generation) return
        setRemaining(result?.ok ? result.remaining : null); setRemainingError(result?.ok ? '' : result?.error || 'Данные недоступны')
      } catch { if (alive && current === generation) setRemainingError('Не удалось загрузить остаток') }
    }
    refresh()
    const subscriptions = [window.api?.onAnomalyDetected?.(refresh), window.api?.onAnomalyCollected?.(refresh), window.api?.onAccountsUpdated?.(refresh)]
    const timer = setInterval(refresh, 60000)
    return () => { alive = false; clearInterval(timer); subscriptions.forEach(unsubscribe => unsubscribe?.()) }
  }, [])
  const [watching, setWatching] = useState(null)
  const [sound, setSound] = useState(true)
  const [autoCollect, setAutoCollect] = useState(false)
  const [toastOn, setToastOn] = useState(true)
  const [detCount, setDetCount] = useState(0)
  const [detLastAt, setDetLastAt] = useState(0)
  const [follow, setFollow] = useState(null)
  const [followBusy, setFollowBusy] = useState(false)
  const [followError, setFollowError] = useState('')
  const [nextCheck, setNextCheck] = useState(0)
  const [whitelist, setWhitelist] = useState([])
  const [blacklist, setBlacklist] = useState([])
  const [blockedNickname, setBlockedNickname] = useState('')
  const [listEditor, setListEditor] = useState(null)
  const listDialog = useRef(null)
  useEffect(() => {
    const dialog = listDialog.current
    if (listEditor) { if (!dialog.open) dialog.showModal() }
    else if (dialog.open) dialog.close()
  }, [listEditor])
  const [listProfile, setListProfile] = useState('')
  const listProfileRef = useRef('')
  const [nickname, setNickname] = useState('')
  const followGeneration = useRef(0)
  const [fbCheckState, setFbCheckState] = useState(0)
  const [tabsCount, setTabsCount] = useState(0)
  const [nowTs, setNowTs] = useState(Date.now())
  const [utilities, setUtilities] = useState(null)
  const utilityGeneration = useRef(0)
  const detectorGeneration = useRef(0)
  const [utilityBusy, setUtilityBusy] = useState('')
  const [toolsOpen, setToolsOpen] = useState(false)

  useEffect(() => { const t = setInterval(() => setNowTs(Date.now()), 1000); return () => clearInterval(t) }, [])
  const lastCheckTs = fbCheckState
  const remainMs = nextCheck ? nextCheck - nowTs : null
  const remainText = remainMs == null ? '—' : remainMs > 0 ? `${String(Math.floor(remainMs / 60000)).padStart(2, '0')}:${String(Math.floor(remainMs % 60000 / 1000)).padStart(2, '0')}` : 'проверка идёт…'
  const utilityActive = (id) => (utilities || []).some(item => item.id === id)

  const refreshFollowStatus = async () => {
    const generation = ++followGeneration.current
    try {
      const s = await window.api?.followbackState?.()
      if (!s || generation !== followGeneration.current) return
      setFollow(!!s.enabled); setFbCheckState(Number(s.lastCheck) || 0); setNextCheck(Number(s.nextAt) || 0)
      setFollowError(s.error || ''); setWhitelist(Array.isArray(s.whitelist) ? s.whitelist : [])
      if (listProfileRef.current !== s.profileId) { setNickname(''); setBlockedNickname(''); setListEditor(null) }
      listProfileRef.current = s.profileId
      setListProfile(s.profileId)
      setBlacklist(Array.isArray(s.blacklist) ? s.blacklist : [])
    } catch { if (generation === followGeneration.current) setFollowError('Не удалось прочитать состояние') }
  }
  const saveWhitelist = async names => {
    setFollowBusy(true)
    try { const saved = await window.api.followbackWhitelist(names, listProfile); if (listProfileRef.current === listProfile) { setWhitelist(saved); setNickname('') } }
    catch { setFollowError('Не удалось сохранить белый список') }
    finally { setFollowBusy(false) }
  }
  const refreshUtilities = async () => { const generation = ++utilityGeneration.current; try { const items = await window.api?.utilitiesList?.(); if (generation === utilityGeneration.current && Array.isArray(items)) setUtilities(items) } catch {} }
  const saveBlacklist = async names => {
    setFollowBusy(true)
    try { const saved = await window.api.followbackBlacklist(names, listProfile); if (listProfileRef.current === listProfile) { setBlacklist(saved); setBlockedNickname('') } }
    catch { setFollowError('Не удалось сохранить чёрный список: проверьте выбранный профиль') }
    finally { setFollowBusy(false) }
  }
  useEffect(() => {
    refreshFollowStatus()
    const t = setInterval(refreshFollowStatus, 5000)
    const unsub = window.api?.onFollowbackState?.(refreshFollowStatus)
    const account = window.api?.onAccountsUpdated?.(refreshFollowStatus)
    return () => { followGeneration.current++; clearInterval(t); unsub?.(); account?.() }
  }, [])
  useEffect(() => {
    refreshUtilities()
    const unsubscribe = window.api?.onUtilitiesUpdated?.(items => { utilityGeneration.current++; setUtilities(items) })
    return () => { utilityGeneration.current++; if (typeof unsubscribe === 'function') unsubscribe() }
  }, [])
  const refreshDetector = async () => { const generation = ++detectorGeneration.current; try { const s = await window.api?.storeGetAll(); if (generation !== detectorGeneration.current) return; const d = s?.detector || {}; setAutoCollect(!!d.autoCollect); setWatching(!!d.watching); setSound(d.sound !== false); setToastOn(d.toast !== false); setDetCount(Number(d.count) || 0); setDetLastAt(Number(d.lastAt) || 0); setTabsCount((s.tabs || []).length) } catch {} }
  useEffect(() => {
    refreshDetector()
    const unsubscribeDetector = window.api?.onDetectorUpdated?.(d => { if (d) { detectorGeneration.current++; setAutoCollect(!!d.autoCollect); setWatching(!!d.watching); setSound(d.sound !== false); setToastOn(d.toast !== false); setDetCount(Number(d.count) || 0); setDetLastAt(Number(d.lastAt) || 0) } })
    const unsubscribeTabs = window.api?.onTabsUpdated?.(t => setTabsCount(Array.isArray(t) ? t.length : 0))
    return () => {
      detectorGeneration.current++; if (typeof unsubscribeDetector === 'function') unsubscribeDetector()
      if (typeof unsubscribeTabs === 'function') unsubscribeTabs()
    }
  }, [])

  const toggleWatch = async () => { const d = await window.api?.detectorToggle(); if (d?.error) { pushEvent(d.error); return } if (d) { setWatching(!!d.watching); setDetCount(Number(d.count) || 0); setDetLastAt(Number(d.lastAt) || 0); pushEvent(d.watching ? 'Наблюдение включено' : 'Наблюдение выключено') } }
  const toggleSound = async () => { const d = await window.api?.detectorSound(); if (d) setSound(d.sound !== false) }
  const toggleToast = async () => { const d = await window.api?.detectorToast(); if (d) setToastOn(d.toast !== false) }
  const testSound = async () => { try { const a = new Audio(anomalySoundUrl); a.volume = 0.1; await a.play() } catch { pushEvent('Звук заблокирован — кликни по окну один раз') } }
  const toggleUtility = async (id, title) => { setUtilityBusy(id); try { const result = await window.api?.utilitiesToggle?.(id); if (!result?.ok) pushEvent(`${title}: ${result?.error || 'не удалось изменить состояние'}`); else pushEvent(`${title}: ${result.active ? 'включён' : 'выключен'}`); await refreshUtilities() } catch { pushEvent(`${title}: не удалось изменить состояние`) } setUtilityBusy('') }

  return <div className="signal-page">
    <h1>Детектор <em>аномалий</em></h1><p className="signal-lede">Удобные функции для AnimeOn</p>
    <div className="signal-dashboard">
      <div className="signal-column signal-left-column"><section className="signal-card signal-stat-card"><small className="signal-kicker">СТАТУС</small>
        <div className="signal-stats"><div><strong>{String(detCount).padStart(2, '0')}</strong><small>замечено всего</small></div><div><b>{detLastAt ? moscowTime(detLastAt) : '—'}</b><small>последняя находка</small></div><div title={remainingError}><b>{remaining ?? '—'}</b><small>аномалий осталось сегодня</small></div></div>
        <div className="signal-journal">{events.length ? events.map(event => <div key={event.id} title={`${event.time} — ${event.text}`}>{event.time} — {event.text}</div>) : <p>Здесь появится журнал работы после запуска.</p>}</div>
        <p role="status" className="signal-note" title={remainingError}>{remainingError || '\u00a0'}</p>
      </section>
      <UtilityCard icon={<CodeIcon />} title="XP Монитор" description="Показывает текущий XP и его изменение." active={utilityActive('xp-checker')} busy={utilities === null || utilityBusy === 'xp-checker'} onToggle={() => toggleUtility('xp-checker', 'XP Монитор')} />
      </div>
      <div className="signal-column"><section className={"signal-card" + (!authorized ? " signal-auth-disabled" : "")} title={authHint || undefined}><b>{watching ? 'Наблюдаю' : 'Выключен'}</b><div className="signal-detector-actions"><button className="signal-primary" disabled={!authorized || watching === null} onClick={toggleWatch}>{watching ? 'Выключить' : 'Включить'}</button><button disabled={!authorized} aria-pressed={sound} onClick={toggleSound} className={'signal-sound' + (sound ? ' on' : '')}>Звук: {sound ? 'вкл' : 'выкл'}</button></div>{AUTO_COLLECT_AVAILABLE && <div className={'signal-setting-row signal-autocollect' + (!authorized || !watching ? ' disabled' : '')} title={authHint || (!watching ? 'Сначала включите детектор' : undefined)}><div><b>Автоматический сбор</b></div>{watching === null ? <span className="signal-switch-placeholder" /> : <button disabled={!authorized || !watching} className="signal-switch" role="switch" aria-label="Автоматический сбор" aria-checked={autoCollect} onClick={() => window.api?.detectorCollect()}><i /></button>}</div>}{authHint && <p className="signal-note signal-auth-hint" role="status">{authHint}</p>}</section>
        <section className={"signal-card" + (!authorized ? " signal-auth-disabled" : "")} title={authHint || undefined}><div className="signal-heading"><div><h2>Автоподписка</h2><div className="signal-follow-meta"><span>проверка: {lastCheckTs ? moscowTime(lastCheckTs) : '—'}</span><span>следующая: {follow ? remainText : '—'}</span></div></div>{follow === null ? <span className="signal-switch-placeholder" aria-label="Загрузка состояния" /> : <Toggle checked={follow} disabled={!authorized || followBusy} onClick={async () => { setFollowBusy(true); followGeneration.current++; try { await window.api?.followbackToggle(); await refreshFollowStatus() } finally { setFollowBusy(false) } }} label="Переключить автоподписку" />}</div>
          <p className="signal-note">Подписывается в ответ.<br />Отписывается от тех, кто не подписан на тебя.</p>
          {authHint && <p className="signal-note signal-auth-hint" role="status">{authHint}</p>}
          {followError && <p className="signal-note" role="status">{followError}</p>}
          <div className="signal-list-buttons"><button onClick={() => setListEditor('white')}>Белый список · {whitelist.length}</button><button onClick={() => setListEditor('black')}>Чёрный список · {blacklist.length}</button></div>
        </section>
      </div>
    </div>
    <section className="signal-tools"><button aria-expanded={toolsOpen} onClick={() => setToolsOpen(open => !open)} className="signal-tools-heading">Дополнительные функции</button>{toolsOpen && <div className="signal-tool-grid">
      <section className="signal-card signal-tool signal-coming-soon"><span>Coming Soon</span></section>
      <section className="signal-card signal-tool signal-coming-soon"><span>Coming Soon</span></section>
      <section className="signal-card signal-tool signal-coming-soon"><span>Coming Soon</span></section>
    </div>}</section>
    <dialog ref={listDialog} className="signal-list-dialog" aria-labelledby="list-editor-title" onCancel={() => setListEditor(null)} onClose={() => setListEditor(null)} onClick={event => { if (event.target === event.currentTarget) { const r = event.currentTarget.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) setListEditor(null) } }}>
      <div className="signal-heading"><h2 id="list-editor-title">{listEditor === 'white' ? 'Белый список' : 'Чёрный список'}</h2><button aria-label="Закрыть список" onClick={() => setListEditor(null)}>×</button></div>
      <p className="signal-note">{listEditor === 'white' ? 'Не отписываться от этих пользователей.' : 'Не подписываться в ответ. Входящие заявки остаются без изменений.'} Профиль {listProfile}.</p>
      <form onSubmit={event => { event.preventDefault(); const value = listEditor === 'white' ? nickname : blockedNickname; if (!followBusy && value.trim()) { if (listEditor === 'white') saveWhitelist([...whitelist, value]); else saveBlacklist([...blacklist, value]) } }}>
        <input autoFocus aria-label="Ник пользователя" placeholder="Ник пользователя" maxLength={100} value={listEditor === 'white' ? nickname : blockedNickname} onChange={event => listEditor === 'white' ? setNickname(event.target.value) : setBlockedNickname(event.target.value)} />
        <button className="signal-primary" disabled={followBusy || !(listEditor === 'white' ? nickname : blockedNickname).trim()}>Добавить</button>
      </form>
      {followError && <p className="signal-note" role="status">{followError}</p>}
      <div className="signal-whitelist-names">{(listEditor === 'white' ? whitelist : blacklist).map(name => <span key={name}>{name}<button disabled={followBusy} aria-label={'Убрать из списка: ' + name} onClick={() => listEditor === 'white' ? saveWhitelist(whitelist.filter(n => n !== name)) : saveBlacklist(blacklist.filter(n => n !== name))}>×</button></span>)}</div>
    </dialog>
  </div>
}
