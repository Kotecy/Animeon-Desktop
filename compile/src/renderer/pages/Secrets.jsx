import { useEffect, useId, useMemo, useRef, useState } from 'react'
import bundledCatalog from '../../shared/secrets.json'
import bundledIcons from '../../shared/secretIcons.json'
import { mergeSecretsCatalogs, sanitizeSecretsCatalog } from '../../shared/secretsCatalog'
import GuideText from '../components/GuideText'

// Список секреток, гайды, иконки и награды лежат в src/shared/secrets.json. Встроенная
// копия работает без сети, свежая приходит с GitHub (main-процесс, secrets:refreshCatalog)
// при запуске и по кнопке «Синхронизировать». Новая секретка — правка secrets.json
// на GitHub, без новой версии приложения.
// Если человек получил секретку раньше, чем она попала в secrets.json, код, название,
// описание, иконка и награда берутся из его ачивок (/api/achievements), без гайда.

// Старые коды и названия из прошлых версий списка и сохранённых данных → нынешние на сайте
const CODE_ALIASES = { secret_midnight_premiere: 'secret_midnight_start', secret_omedeto: 'secret_omedetou', secret_exchange: 'secret_equivalent_exchange', secret_midnight_anomaly: 'secret_anomaly_midnight' }
const NAME_ALIASES = { 'полночная премьера': 'ровно в полночь', 'тайминг': 'внахлёст', 'отошел за чаем': 'ушёл за чаем', 'отошёл за чаем': 'ушёл за чаем', 'ушел за чаем': 'ушёл за чаем', '1000-7': '1000 − 7' }

const ICON_RE = /^gi:[a-z0-9-]{1,64}$/
const PATH_RE = /^[MmLlHhVvCcSsQqTtAaZz0-9.,\-\se]{1,20000}$/
const BUNDLED_ICONS = bundledIcons.icons || {}
// Запасная иконка — звезда, если иконку не удалось получить
const FALLBACK_ICON = 'M256 38l63 152 164 13-125 107 39 160-141-86-141 86 39-160L29 203l164-13z'

const isSecretCode = code => code.startsWith('secret_') || code.startsWith('secret-')
const rawCodeOf = item => {
  const direct = item?.code || item?.slug || item?.achievement_code || item?.achievement_key || item?.achievementKey
  const key = String(item?.key || '').trim()
  return String(direct || (isSecretCode(key.toLowerCase()) ? key : '')).trim().toLowerCase()
}
const codeOf = item => CODE_ALIASES[rawCodeOf(item)] || rawCodeOf(item)
const rawNameOf = item => String(item?.name || item?.title || item?.achievement_name || '').trim()
const nameOf = item => { const name = rawNameOf(item).toLowerCase(); return NAME_ALIASES[name] || name }
const identityOf = item => codeOf(item) || 'name:' + nameOf(item)
const reward = value => Number.isInteger(value) && value >= 0 && value <= 100000 ? value : undefined
const iconOf = value => typeof value === 'string' && ICON_RE.test(value.trim().toLowerCase()) ? value.trim().toLowerCase() : undefined
const textOf = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : ''
const formatNumber = value => value.toLocaleString('ru-RU')

let FILE_DEFS = []
let HIDDEN = new Set()

const BUNDLED_CATALOG = sanitizeSecretsCatalog(bundledCatalog)
function applyCatalog(fresh) {
  const merged = mergeSecretsCatalogs(BUNDLED_CATALOG, sanitizeSecretsCatalog(fresh))
  HIDDEN = new Set(merged.hidden.map(entry => entry.startsWith('name:') ? 'name:' + nameOf({ name: entry.slice(5) }) : (CODE_ALIASES[entry] || entry)))
  // После алиасов старая и новая запись одной секретки сливаются в одну
  const byIdentity = new Map()
  for (const secret of merged.secrets) {
    const def = { ...secret, code: secret.code ? (CODE_ALIASES[secret.code] || secret.code) : null }
    const identity = def.code || 'name:' + nameOf(def)
    const sameName = [...byIdentity.entries()].find(([, existing]) => nameOf(existing) === nameOf(def))
    const key = byIdentity.has(identity) ? identity : sameName?.[0]
    if (key) byIdentity.set(key, { ...def, ...byIdentity.get(key), code: byIdentity.get(key).code || def.code })
    else byIdentity.set(identity, def)
  }
  FILE_DEFS = [...byIdentity.values()].filter(def => !isHidden(def))
}
const isHidden = item => HIDDEN.has(codeOf(item)) || HIDDEN.has('name:' + nameOf(item))
applyCatalog(null)

