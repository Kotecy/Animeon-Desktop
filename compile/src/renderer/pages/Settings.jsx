import { useEffect, useState } from 'react'
import iconUrl from '../icon.png'

const plural = (n, one, few, many) => { const m = Math.abs(Number(n)) % 100; const d = m % 10; if (m > 10 && m < 20) return many; if (d > 1 && d < 5) return few; if (d === 1) return one; return many }
const normalizeSiteBaseUrl = value => { try { return new URL(String(value || '')).origin } catch { return 'https://v2.animeon.co' } }
const formatSiteBaseUrl = value => normalizeSiteBaseUrl(value).replace('https://', '')

const SlidersIcon = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M4 7h10M18 7h2M4 17h2M10 17h10" /><circle cx="16" cy="7" r="2" /><circle cx="8" cy="17" r="2" /></svg>
const GlobeIcon = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></svg>
const UserIcon = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="8" r="3.5" /><path d="M5 20c.7-3.2 3-5 7-5s6.3 1.8 7 5" /></svg>
const CHANGELOG = [
  { version: '0.4.0', date: '06.09.2026', items: ['Новый интерфейс приложения: вкладки, профили, функции и секреты', 'Инструкции секретов открываются по нажатию; добавлен поиск', 'Часы показывают московское время', 'Компактные карточки функций, исправления профилей и вкладок', 'При проблемах можно по желанию очистить локальные данные приложения. Это удалит входы в аккаунты и настройки; обязательной очистки нет.'] },
  { version: '0.3.14', date: '04.09.2026', items: [
    'Дополнительные инструменты собраны в компактный раздел под журналом действий',
        'XP Monitor автоматически определяет аккаунт и показывает точные XP и уровень без перехода в профиль',
    'Улучшено управление вкладками: прокрутка колесом мыши, закрытие средней кнопкой и сохранение выбранного адреса сайта',
    'Добавлена безопасная адресная строка, кнопка обновления страницы и горячие клавиши F5 и F12',
    'Секретки синхронизируются с аккаунтом, распознаются даже без локальной карточки и содержат инструкции по наведению на «?»',
    'Уникальная ачивка «Первый ключ» вынесена в отдельный раздел «Невозможные»',
    'Детектор аномалий продолжает наблюдение в фоне и возобновляет проверку после пробуждения Windows',
    'Исправлены повторные события интерфейса и повышена общая стабильность приложения',
  ] },
  { version: '0.3.0', date: '03.09.2026', items: ['Первый публичный релиз AnimeOn Desktop'] },
]

const CHANGELOG_BY_DATE = CHANGELOG.reduce((groups, release) => {
  const group = groups.find(item => item.date === release.date)
  if (group) group.releases.push(release)
  else groups.push({ date: release.date, releases: [release] })
  return groups
}, [])

