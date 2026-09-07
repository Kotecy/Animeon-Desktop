import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import MoscowClock from './MoscowClock'

function TabAudio({ tab }) {
  const [visible, setVisible] = useState(!!tab.audible)
  useEffect(() => {
    if (tab.audible) { setVisible(true); return }
    const timer = setTimeout(() => setVisible(false), 2000)
    return () => clearTimeout(timer)
  }, [tab.audible])
  return <span className={'tab-audio-slot' + (visible ? ' visible' : '')} aria-hidden={!visible}>
    <button className="tab-audio" tabIndex={visible ? 0 : -1} aria-label={tab.muted ? 'Включить звук вкладки' : 'Отключить звук вкладки'} title={tab.muted ? 'Звук отключён' : 'Вкладка воспроизводит звук'} onClick={event => { event.stopPropagation(); window.api?.tabsToggleMuted(tab.id) }}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 9v6h4l5 4V5L7 9H3Z"/>{tab.muted ? <path d="m16 9 5 6m0-6-5 6"/> : <><path d="M16 9a5 5 0 0 1 0 6"/><path d="M19 6a9 9 0 0 1 0 12"/></>}</svg>
    </button>
  </span>
}

export default function TabStrip({ tabs = [], order = [], activeId, onReorder, onSwitch, baseUrl }) {
  const listRef = useRef(null)
  const addressRef = useRef(null)
  const dragRef = useRef(null)
  const suppressClick = useRef(false)
  const positions = useRef(new Map())
  const [dragOrder, setDragOrder] = useState(null)
  const [dragId, setDragId] = useState(null)
  const [editing, setEditing] = useState(false)
  const [address, setAddress] = useState('')
  const [error, setError] = useState('')
  const [scroll, setScroll] = useState({ before: false, after: false })
  const activeTab = tabs.find(tab => tab.id === activeId)
  const effectiveOrder = dragOrder || order
  const display = [...effectiveOrder.map(id => tabs.find(tab => tab.id === id)).filter(Boolean), ...tabs.filter(tab => !effectiveOrder.includes(tab.id))]
  const url = activeTab?.url || baseUrl || 'https://v2.animeon.co'
  const visibleAddress = url.replace(/^https:\/\//i, '')
  let domain = 'AnimeOn'
  try { domain = new URL(url).hostname } catch {}
  useEffect(() => { setAddress(visibleAddress); setEditing(false); setError('') }, [visibleAddress, activeId])
  useEffect(() => {
    if (!editing) return
    const cancel = () => { setEditing(false); setAddress(visibleAddress); setError('') }
    const outside = event => { if (!addressRef.current?.querySelector('form')?.contains(event.target)) cancel() }
    document.addEventListener('pointerdown', outside, true)
    window.addEventListener('blur', cancel)
    const unsubscribe = window.api?.onSiteFocused?.(cancel)
    return () => { document.removeEventListener('pointerdown', outside, true); window.removeEventListener('blur', cancel); unsubscribe?.() }
  }, [editing, url])
  useLayoutEffect(() => {
    if (!positions.current.size) return
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    listRef.current.querySelectorAll('[data-tab-id]').forEach(element => {
      const previous = positions.current.get(element.dataset.tabId)
      element.getAnimations().forEach(animation => animation.cancel())
      if (previous == null || reduce) return
      const delta = previous - element.getBoundingClientRect().left
      if (Math.abs(delta) > 1) element.animate([{ transform: `translateX(${delta}px)` }, { transform: 'translateX(0)' }], { duration: 180, easing: 'cubic-bezier(.2,.8,.2,1)' })
    })
    positions.current.clear()
  }, [dragOrder])
  const updateScroll = () => { const el = listRef.current; if (el) setScroll({ before: el.scrollLeft > 2, after: el.scrollLeft < el.scrollWidth - el.clientWidth - 2 }) }
  useEffect(() => {
    const el = listRef.current
    const wheel = event => { if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) { event.preventDefault(); el.scrollLeft += event.deltaY } }
    el.addEventListener('wheel', wheel, { passive: false })
    const observer = new ResizeObserver(updateScroll); observer.observe(el)
    return () => { el.removeEventListener('wheel', wheel); observer.disconnect() }
  }, [])
  useEffect(updateScroll, [tabs, editing])
  useEffect(() => window.api?.onTabMenuAction?.((id, action) => {
    if (action === 'pin') window.api?.tabsTogglePinned(id)
    if (action === 'mute') window.api?.tabsToggleMuted(id)
    if (action === 'reload') window.api?.tabsReloadActive()
  }), [])
  const reorder = (event, id) => {
    event.preventDefault()
    const dragged = dragRef.current
    if (!dragged || dragged.id === id) return
    const next = [...dragged.order], from = next.indexOf(dragged.id), to = next.indexOf(id)
    if (from < 0 || to < 0) return
    const rect = event.currentTarget.getBoundingClientRect()
    if ((from < to && event.clientX < rect.left + rect.width / 2) || (from > to && event.clientX > rect.left + rect.width / 2)) return
    positions.current = new Map([...listRef.current.querySelectorAll('[data-tab-id]')].map(element => [element.dataset.tabId, element.getBoundingClientRect().left]))
    next.splice(from, 1); next.splice(to, 0, dragged.id)
    dragged.order = next
    setDragOrder(next)
  }
  const finishDrag = (commit) => {
    const dragged = dragRef.current
    if (commit && dragged) { const next = dragged.order.filter(id => tabs.some(tab => tab.id === id)); onReorder(next); window.api?.tabsReorder(next) }
    dragRef.current = null; setDragId(null); setDragOrder(null)
  }
  const startPointerDrag = (event, id) => {
    if (event.button !== 0 || event.target.closest('button')) return
    suppressClick.current = false
    dragRef.current = { id, order: display.map(item => item.id), x: event.clientX, started: false }
  }
  const movePointerDrag = event => {
    const dragged = dragRef.current
    if (!dragged) return
    if (!dragged.started) {
      if (Math.abs(event.clientX - dragged.x) < 6) return
      dragged.started = true
      suppressClick.current = true
      listRef.current.setPointerCapture(event.pointerId)
      setDragId(dragged.id)
      setDragOrder(dragged.order)
    }
    event.preventDefault()
    const list = listRef.current, bounds = list.getBoundingClientRect()
    if (event.clientX < bounds.left + 30) list.scrollLeft -= 14
    if (event.clientX > bounds.right - 30) list.scrollLeft += 14
    const target = [...list.querySelectorAll('[data-tab-id]')].find(element => {
      const left = bounds.left + element.offsetLeft - list.scrollLeft
      return event.clientX >= left && event.clientX <= left + element.offsetWidth
    })
    if (target) reorder({ preventDefault() {}, clientX: event.clientX, currentTarget: target }, target.dataset.tabId)
  }
  const submit = async event => {
    event.preventDefault()
    try { const result = await window.api?.tabsNavigate(activeId, address); if (!result?.ok) { setError(result?.error || 'Введите адрес AnimeOn'); return } setEditing(false); setError('') }
    catch { setError('Не удалось открыть адрес') }
  }
  return <div className="signal-tabs">
    {scroll.before && <button className="signal-tab-scroll" aria-label="Прокрутить вкладки назад" onClick={() => listRef.current.scrollBy({ left: -220, behavior: 'smooth' })}>‹</button>}
    <div ref={listRef} onScroll={updateScroll} onPointerMove={movePointerDrag} onPointerUp={() => finishDrag(!!dragRef.current?.started)} onPointerCancel={() => finishDrag(false)} onPointerLeave={() => { if (!dragRef.current?.started) dragRef.current = null }} onClickCapture={event => { if (suppressClick.current) { event.preventDefault(); event.stopPropagation(); suppressClick.current = false } }} className="signal-tablist">
      {display.map(tab => <div key={tab.id} data-tab-id={tab.id} role="button" tabIndex={0} aria-label={tab.title || tab.url} title={tab.title || tab.url}
        onPointerDown={event => startPointerDrag(event, tab.id)} onDragStart={event => event.preventDefault()}
        onClick={() => onSwitch(tab.id)} onKeyDown={event => { if (event.target !== event.currentTarget) return; if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSwitch(tab.id) } }}
        onContextMenu={event => { event.preventDefault(); window.api?.tabsContextMenu?.(tab.id) }}
        onAuxClick={event => { if (event.button === 1) { event.preventDefault(); window.api?.tabsClose(tab.id) } }}
        className={'signal-tab' + (activeId === tab.id ? ' active' : '') + (tab.pinned ? ' pinned' : '') + (dragId === tab.id ? ' dragging' : '')}>
        <span className="tab-dot" /><span className="tab-title">{tab.title || 'Новая вкладка'}</span>
        <TabAudio tab={tab} />
        {!tab.pinned && <button className="tab-close" aria-label="Закрыть вкладку" onClick={event => { event.stopPropagation(); window.api?.tabsClose(tab.id) }}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button>}
      </div>)}
    </div>
    {scroll.after && <button className="signal-tab-scroll" aria-label="Прокрутить вкладки вперёд" onClick={() => listRef.current.scrollBy({ left: 220, behavior: 'smooth' })}>›</button>}
    <button className="signal-tab-add" title="Новая вкладка" onClick={() => window.api?.tabsCreate(baseUrl || 'https://v2.animeon.co')}>+</button>
    <div ref={addressRef} className="signal-address">
      {editing ? <form onSubmit={submit}><input autoFocus aria-label="Адрес AnimeOn" value={address} onFocus={event => event.target.select()} onChange={event => setAddress(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') { setEditing(false); setError('') } }} /><button type="submit" title="Открыть">↵</button></form>
        : <button className="signal-domain" onClick={() => { setAddress(visibleAddress); setEditing(true) }} onContextMenu={event => { event.preventDefault(); window.api?.tabsContextMenu?.(activeId) }} title={visibleAddress + ' · Нажмите, чтобы изменить адрес'}>{domain}</button>}
      <MoscowClock />
    </div>
    {error && <div className="signal-address-error" role="alert">{error}<button onClick={() => setError('')} aria-label="Закрыть">×</button></div>}
  </div>
}