const isSecretRemote = item => {
  const kind = String(item?.type || item?.category || item?.group || '').toLowerCase()
  return String(item?.condition_tier || '').toLowerCase() === 'secret' || isSecretCode(codeOf(item))
    || item?.is_secret === true || item?.isSecret === true || kind === 'secret' || kind === 'secrets'
    || (Boolean(nameOf(item)) && FILE_DEFS.some(secret => nameOf(secret) === nameOf(item)))
}

// Секретки из ответа /api/achievements. Сайт отдаёт скрытые достижения только после
// получения, поэтому найденная здесь секретка — полученная.
const collectRemoteSecrets = (value, found = new Map(), seen = new WeakSet(), parentKey = '') => {
  const inheritedCode = isSecretCode(String(parentKey).toLowerCase()) ? String(parentKey).trim().toLowerCase() : ''
  if (value === null || value === undefined) return found
  if (typeof value !== 'object') {
    if (inheritedCode && value !== false && value !== 0 && value !== '') found.set(inheritedCode, { code: inheritedCode })
    return found
  }
  if (seen.has(value)) return found
  seen.add(value)
  if (Array.isArray(value)) { value.forEach((item, index) => collectRemoteSecrets(item, found, seen, String(index))); return found }
  const code = codeOf(value) || inheritedCode
  const candidate = code && !codeOf(value) ? { ...value, code } : value
  if (isSecretRemote(candidate) && candidate.completed !== false && (code || nameOf(candidate))) found.set(code || 'name:' + nameOf(candidate), candidate)
  Object.entries(value).forEach(([key, item]) => collectRemoteSecrets(item, found, seen, key))
  return found
}
// Только то, что можно показать: текст, иконка, награда
const remoteDef = item => {
  const code = codeOf(item) || null
  const def = { code, name: textOf(rawNameOf(item), 80) || code || 'Новая секретка', description: textOf(item?.description, 300) }
  const icon = iconOf(item?.icon)
  if (icon) def.icon = icon
  const trophies = reward(item?.trophy_points ?? item?.trophies)
  if (trophies !== undefined) def.trophies = trophies
  const animon = reward(item?.reward_animon ?? item?.animon)
  if (animon !== undefined) def.animon = animon
  return def
}

// Список карточек: secrets.json, затем открытые с аккаунта секретки, которых в нём нет.
// Из аккаунта берутся только недостающие поля (код, иконка, награда, описание).
function buildCards(discovered) {
  const cards = FILE_DEFS.map(def => ({ ...def, fromAccount: false }))
  for (const item of discovered) {
    if (!item || isHidden(item) || item.category === 'impossible') continue
    const index = cards.findIndex(card => (codeOf(item) && card.code === codeOf(item)) || nameOf(card) === nameOf(item))
    const extra = { code: codeOf(item) || null, name: textOf(item.name, 80), description: textOf(item.description, 300), icon: iconOf(item.icon), trophies: reward(item.trophies), animon: reward(item.animon) }
    if (index >= 0) {
      const card = cards[index]
      cards[index] = { ...card, code: card.code || extra.code, description: card.description || extra.description, icon: card.icon || extra.icon, trophies: card.trophies ?? extra.trophies, animon: card.animon ?? extra.animon }
    } else if (extra.name) cards.push({ ...extra, desc: '', fromAccount: true })
  }
  return cards.map(card => ({ ...card, id: identityOf(card) }))
}
// Сохранённые с аккаунта секретки (видны до синхронизации); старый формат тоже читается
const readDiscovered = saved => Array.isArray(saved) ? saved.filter(item => item && typeof item === 'object' && item.category !== 'impossible' && (isSecretCode(codeOf(item)) || nameOf(item))).map(item => ({
  code: codeOf(item) || null, name: textOf(rawNameOf(item), 80), description: textOf(item.description, 300), icon: iconOf(item.icon), trophies: reward(item.trophies), animon: reward(item.animon)
})).filter(item => item.name) : []

