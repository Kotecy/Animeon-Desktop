import { useEffect, useRef, useState } from 'react'

const CodeIcon = ({ size = 20 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m8 9-3 3 3 3M16 9l3 3-3 3M14 5l-4 14" />
  </svg>
)

function Toggle({ checked, onClick, label, disabled = false }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation()
        onClick(event)
      }}
      className="signal-switch signal-function-switch"
    >
      <i aria-hidden="true" />
    </button>
  )
}

function CustomUtilitySlot({
  item,
  slot,
  busy,
  draggedId,
  dropTarget,
  onToggle,
  onUpload,
  onRemove,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd
}) {
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    if (!menuOpen) return undefined
    const close = (event) => {
      if (!event.target.closest?.('.signal-custom-menu')) setMenuOpen(false)
    }
    const closeOther = (event) => {
      if (event.detail !== item?.id) setMenuOpen(false)
    }
    document.addEventListener('pointerdown', close)
    window.addEventListener('signal-custom-menu-open', closeOther)
    return () => {
      document.removeEventListener('pointerdown', close)
      window.removeEventListener('signal-custom-menu-open', closeOther)
    }
  }, [menuOpen, item?.id])

  const openMenu = (event) => {
    event.stopPropagation()
    setMenuOpen(true)
    window.dispatchEvent(new CustomEvent('signal-custom-menu-open', { detail: item.id }))
  }

  const classes =
    'signal-card signal-tool signal-custom-slot' +
    (draggedId === item?.id ? ' is-dragging' : '') +
    (dropTarget ? ' is-drop-target' : '')

  if (!item) {
    return (
      <button
        type="button"
        className={'signal-card signal-custom-slot signal-custom-empty' + (dropTarget ? ' is-drop-target' : '')}
        onClick={() => onUpload(slot)}
        onDragOver={(event) => onDragOver(slot, event)}
        onDragLeave={(event) => onDragLeave(slot, event)}
        onDrop={(event) => onDrop(slot, event)}
      >
        <span className="signal-custom-plus">＋</span>
        <span>Загрузить скрипт</span>
      </button>
    )
  }

  return (
    <section
      className={classes}
      draggable={!busy}
      onDragStart={(event) => {
        if (event.target.closest?.('button')) {
          event.preventDefault()
          return
        }
        onDragStart(item, event)
      }}
      onDragOver={(event) => onDragOver(slot, event)}
      onDragLeave={(event) => onDragLeave(slot, event)}
      onDrop={(event) => onDrop(slot, event)}
      onDragEnd={onDragEnd}
      onContextMenu={(event) => {
        event.preventDefault()
        openMenu(event)
      }}
    >
      <div className="signal-face">
        <CodeIcon />
      </div>
      <div className="signal-custom-heading">
        <h2 title={item.name}>{item.name}</h2>
        <div className="signal-custom-menu">
          <button
            type="button"
            className="signal-custom-menu-trigger"
            aria-label={'Действия для ' + item.name}
            aria-expanded={menuOpen}
            title="Действия"
            onClick={openMenu}
          >
            ⋯
          </button>
          {menuOpen && (
            <div role="menu">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false)
                  onRemove(item)
                }}
              >
                Удалить скрипт
              </button>
            </div>
          )}
        </div>
      </div>
      <p className="signal-note" title={item.description || ''}>{item.description || 'Пользовательский скрипт'}</p>
      <div className="signal-tool-footer">
        <small>{busy ? 'Загрузка…' : item.active ? 'активен' : 'отключён'}</small>
        <Toggle
          checked={!!item.active}
          onClick={() => onToggle(item)}
          label={'Переключить ' + item.name}
          disabled={busy}
        />
      </div>
    </section>
  )
}

