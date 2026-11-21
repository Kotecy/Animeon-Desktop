// Список секреток с инструкциями. Встроенная копия — secrets.json рядом,
// свежая — тот же файл из ветки main на GitHub (его скачивает main-процесс).
// Новая секретка = правка secrets.json на GitHub, без новой версии приложения.
// Всё, что пришло из сети, проходит через sanitizeSecretsCatalog: только текст
// разумной длины и известные поля, ничего исполняемого.

export const SECRETS_CATALOG_REPO = 'Kotecy/Animeon-Desktop'
export const SECRETS_CATALOG_PATH = 'compile/src/shared/secrets.json'
export const SECRETS_CATALOG_URL = `https://api.github.com/repos/${SECRETS_CATALOG_REPO}/contents/${SECRETS_CATALOG_PATH}?ref=main`
export const SECRETS_CATALOG_MAX_BYTES = 256 * 1024

export type SecretDef = {
  key: string
  code: string | null
  name: string
  desc: string
  category: 'standard' | 'impossible'
  holder?: string
  description?: string
  steps?: string
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
const HOLDER_RE = /^[A-Za-z0-9_.-]{1,40}$/

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
    const identity = code || 'name:' + name.toLowerCase()
    if (seen.has(identity) || seen.has('key:' + key)) continue
    seen.add(identity); seen.add('key:' + key)
    const def: SecretDef = {
      key, code, name,
      desc: text(entry.desc, 300),
      category: entry.category === 'impossible' ? 'impossible' : 'standard'
    }
    const holder = typeof entry.holder === 'string' ? entry.holder.trim() : ''
    if (HOLDER_RE.test(holder)) def.holder = holder
    const description = text(entry.description, 300)
    if (description) def.description = description
    const steps = text(entry.steps, 4000)
    if (steps) def.steps = steps
    // Невозможная секретка без владельца бессмысленна
    if (def.category === 'impossible' && !def.holder) continue
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

// Свежий список дополняет встроенный: совпадения по коду или названию
// заменяются, новые добавляются в конец, скрытые коды объединяются.
export function mergeSecretsCatalogs(base: SecretsCatalog, fresh: SecretsCatalog | null): SecretsCatalog {
  if (!fresh) return base
  const identity = (item: SecretDef) => item.code || 'name:' + item.name.toLowerCase()
  const byName = (item: SecretDef) => 'name:' + item.name.toLowerCase()
  const result = base.secrets.map(item => ({ ...item }))
  for (const item of fresh.secrets) {
    const index = result.findIndex(existing => identity(existing) === identity(item) || byName(existing) === byName(item))
    if (index >= 0) result[index] = { ...item, key: result[index].key }
    else result.push({ ...item })
  }
  return {
    schema: 1,
    updated: fresh.updated || base.updated,
    secrets: result,
    hidden: [...new Set([...base.hidden, ...fresh.hidden])]
  }
}