// Значок как у легендарных достижений сайта: металлическая шестигранная рамка с радужной
// каймой, тонкий орнамент вокруг, тёмная середина и белая иконка.
const hexPoints = (cx, cy, r, rotate = 0) => Array.from({ length: 6 }, (_, index) => {
  const angle = Math.PI / 180 * (60 * index - 90 + rotate)
  return (cx + r * Math.cos(angle)).toFixed(2) + ',' + (cy + r * Math.sin(angle)).toFixed(2)
}).join(' ')
const HEX_OUTER = hexPoints(50, 50, 38)
const HEX_RIM = hexPoints(50, 50, 33.5)
const HEX_INNER = hexPoints(50, 50, 29)
const HEX_ORNAMENT = [hexPoints(50, 50, 46, 8), hexPoints(50, 50, 44, -10), hexPoints(50, 50, 47.5, 30)]
function Badge({ d, done, size = 80 }) {
  const id = useId().replace(/:/g, '')
  // Неполученная — как на сайте: тёмный шестиугольник, двойная серая обводка, серая иконка
  if (!done) return <svg className="secret-badge" width={size} height={size} viewBox="0 0 100 100" aria-hidden="true">
    <polygon points={HEX_OUTER} fill="#1b1a20" stroke="#3a3842" strokeWidth="1.4" />
    <polygon points={HEX_INNER} fill="#222128" stroke="#34323c" strokeWidth="1" />
    <svg x="32" y="32" width="36" height="36" viewBox="0 0 512 512"><path d={d || FALLBACK_ICON} fill="#8b8896" /></svg>
  </svg>
  // Полученная — как легендарные на сайте, с анимацией: перелив по кайме, дыхание свечения,
  // импульс-кольцо, блик по граням, медленный орнамент. Всё на CSS (transform/opacity),
  // крутится только у видимых значков на открытой вкладке (см. useBadgeMotion).
  const url = name => 'url(#' + id + name + ')'
  return <svg className="secret-badge is-done" width={size} height={size} viewBox="0 0 100 100" aria-hidden="true">
    <defs>
      <linearGradient id={id + 'metal'} x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="#f1ecf7" /><stop offset=".35" stopColor="#a49cb2" /><stop offset=".55" stopColor="#5e566c" /><stop offset=".8" stopColor="#c9c1d6" /><stop offset="1" stopColor="#6e6680" />
      </linearGradient>
      <linearGradient id={id + 'holo'} x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="#ff8ad8" /><stop offset=".2" stopColor="#ffd36b" /><stop offset=".4" stopColor="#7cf0b4" /><stop offset=".6" stopColor="#6ec8ff" /><stop offset=".8" stopColor="#b48cff" /><stop offset="1" stopColor="#ff8ad8" />
      </linearGradient>
      <radialGradient id={id + 'core'} cx=".45" cy=".35" r=".75">
        <stop offset="0" stopColor="#8c6fb3" /><stop offset=".55" stopColor="#4a3766" /><stop offset="1" stopColor="#241a35" />
      </radialGradient>
      <linearGradient id={id + 'shine'} x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stopColor="#fff" stopOpacity="0" /><stop offset=".5" stopColor="#fff" stopOpacity=".55" /><stop offset="1" stopColor="#fff" stopOpacity="0" />
      </linearGradient>
      <mask id={id + 'rim'}><polygon points={HEX_RIM} fill="none" stroke="#fff" strokeWidth="2.8" /></mask>
      <clipPath id={id + 'inner'}><polygon points={HEX_INNER} /></clipPath>
      <filter id={id + 'blur'} x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="5" /></filter>
    </defs>
    <polygon className="secret-badge-glow" points={HEX_OUTER} fill="#9f7cff" filter={url('blur')} />
    <polygon className="secret-badge-pulse" points={HEX_OUTER} fill="none" stroke="#9ee9ff" strokeWidth="1.2" />
    <g className="secret-badge-ornament">{HEX_ORNAMENT.map(points => <polygon key={points} points={points} />)}</g>
    <polygon points={HEX_OUTER} fill={url('metal')} stroke="#2a2433" strokeWidth=".8" />
    <g mask={url('rim')}><rect className="secret-badge-holo" x="-25" y="-25" width="150" height="150" fill={url('holo')} /></g>
    <polygon points={HEX_INNER} fill={url('core')} stroke="#1c1526" strokeWidth=".8" />
    <g clipPath={url('inner')}><g transform="rotate(20 50 50)"><rect className="secret-badge-shine" x="10" y="-10" width="22" height="120" fill={url('shine')} /></g></g>
    <polygon points={HEX_INNER} fill="none" stroke="#ffffff" strokeOpacity=".18" strokeWidth=".6" transform="translate(0 .8)" />
    <svg x="32" y="32" width="36" height="36" viewBox="0 0 512 512"><path d={d || FALLBACK_ICON} fill="#fbf8ff" /></svg>
  </svg>
}

