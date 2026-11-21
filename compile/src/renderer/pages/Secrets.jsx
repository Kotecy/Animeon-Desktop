import { useEffect, useMemo, useRef, useState } from 'react'
import bundledCatalog from '../../shared/secrets.json'
import { mergeSecretsCatalogs, sanitizeSecretsCatalog } from '../../shared/secretsCatalog'

const CODE_ALIASES = { secret_midnight_start: 'secret_midnight_premiere', secret_exchange: 'secret_equivalent_exchange', secret_midnight_anomaly: 'secret_anomaly_midnight' }
const NAME_ALIASES = { 'ровно в полночь': 'полночная премьера', 'тайминг': 'внахлёст', 'отошел за чаем': 'ушёл за чаем', 'отошёл за чаем': 'ушёл за чаем', 'ушел за чаем': 'ушёл за чаем' }
// Список секреток и инструкции лежат в src/shared/secrets.json. Встроенная копия
// работает без сети, свежая приходит с GitHub (main-процесс, secrets:refreshCatalog)
// при запуске и по кнопке «Синхронизировать». Новая секретка — правка secrets.json
// на GitHub, без новой версии приложения.
let ACHIEVEMENT_DETAILS = {}
let BASE_SECRETS = []
let IMPOSSIBLE_SECRETS = []
let OBSOLETE = new Set()
let HIDDEN_NAMES = new Set()

const rawCodeOf = item => {
  const direct = item?.code || item?.slug || item?.achievement_code || item?.achievement_key || item?.achievementKey
  const key = String(item?.key || '').trim()
  return String(direct || (isSecretCode(key.toLowerCase()) ? key : '')).trim().toLowerCase()
}
const codeOf = item => CODE_ALIASES[rawCodeOf(item)] || rawCodeOf(item)
const rawNameOf = item => String(item?.name || item?.title || item?.achievement_name || '').trim()
const nameOf = item => { const name = rawNameOf(item).toLowerCase(); return NAME_ALIASES[name] || name }
const detailsFor = item => ACHIEVEMENT_DETAILS[nameOf(item)] || null
const isSecretCode = code => code.startsWith('secret_') || code.startsWith('secret-')
const isCompleted = item => item?.completed === true || item?.is_completed === true || item?.isCompleted === true || item?.unlocked === true || item?.status === 'completed' || Boolean(item?.unlocked_at || item?.completed_at || item?.received_at)
const isImpossible = item => item?.category === 'impossible' || nameOf(item) === 'первый ключ'
const isSecretRemote = item => {
  const kind = String(item?.type || item?.category || item?.group || '').toLowerCase()
  return (Boolean(nameOf(item)) && BASE_SECRETS.some(secret => nameOf(secret) === nameOf(item))) || isSecretCode(codeOf(item)) || item?.is_secret === true || item?.isSecret === true || kind === 'secret' || kind === 'secrets'
}

const BUNDLED_CATALOG = sanitizeSecretsCatalog(bundledCatalog)
function applyCatalog(fresh) {
  const merged = mergeSecretsCatalogs(BUNDLED_CATALOG, sanitizeSecretsCatalog(fresh))
  OBSOLETE = new Set(merged.hidden.filter(code => !code.startsWith('name:')))
  HIDDEN_NAMES = new Set(merged.hidden.filter(code => code.startsWith('name:')).map(code => nameOf({ name: code.slice(5) })))
  const visible = merged.secrets
    .map(secret => ({ ...secret, code: secret.code ? (CODE_ALIASES[secret.code] || secret.code) : null }))
    .filter(secret => !OBSOLETE.has(secret.code || '') && !HIDDEN_NAMES.has(nameOf(secret)))
  ACHIEVEMENT_DETAILS = Object.fromEntries(visible.filter(secret => secret.description || secret.steps)
    .map(secret => [nameOf(secret), { description: secret.description, steps: secret.steps }]))
  BASE_SECRETS = visible.filter(secret => secret.category !== 'impossible')
    .map(({ code, key, name, desc }) => ({ code, key, name, desc, category: 'standard' }))
  IMPOSSIBLE_SECRETS = visible.filter(secret => secret.category === 'impossible')
    .map(({ code, key, name, desc, holder }) => ({ code, key, name, desc, holder, category: 'impossible' }))
}
applyCatalog(null)
const catalogDefs = () => [...BASE_SECRETS, ...IMPOSSIBLE_SECRETS]
const isHiddenSecret = item => OBSOLETE.has(codeOf(item)) || HIDDEN_NAMES.has(nameOf(item))

