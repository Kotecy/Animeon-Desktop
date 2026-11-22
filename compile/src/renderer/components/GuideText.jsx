import { DEFAULT_BASE_URL, isAllowedSiteHost } from '../../shared/siteHosts'

// Гайды секреток приходят из secrets.json (в том числе с GitHub), поэтому разметка
// разбирается здесь сама и превращается только в React-элементы — HTML из файла не
// попадает на страницу. Поддерживается небольшое подмножество Markdown:
//   ### Заголовок        — подзаголовок раздела
//   1. шаг / - пункт     — нумерованный и обычный списки
//   > текст              — приглушённое примечание
//   **жирный**, `код`, [текст](https://…) и голые https://… ссылки
// Кликабельны только ссылки на сайт AnimeOn: они открываются во вкладке приложения
// на адресе, выбранном в настройках. Остальные ссылки остаются текстом.

const INLINE_RE = /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>()«»"]+)/g

export function siteLink(raw, baseUrl) {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !isAllowedSiteHost(url.hostname)) return null
    let origin = DEFAULT_BASE_URL
    try { origin = new URL(String(baseUrl || '')).origin } catch { /* адрес по умолчанию */ }
    if (!isAllowedSiteHost(new URL(origin).hostname)) origin = DEFAULT_BASE_URL
    return origin + url.pathname + url.search + url.hash
  } catch {
    return null
  }
}

function Link({ href, label, baseUrl }) {
  const target = siteLink(href, baseUrl)
  if (!target) return <span className="secret-md-url">{label}</span>
  const shown = label === href ? target.replace(/^https:\/\//, '') : label
  return <a href={target} onClick={event => { event.preventDefault(); window.api?.tabsCreate?.(target) }}>{shown}</a>
}

export function renderInline(text, baseUrl, keyPrefix = '') {
  const out = []
  let last = 0
  let index = 0
  for (const match of text.matchAll(INLINE_RE)) {
    let [whole] = match
    let tail = ''
    if (match[5]) {
      // Знаки препинания в конце предложения не входят в ссылку
      const trimmed = whole.replace(/[.,;:!?]+$/, '')
      tail = whole.slice(trimmed.length)
      whole = trimmed
    }
    if (match.index > last) out.push(text.slice(last, match.index))
    const key = keyPrefix + 'i' + index++
    if (match[1] !== undefined) out.push(<strong key={key}>{renderInline(match[1], baseUrl, key)}</strong>)
    else if (match[2] !== undefined) out.push(<code key={key}>{match[2]}</code>)
    else if (match[3] !== undefined) out.push(<Link key={key} href={match[4]} label={match[3]} baseUrl={baseUrl} />)
    else out.push(<Link key={key} href={whole} label={whole} baseUrl={baseUrl} />)
    if (tail) out.push(tail)
    last = match.index + match[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

export function parseGuide(source) {
  const blocks = []
  let current = null
  const flush = () => { if (current) blocks.push(current); current = null }
  for (const rawLine of String(source || '').split('\n')) {
    const line = rawLine.trimEnd()
    if (!line.trim()) { flush(); continue }
    let match
    if ((match = /^#{2,3}\s+(.+)$/.exec(line))) { flush(); blocks.push({ type: 'heading', text: match[1] }); continue }
    if ((match = /^(\d+)[.)]\s+(.+)$/.exec(line))) {
      if (current?.type !== 'ol') { flush(); current = { type: 'ol', start: Number(match[1]), items: [] } }
      current.items.push(match[2]); continue
    }
    if ((match = /^[-•]\s+(.+)$/.exec(line))) {
      if (current?.type !== 'ul') { flush(); current = { type: 'ul', items: [] } }
      current.items.push(match[1]); continue
    }
    if ((match = /^>\s?(.*)$/.exec(line))) {
      if (current?.type !== 'note') { flush(); current = { type: 'note', lines: [] } }
      current.lines.push(match[1]); continue
    }
    if (current?.type !== 'p') { flush(); current = { type: 'p', lines: [] } }
    current.lines.push(line.trim())
  }
  flush()
  return blocks
}

const lines = (list, baseUrl, key) => list.flatMap((line, index) => index ? [<br key={key + 'br' + index} />, ...renderInline(line, baseUrl, key + 'l' + index)] : renderInline(line, baseUrl, key + 'l' + index))

export default function GuideText({ text, baseUrl }) {
  return (
    <div className="secret-guide-steps secret-md">
      {parseGuide(text).map((block, index) => {
        const key = 'b' + index
        if (block.type === 'heading') return <h3 key={key}>{renderInline(block.text, baseUrl, key)}</h3>
        if (block.type === 'ol') return <ol key={key} start={block.start}>{block.items.map((item, i) => <li key={i}>{renderInline(item, baseUrl, key + i)}</li>)}</ol>
        if (block.type === 'ul') return <ul key={key}>{block.items.map((item, i) => <li key={i}>{renderInline(item, baseUrl, key + i)}</li>)}</ul>
        if (block.type === 'note') return <p key={key} className="secret-md-note">{lines(block.lines, baseUrl, key)}</p>
        return <p key={key}>{lines(block.lines, baseUrl, key)}</p>
      })}
    </div>
  )
}