// Анимация значков только там, где её видно: значок в пределах окна (IntersectionObserver)
// и окно не свёрнуто. Вкладка «Секреты» вне экрана размонтирована — анимаций нет вовсе.
function useBadgeMotion(rootRef, deps) {
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const setHidden = () => root.classList.toggle('is-motion-paused', document.hidden)
    setHidden()
    document.addEventListener('visibilitychange', setHidden)
    const observer = typeof IntersectionObserver === 'function'
      ? new IntersectionObserver(entries => entries.forEach(entry => entry.target.classList.toggle('in-view', entry.isIntersecting)), { rootMargin: '40px' })
      : null
    root.querySelectorAll('.secret-badge.is-done').forEach(badge => observer ? observer.observe(badge) : badge.classList.add('in-view'))
    return () => { observer?.disconnect(); document.removeEventListener('visibilitychange', setHidden) }
  }, deps)
}

const Rewards = ({ card }) => <>
  {card.trophies !== undefined && <span className="secret-reward is-trophy">+{formatNumber(card.trophies)} трофеев</span>}
  {card.animon > 0 && <span className="secret-reward is-animon">+{formatNumber(card.animon)} AniMON</span>}
</>

export default function Secrets({ baseUrl }) {
  const [discovered, setDiscovered] = useState([])
  const [receivedIds, setReceivedIds] = useState(new Set())
  const [catalogVersion, setCatalogVersion] = useState(0)
  const [synced, setSynced] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const [guide, setGuide] = useState(null)
  const [extraIcons, setExtraIcons] = useState({})
  const syncGeneration = useRef(0)
  const pageRef = useRef(null)
  const requestedIcons = useRef(new Set())

  useEffect(() => { const close = event => { if (event.key === 'Escape') setGuide(null) }; window.addEventListener('keydown', close); return () => window.removeEventListener('keydown', close) }, [])

  // fromButton: список секреток с GitHub запрашивается только по кнопке;
  // при открытии вкладки берётся сохранённый (main-процесс обновил его при запуске)
  const sync = async (fromButton = false) => {
    const generation = ++syncGeneration.current
    setLoading(true); setError(''); setSynced(false)
    try {
      // Список секреток с GitHub обновляется вместе с аккаунтом; его ошибка синхронизацию не прерывает
      const [result, fresh] = await Promise.all([
        window.api?.achievementsFetch(),
        fromButton ? Promise.resolve(window.api?.secretsRefreshCatalog?.()).catch(() => null) : null
      ])
      if (generation !== syncGeneration.current) return
      if (fresh?.data) { applyCatalog(fresh.data); setCatalogVersion(version => version + 1) }
      if (!result?.ok) { setError(String(result?.error) === '401' ? 'Войдите в аккаунт AnimeOn для синхронизации' : 'Не удалось загрузить достижения'); return }
      const remote = [...collectRemoteSecrets(result.data).values()].filter(item => !isHidden(item)).map(remoteDef)
      setReceivedIds(new Set(remote.map(identityOf)))
      setDiscovered(previous => {
        const next = [...remote]
        for (const item of previous) if (!next.some(entry => identityOf(entry) === identityOf(item))) next.push(item)
        window.api?.storeSet?.('secretsCatalog', next)
        return next
      })
      setSynced(true)
    } catch (reason) { if (generation === syncGeneration.current) setError(String(reason)) } finally { if (generation === syncGeneration.current) setLoading(false) }
  }

  useEffect(() => {
    const bootstrap = async () => {
      const remote = await Promise.resolve(window.api?.secretsGetCatalog?.()).catch(() => null)
      if (remote?.data) { applyCatalog(remote.data); setCatalogVersion(version => version + 1) }
      setDiscovered(readDiscovered(await window.api?.storeGet?.('secretsCatalog')))
      await sync()
    }
    bootstrap()
    const unsubscribe = window.api?.onAccountsUpdated?.(() => { setReceivedIds(new Set()); setSynced(false); sync() })
    const unsubscribeCatalog = window.api?.onSecretsCatalogUpdated?.(data => { applyCatalog(data); setCatalogVersion(version => version + 1) })
    return () => { syncGeneration.current++; unsubscribe?.(); unsubscribeCatalog?.() }
  }, [])

  // catalogVersion: список из secrets.json сменился (applyCatalog)
  const cards = useMemo(() => buildCards(discovered), [discovered, catalogVersion])
  const isDone = card => synced && (receivedIds.has(card.id) || receivedIds.has('name:' + nameOf(card)))

  // Иконки, которых нет в приложении (новые секретки с аккаунта), — один раз через main-процесс
  useEffect(() => {
    const missing = [...new Set(cards.map(card => card.icon).filter(icon => icon && !BUNDLED_ICONS[icon] && !requestedIcons.current.has(icon)))]
    if (!missing.length || !window.api?.secretsIcons) return
    missing.forEach(icon => requestedIcons.current.add(icon))
    Promise.resolve(window.api.secretsIcons(missing)).then(result => {
      if (!result || typeof result !== 'object') return
      const valid = Object.fromEntries(Object.entries(result).filter(([name, d]) => ICON_RE.test(name) && typeof d === 'string' && PATH_RE.test(d)))
      if (Object.keys(valid).length) setExtraIcons(previous => ({ ...previous, ...valid }))
    }).catch(() => {})
  }, [cards])
  const iconPath = card => (card.icon && (BUNDLED_ICONS[card.icon] || extraIcons[card.icon])) || ''

  const doneCards = cards.filter(isDone)
  const leftCards = cards.filter(card => !isDone(card))
  const sum = (list, field) => list.reduce((total, card) => total + (card[field] || 0), 0)
  const percent = cards.length ? Math.round(doneCards.length / cards.length * 100) : 0
  const needle = query.trim().toLowerCase()
  const displayed = (filter === 'done' ? doneCards : filter === 'left' ? leftCards : cards)
    .filter(card => !needle || (card.name + ' ' + (card.description || '') + ' ' + (card.code || '')).toLowerCase().includes(needle))
  const hasGuide = card => Boolean(card.steps || card.desc)
  // Перепривязать наблюдение, когда меняется набор полученных значков на экране
  useBadgeMotion(pageRef, [cards, receivedIds, synced, filter, query, guide])
  const tabs = [['all', 'Все', cards.length], ['left', 'Осталось', leftCards.length], ['done', 'Получено', doneCards.length]]

  return <div ref={pageRef} className="signal-page secrets-page">
    <header className="secrets-head">
      <div>
        <div className="signal-kicker">СКРЫТЫЕ ДОСТИЖЕНИЯ</div>
        <h1>Секреты</h1>
        <p className="signal-lede">Скрытые задания AnimeOn: что дают и как их получить.</p>
      </div>
      <button className="signal-primary" onClick={() => sync(true)} disabled={loading}>{loading ? 'Загрузка…' : 'Синхронизировать'}</button>
    </header>

    <div className="secrets-stats">
      <div className="secrets-stat">
        <small>Получено</small>
        <b>{synced ? doneCards.length : '—'} <span>из {cards.length}</span></b>
        <div className="secrets-progress" aria-hidden="true"><i style={{ width: (synced ? percent : 0) + '%' }} /></div>
      </div>
      <div className="secrets-stat">
        <small>Твои трофеи</small>
        <b className="is-mint">{synced ? formatNumber(sum(doneCards, 'trophies')) : '—'}</b>
        <span>{synced ? 'за полученные секретки' : 'после синхронизации'}</span>
      </div>
      <div className="secrets-stat is-accent">
        <small>Ещё можно получить</small>
        <b>{formatNumber(sum(leftCards, 'trophies'))}</b>
        <span>трофеев · {formatNumber(sum(leftCards, 'animon'))} AniMON</span>
      </div>
    </div>

    {error && <p role="alert" className="signal-note">{error}. Проверьте вкладку AnimeOn и вход в аккаунт.</p>}

    <div className="secrets-toolbar">
      <div className="secrets-tabs" role="tablist" aria-label="Фильтр секреток">
        {tabs.map(([id, label, count]) => <button key={id} role="tab" aria-selected={filter === id} className={filter === id ? 'is-active' : ''} onClick={() => setFilter(id)}>{label}<span>{id !== 'all' && !synced ? '—' : count}</span></button>)}
      </div>
      <input className="secrets-search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Найти секрет…" aria-label="Найти секрет" />
    </div>

    <div className="secrets-grid">
      {displayed.map(card => {
        const done = isDone(card)
        return <article key={card.id} className={'secret-card' + (done ? ' is-done' : '')}>
          <div className="secret-card-top">
            <Badge d={iconPath(card)} done={done} />
            <div className="secret-card-copy">
              {card.fromAccount && <span className="secret-chip-new">Новая · гайда пока нет</span>}
              {card.unconfirmed && !card.fromAccount && <span className="secret-chip-new">Условия уточняются</span>}
              <h2>{card.name}</h2>
              <p>{card.description || card.desc}</p>
            </div>
          </div>
          <div className="secret-card-rewards"><Rewards card={card} /></div>
          <footer>
            <span className={'secret-status' + (done ? ' is-done' : '')}>{done ? '✓ Получено' : synced ? 'Не получено' : 'Не проверено'}</span>
            {hasGuide(card) && <button className="secret-how" aria-label={'Как получить: ' + card.name} onClick={() => setGuide(card)}>Как получить →</button>}
          </footer>
        </article>
      })}
    </div>
    {!displayed.length && <div className="signal-empty"><b>Ничего не найдено</b><p>{needle ? 'Попробуй другое название или очисти поиск.' : 'В этом списке пока пусто.'}</p>{needle && <button onClick={() => setQuery('')}>Очистить поиск</button>}</div>}

    {guide && <div className="signal-overlay" onClick={() => setGuide(null)}>
      <aside className="secret-guide" role="dialog" aria-modal="true" aria-labelledby="secret-guide-title" onClick={event => event.stopPropagation()}>
        <header>
          <div><small className="signal-kicker">КАК ПОЛУЧИТЬ</small><h2 id="secret-guide-title">{guide.name}</h2></div>
          <button autoFocus className="secret-guide-close" onClick={() => setGuide(null)}>Закрыть</button>
        </header>
        {(guide.trophies !== undefined || guide.animon > 0) && <div className="secret-guide-reward">
          <Badge d={iconPath(guide)} done size={72} />
          <div><small>Награда за достижение</small><b>{[guide.trophies !== undefined && '+' + formatNumber(guide.trophies) + ' трофеев', guide.animon > 0 && '+' + formatNumber(guide.animon) + ' AniMON'].filter(Boolean).join(' · ')}</b></div>
        </div>}
        {guide.unconfirmed && <div className="secret-guide-warning" role="note"><span aria-hidden="true">!</span><div><b>Условия уточняются</b><p>Этот способ пока не гарантирует получение награды.</p></div></div>}
        <GuideText text={guide.steps || guide.desc} baseUrl={baseUrl} />
      </aside>
    </div>}
  </div>
}
