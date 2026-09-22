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
  let collectorWidget: any = null
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
      collectorWidget?.onAnomalySeen?.(source)
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
          if (typeof j?.remaining_today === "number") collectorWidget?.updateRemaining?.(j.remaining_today)
          if (eligible && !detServerEligible) {
            await handleAnomalySeen(document.querySelector(ANOMALY_SELECTOR), 'server')
          }
          if (!eligible) await host()?.anomalyAction('gone')
          // Collect via the confirmed empty-body POST, without DOM or reload.
          if (eligible) {
            const d = await storeGet('detector')
            if (d?.watching && d?.autoCollect) {
              collectorWidget?.onCollecting?.()
              const claimRes = await host()?.anomalyClaim()
              collectorWidget?.onClaimResult?.(claimRes)
            }
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

  /* ═══════════════ Виджет «Автосбор» ═══════════════ */
  const APP_ICON_PNG = 'data:image/png;base64,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'
  function initAnomalyCollectorWidget() {
    let widgetRoot: HTMLDivElement | null = null
    let shadow: ShadowRoot | null = null
    let btnEl: HTMLDivElement | null = null
    let modalEl: HTMLDivElement | null = null
    let badgeEl: HTMLElement | null = null

    let activeTab: 'overview' | 'journal' = 'overview'
    let isEnabled = false
    let isModalOpen = false
    let hasUnread = false
    let tabsCount = 1
    let detectorConfig: any = { watching: false, autoCollect: false, sound: true, toast: true }
    let stats = { remaining: null as number | null, collected: 0, lastAt: '' }
    const journal: Array<{ time: string; text: string; type: 'info' | 'success' | 'warn' }> = []

    function formatTime(d = new Date()): string {
      return [
        String(d.getHours()).padStart(2, '0'),
        String(d.getMinutes()).padStart(2, '0'),
        String(d.getSeconds()).padStart(2, '0')
      ].join(':')
    }

    function addEntry(text: string, type: 'info' | 'success' | 'warn' = 'info') {
      const time = formatTime()
      journal.unshift({ time, text, type })
      if (journal.length > 50) journal.pop()
      renderCurrentTab()
    }

    function escapeWidgetHtml(s: string): string {
      return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    }

    async function refreshAnomalyState() {
      try {
        const r = await fetch(ANOMALY_STATE_URL, { credentials: 'include', cache: 'no-store' })
        if (r.ok) {
          const data: any = await r.json().catch(() => null)
          if (typeof data?.remaining_today === 'number') {
            stats.remaining = data.remaining_today
            renderCurrentTab()
          }
        }
      } catch {}
    }

    function ensureWidget() {
      if (widgetRoot) return
      widgetRoot = document.createElement('div')
      widgetRoot.id = 'animeon-collector-widget-root'
      shadow = widgetRoot.attachShadow({ mode: 'open' })

      const style = document.createElement('style')
      style.textContent = `
        :host {
          all: initial;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Inter", sans-serif;
          color: #ffffff;
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }

        .collector-btn {
          position: fixed;
          bottom: 24px;
          right: 24px;
          width: 48px;
          height: 48px;
          border-radius: 50%;
          background: #1e1a2b;
          border: 1.5px solid #584674;
          box-shadow: 0 10px 30px rgba(0,0,0,0.7), 0 0 20px rgba(187,167,236,0.3);
          display: grid;
          place-items: center;
          cursor: grab;
          user-select: none;
          touch-action: none;
          z-index: 2147483647;
          transition: transform .18s ease, box-shadow .18s ease, border-color .18s ease;
        }
        .collector-btn:hover {
          transform: scale(1.08);
          border-color: #8c6ebb;
          box-shadow: 0 12px 36px rgba(0,0,0,0.8), 0 0 24px rgba(187,167,236,0.5);
        }
        .collector-btn.dragging {
          cursor: grabbing;
          transform: scale(0.96);
        }
        .collector-btn svg {
          width: 22px;
          height: 22px;
          fill: none;
          stroke: #ded2f9;
          stroke-width: 1.8;
          stroke-linecap: round;
          stroke-linejoin: round;
          pointer-events: none;
        }
        .badge {
          position: absolute;
          top: -3px;
          right: -3px;
          width: 19px;
          height: 19px;
          border-radius: 50%;
          background: #ef4444;
          border: 2px solid #13121b;
          color: #ffffff;
          font-size: 11px;
          font-weight: 800;
          display: none;
          place-items: center;
          box-shadow: 0 0 10px rgba(239, 68, 68, 0.8);
          animation: badgePulse 1.8s infinite;
          pointer-events: none;
        }
        @keyframes badgePulse {
          0%, 100% { transform: scale(1); box-shadow: 0 0 8px rgba(239, 68, 68, 0.7); }
          50% { transform: scale(1.15); box-shadow: 0 0 16px rgba(239, 68, 68, 0.95); }
        }

        .modal {
          position: fixed;
          bottom: 84px;
          right: 24px;
          width: 380px;
          max-width: calc(100vw - 32px);
          max-height: calc(100vh - 48px);
          background: rgba(16, 14, 23, 0.75);
          backdrop-filter: blur(28px) saturate(1.4);
          -webkit-backdrop-filter: blur(28px) saturate(1.4);
          border: 1px solid rgba(255, 255, 255, 0.12);
          border-radius: 20px;
          box-shadow: 0 24px 64px rgba(0,0,0,0.75), 0 0 0 1px rgba(255,255,255,0.06), inset 0 1px 0 rgba(255,255,255,0.12);
          z-index: 2147483647;
          display: none;
          flex-direction: column;
          padding: 18px 20px;
          overflow: hidden;
          animation: modalIn .22s cubic-bezier(0.16, 1, 0.3, 1);
        }
        @keyframes modalIn {
          from { opacity: 0; transform: translateY(12px) scale(0.97); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
        .modal.open { display: flex; }

        .header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 14px;
          cursor: grab;
          user-select: none;
          touch-action: none;
        }
        .header:active {
          cursor: grabbing;
        }
        .header-left {
          display: flex;
          align-items: center;
          gap: 12px;
        }
        .header-icon {
          width: 32px;
          height: 32px;
          border-radius: 8px;
          flex: none;
          display: block;
          object-fit: cover;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
          user-select: none;
          -webkit-user-drag: none;
          pointer-events: none;
        }
        .header-title b {
          font-size: 17px;
          font-weight: 700;
          color: #ffffff;
          letter-spacing: -0.01em;
        }
        .close-btn {
          width: 32px;
          height: 32px;
          border-radius: 50%;
          border: 1px solid rgba(255, 255, 255, 0.08);
          background: rgba(255, 255, 255, 0.05);
          color: #a19cb2;
          display: grid;
          place-items: center;
          font-size: 18px;
          line-height: 1;
          cursor: pointer;
          transition: background .15s ease, color .15s ease;
        }
        .close-btn:hover {
          background: rgba(255, 255, 255, 0.1);
          color: #ffffff;
        }

        .nav-tabs {
          display: flex;
          gap: 4px;
          background: rgba(255, 255, 255, 0.04);
          border: 1px solid rgba(255, 255, 255, 0.06);
          border-radius: 10px;
          padding: 3px;
          margin-bottom: 14px;
        }
        .tab-btn {
          background: transparent;
          color: #807b92;
          font-size: 12px;
          font-weight: 500;
          border: none;
          border-radius: 7px;
          padding: 5px 14px;
          cursor: pointer;
          white-space: nowrap;
          transition: all .15s ease;
          flex: 1;
          text-align: center;
        }
        .tab-btn:hover {
          color: #d1cde0;
          background: rgba(255, 255, 255, 0.04);
        }
        .tab-btn.active {
          background: rgba(255, 255, 255, 0.08);
          color: #ffffff;
          font-weight: 600;
        }

        .content-scroll {
          overflow-y: auto;
          display: flex;
          flex-direction: column;
          gap: 14px;
          max-height: 480px;
          padding-right: 2px;
          padding-bottom: 2px;
        }
        .content-scroll::-webkit-scrollbar { width: 4px; }
        .content-scroll::-webkit-scrollbar-thumb { background: #322d42; border-radius: 2px; }

        .hero-card {
          border-radius: 14px;
          border: 1px solid rgba(187, 167, 236, 0.16);
          background: rgba(23, 23, 31, 0.7);
          backdrop-filter: blur(16px);
          padding: 16px 18px;
          display: flex;
          flex-direction: column;
          gap: 12px;
          box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05), 0 8px 24px rgba(0, 0, 0, 0.4);
        }
        .hero-top {
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        .hero-status {
          display: inline-flex;
          align-items: center;
          gap: 7px;
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.06em;
          color: #ded2f9;
          text-transform: uppercase;
        }
        .hero-dot {
          width: 7px;
          height: 7px;
          border-radius: 50%;
          background: #34d399;
          box-shadow: 0 0 8px rgba(52, 211, 153, 0.7);
          display: inline-block;
        }
        .hero-tag {
          font-size: 10px;
          font-weight: 700;
          font-family: monospace;
          padding: 2px 7px;
          background: rgba(187, 167, 236, 0.1);
          border: 1px solid rgba(187, 167, 236, 0.22);
          border-radius: 5px;
          color: #ded2f9;
          letter-spacing: 0.05em;
        }
        .hero-meta {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 8px;
          padding-top: 10px;
          border-top: 1px solid rgba(255, 255, 255, 0.06);
          text-align: center;
        }
        .meta-col {
          display: flex;
          flex-direction: column;
          gap: 3px;
        }
        .meta-col small {
          font-size: 10px;
          color: #918ba3;
          text-transform: uppercase;
          letter-spacing: 0.04em;
        }
        .meta-col b {
          font-size: 14px;
          font-weight: 700;
          color: #eeedf5;
        }

        .dark-box {
          background: rgba(255, 255, 255, 0.03);
          border: 1px solid rgba(255, 255, 255, 0.06);
          border-radius: 12px;
          padding: 16px;
        }
        .empty-center { text-align: center; }
        .empty-title {
          font-size: 13px;
          font-weight: 600;
          color: #ffffff;
          margin-bottom: 4px;
        }
        .empty-desc {
          font-size: 12px;
          color: #807b92;
        }

        .journal-list {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .entry {
          display: flex;
          align-items: baseline;
          gap: 8px;
          font-size: 11px;
          line-height: 1.4;
          color: #d1cde0;
          padding: 7px 10px;
          background: rgba(255,255,255,0.02);
          border-radius: 8px;
          border: 1px solid rgba(255,255,255,0.04);
        }
        .entry .dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          flex: none;
        }
        .entry .time {
          font-size: 10px;
          color: #7d7590;
          font-family: monospace;
          flex: none;
        }
        .entry .text {
          flex: 1;
          word-break: break-word;
        }
      `
      shadow.appendChild(style)

      btnEl = document.createElement('div')
      btnEl.className = 'collector-btn'
      btnEl.title = 'Автосбор аномалий (перетащите для перемещения)'
      btnEl.innerHTML = `
        <svg viewBox="0 0 24 24">
          <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
          <circle cx="12" cy="12" r="3.2" />
        </svg>
        <span class="badge">!</span>
      `
      badgeEl = btnEl.querySelector('.badge')

      modalEl = document.createElement('div')
      modalEl.className = 'modal'
      modalEl.innerHTML = `
        <div class="header">
          <div class="header-left">
            <img class="header-icon" src="${APP_ICON_PNG}" alt="AnimeOn" draggable="false" />
            <div class="header-title">
              <b>Автосбор</b>
            </div>
          </div>
          <button class="close-btn" title="Закрыть">×</button>
        </div>
        <div class="nav-tabs">
          <button class="tab-btn active" data-tab="overview">Обзор</button>
          <button class="tab-btn" data-tab="journal">Журнал</button>
        </div>
        <div class="content-scroll" id="tab-content"></div>
      `
      shadow.appendChild(btnEl)
      shadow.appendChild(modalEl)

      modalEl.querySelector('.close-btn')?.addEventListener('click', (e) => {
        e.stopPropagation()
        toggleModal(false)
      })

      modalEl.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation()
          const tab = (btn as HTMLElement).dataset.tab as any
          if (tab) {
            activeTab = tab
            modalEl?.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', (b as HTMLElement).dataset.tab === activeTab))
            renderCurrentTab()
          }
        })
      })

      setupDrag(btnEl)
      setupModalDrag(modalEl)
      restoreSavedPosition()
      renderCurrentTab()
      updateStats()
      void refreshAnomalyState()
    }

    function restoreSavedPosition() {
      storeGet('collectorBtnPos').then((pos: any) => {
        if (!btnEl) return
        if (pos && typeof pos.left === 'string' && typeof pos.top === 'string') {
          btnEl.style.left = pos.left
          btnEl.style.top = pos.top
          btnEl.style.right = 'auto'
          btnEl.style.bottom = 'auto'
          if (isModalOpen && !userMovedModal) repositionModal()
        }
      }).catch(() => {})
      storeGet('collectorModalPos').then((pos: any) => {
        if (!modalEl) return
        if (pos && typeof pos.left === 'string' && typeof pos.top === 'string') {
          userMovedModal = true
          modalEl.style.left = pos.left
          modalEl.style.top = pos.top
          modalEl.style.right = 'auto'
          modalEl.style.bottom = 'auto'
        }
      }).catch(() => {})
    }

    function renderCurrentTab() {
      if (!modalEl) return
      const container = modalEl.querySelector('#tab-content')
      if (!container) return

      if (activeTab === 'overview') {
        container.innerHTML = `
          <div class="hero-card">
            <div class="hero-top">
              <span class="hero-status"><span class="hero-dot"></span>АВТОСБОР АКТИВЕН</span>
              <span class="hero-tag">AUTO</span>
            </div>
            <div class="hero-meta">
              <div class="meta-col">
                <small>Остаток</small>
                <b>${stats.remaining !== null && stats.remaining !== undefined ? stats.remaining : '—'}</b>
              </div>
              <div class="meta-col">
                <small>Собрано</small>
                <b style="color:#bba7ec;">${stats.collected}</b>
              </div>
              <div class="meta-col">
                <small>Последний сбор</small>
                <b>${stats.lastAt || '—'}</b>
              </div>
            </div>
          </div>
        `
      } else if (activeTab === 'journal') {
        if (!journal.length) {
          container.innerHTML = `
            <div class="dark-box empty-center">
              <div class="empty-title">Журнал пуст</div>
              <div class="empty-desc">Здесь появится история обнаружения и сбора аномалий на странице.</div>
            </div>
          `
        } else {
          container.innerHTML = `
            <div class="journal-list">
              ${journal.map(item => {
                const dotColor = item.type === 'success' ? '#34d399' : item.type === 'warn' ? '#f87171' : '#bba7ec'
                return `<div class="entry"><span class="dot" style="background:${dotColor}"></span><span class="time">${item.time}</span><span class="text">${escapeWidgetHtml(item.text)}</span></div>`
              }).join('')}
            </div>
          `
        }
      }
    }

    function updateStats() {
      if (badgeEl) badgeEl.style.display = hasUnread ? 'grid' : 'none'
    }

    let userMovedModal = false
    function repositionModal() {
      if (!btnEl || !modalEl) return
      if (userMovedModal) {
        const rect = modalEl.getBoundingClientRect()
        const maxLeft = Math.max(12, window.innerWidth - modalEl.offsetWidth - 12)
        const maxTop = Math.max(12, window.innerHeight - modalEl.offsetHeight - 12)
        if (rect.left > maxLeft || rect.top > maxTop || rect.left < 12 || rect.top < 12) {
          modalEl.style.left = Math.max(12, Math.min(maxLeft, rect.left)) + 'px'
          modalEl.style.top = Math.max(12, Math.min(maxTop, rect.top)) + 'px'
        }
        return
      }
      const rect = btnEl.getBoundingClientRect()
      const mWidth = modalEl.offsetWidth || 380
      const mHeight = modalEl.offsetHeight || 190
      let mLeft = rect.right - mWidth
      let mTop = rect.top - mHeight - 14
      if (mLeft < 16) mLeft = 16
      if (mLeft + mWidth > window.innerWidth - 16) mLeft = window.innerWidth - mWidth - 16
      if (mTop < 16) {
        mTop = rect.bottom + 14
      }
      if (mTop + mHeight > window.innerHeight - 16) {
        mTop = Math.max(16, window.innerHeight - mHeight - 16)
      }
      modalEl.style.left = mLeft + 'px'
      modalEl.style.top = mTop + 'px'
      modalEl.style.bottom = 'auto'
      modalEl.style.right = 'auto'
    }

    function toggleModal(open?: boolean) {
      isModalOpen = typeof open === 'boolean' ? open : !isModalOpen
      if (modalEl) modalEl.classList.toggle('open', isModalOpen)
      if (isModalOpen) {
        hasUnread = false
        updateStats()
        renderCurrentTab()
        repositionModal()
        void refreshAnomalyState()
      }
    }

    function setupModalDrag(modal: HTMLElement) {
      const header = modal.querySelector('.header') as HTMLElement
      if (!header) return
      let isDragging = false
      let startX = 0, startY = 0
      let initLeft = 0, initTop = 0

      header.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return
        if ((e.target as HTMLElement)?.closest('.close-btn')) return
        isDragging = true
        startX = e.clientX
        startY = e.clientY
        const rect = modal.getBoundingClientRect()
        initLeft = rect.left
        initTop = rect.top
        header.setPointerCapture(e.pointerId)
      })

      header.addEventListener('pointermove', (e) => {
        if (!isDragging) return
        const dx = e.clientX - startX
        const dy = e.clientY - startY
        if (Math.hypot(dx, dy) > 3) {
          userMovedModal = true
          const maxLeft = Math.max(12, window.innerWidth - modal.offsetWidth - 12)
          const maxTop = Math.max(12, window.innerHeight - modal.offsetHeight - 12)
          const newLeft = Math.max(12, Math.min(maxLeft, initLeft + dx))
          const newTop = Math.max(12, Math.min(maxTop, initTop + dy))
          modal.style.left = newLeft + 'px'
          modal.style.top = newTop + 'px'
          modal.style.bottom = 'auto'
          modal.style.right = 'auto'
        }
      })

      const finish = (e: PointerEvent) => {
        if (!isDragging) return
        isDragging = false
        try { header.releasePointerCapture(e.pointerId) } catch {}
        if (userMovedModal) {
          void storeSet('collectorModalPos', { left: modal.style.left, top: modal.style.top })
        }
      }

      header.addEventListener('pointerup', finish)
      header.addEventListener('pointercancel', finish)
    }

    function setupDrag(button: HTMLElement) {
      let isDragging = false
      let startX = 0, startY = 0
      let initLeft = 0, initTop = 0
      let moved = false

      button.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return
        isDragging = true
        moved = false
        startX = e.clientX
        startY = e.clientY
        const rect = button.getBoundingClientRect()
        initLeft = rect.left
        initTop = rect.top
        button.setPointerCapture(e.pointerId)
        button.classList.add('dragging')
      })

      button.addEventListener('pointermove', (e) => {
        if (!isDragging) return
        const dx = e.clientX - startX
        const dy = e.clientY - startY
        if (Math.hypot(dx, dy) > 4) moved = true
        if (moved) {
          const newLeft = Math.max(12, Math.min(window.innerWidth - 60, initLeft + dx))
          const newTop = Math.max(12, Math.min(window.innerHeight - 60, initTop + dy))
          button.style.left = newLeft + 'px'
          button.style.top = newTop + 'px'
          button.style.right = 'auto'
          button.style.bottom = 'auto'
          if (isModalOpen && !userMovedModal) {
            repositionModal()
          }
        }
      })

      const finish = (e: PointerEvent) => {
        if (!isDragging) return
        isDragging = false
        button.classList.remove('dragging')
        try { button.releasePointerCapture(e.pointerId) } catch {}
        if (!moved) {
          toggleModal()
        } else {
          void storeSet('collectorBtnPos', { left: button.style.left, top: button.style.top })
          if (isModalOpen && !userMovedModal) {
            repositionModal()
          }
        }
      }

      button.addEventListener('pointerup', finish)
      button.addEventListener('pointercancel', finish)
    }

    function setEnabled(enabled: boolean) {
      if (isEnabled === enabled) return
      isEnabled = enabled
      if (isEnabled) {
        ensureWidget()
        if (widgetRoot && !widgetRoot.isConnected) (document.body || document.documentElement).appendChild(widgetRoot)
        if (widgetRoot) widgetRoot.style.display = 'block'
      } else {
        if (widgetRoot) widgetRoot.style.display = 'none'
        toggleModal(false)
      }
    }

    return {
      openModal() {
        setEnabled(true)
        toggleModal(true)
      },
      updateConfig(d: any) {
        detectorConfig = d || {}
        if (typeof d?.count === 'number') stats.collected = d.count
        if (d?.lastAt) stats.lastAt = formatTime(new Date(d.lastAt))
        const shouldShow = Boolean(d?.watching && d?.autoCollect)
        setEnabled(shouldShow)
        renderCurrentTab()
      },
      updateTabsCount(count: number) {
        tabsCount = count || 1
      },
      updateRemaining(rem: number) {
        stats.remaining = rem
        if (activeTab === 'overview') renderCurrentTab()
      },
      onAnomalySeen(source: string) {
        addEntry(`Найдена аномалия (${source === 'server' ? 'сервер' : 'страница'})`, 'info')
        updateStats()
      },
      onCollecting() {
        addEntry('Запрос на сбор аномалии…', 'info')
      },
      onClaimResult(result: any) {
        const time = formatTime()
        stats.lastAt = time
        if (result?.status === 'accepted') {
          stats.collected++
          if (typeof stats.remaining === 'number' && stats.remaining > 0) {
            stats.remaining--
          }
          void refreshAnomalyState()
          addEntry('Собрана аномалия (успешно)', 'success')
          if (!isModalOpen) {
            hasUnread = true
          }
        } else if (result?.status === 'failed') {
          addEntry(`Ошибка сбора (HTTP ${result?.httpStatus || '—'})`, 'warn')
        } else {
          addEntry('Сбор отложен или пропущен', 'warn')
        }
        updateStats()
        renderCurrentTab()
      }
    }
  }

  collectorWidget = initAnomalyCollectorWidget()
  storeGet('detector').then(d => collectorWidget?.updateConfig(d)).catch(() => {})
  host()?.getTabsCount?.().then((cnt: number) => collectorWidget?.updateTabsCount(cnt)).catch(() => {})
  host()?.onDetectorUpdated?.((d: any) => collectorWidget?.updateConfig(d))
  host()?.onCollectorEvent?.((data: any) => collectorWidget?.onClaimResult(data))
  host()?.onOpenDetectorModal?.(() => collectorWidget?.openModal())
  setInterval(() => {
    storeGet('detector').then(d => collectorWidget?.updateConfig(d)).catch(() => {})
    host()?.getTabsCount?.().then((cnt: number) => collectorWidget?.updateTabsCount(cnt)).catch(() => {})
  }, 5000)

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
  const FOLLOWBACK_CHECK_MS = 600000
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
      if (!owner) { nextAttempt = Date.now() + FOLLOWBACK_CHECK_MS; throw new Error('Войдите в Animeon для проверки подписок') }
      const claim = await host()?.followbackClaim(owner, false)
      if (!claim?.ok) { nextAttempt = Date.now() + FOLLOWBACK_CHECK_MS; return }
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
      nextAttempt = Date.now() + FOLLOWBACK_CHECK_MS
      diag(summary.error)
    } finally {
      try { if (claimed || summary.error) await host()?.followbackFinish(summary, claimed) }
      catch { /* The next scheduled check retries after a disconnected bridge. */ }
      finally { fbRunning = false }
    }
  }
  // Enabling the feature only schedules its first check. The API is not
  // touched immediately, and every subsequent run keeps the same 10-minute
  // interval even after a transient error.
  ;(window as any).__animeonFollowback = { wake: () => { nextAttempt = Date.now() + FOLLOWBACK_CHECK_MS } }
  setInterval(() => { void checkFollowBacks() }, 10000)
  setTimeout(() => { void checkFollowBacks() }, FOLLOWBACK_CHECK_MS)
})()
