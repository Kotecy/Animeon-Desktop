// Детектор аномалий + автоподписка — встроенная функция приложения
// Кастомные тосты ачивок вырезаны: сайт сам показывает получение
//
// Важно: этот файл инжектится в контекст СТРАНИЦЫ через executeJavaScript,
// где require('electron') недоступен. Всё общение с main идёт через
// window.__animeon, который expose'ит настоящий preload (hidden.js).
(function () {
  if ((window as any).__acInjected) return
  ;(window as any).__acInjected = true
  const ANIMEON_HOSTS = new Set(['animeon.cc', 'animeon.co', 'v1.animeon.co', 'v2.animeon.co'])
  const isAnimeon = ANIMEON_HOSTS.has(location.hostname.toLowerCase())
  // Embedded Animeon must not be able to close the host tab.
  if (isAnimeon) {
    try { window.close = (() => {}) as any } catch {}
  }

  function host(): any {
    return (window as any).__animeon || null
  }
  async function storeGet(key: string): Promise<any> {
    try { return await host()?.storeGet(key) } catch { return undefined }
  }
  async function storeSet(key: string, val: any): Promise<void> {
    try { await host()?.storeSet(key, val) } catch {}
  }

  // Observe by default; collecting requires an explicit run-only switch.
  const ANOMALY_SELECTOR = 'button.anomaly-orb-root,button[aria-label="Аномалия — собрать награду"]'
  const ANOMALY_STATE_URL = '/api/event/boar/anomaly/state'
  const DETECT_SCAN_MS = 500
  const DETECT_GONE_MS = 4000
  const DETECT_STATE_READY_MS = 4000
  const DETECT_STATE_WAIT_MS = 12000
  const DETECT_STATE_IDLE_MS = 60000
  const DETECT_STATE_ERROR_MS = 15000
  const DETECT_WATCH_CACHE_MS = 5000
  let detPresent = false
  let detMissingSince = 0
  let detAlerted = false
  let detServerEligible = false
  let detWatchCache = { value: false, at: 0 }
  async function isWatching(): Promise<boolean> {
    const now = Date.now()
    if (now - detWatchCache.at < DETECT_WATCH_CACHE_MS) return detWatchCache.value
    try {
      const d = await storeGet('detector')
      detWatchCache = { value: !!(d && d.watching), at: now }
    } catch {}
    return detWatchCache.value
  }
  function highlightAnomaly(btn: Element | null) {
    try {
      document.querySelectorAll('[data-anomaly-hl]').forEach((n) => { if (n !== btn) (n as HTMLElement).removeAttribute('data-anomaly-hl') })
      if (btn) (btn as HTMLElement).setAttribute('data-anomaly-hl', '1')
    } catch {}
  }
  try {
    const st = document.createElement('style')
    st.setAttribute('data-anomaly-style', '1')
    st.textContent = '[data-anomaly-hl]{outline:2px solid #34d399 !important;outline-offset:3px;border-radius:12px;}'
    document.documentElement.appendChild(st)
  } catch {}
  async function notifyAnomaly(source: string) {
    try {
      const h = host() as any
      if (h && typeof h.anomalyDetected === 'function') {
        await h.anomalyDetected({ source, at: Date.now(), url: location.href })
      }
    } catch {}
  }
  async function handleAnomalySeen(btn: Element | null, source: string) {
    detMissingSince = 0
    highlightAnomaly(btn)
    if (!detPresent) {
      detPresent = true
      if (!detAlerted && (await isWatching())) {
        detAlerted = true
        await notifyAnomaly(source)
      }
    }
  }
  function handleAnomalyGone() {
    if (!detPresent) return
    const now = Date.now()
    if (!detMissingSince) { detMissingSince = now; return }
    if (now - detMissingSince < DETECT_GONE_MS) return
    detPresent = false
    detAlerted = false
    detMissingSince = 0
    highlightAnomaly(null)
  }
  async function scanAnomalyDom() {
    try {
      if (!(await isWatching())) {
        if (detPresent) { detPresent = false; detAlerted = false; detMissingSince = 0; highlightAnomaly(null) }
        return
      }
      const btn = document.querySelector(ANOMALY_SELECTOR)
      if (btn) { await handleAnomalySeen(btn, 'dom'); return }
      handleAnomalyGone()
    } catch {}
  }
  let detPollTimer: ReturnType<typeof setTimeout> | null = null
  let detPollRunning = false
  function scheduleStatePoll(ms: number) {
    if (detPollTimer) clearTimeout(detPollTimer)
    detPollTimer = setTimeout(() => {
      detPollTimer = null
      void pollAnomalyState()
    }, ms)
  }
  async function pollAnomalyState(): Promise<void> {
    if (detPollRunning) return
    detPollRunning = true
    try {
      if (!(await isWatching())) { scheduleStatePoll(DETECT_STATE_IDLE_MS); return }
      let delay = DETECT_STATE_WAIT_MS
      try {
        const r = await fetchWithTimeout(ANOMALY_STATE_URL, { credentials: 'include' }, DETECT_STATE_ERROR_MS)
        if (r.ok) {
          const j: any = await r.json().catch(() => null)
          const eligible = !!(j && j.eligible === true)
          if (eligible && !detServerEligible) {
            await handleAnomalySeen(document.querySelector(ANOMALY_SELECTOR), 'server')
          }
          if (!eligible) await host()?.anomalyAction('gone')
          // Collect via the confirmed empty-body POST, without DOM or reload.
          if (eligible) {
            const d = await storeGet('detector')
            if (d?.watching && d?.autoCollect) await host()?.anomalyClaim()
          }
          detServerEligible = eligible
          delay = eligible ? DETECT_STATE_READY_MS : DETECT_STATE_WAIT_MS
        }
      } catch { delay = DETECT_STATE_ERROR_MS }
      scheduleStatePoll(delay)
    } catch { scheduleStatePoll(DETECT_STATE_ERROR_MS) }
    finally { detPollRunning = false }
  }
  const detObserver = new MutationObserver(() => { void scanAnomalyDom() })
  detObserver.observe(document.documentElement, { childList: true, subtree: true })
  setInterval(() => { void scanAnomalyDom() }, DETECT_SCAN_MS)
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { void scanAnomalyDom() })
  else void scanAnomalyDom()
  scheduleStatePoll(2000)
  // Main вызывает wake после пробуждения Windows. Таймер заменяется одним
  // срочным polling-циклом, поэтому параллельные проверки не копятся.
  try {
    ;(window as any).__animeonDetector = {
      wake: () => {
        detWatchCache.at = 0
        void scanAnomalyDom()
        scheduleStatePoll(0)
      }
    }
  } catch {}
  if (!isAnimeon) return

  /* ═══════════════ Меню профиля: скролл в низком окне ═══════════════ */
  // Панель меню ищем по текстам («Мой профиль» + «Выйти»), без привязки к
  // классам сайта. Ограничиваем высоту и даём внутренний скролл, иначе пункты
  // внизу (включая «Выйти») недостижимы в невысоком окне.
  const MENU_FIX_MS = 2000
  let lastMenuFix = 0
  function fixProfileMenu() {
    const now = Date.now()
    if (now - lastMenuFix < MENU_FIX_MS) return
    lastMenuFix = now
    try {
      const divs = document.getElementsByTagName('div')
      let best: HTMLElement | null = null
      let bestLen = Infinity
      for (let i = 0; i < divs.length; i++) {
        const t = (divs[i] as HTMLElement).textContent || ''
        if (t.length < 20 || t.length > 3000) continue
        if (t.indexOf('Мой профиль') === -1 || t.indexOf('Выйти') === -1) continue
        if (t.length < bestLen) { best = divs[i] as HTMLElement; bestLen = t.length }
      }
      if (best && !(best as any).__menuFixed) {
        (best as any).__menuFixed = true
        best.style.setProperty('max-height', 'calc(100vh - 110px)', 'important')
        best.style.setProperty('overflow-y', 'auto', 'important')
      }
    } catch {}
  }
  setInterval(fixProfileMenu, MENU_FIX_MS)

  /* ═══════════════ Автоподписка (взаимная подписка) ═══════════════ */
  // Authenticated self identity and complete live lists. Main owns per-profile locks.
  const FOLLOWBACK_CHECK_MS = 180000
  const FOLLOWBACK_MAX_PER_RUN = 5
  // Короткий TTL: каждая перезагрузка/навигация рождает новый INSTANCE_ID,
  // а метка в общем store остаётся за мёртвым инстансом. С длинным TTL новый
  // контекст до 6 минут получал отказ в лидерстве — проверки вставали.
  // 45с достаточно против параллельных прогонов (интервал 3 мин).
  const FETCH_TIMEOUT_MS = 20000
  async function fetchWithTimeout(url: string, init?: RequestInit, ms = FETCH_TIMEOUT_MS): Promise<Response> {
    const ctrl = new AbortController()
    const t = setTimeout(() => { try { ctrl.abort() } catch {} }, ms)
    try {
      return await fetch(url, { ...(init || {}), signal: ctrl.signal })
    } finally { clearTimeout(t) }
  }
  const FB_LOG = '[AnimeonDesktop follow-back]'

  function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  const normalizeNick = (value: unknown) => String(value || '').normalize('NFKC').trim().replace(/^@/, '').toLowerCase()
  async function resolveOwnApiSegment(): Promise<string | null> {
    // Only authenticated self endpoints; never infer the owner from another user's page.
    for (const url of ['/api/auth/me', '/api/users/me', '/api/user/profile', '/api/profile']) {
      const response = await fetchWithTimeout(url, { credentials: 'include', cache: 'no-store' })
      if (response.status === 401 || response.status === 403) return null
      if (!response.ok) continue
      const body = await response.json().catch(() => null)
      const data = body?.data || body
      const user = data?.user || data?.profile || data
      const slug = user?.username_slug || user?.slug || user?.username || user?.nickname
      if (typeof slug === 'string' && slug.trim() && normalizeNick(slug) !== 'me') return slug.trim()
    }
    return null
  }

  async function readRelations(owner: string, kind: 'followers' | 'following') {
    const users = new Map<string, { slug: string, aliases: string[] }>()
    let expected: number | null = null
    for (let page = 1; page <= 100; page++) {
      if (!(await host()?.followbackClaim(owner, true))?.ok) throw new Error('Проверка остановлена')
      const response = await fetchWithTimeout(
        `/api/users/${encodeURIComponent(owner)}/${kind}?page=${page}&per_page=50`,
        { credentials: 'include', cache: 'no-store' })
      if (!response.ok) throw new Error(`Не удалось загрузить ${kind === 'followers' ? 'подписчиков' : 'подписки'} (HTTP ${response.status})`)
      const body = await response.json()
      const data = body?.data ?? body
      const rows = Array.isArray(data) ? data : data?.users
      if (!Array.isArray(rows)) throw new Error('Неизвестный формат списка; действия отменены')
      const total = body?.total ?? data?.total
      if (total != null) {
        if (!Number.isSafeInteger(total) || total < 0 || (expected !== null && total !== expected)) throw new Error('Список изменился во время загрузки; повторим проверку')
        expected = total
      }
      const before = users.size
      for (const row of rows) {
        const slug = row?.username_slug || row?.slug || row?.username
        if (typeof slug !== 'string' || !slug.trim()) throw new Error('В списке отсутствует ник; действия отменены')
        users.set(normalizeNick(slug), { slug, aliases: [slug, row.username, row.nickname].filter(Boolean).map(normalizeNick) })
      }
      if (expected !== null && users.size === expected) return users
      if (rows.length === 0) {
        if (expected === null) return users
        throw new Error('Получен неполный список; действия отменены')
      }
      if (users.size === before) throw new Error('Повтор страницы списка; действия отменены')
      // Without a total, read through an explicit empty page rather than assuming page size.
    }
    throw new Error('Список слишком большой для безопасной проверки')
  }

  function escapeHtml(str: string) {
    const d = document.createElement('div')
    d.textContent = str
    return d.innerHTML
  }

  // Очередь тостов подписки: показываем строго по одному (6с каждый),
  // а не стеком. Клик/свайп — пропуск к следующему.
  const followQueue: string[] = []
  let followPumping = false
  function showSingleFollowToast(name: string): Promise<void> {
    return new Promise((resolve) => {
      try {
        const el = document.createElement('div')
        el.setAttribute('data-animeon-toast', '1')
        el.setAttribute('style', 'position:fixed;left:16px;bottom:16px;z-index:2147483647;width:320px;background:#141521;border:1px solid rgba(139,92,246,.45);border-left:3px solid #8b5cf6;border-radius:12px;padding:12px 14px;color:#fff;font:13px/1.45 system-ui,sans-serif;box-shadow:0 18px 50px rgba(0,0,0,.5);display:flex;gap:10px;align-items:center;cursor:pointer')
        el.innerHTML = '<span style="flex:none;display:grid;place-items:center;width:36px;height:36px;border-radius:10px;background:rgba(139,92,246,.14);border:1px solid rgba(139,92,246,.35)"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="8" r="3.5"/><path d="M4 20c.7-3.2 3-5 6-5s5.3 1.8 6 5"/><path d="M18.5 8v6M15.5 11h6"/></svg></span><span style="min-width:0;flex:1"><span style="display:block;font-weight:600">' + escapeHtml(name) + '</span><span style="display:block;margin-top:2px;color:#d4d4d8">Подписался в ответ</span><span style="display:block;margin-top:4px;font-size:10px;color:#71717a">AnimeOn Desktop</span></span>'
        let done = false
        const finish = () => { if (done) return; done = true; try { el.remove() } catch {} ; resolve() }
        el.addEventListener('click', finish)
        let startY = 0
        el.addEventListener('touchstart', (e) => { try { startY = e.touches[0].clientY } catch {} })
        el.addEventListener('touchend', (e) => { try { if (e.changedTouches[0].clientY - startY > 40) finish() } catch {} })
        document.documentElement.appendChild(el)
        setTimeout(finish, 6000)
      } catch { resolve() }
    })
  }
  async function pumpFollowQueue() {
    if (followPumping) return
    followPumping = true
    try {
      while (followQueue.length) {
        const name = followQueue.shift() as string
        await showSingleFollowToast(name)
      }
    } finally { followPumping = false }
  }
  function enqueueFollow(names: string[]) {
    for (const n of names) { if (n) followQueue.push(String(n)) }
    if (followQueue.length > 10) followQueue.splice(0, followQueue.length - 10)
    void pumpFollowQueue()
  }
  // Пилюля лимита — прямоугольная со скруглением (rounded-xl стиль, НЕ овал),
  // рисуется ВНУТРИ страницы поверх сайта: углы ничего не режет.
  let limitPillTimer: any = null
  function showLimitPill(ms = 2500) {
    try {
      // Синглтон: пока пилюля висит — новые вызовы (спам 6-й вкладки)
      // игнорируются, очередь не копится.
      if (document.querySelector('[data-animeon-limit]')) return
      if (limitPillTimer) { clearTimeout(limitPillTimer); limitPillTimer = null }
      const el = document.createElement('div')
      el.setAttribute('data-animeon-limit', '1')
      el.setAttribute('style', 'position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:2147483647;display:flex;align-items:center;gap:8px;background:rgba(15,16,26,.72);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);border:1px solid rgba(139,92,246,.35);border-radius:10px;padding:8px 14px;color:#e4e4e7;font:500 12.5px/1.4 system-ui,sans-serif;box-shadow:0 12px 32px rgba(0,0,0,.45);white-space:nowrap;cursor:default')
      el.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="14" height="12" rx="2"/><path d="M7 20h7M17 8h4a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-4"/></svg><span>Достигнут лимит вкладок</span>'
      el.addEventListener('click', () => { try { el.remove() } catch {} ; if (limitPillTimer) { clearTimeout(limitPillTimer); limitPillTimer = null } })
      document.documentElement.appendChild(el)
      limitPillTimer = setTimeout(() => { try { el.remove() } catch {} ; limitPillTimer = null }, ms)
    } catch {}
  }
  // Тост детектора: emerald-карточка слева внизу (свой визуал, не копия
  // подписки). Синглтон: новый вызов заменяет висящий.
  // Если тост уже висит, а страница уходит в фулскрин — пересаживаем его
  // внутрь fullscreen-элемента, иначе он пропадёт вместе с остальной страницей.
  let anomalyFsHooked = false
  function hookAnomalyFullscreen() {
    if (anomalyFsHooked) return
    anomalyFsHooked = true
    try {
      document.addEventListener('fullscreenchange', () => {
        try {
          const mount = (document as any).fullscreenElement || document.documentElement
          document.querySelectorAll('[data-animeon-anomaly]').forEach((n) => { try { mount.appendChild(n) } catch {} })
        } catch {}
      })
    } catch {}
  }
  let anomalyToastTimer: any = null
  function showAnomalyToast() {
    try {
      document.querySelectorAll('[data-animeon-anomaly]').forEach((n) => { try { (n as HTMLElement).remove() } catch {} })
      if (anomalyToastTimer) { clearTimeout(anomalyToastTimer); anomalyToastTimer = null }
      const el = document.createElement('div')
      el.setAttribute('data-animeon-anomaly', '1')
      el.setAttribute('style', 'position:fixed;left:16px;bottom:16px;z-index:2147483647;width:320px;background:#101814;border:1px solid rgba(52,211,153,.55);border-radius:12px;padding:12px 14px;color:#fff;font:13px/1.45 system-ui,sans-serif;box-shadow:0 18px 50px rgba(0,0,0,.5);display:flex;gap:10px;align-items:center;cursor:pointer;text-shadow:0 1px 2px rgba(0,0,0,.8)')
      el.innerHTML = '<span style="flex:none;display:grid;place-items:center;width:36px;height:36px;border-radius:10px;background:rgba(52,211,153,.16);border:1px solid rgba(52,211,153,.45)"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#a7f3d0" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 12 18.3 5.7"/><circle cx="12" cy="12" r="1.4" fill="#a7f3d0" stroke="none"/></svg></span><span style="min-width:0;flex:1"><span style="display:block;font-weight:700;color:#fff">Нашли аномалию!</span><span style="display:block;margin-top:2px;color:#e4e4e7">Загляни на вкладку и забери награду</span><span style="display:block;margin-top:4px;font-size:10px;color:#a1a1aa">AnimeOn Desktop</span></span>'
      const finish = () => { try { el.remove() } catch {} ; if (anomalyToastTimer) { clearTimeout(anomalyToastTimer); anomalyToastTimer = null } }
      el.addEventListener('click', finish)
      let startY = 0
      el.addEventListener('touchstart', (e) => { try { startY = e.touches[0].clientY } catch {} })
      el.addEventListener('touchend', (e) => { try { if (e.changedTouches[0].clientY - startY > 40) finish() } catch {} })
      // В полноэкранном видео (плеер) элементы вне fullscreen-элемента
      // скрыты — вешаем тост внутрь него, тогда видно и поверх фильма.
      hookAnomalyFullscreen()
      const mount = (document as any).fullscreenElement || document.documentElement
      mount.appendChild(el)
      anomalyToastTimer = setTimeout(finish, 6000)
    } catch {}
  }
  // API для main-процесса: тосты рисуются в АКТИВНОЙ вкладке, а не в лидере.
  try { (window as any).__animeonToast = { limit: showLimitPill, follow: enqueueFollow, anomaly: showAnomalyToast } } catch {}

  // Основной канал уведомления — тост уровня приложения (виден всегда,
  // независимо от активной вкладки). Внутристраничный тост — только
  // fallback, если bridge недоступен.
  async function notifyFollowed(followedNames: string[]) {
    let delivered = false
    try {
      const h = host() as any
      if (h && typeof h.followbackNotify === 'function') {
        await h.followbackNotify(followedNames.slice(0, 5))
        delivered = true
      }
    } catch {}
    if (!delivered) {
      // Bridge недоступен — показываем локально по одному из очереди.
      enqueueFollow(followedNames)
    }
  }

  // Диагностика в файл (консоль вкладки пользователю не видна).
  function diag(msg: string) {
    try { console.log(FB_LOG, msg) } catch {}
    try { (host() as any)?.followbackDiag?.(FB_LOG + ' ' + msg) } catch {}
  }
  async function heartbeat() {
    try {
      const ts = Number(await storeGet('followbackLastCheck')) || Date.now()
      await (host() as any)?.followbackHeartbeat?.(ts)
    } catch {}
  }

  let fbRunning = false
  let nextAttempt = 0
  async function checkFollowBacks(force = false) {
    if (fbRunning || (!force && Date.now() < nextAttempt)) return
    fbRunning = true
    let claimed = false
    let summary: any = { ts: Date.now(), followed: 0, unfollowed: 0, unfollowedNames: [] }
    try {
      if (!(await storeGet('followBackEnabled'))) return
      const owner = await resolveOwnApiSegment()
      if (!owner) { nextAttempt = Date.now() + 15000; throw new Error('Войдите в Animeon для проверки подписок') }
      const claim = await host()?.followbackClaim(owner, false)
      if (!claim?.ok) { nextAttempt = Date.now() + 10000; return }
      claimed = true
      const followers = await readRelations(owner, 'followers')
      const following = await readRelations(owner, 'following')
      const matches = (user: { aliases: string[] }, list: Map<string, { aliases: string[] }>) =>
        [...list.values()].some(other => other.aliases.some(name => user.aliases.includes(name)))
      const protectedUser = async (user: { aliases: string[] }) => {
        const names = (await host()?.followbackLists())?.whitelist
        if (!Array.isArray(names)) return true
        const whitelist = new Set((Array.isArray(names) ? names : []).map(normalizeNick))
        return user.aliases.some(name => whitelist.has(name))
      }
      const stillAllowed = async () => {
        if (!(await storeGet('followBackEnabled'))) return false
        if (normalizeNick(await resolveOwnApiSegment()) !== normalizeNick(owner)) throw new Error('Аккаунт изменился; проверка остановлена')
        return !!(await host()?.followbackClaim(owner, true))?.ok
      }
      const removals = [...following.values()].filter(user => !matches(user, followers))
      // Re-read followers before removal: errors or incomplete pagination abort all mutations.
      const freshFollowers = removals.length ? await readRelations(owner, 'followers') : followers
      for (const user of removals.filter(user => !matches(user, freshFollowers))) {
        if (summary.unfollowed >= FOLLOWBACK_MAX_PER_RUN) break
        if (await protectedUser(user)) continue
        if (!(await stillAllowed())) break
        if (await protectedUser(user)) continue
        const response = await fetchWithTimeout(`/api/users/${encodeURIComponent(user.slug)}/follow`, { method: 'DELETE', credentials: 'include' })
        if (!response.ok) throw new Error(`Отписка не выполнена (HTTP ${response.status}); повторим позже`)
        summary.unfollowed++
        summary.unfollowedNames.push(user.slug)
        await sleep(400)
      }
      const followedNames: string[] = []
      const blockedUser = async (user: { aliases: string[] }) => {
        const names = (await host()?.followbackLists())?.blacklist
        // Fail closed when profile-specific lists cannot be read.
        if (!Array.isArray(names)) return true
        const blocked = new Set(names.map(normalizeNick))
        return user.aliases.some(name => blocked.has(name))
      }
      for (const user of freshFollowers.values()) {
        if (summary.followed >= FOLLOWBACK_MAX_PER_RUN) break
        if (matches(user, following) || normalizeNick(user.slug) === normalizeNick(owner)) continue
        if (await blockedUser(user)) continue
        if (!(await stillAllowed())) break
        if (await blockedUser(user)) continue
        const response = await fetchWithTimeout(`/api/users/${encodeURIComponent(user.slug)}/follow`, { method: 'POST', credentials: 'include' })
        if (!response.ok) throw new Error(`Подписка не выполнена (HTTP ${response.status}); повторим позже`)
        summary.followed++
        followedNames.push(user.slug)
        await sleep(400)
      }
      summary.followers = freshFollowers.size
      summary.segment = owner
      summary.ts = Date.now()
      summary.ok = true
      nextAttempt = Date.now() + FOLLOWBACK_CHECK_MS
      if (followedNames.length) await notifyFollowed(followedNames)
    } catch (error) {
      summary.ok = false
      summary.error = error instanceof Error ? error.message : 'Проверка подписок не выполнена'
      nextAttempt = Date.now() + (summary.followed || summary.unfollowed ? FOLLOWBACK_CHECK_MS : 30000)
      diag(summary.error)
    } finally {
      try { if (claimed || summary.error) await host()?.followbackFinish(summary, claimed) }
      catch { /* The next scheduled check retries after a disconnected bridge. */ }
      finally { fbRunning = false }
    }
  }
  ;(window as any).__animeonFollowback = { wake: () => { nextAttempt = 0; void checkFollowBacks(true) } }
  setInterval(() => { void checkFollowBacks() }, 10000)
  setTimeout(() => { void checkFollowBacks() }, 2000)
})()