export default function Dashboard({ pushEvent = () => {} }) {
  const [utilities, setUtilities] = useState(null)
  const [utilityBusy, setUtilityBusy] = useState('')
  const fileInputs = useRef({})
  const [draggedUtilityId, setDraggedUtilityId] = useState('')
  const [dragOverSlot, setDragOverSlot] = useState(null)
  const utilityGeneration = useRef(0)

  const refreshUtilities = async () => {
    const generation = ++utilityGeneration.current
    try {
      const items = await window.api?.utilitiesList?.()
      if (generation === utilityGeneration.current && Array.isArray(items)) {
        setUtilities(items)
      }
    } catch {}
  }

  useEffect(() => {
    refreshUtilities()
    const unsubscribe = window.api?.onUtilitiesUpdated?.((items) => {
      utilityGeneration.current++
      setUtilities(items)
    })
    return () => {
      utilityGeneration.current++
      if (typeof unsubscribe === 'function') unsubscribe()
    }
  }, [])

  const toggleUtility = async (item) => {
    setUtilityBusy(item.id)
    try {
      const result = await window.api?.utilitiesToggle?.(item.id)
      if (!result?.ok) {
        pushEvent(`${item.name}: ${result?.error || 'не удалось изменить состояние'}`)
      } else {
        pushEvent(`${item.name}: ${result.active ? 'включён' : 'выключен'}`)
        await refreshUtilities()
      }
    } catch {
      pushEvent(`${item.name}: не удалось изменить состояние`)
    }
    setUtilityBusy('')
  }

  const uploadUtility = async (slot, event) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (!/\.js$/i.test(file.name)) {
      pushEvent('Принимаются только скрипты формата .js')
      return
    }
    try {
      const source = await file.text()
      const result = await window.api?.utilitiesImport?.(slot, file.name, source)
      if (!result?.ok) {
        pushEvent(result?.error || 'Не удалось загрузить скрипт')
      } else {
        pushEvent(`Скрипт «${result.item?.name || file.name}» успешно загружен`)
        await refreshUtilities()
      }
    } catch {
      pushEvent('Не удалось прочитать файл скрипта')
    }
  }

  const removeUtility = async (item) => {
    setUtilityBusy(item.id)
    try {
      await window.api?.utilitiesRemove?.(item.id)
      pushEvent(`Скрипт «${item.name}» удалён`)
      await refreshUtilities()
    } catch {
      pushEvent('Не удалось удалить скрипт')
    }
    setUtilityBusy('')
  }

  const beginUtilityDrag = (item, event) => {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', item.id)
    setDraggedUtilityId(item.id)
    setDragOverSlot(item.slot)
  }

  const dragOverUtility = (slot, event) => {
    if (!draggedUtilityId) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setDragOverSlot(slot)
  }

  const leaveUtility = (slot, event) => {
    if (!event.currentTarget.contains(event.relatedTarget)) {
      setDragOverSlot((current) => (current === slot ? null : current))
    }
  }

  const dropUtility = async (slot, event) => {
    event.preventDefault()
    const id = event.dataTransfer.getData('text/plain') || draggedUtilityId
    setDraggedUtilityId('')
    setDragOverSlot(null)
    if (!id) return
    try {
      const result = await window.api?.utilitiesMove?.(id, slot)
      if (!result?.ok) {
        pushEvent(result?.error || 'Не удалось переместить скрипт')
      } else {
        await refreshUtilities()
      }
    } catch {
      pushEvent('Не удалось переместить скрипт')
    }
  }

  const endUtilityDrag = () => {
    setDraggedUtilityId('')
    setDragOverSlot(null)
  }

  const count = (utilities || []).length
  const totalSlots = Math.min(12, Math.max(3, (Math.floor(count / 3) + 1) * 3))
  const customBySlot = new Map((utilities || []).map((item) => [item.slot, item]))

  return (
    <div className="signal-page">
      <h1>Пользовательские <em>расширения</em></h1>

      <div className="signal-tool-grid signal-custom-grid" style={{ marginTop: '24px' }}>
        {Array.from({ length: totalSlots }, (_, slot) => {
          return (
            <span key={slot} className="signal-custom-slot-wrap">
              <input
                ref={(node) => {
                  if (node) fileInputs.current[slot] = node
                }}
                type="file"
                accept=".js,application/javascript,text/javascript"
                hidden
                onChange={(event) => uploadUtility(slot, event)}
              />
              <CustomUtilitySlot
                item={customBySlot.get(slot)}
                slot={slot}
                busy={utilities === null || utilityBusy === customBySlot.get(slot)?.id}
                draggedId={draggedUtilityId}
                dropTarget={dragOverSlot === slot && draggedUtilityId !== customBySlot.get(slot)?.id}
                onToggle={toggleUtility}
                onUpload={(index) => fileInputs.current[index]?.click()}
                onRemove={removeUtility}
                onDragStart={beginUtilityDrag}
                onDragOver={dragOverUtility}
                onDragLeave={leaveUtility}
                onDrop={dropUtility}
                onDragEnd={endUtilityDrag}
              />
            </span>
          )
        })}
      </div>
    </div>
  )
}
