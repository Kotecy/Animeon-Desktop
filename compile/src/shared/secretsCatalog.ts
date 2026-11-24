// Список секреток с инструкциями. Встроенная копия — secrets.json рядом,
// свежая — тот же файл из ветки main на GitHub (его скачивает main-процесс).
// Новая секретка = правка secrets.json на GitHub, без новой версии приложения.
// Всё, что пришло из сети, проходит через sanitizeSecretsCatalog: только текст
// разумной длины и известные поля, ничего исполняемого.

export const SECRETS_CATALOG_REPO = 'Kotecy/Animeon-Desktop'
export const SECRETS_CATALOG_PATH = 'compile/src/shared/secrets.json'
export const SECRETS_CATALOG_URL = `https://api.github.com/repos/${SECRETS_CATALOG_REPO}/contents/${SECRETS_CATALOG_PATH}?ref=main`
export const SECRETS_CATALOG_MAX_BYTES = 256 * 1024

// Поля записи: code — код достижения на сайте (secret_*), name и description — как на
// сайте, desc — короткая подсказка, steps — гайд, icon — иконка game-icons ("gi:имя"),
// trophies / animon — награда, unconfirmed — «условия уточняются». Недостижимые секретки (category: impossible) с 0.5.4
// не показываются.
export type SecretDef = {
  key: string
  code: string | null
  name: string
  desc: string
  description?: string
  steps?: string
  icon?: string
  trophies?: number
  animon?: number
  unconfirmed?: boolean
}

export type SecretsCatalog = { schema: 1, updated: string, secrets: SecretDef[], hidden: string[] }

const MAX_SECRETS = 300
const text = (value: unknown, max: number) => {
  if (typeof value !== 'string') return ''
  // Управляющие символы, кроме перевода строки и табуляции, выбрасываем
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, max)
}
const CODE_RE = /^[a-z0-9_-]{1,64}$/
const KEY_RE = /^[\p{L}\p{N}_:.-]{1,96}$/u
export const SECRET_ICON_RE = /^gi:[a-z0-9-]{1,64}$/
const SVG_PATH_RE = /^[MmLlHhVvCcSsQqTtAaZz0-9.,\-\se]{1,20000}$/
const reward = (value: unknown) => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 100000 ? value as number : undefined

// Иконка game-icons из Iconify: принимаем только простые <path fill="currentColor" d="…"/>
// и отдаём одну строку d. Рисуется как <path d>, разметка из сети не вставляется.
export function extractSecretIconPath(body: unknown) {
  if (typeof body !== 'string' || body.length > 40000) return ''
  const paths: string[] = []
  const rest = body.replace(/<path fill="currentColor" d="([^"]+)"\s*\/>/g, (_match, d: string) => { paths.push(d); return '' })
  if (rest.trim() || !paths.length || paths.length > 8) return ''
  const joined = paths.join(' ')
  return SVG_PATH_RE.test(joined) ? joined : ''
}
export function isSecretIconPath(value: unknown) {
  return typeof value === 'string' && SVG_PATH_RE.test(value)
}

// Нормализация названия для сопоставления: регистр, ё→е, любые тире/минусы и пробелы вокруг них,
// чтобы варианты вроде «Опенинг - святое» и «Опенинг — святое» считались одной секреткой.
export function normalizeSecretName(name: string) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[\u2010-\u2015\u2212-]+/g, '-')
    .replace(/\s*-\s*/g, ' - ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function secretKeyFor(code: string | null, name: string) {
  return code || 'name:' + name.toLowerCase()
}

export function sanitizeSecretsCatalog(raw: unknown): SecretsCatalog | null {
  if (!raw || typeof raw !== 'object') return null
  const source = raw as Record<string, unknown>
  if (source.schema !== 1 || !Array.isArray(source.secrets)) return null
  const secrets: SecretDef[] = []
  const seen = new Set<string>()
  for (const item of source.secrets.slice(0, MAX_SECRETS)) {
    if (!item || typeof item !== 'object') continue
    const entry = item as Record<string, unknown>
    const name = text(entry.name, 80)
    if (!name) continue
    const rawCode = typeof entry.code === 'string' ? entry.code.trim().toLowerCase() : ''
    const code = CODE_RE.test(rawCode) ? rawCode : null
    const rawKey = typeof entry.key === 'string' ? entry.key.trim() : ''
    const key = KEY_RE.test(rawKey) ? rawKey : secretKeyFor(code, name)
    const identity = code || 'name:' + normalizeSecretName(name)
    if (seen.has(identity) || seen.has('key:' + key)) continue
    seen.add(identity); seen.add('key:' + key)
    // Недостижимые («в единственном экземпляре») больше не показываем
    if (entry.category === 'impossible') continue
    const def: SecretDef = { key, code, name, desc: text(entry.desc, 300) }
    const description = text(entry.description, 300)
    if (description) def.description = description
    const steps = text(entry.steps, 8000)
    if (steps) def.steps = steps
    const icon = typeof entry.icon === 'string' ? entry.icon.trim().toLowerCase() : ''
    if (SECRET_ICON_RE.test(icon)) def.icon = icon
    const trophies = reward(entry.trophies)
    if (trophies !== undefined) def.trophies = trophies
    const animon = reward(entry.animon)
    if (animon !== undefined) def.animon = animon
    if (entry.unconfirmed === true) def.unconfirmed = true
    secrets.push(def)
  }
  if (!secrets.length) return null
  const hidden = Array.isArray(source.hidden)
    // Скрыть можно по коду или, для секреток без кода, по "name:название"
    ? source.hidden.map(code => typeof code === 'string' ? code.trim().toLowerCase() : '')
      .filter(code => CODE_RE.test(code) || (code.startsWith('name:') && code.length > 5 && code.length <= 90)).slice(0, 200)
    : []
  return { schema: 1, updated: text(source.updated, 32), secrets, hidden }
}

// Свежий список дополняет встроенный: у совпавших по коду или названию текст (name, desc,
// description, steps, unconfirmed) берётся из свежей записи целиком, а код, иконка и
// награда — из свежей, если там есть, иначе остаются встроенные. Новые — в конец.
// Если свежий файл старше встроенного (поле updated, ГГГГ-ММ-ДД) — например, на GitHub
// ещё лежит файл прошлой версии, — при расхождении главнее встроенный, а скрытые коды
// старого файла не применяются. При правке secrets.json на GitHub менять updated.
export function mergeSecretsCatalogs(base: SecretsCatalog, fresh: SecretsCatalog | null): SecretsCatalog {
  if (!fresh) return base
  const freshWins = !base.updated || !fresh.updated || fresh.updated >= base.updated
  const identity = (item: SecretDef) => item.code || 'name:' + normalizeSecretName(item.name)
  const byName = (item: SecretDef) => 'name:' + normalizeSecretName(item.name)
  const result = base.secrets.map(item => ({ ...item }))
  for (const item of fresh.secrets) {
    const index = result.findIndex(existing => identity(existing) === identity(item) || byName(existing) === byName(item))
    if (index < 0) { result.push({ ...item }); continue }
    const current = result[index]
    const [main, other] = freshWins ? [item, current] : [current, item]
    const next: SecretDef = { ...main, key: current.key, code: main.code || other.code || null }
    for (const field of ['icon', 'trophies', 'animon'] as const) if (next[field] === undefined && other[field] !== undefined) (next as any)[field] = other[field]
    result[index] = next
  }
  return {
    schema: 1,
    updated: freshWins ? fresh.updated || base.updated : base.updated,
    secrets: result,
    hidden: freshWins ? [...new Set([...base.hidden, ...fresh.hidden])] : base.hidden
  }
}