// Не используем key интерфейса как код API. Если сайт отдаст секретку без
// secret_*, фиксируем её по имени и не теряем при следующих синхронизациях.
const collectRemoteSecrets = (value, found = new Map(), seen = new WeakSet(), parentKey = '') => {
  const inheritedCode = isSecretCode(String(parentKey).toLowerCase()) ? String(parentKey).trim().toLowerCase() : ''
  if (value === null || value === undefined) return found
  if (typeof value !== 'object') {
    if (inheritedCode && value !== false && value !== 0 && value !== '') found.set(inheritedCode, { code: inheritedCode, received: true })
    return found
  }
  if (seen.has(value)) return found
  seen.add(value)
  if (Array.isArray(value)) { value.forEach((item, index) => collectRemoteSecrets(item, found, seen, String(index))); return found }
  const code = codeOf(value) || inheritedCode
  const candidate = code && !codeOf(value) ? { ...value, code } : value
  const name = nameOf(candidate)
  if (isSecretRemote(candidate) && !OBSOLETE.has(code)) found.set(code || `name:${name}`, candidate)
  Object.entries(value).forEach(([key, item]) => collectRemoteSecrets(item, found, seen, key))
  return found
}

const LockIcon = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3" /></svg>
const SparkIcon = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m12 3 1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5L12 3Z"/><path d="m19 16 .7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7L19 16Z"/></svg>

