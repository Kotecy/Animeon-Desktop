// Адреса AnimeOn. Белый список — домены animeon.cc и animeon.co вместе с
// любыми их поддоменами. Проверка общая для main и интерфейса; решение
// всегда принимает main.

export const SITE_DOMAINS = ['animeon.cc', 'animeon.co'] as const
export const DEFAULT_SITE_ADDRESSES = ['https://animeon.cc', 'https://v3.animeon.co'] as const
export const DEFAULT_BASE_URL = DEFAULT_SITE_ADDRESSES[0]
export const SITE_HOSTS_HINT = 'animeon.cc, animeon.co и их поддомены (например, v3.animeon.co)'

// Заблокированные или прежние зеркала переезжают на ближайший слот.
const LEGACY_HOST_TARGETS: Record<string, string> = {
  'v1.animeon.co': DEFAULT_SITE_ADDRESSES[0],
  'v2.animeon.co': DEFAULT_SITE_ADDRESSES[1]
}

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/

export function isAllowedSiteHost(raw: unknown): boolean {
  const host = String(raw || '').toLowerCase()
  if (!host || host.length > 253) return false
  const domain = SITE_DOMAINS.find(item => host === item || host.endsWith('.' + item))
  if (!domain) return false
  return host.split('.').every(label => LABEL.test(label))
}

// Полный адрес страницы AnimeOn (https, без логина, пароля и порта) или null.
export function normalizeSiteUrl(raw: unknown): string | null {
  const value = String(raw || '').trim()
  if (!value) return null
  const candidate = /^https?:\/\//i.test(value) ? value : `https://${value}`
  try {
    const parsed = new URL(candidate)
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) return null
    if (!isAllowedSiteHost(parsed.hostname)) return null
    return parsed.toString()
  } catch { return null }
}

// Базовый адрес — только origin, без пути.
export function normalizeSiteOrigin(raw: unknown): string | null {
  const safe = normalizeSiteUrl(raw)
  if (!safe) return null
  try { return new URL(safe).origin } catch { return null }
}

export function legacySiteTarget(origin: string): string | null {
  try { return LEGACY_HOST_TARGETS[new URL(origin).hostname] || null } catch { return null }
}

// Ровно два различных разрешённых адреса; прежние зеркала заменяются.
export function normalizeSiteAddresses(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : []
  const result: string[] = []
  for (let index = 0; index < DEFAULT_SITE_ADDRESSES.length; index++) {
    let origin = normalizeSiteOrigin(list[index])
    if (origin) origin = legacySiteTarget(origin) || origin
    if (!origin || result.includes(origin)) origin = DEFAULT_SITE_ADDRESSES[index]
    if (result.includes(origin)) origin = DEFAULT_SITE_ADDRESSES.find(item => !result.includes(item)) || origin
    result.push(origin)
  }
  return result
}

export function formatSiteAddress(origin: string): string {
  return String(origin || '').replace(/^https:\/\//, '')
}
