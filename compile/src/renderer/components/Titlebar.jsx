import iconUrl from '../icon.png'

export default function Titlebar({ version, onCommands }) {
  return <header className="signal-titlebar" style={{ WebkitAppRegion: 'drag' }}>
    <img className="signal-logo" src={iconUrl} alt="AnimeOn" />
    <div className="signal-wordmark">ANIMEON<small>DESKTOP · V{version || '0.4.0'}</small></div>
    <button className="signal-command" onClick={onCommands} aria-label="Найти функцию" title="Найти функцию (Ctrl+K)"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/></svg></button>
    <div className="signal-window">
      <button aria-label="Свернуть" title="Свернуть" onClick={() => window.api?.winMinimize?.()}><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M1 6h10" fill="none" stroke="currentColor"/></svg></button>
      <button aria-label="Развернуть или восстановить" title="Развернуть / восстановить" onClick={() => window.api?.winMaximize?.()}><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect x="1.5" y="1.5" width="9" height="9" rx="1" fill="none" stroke="currentColor"/></svg></button>
      <button aria-label="Закрыть" title="Закрыть" onClick={() => window.api?.winClose?.()}><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="m2 2 8 8M10 2l-8 8" fill="none" stroke="currentColor" strokeWidth="1.2"/></svg></button>
    </div>
  </header>
}
