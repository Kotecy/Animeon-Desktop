import React from 'react'

export default function UpdateModal({ info, onClose, onUpdate }) {
  if (!info) return null

  return (
    <div className="signal-update-modal-backdrop" onClick={onClose}>
      <div
        className="signal-update-modal-card"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="update-modal-title"
      >
        <div className="signal-update-modal-glow" aria-hidden="true" />
        
        <div className="signal-update-modal-header">
          <div className="signal-update-modal-icon-wrap">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </div>
          <div className="signal-update-modal-title-box">
            <h2 id="update-modal-title" className="signal-update-modal-title">Доступно обновление</h2>
            <div className="signal-update-modal-versions">
              <span className="signal-update-modal-badge current" title="Текущая версия">v{info.current}</span>
              <span className="signal-update-modal-arrow">→</span>
              <span className="signal-update-modal-badge latest" title="Новая версия">v{info.latest}</span>
            </div>
          </div>
        </div>

        <div className="signal-update-modal-body">
          <p>
            Вышла новая версия <strong>AnimeOn Desktop v{info.latest}</strong>. 
            Рекомендуется обновиться для получения последних исправлений, оптимизаций и новых функций.
          </p>
        </div>

        <div className="signal-update-modal-footer">
          <button
            type="button"
            className="signal-update-btn-cancel"
            onClick={onClose}
          >
            Отказаться
          </button>
          <button
            type="button"
            className="signal-update-btn-confirm"
            onClick={onUpdate}
            autoFocus
          >
            Обновиться
          </button>
        </div>
      </div>
    </div>
  )
}