export default function Settings({ baseUrl, onBaseUrl }) {
  const [nyaVisible, setNyaVisible] = useState(false)
  useEffect(() => {
    let keys = '', hideTimer, lastKeyAt = 0
    const onKey = event => {
      if (event.ctrlKey || event.altKey || event.metaKey || event.repeat || event.target.closest?.('input, textarea, [contenteditable]:not([contenteditable="false"])')) { keys = ''; return }
      if (Date.now() - lastKeyAt > 2000) keys = ''
      lastKeyAt = Date.now()
      keys = (keys + event.key.toLowerCase()).slice(-3)
      if (keys !== 'nya') return
      keys = ''; setNyaVisible(true); clearTimeout(hideTimer)
      hideTimer = setTimeout(() => setNyaVisible(false), 10000)
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey); clearTimeout(hideTimer) }
  }, [])
  const [version, setVersion] = useState('0.4.0')
  const [profileBusy, setProfileBusy] = useState(false)
  const [openProfileMenu, setOpenProfileMenu] = useState(null)
  useEffect(() => {
    if (openProfileMenu === null) return
    const outside = event => {
      if (!event.target.closest?.('.signal-profile-menu')) setOpenProfileMenu(null)
    }
    const escape = event => {
      if (event.key !== 'Escape') return
      document.querySelector('.signal-profile-menu[open] summary')?.focus()
      setOpenProfileMenu(null)
    }
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('keydown', escape)
    }
  }, [openProfileMenu])
  useEffect(() => { window.api?.appVersion?.().then(setVersion).catch(() => {}) }, [])
  const [url, setUrl] = useState(() => normalizeSiteBaseUrl(baseUrl))
  const [acc, setAcc] = useState(1)
  const [checking, setChecking] = useState(false)
  const [updateUrl, setUpdateUrl] = useState('')
  const [msg, setMsg] = useState('')
  const [accounts, setAccounts] = useState([{ id: '1', nickname: '' }])
  const [showChangelog, setShowChangelog] = useState(false)
  const [expandedLog, setExpandedLog] = useState('')
  const [switchAll, setSwitchAll] = useState(true)
  const [tabsCount, setTabsCount] = useState(0)
  const [siteOk, setSiteOk] = useState(true)
  useEffect(() => setUrl(normalizeSiteBaseUrl(baseUrl)), [baseUrl])
  useEffect(() => {
    window.api?.storeGetAll?.().then(s => {
      const saved = Number(s?.activeAccountId)
      if (saved >= 1 && saved <= 5) setAcc(saved)
      if (Array.isArray(s?.accounts) && s.accounts.length) setAccounts(s.accounts)
      if (s?.baseUrl) { const savedBaseUrl = normalizeSiteBaseUrl(s.baseUrl); setUrl(savedBaseUrl); onBaseUrl?.(savedBaseUrl) }
      setSwitchAll(s?.switchAllTabsOnProfileChange !== false)
      if (Array.isArray(s?.tabs)) { setTabsCount(s.tabs.length) }
    })
  }, [])
  const refreshAccounts = async () => {
    const [next, activeId, tabs] = await Promise.all([
      window.api?.accountsList?.(),
      window.api?.storeGet?.('activeAccountId'),
      window.api?.storeGet?.('tabs')
    ])
    if (Array.isArray(next) && next.length) setAccounts(next)
    const selected = Number(activeId)
    if (selected >= 1 && selected <= 5) setAcc(selected)
    if (Array.isArray(tabs)) { setTabsCount(tabs.length) }
  }
  // Slow safety poll: nickname sync now happens on page load in main, this is
  // only a fallback (e.g. in-page login without reload).
  useEffect(() => { refreshAccounts(); const timer = setInterval(refreshAccounts, 30000); return () => clearInterval(timer) }, [])
  useEffect(() => {
    const unsubscribe = window.api?.onTabsUpdated?.((t) => { if (Array.isArray(t)) setTabsCount(t.length) })
    return () => { if (typeof unsubscribe === 'function') unsubscribe() }
  }, [])
  useEffect(() => {
    const unsubscribe = window.api?.onAccountsUpdated?.((next, activeId) => {
      if (Array.isArray(next) && next.length) setAccounts(next)
      const selected = Number(activeId)
      if (selected >= 1 && selected <= 5) setAcc(selected)
    })
    return () => { if (typeof unsubscribe === 'function') unsubscribe() }
  }, [])

  const saveAccount = async (id) => { setAcc(Number(id)); await window.api?.accountsSelect?.(String(id)); refreshAccounts() }
  const saveBaseUrl = async () => {
    const nextBaseUrl = normalizeSiteBaseUrl(url)
    const saved = await window.api?.siteSetBaseUrl?.(nextBaseUrl)
    if (saved === false) return
    setUrl(nextBaseUrl)
    onBaseUrl?.(nextBaseUrl)
  }
  const removeAccount = async (id) => {
    if (profileBusy) return
    setOpenProfileMenu(null)
    setProfileBusy(true)
    try {
      const removed = await window.api?.accountsRemove?.(String(id))
      if (!removed) setMsg('Не удалось удалить профиль')
      await refreshAccounts()
    } catch { setMsg('Не удалось очистить сессию профиля. Повторите удаление.') }
    finally { setProfileBusy(false) }
  }
  const toggleSwitchAll = async () => { const next = !switchAll; setSwitchAll(next); await window.api?.storeSet?.('switchAllTabsOnProfileChange', next) }
  const addAccount = async () => {
    if (profileBusy || accounts.length >= 4) return
    setProfileBusy(true)
    try { const profile = await window.api?.accountsAdd?.(); if (!profile) setMsg('Не удалось добавить профиль'); await refreshAccounts() }
    catch { setMsg('Не удалось добавить профиль') }
    finally { setProfileBusy(false) }
  }
  const selectBase = async next => {
    try { const saved = await window.api?.siteSetBaseUrl?.(next); if (saved === false) { setMsg('Не удалось изменить адрес'); return } setUrl(next); onBaseUrl?.(next) }
    catch { setMsg('Не удалось изменить адрес') }
  }

  const siteVersions = Array.from({ length: 4 }, (_, i) => i + 1)

  return <div className="signal-page">
    <h1>Настройки</h1>
    <div className="signal-settings">
      <section className="signal-card"><div className="signal-heading"><h2>Профили</h2><small>{accounts.length} / 4</small></div>
        <p className="signal-note">Отдельная сессия для каждого аккаунта.</p>
        <div className="signal-profiles">{accounts.map(profile => {
          const active = Number(profile.id) === acc
          const name = profile.nickname || 'Профиль ' + profile.id
          return <article key={profile.id} className={'signal-profile' + (active ? ' active' : '')}>
            <button className="signal-profile-select" aria-pressed={active} onClick={() => saveAccount(profile.id)}><span className="signal-face">{name[0].toUpperCase()}</span><b>{name}</b><span className={profile.nickname ? 'signed-in' : 'signal-note'}>{profile.nickname ? '● Вход выполнен' : '○ Не авторизован'}</span><small>{active ? 'Выбран' : 'Выбрать профиль'}</small></button>
            <details className="signal-profile-menu" open={openProfileMenu === String(profile.id)}><summary aria-label={'Действия профиля ' + name} aria-expanded={openProfileMenu === String(profile.id)} onClick={event => { event.preventDefault(); setOpenProfileMenu(current => current === String(profile.id) ? null : String(profile.id)) }}>⋯</summary><button disabled={profileBusy} onClick={() => removeAccount(profile.id)}>{Number(profile.id) === 1 ? 'Очистить профиль' : 'Удалить профиль'}</button></details>
          </article>
        })}{Array.from({ length: Math.max(0, 4 - accounts.length) }, (_, slot) => <button key={'empty-' + slot} disabled={profileBusy} onClick={addAccount} className="signal-profile-add"><span>+</span>{profileBusy ? 'Добавление…' : 'Добавить профиль'}</button>)}</div>
        <div className="signal-setting-row signal-nya-anchor">{nyaVisible && <span className="signal-nya-code" role="status">NYA-D7E6-0187</span>}<div><b>Переключать профиль во всех вкладках</b><p>При смене профиля все вкладки перезагрузятся с выбранным аккаунтом. Если выключено — только текущая вкладка, остальные сохранят свои профили.</p></div><button role="switch" aria-checked={switchAll} aria-label="Переключать профиль во всех вкладках" onClick={toggleSwitchAll} className="signal-switch"><i /></button></div>
      </section>
      <div className="signal-column"><section className="signal-card"><h2>Адрес сайта</h2><p className="signal-note">Для новых вкладок AnimeOn.</p><div className="signal-envs">{['https://v1.animeon.co', 'https://v2.animeon.co'].map(value => <button key={value} aria-pressed={url === value} onClick={() => selectBase(value)}><b>{formatSiteBaseUrl(value)}</b><small>{url === value ? 'выбрано' : 'выбрать'}</small></button>)}</div></section>
        <section className="signal-card signal-about"><div className="signal-heading"><h2>О приложении</h2></div><div className="signal-brand"><img src={iconUrl} alt="" /><div><b>AnimeOn Desktop</b><p className="signal-note">v{version}</p></div></div>
          <button disabled={checking} onClick={async () => { if (updateUrl) { window.api?.appOpenUrl?.(updateUrl); return } setChecking(true); setMsg('Проверяем...'); setUpdateUrl(''); try { const result = await window.api?.appCheckUpdate?.(); if (!result?.ok) setMsg(result?.error || 'Не удалось проверить обновления'); else if (result.newer) { setMsg(`Доступна новая версия v${result.latest}`); setUpdateUrl(result.url || 'https://github.com/Kotecy/Animeon-Desktop/releases') } else setMsg(`Установлена актуальная v${result.current}`) } catch { setMsg('Не удалось проверить обновления') } setChecking(false) }} className="h-10 rounded-xl border border-white/15 bg-white px-4 text-sm font-medium text-black transition hover:bg-zinc-200 disabled:opacity-50">{checking ? 'Проверяем...' : updateUrl ? 'Установить новую версию ?' : 'Проверить обновления'}</button>
          {msg && <p className="signal-note" role="status">{msg}</p>}
          <details className="signal-history"><summary>История изменений</summary><div className="signal-history-dates">{CHANGELOG_BY_DATE.map(group => <details key={group.date} open={expandedLog === group.date}><summary onClick={event => { event.preventDefault(); const heading = event.currentTarget; const container = heading.closest('.signal-history-dates'); setExpandedLog(current => current === group.date ? '' : group.date); requestAnimationFrame(() => { if (container && heading.isConnected) container.scrollTop += heading.getBoundingClientRect().top - container.getBoundingClientRect().top }) }}>{group.date}</summary>{group.releases.map(release => <div className="release-entry" key={release.version}><b>v{release.version}</b><ul>{release.items.map(item => <li key={item}>{item}</li>)}</ul></div>)}</details>)}</div></details>
          <div className="signal-credits"><h3>Credits</h3>{[['Приложение', 'nieqq'], ['Скрипты детектора и XP Монитора', 'Suchka322']].map(([role, nick]) => <div key={nick}><span className="signal-note">{role}</span><a href={normalizeSiteBaseUrl(baseUrl) + '/user/' + encodeURIComponent(nick)} onClick={event => { event.preventDefault(); window.api?.tabsCreate?.(normalizeSiteBaseUrl(baseUrl) + '/user/' + encodeURIComponent(nick)) }}>by {nick} ↗</a></div>)}</div>
        </section>
      </div>
    </div>
  </div>
}
