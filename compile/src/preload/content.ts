// AnimeOn Desktop — Content Preload Script
// Чистый вспомогательный скрипт для корректного отображения и управления вкладками.
// Любая дополнительная автоматизация вынесена в пользовательские скрипты (Custom Utilities).

(function () {
  if ((window as any).__acInjected) return
  ;(window as any).__acInjected = true

  const ANIMEON_HOSTS = new Set(['animeon.cc', 'animeon.co', 'v1.animeon.co', 'v2.animeon.co'])
  const isAnimeon = ANIMEON_HOSTS.has(location.hostname.toLowerCase())

  // Предотвращаем закрытие вкладки веб-страницей Animeon
  if (isAnimeon) {
    try { window.close = (() => {}) as any } catch {}
  }

  /* ═══════════════ Меню профиля: скролл в невысоком окне ═══════════════ */
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

  /* ═══════════════ Уведомление о лимите вкладок ═══════════════ */
  let limitPillTimer: any = null
  function showLimitPill(ms = 2500) {
    try {
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

  try {
    ;(window as any).__animeonToast = {
      limit: showLimitPill
    }
  } catch {}
})()