export default function Secrets() {
  const [achievements, setAchievements] = useState(null)
  const [catalog, setCatalog] = useState(catalogDefs)
  const [synced, setSynced] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const syncGeneration = useRef(0)
  const [cursorHint, setCursorHint] = useState(null)

  const showCursorHint = (event, item) => {
    if (!detailsFor(item)) return
    setCursorHint({ item, x: event.clientX, y: event.clientY })
  }
  const hideCursorHint = () => setCursorHint(null)
  useEffect(() => { const close = event => { if (event.key === 'Escape') setCursorHint(null) }; window.addEventListener('keydown', close); return () => window.removeEventListener('keydown', close) }, [])

  const mergeCatalog = (previous, remote) => {
    const next = [...previous]
    remote.forEach(item => {
      const index = next.findIndex(secret => (item.code && codeOf(secret) === item.code) || (nameOf(secret) && nameOf(secret) === nameOf(item)))
      if (index >= 0) next[index] = { ...next[index], ...item, category: isImpossible(next[index]) ? 'impossible' : item.category }
      else next.push(item)
    })
    return next
  }

  // fromButton: список секреток с GitHub запрашивается только по кнопке;
  // при открытии вкладки берётся сохранённый (main-процесс обновил его при запуске)
  const sync = async (fromButton = false) => {
    const generation = ++syncGeneration.current
    setLoading(true); setError('')
    setAchievements(null); setSynced(false)
    try {
      // Список секреток с GitHub обновляется вместе с аккаунтом; его ошибка синхронизацию не прерывает
      const [result, fresh] = await Promise.all([
        window.api?.achievementsFetch(),
        fromButton ? Promise.resolve(window.api?.secretsRefreshCatalog?.()).catch(() => null) : null
      ])
      if (generation !== syncGeneration.current) return
      if (fresh?.data) {
        applyCatalog(fresh.data)
        setCatalog(previous => mergeCatalog(previous, catalogDefs()))
      }
      if (!result?.ok) { setError(String(result?.error) === '401' ? 'Войдите в аккаунт AnimeOn для синхронизации' : 'Не удалось загрузить достижения'); return }
      setAchievements(result.data)
      const remote = [...collectRemoteSecrets(result.data)].map(([identity, item]) => {
        const code = codeOf(item), name = rawNameOf(item) || code || 'Неизвестная секретка'
        return { key: code || identity, sourceIdentity: identity, code: code || null, name, desc: String(item?.description || item?.desc || item?.hint || 'Секретка из профиля AnimeOn'), received: true, completed: isCompleted(item), category: isImpossible(item) ? 'impossible' : 'standard' }
      })
      setCatalog(previous => {
        // Описания и названия из secrets.json главнее присланных сайтом
        const next = mergeCatalog(mergeCatalog(previous, remote), catalogDefs())
        window.api?.storeSet?.('secretsCatalog', next)
        return next
      })
      setSynced(true)
    } catch (reason) { if (generation === syncGeneration.current) setError(String(reason)) } finally { if (generation === syncGeneration.current) setLoading(false) }
  }

  useEffect(() => {
    const bootstrap = async () => {
      const remote = await Promise.resolve(window.api?.secretsGetCatalog?.()).catch(() => null)
      if (remote?.data) applyCatalog(remote.data)
      const saved = await window.api?.storeGet?.('secretsCatalog')
      const savedSecrets = Array.isArray(saved)
        ? saved.filter(item => !isHiddenSecret(item) && (item?.received || isSecretCode(codeOf(item)) || isImpossible(item) || !codeOf(item)))
        : []
      setCatalog(mergeCatalog(mergeCatalog(catalogDefs(), savedSecrets), catalogDefs()))
      await sync()
    }
    bootstrap()
    const unsubscribe = window.api?.onAccountsUpdated?.(() => { setAchievements(null); setSynced(false); sync() })
    const unsubscribeCatalog = window.api?.onSecretsCatalogUpdated?.(data => {
      applyCatalog(data)
      setCatalog(previous => mergeCatalog(previous, catalogDefs()))
    })
    return () => { syncGeneration.current++; unsubscribe?.(); unsubscribeCatalog?.() }
  }, [])

  const remoteEntries = useMemo(() => [...collectRemoteSecrets(achievements)].map(([identity, item]) => ({ identity, code: codeOf(item), name: nameOf(item), item })), [achievements])
  const allSecrets = useMemo(() => catalog.filter(item => item?.key && !isHiddenSecret(item)), [catalog])
  const standardSecrets = useMemo(() => allSecrets.filter(item => !isImpossible(item)), [allSecrets])
  const impossibleSecrets = useMemo(() => allSecrets.filter(isImpossible), [allSecrets])
  const stateFor = item => {
    const code = codeOf(item), name = nameOf(item)
    const remote = remoteEntries.find(entry => (code && entry.code === code) || (name && entry.name === name))
    const done = Boolean(synced && remote)
    return { ...item, name: nameOf(item) === 'ушёл за чаем' ? 'Ушёл за чаем' : item.name, desc: detailsFor(item)?.description || remote?.item?.description || (nameOf(item) === 'три часа ночи' ? 'Семь ночей после 03:00.' : item.desc), code, done, visibleCode: synced && done && code ? code : '······' }
  }
  const displayed = standardSecrets.map(stateFor).filter(item => (item.name + ' ' + (item.code || '')).toLowerCase().includes(query.trim().toLowerCase()))

  const received = standardSecrets.filter(item => stateFor(item).done).length
  const percent = standardSecrets.length ? Math.round(received / standardSecrets.length * 100) : 0

  const selectedDetails = cursorHint ? detailsFor(cursorHint.item) : null
  const section = (title, items) => items.length > 0 && <section className="signal-secret-group"><div className="signal-kicker">{title} · {items.length}</div>{items.map(item => <article key={item.key} className={'signal-secret-row' + (item.done ? ' done' : '')}><span className="signal-secret-number">{String(standardSecrets.findIndex(secret => secret.key === item.key) + 1).padStart(2, '0')}</span><div className="signal-secret-copy"><h2>{item.name}</h2><p>{item.desc}</p></div><small>{item.done ? 'получено' : synced ? 'не открыто' : 'не проверено'}</small>{detailsFor(item) && <button className="signal-hint" aria-label={'Инструкция: ' + item.name} onClick={event => showCursorHint(event, item)}>?</button>}</article>)}</section>
  return <div className="signal-page">
    <div className="signal-kicker">КОЛЛЕКЦИЯ · {synced ? received : '—'}/{standardSecrets.length} · {synced ? percent + '%' : 'не синхронизировано'}</div>
    <h1>Секреты</h1><p className="signal-lede">Скрытые задания AnimeOn. Нажми на ? — покажем, как выполнить.</p>
    <div className="signal-search"><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Найти секрет…" aria-label="Найти секрет" /><button className="signal-primary" onClick={() => sync(true)} disabled={loading}>{loading ? 'Загрузка…' : 'Синхронизировать'}</button></div>
    {error && <p role="alert" className="signal-note">{error}. Проверьте вкладку AnimeOn и вход в аккаунт.</p>}
    {!query.trim() && impossibleSecrets.map(item => <details key={item.key} className="signal-impossible-spoiler"><summary>Секретка в единственном экземпляре</summary><article className="signal-impossible"><small>ЕДИНСТВЕННАЯ В МИРЕ · ВНЕ КОЛЛЕКЦИИ</small><h2>{item.name}</h2><p>{item.desc}</p><footer><span>Владелец: <button onClick={() => window.api?.storeGet?.('baseUrl').then(base => window.api?.tabsCreate?.(String(base || 'https://animeon.cc') + '/user/' + item.holder))}>{item.holder}</button></span><span>недостижима</span></footer></article></details>)}
    {section(synced ? 'ОСТАЛОСЬ ПОЛУЧИТЬ' : 'КОЛЛЕКЦИЯ', displayed.filter(item => !item.done))}
    {section('ПОЛУЧЕНО', displayed.filter(item => item.done))}
    {!displayed.length && <div className="signal-empty"><b>Ничего не найдено</b><p>Попробуй другое название или очисти поиск.</p><button onClick={() => setQuery('')}>Очистить поиск</button></div>}
    {cursorHint && selectedDetails && <div className="signal-overlay" onClick={hideCursorHint}><aside className="signal-instruction" role="dialog" aria-modal="true" aria-labelledby="instruction-title" onClick={event => event.stopPropagation()}><button className="signal-close" aria-label="Закрыть инструкцию" onClick={hideCursorHint}>×</button><small className="signal-kicker">КАК ВЫПОЛНИТЬ</small><h2 id="instruction-title">{cursorHint.item.name}</h2><p>{selectedDetails.description}</p>{selectedDetails.steps && <div className="signal-instruction-steps">{selectedDetails.steps}</div>}<button autoFocus className="signal-primary" onClick={hideCursorHint}>Понятно</button></aside></div>}
  </div>
}
