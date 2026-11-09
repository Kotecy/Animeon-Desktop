import { app, BrowserWindow, BrowserView, Menu, ipcMain as electronIpcMain, powerMonitor, session, shell, clipboard, nativeTheme } from 'electron'
import path from 'path'
import fs from 'fs'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import Store from 'electron-store'
import { AUTO_COLLECT_AVAILABLE } from '../shared/buildFlags'
import { getTabOrder, moveTab, sameTabOrder } from '../shared/tabOrder'
import { relocatePortableLauncher } from './portableLauncher'

try { nativeTheme.themeSource = 'dark' } catch {}

// Memory, media & background rendering stability
try {
  // Prevent Chromium from occluding, blanking or freezing background/idle WebContents on Windows
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
} catch {}

process.on('uncaughtException', (err: any) => {
  if (String(err?.message || err).includes('SQLITE_CANTOPEN')) return
  try { debugLog('FATAL uncaughtException:', String(err?.stack || err)) } catch {}
  console.error(err)
})
process.on('unhandledRejection', (reason: any) => {
  if (String(reason?.message || reason).includes('SQLITE_CANTOPEN')) return
  try { debugLog('FATAL unhandledRejection:', String(reason)) } catch {}
})

let localBase = ''
let logsDir = ''
try {
  const appData = app.getPath('appData')
  localBase = process.env.ANIMEON_TEST_USER_DATA ? path.resolve(process.env.ANIMEON_TEST_USER_DATA) : path.join(appData.replace(/Roaming$/, 'Local'), 'AnimeonDesktop')
  app.setPath('userData', localBase)
  fs.mkdirSync(localBase, { recursive: true })
  logsDir = path.join(localBase, 'logs')
  fs.mkdirSync(logsDir, { recursive: true })
  const oldLog = path.join(localBase, 'oauth-debug.log')
  const newLog = path.join(logsDir, 'oauth-debug.log')
  if (fs.existsSync(oldLog)) {
    try {
      if (!fs.existsSync(newLog)) fs.renameSync(oldLog, newLog)
      else fs.unlinkSync(oldLog)
    } catch {}
  }
} catch {}

const LOG_FILE = path.join(logsDir || localBase || process.cwd(), 'oauth-debug.log')
// Лог-гигиена: URL и тела OAuth-запросов могут нести code/token/credential.
// В файл пишем только origin+path, плюс длины/флаги — самих секретов нет.
function safeUrl(u: unknown): string {
  try { return String(u || '').split(/[?#]/)[0] } catch { return '' }
}
function debugLog(...args: any[]) {
  try {
    const line = `[${new Date().toISOString()}] ` + args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')
    console.log(line)
    fs.appendFileSync(LOG_FILE, line + '\n')
  } catch {}
}

const AFK_LOG_FILE = path.join(logsDir || localBase || process.cwd(), 'afk-debug.log')

function logAfk(type: string, data: any) {
  try {
    const label = String(type).slice(0, 80).replace(/[\r\n]/g, ' ')
    const value = typeof data === 'object' ? JSON.stringify(data) : String(data)
    const line = `[${new Date().toISOString()}] [${label}] ${value.slice(0, 4000).replace(/[\r\n]/g, ' ')}\n`
    fs.appendFileSync(AFK_LOG_FILE, line, 'utf8')
  } catch {}
}

const store = new Store({
  cwd: localBase || undefined,
  defaults: {
    baseUrl: 'https://v2.animeon.co',
    accounts: [] as any[],
    activeAccountId: null as string | null,
    tabs: [] as any[],
    tabOrder: [] as string[],
    activeTabId: null as string | null,
    activeView: 'site',
    detector: { watching: false, sound: true, toast: true, count: 0, lastAt: 0 },
    followBackEnabled: false,
    customUtilities: [] as any[],
    switchAllTabsOnProfileChange: true
  }
})

// Keep account metadata independent from tab state. Older builds stored an
// empty array (or only activeAccountId), so migrate that shape to a single
// default profile without disturbing existing sessions.
function normalizeAccounts() {
  const raw: any[] = Array.isArray(store.get('accounts')) ? (store.get('accounts') as any[]) : []
  const byId = new Map<string, any>()
  for (const item of raw) {
    const id = String(item?.id ?? item?.accountId ?? item?.number ?? '')
    if (!id || byId.has(id)) continue
    byId.set(id, { id, nickname: item?.nickname || item?.name || '', createdAt: item?.createdAt || Date.now() })
  }
  const active = String(store.get('activeAccountId') || '')
  if (!byId.size) byId.set('1', { id: '1', nickname: '', createdAt: Date.now() })
  if (active && !byId.has(active) && /^\d+$/.test(active) && Number(active) <= 5) {
    byId.set(active, { id: active, nickname: '', createdAt: Date.now() })
  }
  const accounts = [...byId.values()].sort((a, b) => Number(a.id) - Number(b.id)).slice(0, 5)
  if (JSON.stringify(raw) !== JSON.stringify(accounts)) store.set('accounts', accounts)
  if (!store.get('activeAccountId')) store.set('activeAccountId', accounts[0].id)
  return accounts
}
normalizeAccounts()
// Preserve the former shared whitelist for existing profiles once, then isolate edits.
if (!store.get('followListsByProfile')) {
  const legacy = store.get('followbackWhitelist') || []
  store.set('followListsByProfile', Object.fromEntries(normalizeAccounts().map(a => [a.id, { whitelist: legacy, blacklist: [] }])))
}

// One-time purge of nicknames stored by the old scraper, which could save
// nav text ("Онгоинги") or other users' nicks. They re-sync on next page load.
if (!store.get('nickCleanedV1')) {
  try {
    const accs = normalizeAccounts()
    for (const a of accs) a.nickname = ''
    store.set('accounts', accs)
    store.set('nickCleanedV1', true)
  } catch {}
}

function notifyAccounts() {
  const accounts = normalizeAccounts()
  mainWindow?.webContents.send('accounts:updated', accounts, String(store.get('activeAccountId') || accounts[0]?.id || '1'))
  return accounts
}

const audibleReleaseTimers = new Map<string, NodeJS.Timeout>()

function setTabAudible(tabId: string, audible: boolean) {
  const existingTimer = audibleReleaseTimers.get(tabId)
  if (existingTimer) {
    clearTimeout(existingTimer)
    audibleReleaseTimers.delete(tabId)
  }

  if (audible) {
    applyTabAudible(tabId, true)
  } else {
    // Grace period (3500ms): hold audible state so natural dialogue pauses,
    // quiet scenes, and buffer swaps in video playback do not cause the mute button to flicker.
    const timer = setTimeout(() => {
      audibleReleaseTimers.delete(tabId)
      applyTabAudible(tabId, false)
    }, 3500)
    audibleReleaseTimers.set(tabId, timer)
  }
}

function applyTabAudible(tabId: string, audible: boolean) {
  try {
    const tabs: any[] = (store.get('tabs') as any[]) || []
    const t = tabs.find(x => x.id === tabId)
    if (!t || !!t.audible === audible) return
    t.audible = audible
    store.set('tabs', tabs)
    mainWindow?.webContents.send('tabs:updated', tabs, activeTabId)
  } catch {}
}

let collectionEpoch = 0
const pendingCollections = new Set<() => void>()
function cancelCollections() {
  collectionEpoch++
  for (const cancel of [...pendingCollections]) cancel()
}
function waitForCollection(): Promise<boolean> {
  return new Promise(resolve => {
    const finish = (ready: boolean) => { clearTimeout(timer); pendingCollections.delete(cancel); resolve(ready) }
    const cancel = () => finish(false)
    const timer = setTimeout(() => finish(true), 3000 + Math.floor(Math.random() * 7001))
    pendingCollections.add(cancel)
  })
}

let lastLimitInject = 0
const ALLOWED_ANIMEON_HOSTS = new Set(['animeon.cc', 'animeon.co', 'v1.animeon.co', 'v2.animeon.co'])
const ANIMEON_TELEGRAM_CHANNEL = 'https://t.me/animeon'

function normalizeAnimeonUrl(raw: unknown): string | null {
  const value = String(raw || '').trim()
  if (!value) return null
  const candidate = /^https?:\/\//i.test(value) ? value : `https://${value}`
  try {
    const parsed = new URL(candidate)
    if (
      parsed.protocol !== 'https:' ||
      !ALLOWED_ANIMEON_HOSTS.has(parsed.hostname.toLowerCase()) ||
      parsed.username ||
      parsed.password ||
      parsed.port
    ) return null
    return parsed.toString()
  } catch { return null }
}

// Базовый адрес — это только окружение сайта. В отличие от адреса вкладки,
// для него не нужен путь `/`: origin даёт единый формат для v1 и v2.
function normalizeAnimeonBaseUrl(raw: unknown): string | null {
  const safeUrl = normalizeAnimeonUrl(raw)
  if (!safeUrl) return null
  try { return new URL(safeUrl).origin } catch { return null }
}

// Старые версии сохраняли v2 как `https://v2.animeon.co/`. Мигрируем это
// значение сразу, иначе select в настройках не может сопоставить его с option.
const normalizedStoredBaseUrl = normalizeAnimeonBaseUrl(store.get('baseUrl')) || 'https://v2.animeon.co'
if (store.get('baseUrl') !== normalizedStoredBaseUrl) store.set('baseUrl', normalizedStoredBaseUrl)

function getActiveViewForToast(): any | null {
  try {
    const v = activeTabId ? views.get(activeTabId) : null
    if (!v || (v.webContents as any)?.isDestroyed?.()) return null
    if (!normalizeAnimeonUrl(v.webContents.getURL())) return null
    return v
  } catch { return null }
}

function reloadActiveTab() {
  const view = getActiveViewForToast()
  if (!view) return { ok: false, error: 'Нет открытой вкладки AnimeOn' }
  try { view.webContents.reload(); return { ok: true } } catch { return { ok: false, error: 'Не удалось перезагрузить вкладку' } }
}

const DEVTOOLS_THEME_CSS = `
  :root, body, .theme-with-dark-background {
    --color-background: #13121b !important;
    --sys-color-cdt-base-container: #13121b !important;
    --sys-color-surface: #13121b !important;
    --sys-color-surface-variant: #1a1626 !important;
    --sys-color-surface-container: #1e1a2b !important;
    --sys-color-surface-container-high: #242033 !important;
    --sys-color-surface-container-highest: #2a253c !important;
    --sys-color-surface-container-low: #161421 !important;
    --sys-color-surface-container-lowest: #100e18 !important;
    --sys-color-tonal-container: #28223a !important;
    --sys-color-outline: rgba(187, 167, 236, 0.2) !important;
    --sys-color-outline-variant: rgba(187, 167, 236, 0.1) !important;
    --legacy-accent-color: #bba7ec !important;
    --legacy-accent-fg-color: #bba7ec !important;
    --legacy-accent-color-hover: #ded2f9 !important;
    --color-primary: #bba7ec !important;
    --sys-color-primary: #bba7ec !important;
    --sys-color-primary-bright: #ded2f9 !important;
    --sys-color-on-surface: #eeedf5 !important;
    --sys-color-on-surface-subtle: #a19cb2 !important;
    background-color: #13121b !important;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Inter", sans-serif !important;
  }
  body, .root-view {
    background-color: #13121b !important;
  }
  ::-webkit-scrollbar { width: 5px; height: 5px; }
  ::-webkit-scrollbar-thumb { background: #322d42; border-radius: 3px; }
  ::-webkit-scrollbar-thumb:hover { background: #584674; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::selection { background-color: rgba(187, 167, 236, 0.35) !important; color: #ffffff !important; }
`

const hookedDevTools = new WeakSet<Electron.WebContents>()
function hookDevToolsForWebContents(contents: Electron.WebContents) {
  if (hookedDevTools.has(contents)) return
  hookedDevTools.add(contents)
  contents.on('devtools-opened', () => {
    const dt = contents.devToolsWebContents
    if (!dt) return
    try { dt.insertCSS(DEVTOOLS_THEME_CSS) } catch {}

    dt.on('page-title-updated', (event, title) => {
      if (title === '__ANIMEON_F12_CLOSE__') {
        event.preventDefault()
        setImmediate(() => {
          try { contents.closeDevTools() } catch {}
        })
      }
    })

    contents.devToolsWebContents?.on('before-input-event', (event: Electron.Event, input: Electron.Input) => {
      if (input.type === 'keyDown' && (input.key === 'F12' || input.code === 'F12')) {
        event.preventDefault()
        setImmediate(() => {
          try { contents.closeDevTools() } catch {}
        })
      }
    })

    const attachScript = `(() => {
      try {
        window.addEventListener('keydown', (e) => {
          if (e.key === 'F12' || e.code === 'F12') {
            e.preventDefault();
            e.stopPropagation();
            document.title = '__ANIMEON_F12_CLOSE__';
          }
        }, true);
      } catch (e) {}
    })()`
    try { dt.executeJavaScript(attachScript).catch(() => {}) } catch {}
  })
}

function toggleDevTools() {
  const contents = getActiveViewForToast()?.webContents || mainWindow?.webContents
  if (!contents) return false
  try {
    if (contents.isDevToolsOpened()) {
      contents.closeDevTools()
    } else {
      hookDevToolsForWebContents(contents)
      contents.openDevTools({ mode: 'right' })
    }
    return true
  } catch { return false }
}

function handleBrowserShortcut(input: any) {
  if (input.type !== 'keyDown') return false
  if (input.key === 'F5') { reloadActiveTab(); return true }
  if (input.key === 'F12') { toggleDevTools(); return true }
  if ((input.control || input.meta) && String(input.key || '').toLowerCase() === 'k') {
    mainWindow?.webContents.send('commands:toggle')
    return true
  }
  return false
}

function notifyTabLimit() {
  debugLog('DIAG tabs limit reached, notifying renderer')
  try { store.set('lastTabLimitWarn', Date.now()) } catch {}
  mainWindow?.webContents.send('tabs:limit')
  // Пилюля рисуется ВНУТРИ активной вкладки (поверх сайта) — синглтон:
  // пока висит (2.5с), спам-вызовы игнорируются и там, и в рендерере.
  const now = Date.now()
  if (now - lastLimitInject < 2500) return
  lastLimitInject = now
  try { getActiveViewForToast()?.webContents.executeJavaScript('window.__animeonToast&&window.__animeonToast.limit()').catch(() => {}) } catch {}
}

// Middle-click / window.open links from tabs: a background tab (limit 7).
function createTabFromUrl(url: string) {
  const tabs: any[] = (store.get('tabs') as any[]) || []
  debugLog('DIAG createTabFromUrl count=', tabs.length)
  if (tabs.length >= 7) { notifyTabLimit(); return null }
  const safeUrl = normalizeAnimeonUrl(url) || String(store.get('baseUrl') || 'https://v2.animeon.co')
  const id = randomUUID()
  const activeAcc = store.get('activeAccountId') as string | null
  const partition = activeAcc ? `persist:animeon-acc-${activeAcc}` : 'persist:animeon-acc-1'
  const tab = { id, url: safeUrl, title: 'Новая вкладка', favicon: '', partition, pinned: false, muted: false, audible: false }
  tabs.push(tab)
  store.set({ tabs, tabOrder: getTabOrder(tabs, store.get('tabOrder')) })
  ensureView(tab); layoutViews()
  mainWindow?.webContents.send('tabs:updated', tabs, activeTabId)
  return tab
}

function destroyView(tabId: string) {
  if (fullscreenTabId === tabId) fullscreenTabId = null
  const timer = audibleReleaseTimers.get(tabId)
  if (timer) { clearTimeout(timer); audibleReleaseTimers.delete(tabId) }
  const old = views.get(tabId)
  stopUtilitiesForTab(tabId)
  views.delete(tabId)
  if (old) {
    try { mainWindow?.removeBrowserView(old) } catch {}
    try { if (!old.webContents.isDestroyed()) old.webContents.close() } catch {}
  }
}

// Applies the profile's isolated session (cookies live per partition) to all tabs.
// When switching profile, every tab reloads with the selected profile's session.
function applyAccountToTabs(accountId: string) {
  const partition = `persist:animeon-acc-${accountId}`
  const tabs: any[] = (store.get('tabs') as any[]) || []
  for (const tab of tabs) tab.partition = partition
  store.set('tabs', tabs)
  const loadedTabIds = new Set(views.keys())
  for (const tab of tabs) { destroyView(tab.id); if (loadedTabIds.has(tab.id)) ensureView(tab) }
  if (!tabs.some(t => t.id === activeTabId)) {
    activeTabId = tabs[0]?.id || null
    store.set('activeTabId', activeTabId)
  }
  // The caller stays where it was (e.g. Settings): tabs reload in the
  // background, cards and nicknames update via the events below.
  layoutViews()
  mainWindow?.webContents.send('tabs:updated', tabs, activeTabId)
}

function switchTabAccount(accountId: string) {
  if (!activeTabId) return
  applyAccountToTabs(accountId)
}

async function syncAccountNickname(view: BrowserView, accountId: string) {
  const mutationEpoch = accountMutationEpoch
  try {
    // Nickname is trusted only from a logged-in session (profile API answers).
    // Logged-out pages clear stale nicknames instead of scraping nav text.
    const res: any = await view.webContents.executeJavaScript(`(async()=>{
      let loggedIn=false; let found=null; let status=0;
      const paths=['/api/auth/me','/api/user/profile','/api/profile'];
      for(const p of paths){try{const r=await fetch(p,{credentials:'include'});status=r.status;if(r.ok){const j=await r.json().catch(()=>null);if(j&&typeof j==='object'&&Object.keys(j).length){loggedIn=true;found=(j&&j.user)||(j&&j.profile)||j;break;}}}catch{}}
      const pick=(o)=>{if(!o||typeof o!=='object')return '';const d=(o.data&&typeof o.data==='object')?o.data:o;const u=(d.user&&typeof d.user==='object')?d.user:d;return String(u.nickname||u.username||u.name||u.login||d.nickname||d.username||d.name||d.login||o.nickname||o.username||o.name||o.login||'').trim();};
      let nickname=pick(found);
      if(loggedIn&&!nickname){
        try{
          const links=[...document.querySelectorAll('a[href]')];
          const self=links.find(a=>{const t=(a.textContent||'').trim().toLowerCase();return t.indexOf('как видят другие')!==-1||t.indexOf('мой профиль')!==-1;});
          const h=self?(self.getAttribute('href')||''):'';
          const iu=h.toLowerCase().indexOf('/user/');
          if(iu!==-1)nickname=decodeURIComponent(h.slice(iu+6).split(/[?#]/)[0]);
        }catch{}
      }
      return {loggedIn,nickname,status};
    })()`, true)
    if (mutationEpoch !== accountMutationEpoch || profileSwitchBusy) return false
    const accounts = normalizeAccounts()
    const account = accounts.find(a => a.id === String(accountId))
    if (!account) return false
    if (res && res.loggedIn) {
      const nickname = String(res.nickname || '').trim()
      if (!nickname || nickname === account.nickname) return false
      account.nickname = nickname
      store.set('accounts', accounts)
      notifyAccounts()
      debugLog('account nickname synced:', accountId, nickname)
      void getFeatureAuth(true)
      return true
    }
    if (res && (res.status === 401 || res.status === 403) && account.nickname) {
      account.nickname = ''
      store.set('accounts', accounts)
      notifyAccounts()
      debugLog('account nickname cleared (logged out):', accountId)
      return true
    }
    return false
  } catch { return false }
}

let mainWindow: BrowserWindow | null = null
const views = new Map<string, BrowserView>()
let activeTabId: string | null = (store.get('activeTabId') as any) || null
let activeViewMode: string = (store.get('activeView') as any) || 'site'
let lastOAuthWindowTime = 0
let fullscreenTabId: string | null = null
const popupContents = new Set<number>()

type UtilityId = string
type UtilityRun = {
  id: UtilityId
  tabId: string
  frame: Electron.WebFrameMain
  token: number
  start: Promise<boolean>
  stop?: Promise<boolean>
}
type CustomUtility = { id: string; name: string; description: string; source: string; slot: number; createdAt: number }
const utilityRuns = new Map<string, UtilityRun>()
const enabledUtilities = new Map<UtilityId, symbol>()
let utilityRunToken = 0
let utilityEpoch = 0
let profileSwitchBusy = false
let accountMutationEpoch = 0
async function clearProfileSession(key: string) {
  if (!/^[1-5]$/.test(key)) throw new Error('Invalid profile')
  const partition = `persist:animeon-acc-${key}`
  const targetSession = session.fromPartition(partition)
  const tabs: any[] = (store.get('tabs') as any[]) || []
  const removed = new Set(tabs.filter(t => t.partition === partition).map(t => t.id))
  for (const id of removed) destroyView(id)
  for (const win of BrowserWindow.getAllWindows()) {
    if (win !== mainWindow && !win.isDestroyed() && win.webContents.session === targetSession) win.destroy()
  }
  const remaining = tabs.filter(t => !removed.has(t.id))
  store.set('tabs', remaining)
  const order = ((store.get('tabOrder') as string[]) || []).filter(id => !removed.has(id))
  store.set('tabOrder', order)
  if (activeTabId && removed.has(activeTabId)) {
    activeTabId = order[0] || remaining[0]?.id || null
    store.set('activeTabId', activeTabId)
  }
  layoutViews()
  mainWindow?.webContents.send('tabs:updated', remaining, activeTabId)
  await targetSession.closeAllConnections()
  await targetSession.clearStorageData()
  await targetSession.clearAuthCache()
  await targetSession.clearCache()
  await targetSession.cookies.flushStore()
  const lists: any = store.get('followListsByProfile') || {}
  delete lists[key]
  store.set('followListsByProfile', lists)
}
function getCustomUtilities(): Array<CustomUtility | null> {
  const raw: any = store.get('customUtilities')
  const validItems: CustomUtility[] = []
  if (Array.isArray(raw)) {
    for (let i = 0; i < raw.length; i++) {
      const item = raw[i]
      if (item && typeof item === 'object' && typeof item.id === 'string' && typeof item.source === 'string') {
        validItems.push({
          id: item.id,
          name: String(item.name || 'Пользовательская функция').slice(0, 80),
          description: String(item.description || readUtilityDescription(item.source)).slice(0, 180),
          source: item.source,
          slot: Number.isInteger(item.slot) ? item.slot : i,
          createdAt: Number(item.createdAt) || Date.now()
        })
      }
    }
  }
  const count = validItems.length
  const maxAllowedSlot = Math.min(11, Math.max(2, (Math.floor(count / 3) + 1) * 3 - 1))
  validItems.sort((a, b) => a.slot - b.slot)
  if (validItems.some(it => it.slot > maxAllowedSlot)) {
    validItems.forEach((it, idx) => { it.slot = idx })
  }
  const slots: Array<CustomUtility | null> = Array.from({ length: 12 }, () => null)
  validItems.forEach(it => {
    if (it.slot >= 0 && it.slot < 12) {
      slots[it.slot] = it
    }
  })
  return slots
}

function publicUtilities() {
  return getCustomUtilities().flatMap(item => item ? [{ id: item.id, name: item.name, description: item.description, slot: item.slot, active: enabledUtilities.has(item.id) }] : [])
}

function readUtilityDescription(source: string) {
  const normalize = (value: string) => {
    const quoted = value.trim().match(/^(["'`])([\s\S]*)\1$/)?.[2] || value
    return quoted.replace(/\\(["'`\\])/g, '$1').replace(/\s+/g, ' ').trim().slice(0, 180)
  }
  const directive = source.match(/(?:^|[\r\n])\s*\/\/\s*@description(?:\s*[:=]|\s+)\s*([^\r\n]+)/i)
    || source.match(/(?:^|[\r\n])\s*\/\/\s*@animeon\s+description\s*[:=]\s*([^\r\n]+)/i)
    || source.match(/(?:^|[\r\n])\s*\/\/\s*description\s*[:=]\s*([^\r\n]+)/i)
    || source.match(/\/\*[\s\S]*?@description(?:\s*[:=]|\s+)\s*([^\r\n*]+)/i)
    || source.match(/\/\*\s*@animeon\s+description\s*[:=]\s*([\s\S]*?)\*\//i)
  if (directive) return normalize(directive[1])
  const code = source.match(/(?:^|[;,\n\r{])\s*(?:(?:const|let|var)\s+)?description\s*(?:=|:)\s*(["'`])([\s\S]*?)\1/)
  return code ? normalize(code[2]) : ''
}

function notifyUtilities() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('utilities:updated', publicUtilities())
}

function utilityKey(id: UtilityId, tabId: string) { return `${id}:${tabId}` }

function getUtilitySource(id: UtilityId) {
  return getCustomUtilities().find(item => item?.id === id)?.source || ''
}

function stopUtilityInTab(run: UtilityRun): Promise<boolean> {
  if (run.stop) return run.stop
  const key = utilityKey(run.id, run.tabId)
  run.stop = (async () => {
    let cleaned = false
    try {
      if (!await run.start || utilityRuns.get(key) !== run) {
        cleaned = true
        return true
      }
      cleaned = await run.frame.executeJavaScript(`(async () => {
        const root = window.__ANIMEON_CUSTOM_UTILITIES__
        const id = ${JSON.stringify(run.id)}
        const entry = root?.[id]
        if (entry?.token !== ${run.token}) return true
        if (typeof entry.stop !== 'function') return false
        await entry.stop()
        if (root[id] === entry) delete root[id]
        return true
      })()`, true) === true
      return cleaned
    } catch (error) {
      debugLog(`utility ${run.id} stop failed in tab ${run.tabId}:`, String(error))
      return utilityRuns.get(key) !== run
    } finally {
      if (cleaned && utilityRuns.get(key) === run) utilityRuns.delete(key)
      // Keep scripts without cleanup registered until the document is replaced.
      // Turning one back on must not execute a second copy.
      run.stop = undefined
    }
  })()
  return run.stop
}

async function waitForUtilityWork<T>(work: Promise<T>, onTimeout: T): Promise<T> {
  // Keep the run reserved without letting a user promise block the UI.
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      work,
      new Promise<T>(resolve => { timer = setTimeout(() => resolve(onTimeout), 2000) })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function waitForUtilityStops(runs: UtilityRun[]) {
  if (!runs.length) return true
  const work = Promise.all(runs.map(stopUtilityInTab)).then(results => results.every(Boolean))
  return waitForUtilityWork(work, false)
}

async function stopUtility(id: UtilityId, notify = true) {
  enabledUtilities.delete(id)
  const cleaned = await waitForUtilityStops([...utilityRuns.values()].filter(run => run.id === id))
  if (notify) notifyUtilities()
  return { ok: true, active: false, reloadRequired: !cleaned }
}

async function stopAllUtilities() {
  enabledUtilities.clear()
  await waitForUtilityStops([...utilityRuns.values()])
  notifyUtilities()
}

async function getActiveNickname(view: BrowserView) {
  const accountId = String((view as any).__accountId || store.get('activeAccountId') || '1')
  // Resolve the session owner, never the visited profile or a persisted display name.
  // TARGET_USER remains fixed for this script instance after injection.
  const nickname = await view.webContents.executeJavaScript(`(async()=>{
    for(const path of ['/api/auth/me','/api/users/me','/api/user/profile','/api/profile']) {
      try {
        const response=await fetch(path,{credentials:'include',cache:'no-store',signal:AbortSignal.timeout(8000)});
        if(response.status===401||response.status===403)return '';
        if(!response.ok)continue;
        const body=await response.json();
        const data=body?.data??body;
        const user=data?.user??data?.profile??data;
        const nick=user?.username_slug||user?.slug||user?.username||user?.nickname;
        if(typeof nick==='string'&&nick.trim()&&nick.trim().toLowerCase()!=='me')return nick.trim();
      } catch {}
    }
    return '';
  })()`, true)
  if (String((view as any).__accountId || '1') !== accountId) return { accountId, nickname: '' }
  return { accountId, nickname: typeof nickname === 'string' ? nickname : '' }
}

let authCache: { profileId: string, epoch: number, authenticated: boolean, checkedAt: number } | null = null
let authPending: { profileId: string, epoch: number, promise: Promise<{ profileId: string, authenticated: boolean }> } | null = null
let detectorToggleRevision = 0
let followToggleRevision = 0
let detectorPausedState: { watching: boolean, autoCollect: boolean, profileId: string } | null = null
function stopUnauthenticatedFunctions() {
  const d: any = store.get('detector') || {}
  const profileId = String(store.get('activeAccountId') || '1')
  detectorToggleRevision++; followToggleRevision++
  if (d.watching || d.autoCollect) {
    detectorPausedState = { watching: !!d.watching, autoCollect: !!d.autoCollect, profileId }
    d.watching = false; d.autoCollect = false; cancelCollections()
    store.set('detector', d)
    mainWindow?.webContents.send('detector:updated', d)
  }
  if (store.get('followBackEnabled')) {
    store.set('followBackEnabled', false)
    mainWindow?.webContents.send('followback:stateChanged')
  }
}
async function getFeatureAuth(force = false): Promise<{ profileId: string, authenticated: boolean }> {
  const profileId = String(store.get('activeAccountId') || '1'), epoch = utilityEpoch
  if (profileSwitchBusy) return { profileId, authenticated: false }
  if (authPending?.profileId === profileId && authPending.epoch === epoch) return authPending.promise
  if (!force && authCache?.profileId === profileId && authCache.epoch === epoch && Date.now() - authCache.checkedAt < 60000) return authCache
  const promise = (async () => {
    let authenticated = false
    const view = [...views.values()].find(v => !v.webContents.isDestroyed() && String((v as any).__accountId) === profileId && !!normalizeAnimeonUrl(v.webContents.getURL()))
    try { if (view) authenticated = !!(await getActiveNickname(view)).nickname } catch {}
    if (epoch !== utilityEpoch || profileId !== String(store.get('activeAccountId') || '1') || profileSwitchBusy) return { profileId, authenticated: false }
    authCache = { profileId, epoch, authenticated, checkedAt: Date.now() }
    if (!authenticated) {
      stopUnauthenticatedFunctions()
    } else if (detectorPausedState && detectorPausedState.profileId === profileId) {
      const d: any = store.get('detector') || {}
      if (!d.watching && detectorPausedState.watching) {
        d.watching = true
        d.autoCollect = !!detectorPausedState.autoCollect
        store.set('detector', d)
        mainWindow?.webContents.send('detector:updated', d)
      }
      detectorPausedState = null
    }
    mainWindow?.webContents.send('auth:updated', { profileId, authenticated })
    return { profileId, authenticated }
  })()
  authPending = { profileId, epoch, promise }
  try { return await promise } finally { if (authPending?.promise === promise) authPending = null }
}

async function startUtilityInTab(id: UtilityId, tabId: string, view: BrowserView): Promise<boolean> {
  if (!enabledUtilities.has(id) || views.get(tabId) !== view || view.webContents.isDestroyed()) return false
  const key = utilityKey(id, tabId)
  const existing = utilityRuns.get(key)
  if (existing) return existing.stop ? false : existing.start
  const source = getUtilitySource(id)
  if (!source) return false

  const frame = view.webContents.mainFrame
  const token = ++utilityRunToken
  const script = `(async () => {
    const root = window.__ANIMEON_CUSTOM_UTILITIES__ ||= Object.create(null)
    const module = { exports: {} }
    const result = await new Function('module', 'exports', ${JSON.stringify(source)})(module, module.exports)
    const candidate = (result && typeof result === 'object' ? result : null) || module.exports
    root[${JSON.stringify(id)}] = { token: ${token}, stop: typeof candidate?.stop === 'function' ? () => candidate.stop() : undefined }
    return true
  })()`
  const start = Promise.resolve().then(async () => {
    if (utilityRuns.get(key) !== run || run.stop) return false
    try {
      return await frame.executeJavaScript(script, true) === true
    } catch (error) {
      debugLog(`utility ${id} start failed in tab ${tabId}:`, String(error))
      return false
    }
  })
  const run: UtilityRun = { id, tabId, frame, token, start }
  utilityRuns.set(key, run)
  const started = await start
  if (!started && utilityRuns.get(key) === run && !run.stop) utilityRuns.delete(key)
  return started && utilityRuns.get(key) === run && !run.stop
}

async function startUtility(id: UtilityId) {
  if (!getCustomUtilities().some(item => item?.id === id)) return { ok: false, error: 'Неизвестная функция' }
  const activation = Symbol()
  enabledUtilities.set(id, activation)
  const tabs: any[] = (store.get('tabs') as any[]) || []
  if (!tabs.length) { enabledUtilities.delete(id); notifyUtilities(); return { ok: false, error: 'Откройте вкладку AnimeOn для запуска инструмента' } }
  for (const tab of tabs) ensureView(tab)
  const work = Promise.all(tabs.map(async tab => {
    const view = views.get(tab.id)
    if (!view || view.webContents.isDestroyed()) return false
    if (view.webContents.isLoadingMainFrame()) return null
    return normalizeAnimeonUrl(view.webContents.getURL()) ? startUtilityInTab(id, tab.id, view) : false
  })).then(started => {
    if (enabledUtilities.get(id) !== activation) return { ok: true, active: enabledUtilities.has(id) }
    if (started.every(result => result === false)) {
      enabledUtilities.delete(id)
      notifyUtilities()
      return { ok: false, error: 'Не удалось запустить пользовательскую функцию' }
    }
    notifyUtilities()
    return { ok: true, active: true, tabs: started.filter(Boolean).length }
  })
  const result = await waitForUtilityWork(work, null)
  if (result) return result
  notifyUtilities()
  return { ok: true, active: enabledUtilities.has(id) }
}

async function applyEnabledUtilitiesToView(tabId: string, view: BrowserView) {
  if (!normalizeAnimeonUrl(view.webContents.getURL())) return
  for (const id of [...enabledUtilities.keys()]) {
    await waitForUtilityWork(startUtilityInTab(id, tabId, view), false)
  }
  notifyUtilities()
}

function clearUtilityStatesForTab(tabId: string) {
  for (const [key, run] of utilityRuns) {
    if (run.tabId === tabId) utilityRuns.delete(key)
  }
}

function stopUtilitiesForTab(tabId: string) {
  clearUtilityStatesForTab(tabId)
  notifyUtilities()
}

function getPreloadPath(name: string) {
  return path.join(__dirname, '..', 'preload', name)
}

function getContentBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return { x: 72, y: 99, width: 1060, height: 712 }
  if (mainWindow.isMinimized()) {
    try {
      const rect = mainWindow.getNormalBounds()
      const sidebarW = 72
      return { x: sidebarW, y: 99, width: Math.max(200, rect.width - sidebarW), height: Math.max(200, rect.height - 99) }
    } catch {}
  }
  if (fullscreenTabId && fullscreenTabId === activeTabId) {
    const [w, h] = mainWindow.getSize()
    return { x: 0, y: 0, width: w, height: h }
  }
  const sidebarW = 72
  const [winW, winH] = mainWindow.getSize()
  return { x: sidebarW, y: 99, width: Math.max(100, winW - sidebarW), height: Math.max(100, winH - 99) }
}

// Login uses native popups in the originating profile session.
const oauthWindows = new Set<BrowserWindow>()

let lastAppliedZoom = 1
// When the window is short, zoom the embedded site out a bit so tall
// dropdowns (e.g. the profile menu with "Выйти") fit without resizing.
// Startup size is untouched: full zoom down to 600px content height.
function applyFitZoom(contentHeight: number) {
  const zoom = Math.min(1, Math.max(0.65, contentHeight / 600))
  if (Math.abs(zoom - lastAppliedZoom) < 0.01) return
  lastAppliedZoom = zoom
  for (const [, view] of views.entries()) {
    try { view.webContents.setZoomFactor(zoom) } catch {}
  }
}
function layoutViews() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const bounds = getContentBounds()

  if (activeViewMode === 'site') {
    const tabs: any[] = (store.get('tabs') as any[]) || []
    if (tabs.length > 0) {
      if (!activeTabId || !views.has(activeTabId)) {
        const t = (activeTabId && tabs.find(x => x.id === activeTabId)) || tabs[0]
        if (t) {
          activeTabId = t.id
          store.set('activeTabId', t.id)
          ensureView(t)
        }
      }
    }
  }

  const showSite = activeViewMode === 'site' && activeTabId && views.has(activeTabId)
  for (const [id, view] of views.entries()) {
    if (id === activeTabId && showSite) {
      view.setBounds(bounds as any)
      try { view.webContents.setBackgroundThrottling(false) } catch {}
    } else {
      view.setBounds({ x: -2000, y: -2000, width: 10, height: 10 } as any)
      try {
        const isAudible = view.webContents.isCurrentlyAudible()
        view.webContents.setBackgroundThrottling(!isAudible)
      } catch {}
    }
  }
  applyFitZoom(bounds.height)
}

function refreshActiveViewSurface() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (activeViewMode !== 'site' || !activeTabId) return
  const view = views.get(activeTabId)
  if (!view || (view.webContents as any)?.isDestroyed?.()) return
  const bounds = getContentBounds()
  try {
    view.webContents.setBackgroundThrottling(false)
    view.setBounds({ ...bounds, width: Math.max(10, bounds.width - 1) } as any)
    setImmediate(() => {
      if (!mainWindow || mainWindow.isDestroyed() || activeViewMode !== 'site'
        || !activeTabId || views.get(activeTabId) !== view || view.webContents.isDestroyed()) return
      view.setBounds(getContentBounds())
      try { view.webContents.setBackgroundThrottling(false) } catch {}
    })
  } catch {
    layoutViews()
  }
}

function ensureView(tab: any) {
  if (!mainWindow) return null
  let view = views.get(tab.id)
  if (!view) {
    const ses = session.fromPartition(tab.partition)
    view = new BrowserView({
      webPreferences: {
        session: ses,
        preload: getPreloadPath('hidden.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })
    views.set(tab.id, view)
    let nicknameTimer: NodeJS.Timeout | undefined
    const clearNicknameTimer = () => {
      if (nicknameTimer) clearTimeout(nicknameTimer)
      nicknameTimer = undefined
    }
    view.webContents.once('destroyed', clearNicknameTimer)
    const audioContents = view.webContents
    const isAudible = audioContents.isCurrentlyAudible()
    try { view.webContents.setBackgroundThrottling(tab.id !== activeTabId && !isAudible) } catch {}
    view.webContents.on('focus', () => mainWindow?.webContents.send('site:focused'))
    // Track audio emission independently of the tab's muted setting, without polling.
    audioContents.on('audio-state-changed', event => {
      if (views.get(tab.id) !== view) return
      setTabAudible(tab.id, event.audible)
      if (tab.id !== activeTabId) {
        try { view?.webContents.setBackgroundThrottling(!event.audible) } catch {}
      }
    })
    setTabAudible(tab.id, isAudible)
    view.webContents.on('render-process-gone', (_e, details) => {
      debugLog('DIAG view render-process-gone tab=', tab.id, JSON.stringify(details))
      if (views.get(tab.id) !== view) return
      clearNicknameTimer()
      stopUtilitiesForTab(tab.id)
      setTabAudible(tab.id, false)
      if (fullscreenTabId === tab.id) {
        fullscreenTabId = null
        layoutViews()
      }
    })
    ;(view as any).__accountId = String((tab.partition || '').match(/animeon-acc-(\d+)/)?.[1] || '1')
    mainWindow.addBrowserView(view)
    view.webContents.on('before-input-event', (event, input) => {
      if (handleBrowserShortcut(input)) event.preventDefault()
    })
    view.webContents.on('context-menu', (_event, params) => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      const menu: Electron.MenuItemConstructorOptions[] = []
      if (String(params.selectionText || '').trim()) {
        menu.push({ label: 'Копировать', click: () => view?.webContents.copy() })
      }
      if (params.isEditable) {
        menu.push({ label: 'Вставить', click: () => view?.webContents.paste() })
      }
      if (!params.selectionText && !params.isEditable) {
        if (menu.length) menu.push({ type: 'separator' })
        menu.push({ label: 'Обновить страницу', click: () => { try { view?.webContents.reload() } catch {} } })
      }
      Menu.buildFromTemplate(menu.length ? menu : [{ label: 'Обновить страницу', click: () => { try { view?.webContents.reload() } catch {} } }]).popup({ window: mainWindow })
    })
    view.webContents.on('will-navigate', (event, url) => {
      if (!normalizeAnimeonUrl(url)) {
        event.preventDefault()
        mainWindow?.webContents.send('site:navigationBlocked')
      }
    })
    view.webContents.on('will-redirect', (event, url) => {
      if (!normalizeAnimeonUrl(url)) {
        event.preventDefault()
        mainWindow?.webContents.send('site:navigationBlocked')
      }
    })
    view.webContents.on('page-title-updated', (_e, title) => {
      const tabs: any[] = (store.get('tabs') as any[]) || []
      const t = tabs.find((x) => x.id === tab.id)
      if (t && t.title !== title) { t.title = title; store.set('tabs', tabs); mainWindow?.webContents.send('tabs:updated', tabs, activeTabId) }
    })
    view.webContents.on('page-favicon-updated', (_e, favicons) => {
      const favicon = Array.isArray(favicons) ? String(favicons.find(Boolean) || '') : ''
      const tabs: any[] = (store.get('tabs') as any[]) || []
      const t = tabs.find((x) => x.id === tab.id)
      if (t && t.favicon !== favicon) {
        t.favicon = favicon
        store.set('tabs', tabs)
        mainWindow?.webContents.send('tabs:updated', tabs, activeTabId)
      }
    })
    view.webContents.on('did-navigate', (_e, url) => {
      if (views.get(tab.id) !== view) return
      if (fullscreenTabId === tab.id) {
        fullscreenTabId = null
        layoutViews()
      }
      clearUtilityStatesForTab(tab.id)
      notifyUtilities()
      const tabs: any[] = (store.get('tabs') as any[]) || []
      const t = tabs.find((x) => x.id === tab.id)
      if (t && t.url !== url) { t.url = url; store.set('tabs', tabs) }
    })
    // SPA-навигация не стреляет did-navigate — обновляем адрес вкладки здесь,
    // чтобы хранилась актуальная ссылка.
    view.webContents.on('did-navigate-in-page', (_e, url) => {
      try {
        if (!url || !url.startsWith('http')) return
        const tabs: any[] = (store.get('tabs') as any[]) || []
        const t = tabs.find((x) => x.id === tab.id)
        if (t && t.url !== url) { t.url = url; store.set('tabs', tabs) }
      } catch {}
    })
    view.webContents.on('did-start-navigation', (_e, _url, isInPlace, isMainFrame) => {
      if (!isInPlace && isMainFrame) clearNicknameTimer()
    })
    view.webContents.on('did-finish-load', () => {
      if (views.get(tab.id) !== view) return
      injectPlugin(view!)
      injectNoScrollbarCSS(view!)
      void applyEnabledUtilitiesToView(tab.id, view!)
      // Pick up the nickname on our own after every page load (login, OAuth
      // reload, SPA navigation) instead of relying only on the Settings poll.
      // Delayed slightly so the site can hydrate client-side state first.
      const accountId = (view! as any).__accountId
      clearNicknameTimer()
      nicknameTimer = setTimeout(() => {
        nicknameTimer = undefined
        try {
          if (views.get(tab.id) !== view || (view! as any).__accountId !== accountId) return
          if (view!.webContents.isDestroyed()) return
          if (!normalizeAnimeonUrl(view!.webContents.getURL())) return
          syncAccountNickname(view!, String(accountId || '1'))
        } catch {}
      }, 2500)
    })
    view.webContents.on('enter-html-full-screen', () => {
      if (views.get(tab.id) !== view || tab.id !== activeTabId) return
      fullscreenTabId = tab.id
      layoutViews()
      setTimeout(layoutViews, 50)
    })
    view.webContents.on('leave-html-full-screen', () => {
      if (views.get(tab.id) !== view || fullscreenTabId !== tab.id) return
      fullscreenTabId = null
      layoutViews()
      setTimeout(layoutViews, 50)
      setTimeout(layoutViews, 200)
    })
    view.webContents.loadURL(tab.url).catch(error => {
      if (views.get(tab.id) === view && error?.code !== 'ERR_ABORTED') {
        debugLog('Tab load failed:', tab.id, error?.code || 'unknown error')
      }
    })
  }
  try { view.webContents.setAudioMuted(!!tab.muted) } catch {}
  try { if (lastAppliedZoom !== 1) view.webContents.setZoomFactor(lastAppliedZoom) } catch {}
  return view
}

let pluginCache: string | null = null
function injectPlugin(view: BrowserView) {
  try {
    if (pluginCache == null) {
      const pluginPath = path.join(__dirname, '..', 'preload', 'content.js')
      pluginCache = fs.existsSync(pluginPath) ? fs.readFileSync(pluginPath, 'utf8') : ''
    }
    if (pluginCache) view.webContents.executeJavaScript(pluginCache).catch(() => {})
  } catch {}
}

function injectNoScrollbarCSS(view: BrowserView) {
  view.webContents.insertCSS(`
    ::-webkit-scrollbar { display: none !important; width: 0 !important; }
    html, body { scrollbar-width: none !important; }
  `).catch(() => {})
}

// Ленивый старт: тяжёлый BrowserView создаём только для активной вкладки,
// остальные — по первому переключению (tabs:switch делает ensureView сам).
// Раньше все закреплённые грузились параллельно и тормозили запуск.
function attachActiveTab() {
  try {
    const tabs: any[] = (store.get('tabs') as any[]) || []
    if (!tabs.length) {
      const defaultTab = createTabFromUrl(String(store.get('baseUrl') || 'https://v2.animeon.co'))
      if (defaultTab) {
        activeTabId = defaultTab.id
        store.set('activeTabId', defaultTab.id)
        ensureView(defaultTab)
      }
    } else {
      const t = (activeTabId && tabs.find(x => x.id === activeTabId)) || tabs[0]
      if (t) {
        activeTabId = t.id
        store.set('activeTabId', t.id)
        ensureView(t)
      }
    }
  } catch {}
  layoutViews()
  try { mainWindow?.webContents.send('tabs:updated', store.get('tabs'), activeTabId) } catch {}
}

const DEV_RENDERER_URL = 'http://localhost:5173'
const RENDERER_ENTRY = path.join(__dirname, '..', 'renderer', 'index.html')
const RENDERER_FILE_URL = pathToFileURL(RENDERER_ENTRY).href

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1522,
    height: 884,
    minWidth: 1024,
    minHeight: 600,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    titleBarStyle: 'hidden',
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'bridge.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  mainWindow.setMenuBarVisibility(false)
  mainWindow.removeMenu()
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (handleBrowserShortcut(input)) event.preventDefault()
  })

  if (process.env.NODE_ENV === 'development' && !app.isPackaged) {
    mainWindow.loadURL(DEV_RENDERER_URL).catch(() => mainWindow?.loadFile(RENDERER_ENTRY))
  } else {
    mainWindow.loadFile(RENDERER_ENTRY)
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
    attachActiveTab()
    layoutViews()
  })
  // Renderer тоже остаётся живым при сворачивании: он получает статусы
  // инструментов и уведомления, пока фоновые вкладки продолжают наблюдение.
  try { mainWindow.webContents.setBackgroundThrottling(false) } catch {}

  const shellContents = mainWindow.webContents
  let closing = false
  let lastShellRecovery = -Infinity
  shellContents.on('render-process-gone', (_e, details) => {
    debugLog('DIAG main render-process-gone:', JSON.stringify(details))
    if (closing || details.reason === 'clean-exit' || shellContents.isDestroyed()) return
    const now = performance.now()
    // Give a crashed shell one reload without entering a crash/reload loop.
    if (now - lastShellRecovery < 30_000) return
    lastShellRecovery = now
    shellContents.reload()
  })
  mainWindow.on('unresponsive', () => debugLog('DIAG main window unresponsive'))
  mainWindow.on('responsive', () => debugLog('DIAG main window responsive again'))
  mainWindow.on('hide', () => debugLog('DIAG main window hide'))
  mainWindow.on('minimize', () => {
    debugLog('DIAG main window minimize')
    for (const [id, view] of views) {
      try {
        const isAudible = view.webContents.isCurrentlyAudible()
        view.webContents.setBackgroundThrottling(id !== activeTabId && !isAudible)
      } catch {}
    }
  })
  mainWindow.on('close', () => {
    closing = true
    resetRunFlags()
    debugLog('DIAG main window close')
  })

  mainWindow.on('resize', layoutViews)
  mainWindow.on('maximize', () => { layoutViews(); refreshActiveViewSurface() })
  mainWindow.on('unmaximize', () => { layoutViews(); refreshActiveViewSurface() })
  mainWindow.on('restore', () => { layoutViews(); refreshActiveViewSurface() })
  mainWindow.on('show', () => { layoutViews(); refreshActiveViewSurface() })
  mainWindow.on('focus', () => { refreshActiveViewSurface() })
  mainWindow.on('enter-full-screen', () => { fullscreenTabId = null; layoutViews(); refreshActiveViewSurface() })
  mainWindow.on('leave-full-screen', () => { fullscreenTabId = null; layoutViews(); refreshActiveViewSurface() })

  mainWindow.on('closed', () => {
    mainWindow = null
    for (const id of [...views.keys()]) destroyView(id)
  })
}

function registerIpcHandlers() {
  const privateKeys = new Set(['tabs', 'tabOrder', 'accounts', 'customUtilities', 'secretsCatalog', 'followListsByProfile'])
  const managedKeys = new Set([
    ...privateKeys, 'activeTabId', 'activeAccountId', 'baseUrl', 'activeView', 'sidebarCollapsed',
    'detector', 'followBackEnabled', 'followbackStates', 'followbackLastCheck', 'followbackLastSummary'
  ])
  const rootStoreKey = (key: string) => key.replace(/\\/g, '').split(/[.\[]/, 1)[0]
  type IpcSender = Electron.IpcMainInvokeEvent | Electron.IpcMainEvent
  const isAppRenderer = (event: IpcSender) => {
    const frame = event.senderFrame
    if (event.sender !== mainWindow?.webContents || !frame || frame !== event.sender.mainFrame) return false
    if (frame.url.split(/[?#]/, 1)[0] === RENDERER_FILE_URL) return true
    return process.env.NODE_ENV === 'development' && !app.isPackaged && frame.origin === DEV_RENDERER_URL
  }
  const isSiteRenderer = (event: IpcSender) => {
    const frame = event.senderFrame
    if (!frame || frame !== event.sender.mainFrame || ![...views.values()].some(view => view.webContents === event.sender)) return false
    const url = normalizeAnimeonUrl(frame.url)
    return url !== null && frame.origin === new URL(url).origin
  }
  electronIpcMain.on('site:open-telegram-channel', event => {
    if (!isSiteRenderer(event) || event.sender !== views.get(activeTabId ?? '')?.webContents) return
    void shell.openExternal(ANIMEON_TELEGRAM_CHANNEL).catch(() => {})
  })
  // These channels back the compatibility API in hidden.ts. The rest
  // are commands for the local application renderer.
  const siteChannels = new Set([
    'store:get', 'store:set', 'tabs:getCount', 'afk:log', 'detector:toggle',
    'anomaly:detected', 'anomaly:action', 'anomaly:claim',
    'followback:lists', 'followback:notify', 'followback:diag', 'followback:heartbeat',
    'followback:claim', 'followback:finish'
  ])
  const ipcMain = {
    handle(channel: string, handler: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => unknown) {
      electronIpcMain.handle(channel, (event, ...args) => {
        if (isAppRenderer(event) || (siteChannels.has(channel) && isSiteRenderer(event))) {
          return handler(event, ...args)
        }
        return undefined
      })
    },
    on(channel: string, handler: () => void) {
      electronIpcMain.on(channel, event => { if (isAppRenderer(event)) handler() })
    }
  }
  ipcMain.handle('store:get', (event, key: unknown) => {
    if (typeof key !== 'string' || !key) return undefined
    if (privateKeys.has(rootStoreKey(key)) && !isAppRenderer(event)) return undefined
    return store.get(key)
  })
  ipcMain.handle('store:set', (event, key: unknown, value: unknown) => {
    if (typeof key !== 'string' || !key || value === undefined) return false
    const root = rootStoreKey(key)
    if (managedKeys.has(root) && !(key === 'secretsCatalog' && isAppRenderer(event))) return false
    store.set(key, value)
    return true
  })
  ipcMain.handle('store:getAll', () => store.store)
  ipcMain.handle('accounts:list', async () => {
    const mutationEpoch = accountMutationEpoch
    if (profileSwitchBusy) return normalizeAccounts()
    const accounts = normalizeAccounts()
    // Best effort: when a profile tab is already loaded, ask AnimeOn for the
    // current user and persist the nickname alongside the account id.
    for (const account of accounts) {
      const view = [...views.values()].find(v => {
        try { return !!normalizeAnimeonUrl(v.webContents.getURL()) && (v as any).__accountId === account.id } catch { return false }
      })
      if (!view) continue
      try {
        const res: any = await view.webContents.executeJavaScript(`(async()=>{\n          let loggedIn=false;\n          const paths=['/api/auth/me','/api/user/profile','/api/profile'];\n          for(const p of paths){try{const r=await fetch(p,{credentials:'include'});if(r.ok){const j=await r.json().catch(()=>null);if(j&&typeof j==='object'&&Object.keys(j).length){loggedIn=true;return {loggedIn,data:(j&&j.user)||(j&&j.profile)||j};}}}catch{}}\n          return {loggedIn,data:null};\n        })()`, true)
        const profile = res && res.data
        let nickname = String(profile?.nickname || profile?.username || profile?.name || profile?.login || profile?.user?.nickname || profile?.user?.username || profile?.user?.name || profile?.data?.nickname || profile?.data?.username || profile?.data?.name || profile?.data?.user?.nickname || profile?.data?.user?.username || profile?.data?.user?.name || '').trim()
        if (!nickname && res && res.loggedIn) {
          try {
            nickname = String(await view.webContents.executeJavaScript(`(()=>{
              const links=[...document.querySelectorAll('a[href]')];
              const self=links.find(a=>{const t=(a.textContent||'').trim().toLowerCase();return t.indexOf('как видят другие')!==-1||t.indexOf('мой профиль')!==-1;});
              const h=self?(self.getAttribute('href')||''):'';
              const iu=h.toLowerCase().indexOf('/user/');
              if(iu===-1)return '';
              return decodeURIComponent(h.slice(iu+6).split(/[?#]/)[0]);
            })()`, true) || '').trim()
          } catch {}
        }
        if (res && res.loggedIn) {
          if (nickname && nickname !== account.nickname) account.nickname = nickname
        } else if (account.nickname) {
          account.nickname = ''
        }
      } catch {}
    }
    if (mutationEpoch !== accountMutationEpoch) return normalizeAccounts()
    if (JSON.stringify(store.get('accounts')) !== JSON.stringify(accounts)) store.set('accounts', accounts)
    notifyAccounts()
    return accounts
  })
  ipcMain.handle('accounts:add', async () => {
    if (profileSwitchBusy) return null
    profileSwitchBusy = true
    accountMutationEpoch++
    try {
    const accounts = normalizeAccounts()
    if (accounts.length >= 4) return null
    const used = new Set(accounts.map(a => String(a.id)))
    let n = 1; while (used.has(String(n)) && n <= 4) n++
    if (n > 4) return null
    await clearProfileSession(String(n))
    const profile = { id: String(n), nickname: '', createdAt: Date.now() }
    accounts.push(profile)
    accounts.sort((a, b) => Number(a.id) - Number(b.id))
    store.set('accounts', accounts)
    notifyAccounts()
    return profile
    } finally { profileSwitchBusy = false }
  })
  ipcMain.handle('accounts:select', async (_e, id: string | number) => {
    const key = String(id)
    const accounts = normalizeAccounts()
    if (!accounts.some(a => a.id === key)) return false
    if (String(store.get('activeAccountId')) === key) return true
    if (profileSwitchBusy) return false
    profileSwitchBusy = true
    try {
    resetRunFlags()
    utilityEpoch++
    await stopAllUtilities()
    mainWindow?.webContents.send('detector:updated', store.get('detector'))
    mainWindow?.webContents.send('followback:stateChanged')
    store.set('activeAccountId', key)
    if (activeTabId) applyAccountToTabs(key)
    notifyAccounts()
    return true
    } finally { profileSwitchBusy = false }
  })
  ipcMain.handle('accounts:setNickname', (_e, id: string | number, nickname: string) => {
    const key = String(id)
    const accounts = normalizeAccounts()
    const account = accounts.find(a => a.id === key)
    if (!account) return false
    account.nickname = String(nickname || '').trim().slice(0, 80)
    store.set('accounts', accounts)
    notifyAccounts()
    return account
  })
  ipcMain.handle('accounts:remove', async (_e, id: string | number) => {
    if (profileSwitchBusy) return false
    const key = String(id)
    const accounts = normalizeAccounts()
    if (!accounts.some(a => a.id === key)) return false
    profileSwitchBusy = true
    accountMutationEpoch++
    try {
    resetRunFlags()
    utilityEpoch++
    await stopAllUtilities()
    mainWindow?.webContents.send('detector:updated', store.get('detector'))
    mainWindow?.webContents.send('followback:stateChanged')
    await clearProfileSession(key)
    const next = accounts.filter(a => a.id !== key)
    if (key === '1' || !next.length) next.push({ id: '1', nickname: '', createdAt: Date.now() })
    next.sort((a, b) => Number(a.id) - Number(b.id))
    store.set('accounts', next)
    if (String(store.get('activeAccountId')) === key) {
      const fallback = String(next[0].id)
      store.set('activeAccountId', fallback)
    }
    if (!activeTabId) {
      const tab = createTabFromUrl(String(store.get('baseUrl')))
      if (tab) { activeTabId = tab.id; store.set('activeTabId', tab.id); layoutViews() }
    }
    mainWindow?.webContents.send('tabs:updated', store.get('tabs'), activeTabId)
    notifyAccounts()
    return true
    } finally { profileSwitchBusy = false }
  })
  ipcMain.handle('tabs:create', (_e, url) => {
    if (profileSwitchBusy) return null
    const safeUrl = normalizeAnimeonUrl(url || store.get('baseUrl'))
    if (!safeUrl) return null
    const id = randomUUID()
    const tabs: any[] = (store.get('tabs') as any[]) || []
    if (tabs.length >= 7) { debugLog('DIAG tabs:create at limit'); notifyTabLimit(); return null }
    const activeAcc = store.get('activeAccountId') as string | null
    const partition = activeAcc ? `persist:animeon-acc-${activeAcc}` : 'persist:animeon-acc-1'
    const tab = { id, url: safeUrl, title: 'Новая вкладка', favicon: '', partition, pinned: false, muted: false, audible: false }
    tabs.push(tab)
    store.set({ tabs, tabOrder: getTabOrder(tabs, store.get('tabOrder')), activeTabId: id })
    activeTabId = id
    ensureView(tab); layoutViews()
    mainWindow?.webContents.send('tabs:updated', tabs, activeTabId)
    return tab
  })
  ipcMain.handle('tabs:close', (_e, id) => {
    const allTabs = store.get('tabs') || []
    const existing = allTabs.find(t => t.id === id)
    if (!existing || existing.pinned) return false
    const tabs = allTabs.filter(tab => tab.id !== id)
    const order = getTabOrder(tabs, store.get('tabOrder'))
    const wasActive = activeTabId === id
    const nextActive = wasActive ? order[0] || null : activeTabId
    store.set({ tabs, tabOrder: order, activeTabId: nextActive })
    activeTabId = nextActive
    destroyView(id)
    if (wasActive) layoutViews()
    mainWindow?.webContents.send('tabs:updated', tabs, activeTabId)
    return true
  })
  ipcMain.handle('tabs:reorder', (event, order: unknown, draggedId: string, previousOrder: unknown) => {
    if (!isAppRenderer(event)) return false
    const tabs: any[] = store.get('tabs') || []
    const current = getTabOrder(tabs, store.get('tabOrder'))
    if (!Array.isArray(order) || !sameTabOrder(current, previousOrder)) return false
    const next = moveTab(tabs, current, current.indexOf(draggedId), order.indexOf(draggedId))
    if (!next || !sameTabOrder(next, order)) return false
    store.set('tabOrder', next)
    return true
  })
  ipcMain.handle('tabs:togglePinned', (_e, id: string) => {
    const tabs: any[] = (store.get('tabs') as any[]) || []
    const tab = tabs.find(t => t.id === id)
    if (!tab) return false
    tab.pinned = !tab.pinned
    store.set({ tabs, tabOrder: getTabOrder(tabs, store.get('tabOrder')) })
    mainWindow?.webContents.send('tabs:updated', tabs, activeTabId)
    return tab.pinned
  })
  ipcMain.handle('tabs:toggleMuted', (_e, id: string) => {
    const tabs: any[] = (store.get('tabs') as any[]) || []
    const tab = tabs.find(t => t.id === id)
    if (!tab) return false
    tab.muted = !tab.muted
    store.set('tabs', tabs)
    try { views.get(id)?.webContents.setAudioMuted(!!tab.muted) } catch {}
    mainWindow?.webContents.send('tabs:updated', tabs, activeTabId)
    return tab.muted
  })
  ipcMain.handle('tabs:switch', (_e, id: string) => {
    const tab = (store.get('tabs') || []).find(t => t.id === id)
    if (!tab) return false
    if (activeTabId !== id) store.set('activeTabId', id)
    activeTabId = id
    activeViewMode = 'site'
    if (store.get('activeView') !== 'site') store.set('activeView', 'site')
    ensureView(tab)
    layoutViews(); return true
  })
  ipcMain.handle('tabs:navigate', (_e, id: string, url: string) => {
    const safeUrl = normalizeAnimeonUrl(url)
    if (!safeUrl) return { ok: false, error: 'Введите корректный адрес AnimeOn: animeon.cc, animeon.co, v1.animeon.co или v2.animeon.co.' }
    const tabs = store.get('tabs') || []
    const tab = tabs.find(t => t.id === id)
    if (!tab) return { ok: false, error: 'Вкладка уже закрыта' }
    if (tab.url !== safeUrl) {
      tab.url = safeUrl
      store.set('tabs', tabs)
    }
    const view = views.get(id)
    if (view) void view.webContents.loadURL(safeUrl).catch(() => {})
    else ensureView(tab)
    return { ok: true, url: safeUrl }
  })
  // Domain switch from Settings: rewrite tab URLs to the new host and reload
  // all views there, same as profile switching recreates sessions.
  // Copy host-only session cookies to the new domain so the user stays
  // logged in after a domain switch (mirrors don't share sessions).
  async function migrateSessionCookies(partition: string, fromHost: string, toHost: string) {
    try {
      const ses = session.fromPartition(partition)
      const all = await ses.cookies.get({})
      const own = all.filter(c => c.domain === fromHost || c.domain === `.${fromHost}`)
      for (const c of own) {
        if (c.name.startsWith('__Host-')) continue
        try {
          await ses.cookies.set({
            url: `https://${toHost}${c.path && c.path.startsWith('/') ? c.path : '/'}`,
            name: c.name,
            value: c.value,
            path: c.path || '/',
            secure: c.secure,
            httpOnly: c.httpOnly,
            expirationDate: c.expirationDate,
            sameSite: c.sameSite as any,
          })
        } catch {}
      }
    } catch {}
  }
  ipcMain.handle('site:setBaseUrl', async (_e, url: string) => {
    const base = normalizeAnimeonBaseUrl(url)
    if (!base || profileSwitchBusy) return false
    const prev = String(store.get('baseUrl') || '')
    if (prev === base) return true
    const host = new URL(base).host
    let prevHost = ''
    try { prevHost = new URL(prev).host } catch {}
    profileSwitchBusy = true
    try {
      if (prevHost && prevHost !== host) {
        const partitions = new Set<string>(['1', '2', '3', '4', '5'].map(id => `persist:animeon-acc-${id}`))
        for (const tab of store.get('tabs') || []) {
          if (typeof tab.partition === 'string' && tab.partition.startsWith('persist:')) partitions.add(tab.partition)
        }
        for (const partition of partitions) await migrateSessionCookies(partition, prevHost, host)
      }

      // Closing, pinning or muting a tab while cookies are copied must survive
      // the mirror change. Read the live tabs after the asynchronous work.
      const tabs = store.get('tabs') || []
      for (const tab of tabs) {
        if (typeof tab.url === 'string' && normalizeAnimeonUrl(tab.url)) {
          const u = new URL(tab.url)
          u.host = host
          tab.url = u.toString()
        } else {
          tab.url = base
        }
      }
      store.set({ baseUrl: base, tabs })
      const loadedTabIds = new Set(views.keys())
      for (const tab of tabs) {
        if (!loadedTabIds.has(tab.id)) continue
        destroyView(tab.id)
        ensureView(tab)
      }
      layoutViews()
      mainWindow?.webContents.send('tabs:updated', tabs, activeTabId)
      return true
    } finally {
      profileSwitchBusy = false
    }
  })
  ipcMain.handle('tabs:contextMenu', (_e, id: string) => {
    const tab = ((store.get('tabs') as any[]) || []).find(tab => tab.id === id)
    if (!tab || !mainWindow) return
    const send = (action: string) => mainWindow?.webContents.send('tabs:menuAction', id, action)
    Menu.buildFromTemplate([
      { label: tab.pinned ? 'Открепить вкладку' : 'Закрепить вкладку', click: () => send('pin') },
      { label: tab.muted ? 'Включить звук' : 'Выключить звук', click: () => send('mute') }
    ]).popup({ window: mainWindow })
  })
  ipcMain.handle('address:contextMenu', async (_e, currentUrl: string) => {
    if (!mainWindow) return
    const fullUrl = /^https?:\/\//i.test(currentUrl) ? currentUrl : `https://${currentUrl}`
    let clipText = ''
    try { clipText = (await clipboard.readText()).trim() } catch {}
    Menu.buildFromTemplate([
      {
        label: 'Копировать адрес',
        click: async () => {
          await clipboard.writeText(fullUrl)
          mainWindow?.webContents.send('address:copied', fullUrl)
        }
      },
      {
        label: 'Вставить',
        enabled: Boolean(clipText),
        click: () => {
          mainWindow?.webContents.send('address:pasted', clipText)
        }
      },
      {
        label: 'Вставить и перейти',
        enabled: Boolean(clipText),
        click: () => {
          mainWindow?.webContents.send('address:pasteAndGo', clipText)
        }
      }
    ]).popup({ window: mainWindow })
  })
  ipcMain.handle('view:set', (_e, mode: string) => {
    if (activeViewMode === mode) return true
    activeViewMode = mode
    if (mode !== 'commands' && mode !== 'modal' && store.get('activeView') !== mode) store.set('activeView', mode)
    layoutViews()
    return true
  })
  ipcMain.handle('sidebar:setCollapsed', (_e, v: unknown) => {
    if (typeof v !== 'boolean') return false
    if (store.get('sidebarCollapsed') !== v) {
      store.set('sidebarCollapsed', v)
      layoutViews()
    }
    return true
  })
  ipcMain.handle('app:version', () => app.getVersion())
  ipcMain.handle('tabs:reloadActive', () => reloadActiveTab())
  ipcMain.handle('app:toggleDevTools', () => toggleDevTools())
  ipcMain.handle('app:clearCache', async () => {
    try {
      const partitions = new Set<string>()
      for (let i = 1; i <= 5; i++) partitions.add(`persist:animeon-acc-${i}`)
      const tabs = (store.get('tabs') as any[]) || []
      for (const t of tabs) {
        if (typeof t.partition === 'string' && t.partition.startsWith('persist:')) partitions.add(t.partition)
      }
      for (const p of partitions) {
        try {
          const ses = session.fromPartition(p)
          await ses.clearCache()
          await ses.clearStorageData({ storages: ['cachestorage', 'shadercache'] })
        } catch {}
      }
      await session.defaultSession.clearCache()
      await session.defaultSession.clearStorageData({ storages: ['cachestorage', 'shadercache'] })
      return true
    } catch {
      return false
    }
  })
  ipcMain.handle('clipboard:writeText', async (_e, text: string) => {
    try { await clipboard.writeText(String(text || '')); return true } catch { return false }
  })
  ipcMain.handle('app:checkUpdate', async () => {
    const current = app.getVersion()
    try {
      let latest = ''
      let releaseUrl = 'https://github.com/Kotecy/Animeon-Desktop/releases'
      try {
        const response = await fetch('https://api.github.com/repos/Kotecy/Animeon-Desktop/releases/latest', { headers: { 'User-Agent': 'AnimeonDesktop' } })
        if (response.ok) {
          const release: any = await response.json()
          latest = String(release.tag_name || release.name || '').replace(/^v/i, '')
          if (release.html_url) releaseUrl = release.html_url
        }
      } catch {}

      if (!latest) {
        // Fallback: GitHub web release redirect (bypasses api.github.com 60 req/hr rate limit)
        const webRes = await fetch('https://github.com/Kotecy/Animeon-Desktop/releases/latest', { redirect: 'manual' })
        const loc = webRes.headers.get('location') || ''
        const match = loc.match(/\/tag\/v?([0-9.]+)/i)
        if (match) {
          latest = match[1]
          releaseUrl = loc
        } else if (webRes.url) {
          const matchUrl = webRes.url.match(/\/tag\/v?([0-9.]+)/i)
          if (matchUrl) {
            latest = matchUrl[1]
            releaseUrl = webRes.url
          }
        }
      }

      if (!latest) return { ok: false, current, error: 'Не удалось получить данные о релизе' }

      const parts = (v: string) => v.split('.').map(n => Number.parseInt(n, 10) || 0)
      const a = parts(current); const b = parts(latest)
      let newer = false
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        if ((b[i] || 0) !== (a[i] || 0)) { newer = (b[i] || 0) > (a[i] || 0); break }
      }
      return { ok: true, current, latest, newer, url: releaseUrl }
    } catch (error: any) { return { ok: false, current, error: String(error?.message || error) } }
  })
  // Open release notes in the system browser. URL is whitelisted to our repo.
  ipcMain.handle('app:openUrl', (_e, url: string) => {
    const u = String(url || '')
    if (!/^https:\/\/github\.com\/Kotecy\/Animeon-Desktop\/releases/.test(u)) return false
    try { shell.openExternal(u); return true } catch { return false }
  })
  // Open the site's own login page in the active embedded tab.  The renderer
  // exposes this API for a native login button, so keep the navigation in the
  // same persistent partition as the selected account.
  ipcMain.handle('google:login', async () => {
    const id = activeTabId || (store.get('tabOrder') as string[])?.[0]
    const view = id ? views.get(id) : null
    if (!view) return { ok: false, error: 'Нет вкладки AnimeOn' }
    const current = view.webContents.getURL()
    const target = normalizeAnimeonUrl(current) ? current : (store.get('baseUrl') as string)
    try {
      await view.webContents.executeJavaScript(`(()=>{const b=[...document.querySelectorAll('button,a')].find(x=>/google|войти|вход|login/i.test((x.innerText||'')+' '+(x.getAttribute('aria-label')||'')));if(b){b.click();return true}return false})()`, true)
      return { ok: true }
    } catch {
      try { await view.webContents.loadURL(target); return { ok: true } } catch (e) { return { ok: false, error: String(e) } }
    }
  })
  ipcMain.handle('achievements:fetch', async () => {
    const id = activeTabId || (store.get('tabOrder') as string[])?.[0]
    const view = id ? views.get(id) : null
    const target = view || [...views.values()].find(v => {
      try { return !!normalizeAnimeonUrl(v.webContents.getURL()) } catch { return false }
    })
    if (!target) return { ok: false, error: 'Нет вкладки AnimeOn' }
    try {
      const data = await target.webContents.executeJavaScript(`
        fetch('/api/achievements', { credentials: 'include' }).then(r => r.ok ? r.json() : Promise.reject(r.status)).catch(e => ({ __error: String(e) }))
      `)
      if ((data as any)?.__error) return { ok: false, error: (data as any).__error }
      return { ok: true, data }
    } catch (e) { return { ok: false, error: String(e) } }
  })
  ipcMain.handle('anomaly:state', async () => {
    const target = activeTabId ? views.get(activeTabId) : null
    if (!target || !normalizeAnimeonUrl(target.webContents.getURL())) return { ok: false, error: 'Откройте вкладку AnimeOn' }
    try {
      return await target.webContents.executeJavaScript(`(async () => {
        const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 8000);
        try {
          const response = await fetch('/api/event/boar/anomaly/state', { credentials: 'include', signal: controller.signal });
          if (!response.ok) return { ok: false, error: response.status === 401 ? 'Войдите в аккаунт' : 'Не удалось загрузить остаток' };
          const data = await response.json();
          return Number.isInteger(data.remaining_today) && data.remaining_today >= 0
            ? { ok: true, remaining: data.remaining_today } : { ok: false, error: 'Данные остатка недоступны' };
        } catch { return { ok: false, error: 'Нет соединения с сайтом' } } finally { clearTimeout(timer) }
      })()`)
    } catch { return { ok: false, error: 'Не удалось загрузить остаток' } }
  })
  ipcMain.handle('auth:state', () => getFeatureAuth())
  ipcMain.handle('utilities:list', () => publicUtilities())
  ipcMain.handle('utilities:import', (_e, rawSlot: unknown, rawName: unknown, rawSource: unknown) => {
    const slot = Number(rawSlot)
    const name = String(rawName || '').trim()
    const source = String(rawSource || '')
    if (!Number.isInteger(slot) || slot < 0 || slot >= 12) return { ok: false, error: 'Недопустимая позиция' }
    if (!/\.js$/i.test(name)) return { ok: false, error: 'Загрузите файл .js' }
    if (!source || source.length > 300000 || source.includes('\u0000')) return { ok: false, error: 'Файл пустой или слишком большой' }
    const slots = getCustomUtilities()
    if (slots[slot]) return { ok: false, error: 'Эта позиция уже занята' }
    const id = `custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    slots[slot] = { id, name: name.replace(/\.js$/i, '').slice(0, 80) || 'Пользовательская функция', description: readUtilityDescription(source), source, slot, createdAt: Date.now() }
    store.set('customUtilities', slots)
    notifyUtilities()
    return { ok: true, item: { id, name: slots[slot]!.name, description: slots[slot]!.description, slot, active: false } }
  })
  ipcMain.handle('utilities:move', (_e, rawId: unknown, rawTargetSlot: unknown) => {
    const id = String(rawId || '')
    const targetSlot = Number(rawTargetSlot)
    if (!Number.isInteger(targetSlot) || targetSlot < 0 || targetSlot >= 12) return { ok: false, error: 'Недопустимая позиция' }
    const slots = getCustomUtilities()
    const sourceSlot = slots.findIndex(item => item?.id === id)
    if (sourceSlot < 0) return { ok: false, error: 'Функция не найдена' }
    if (sourceSlot === targetSlot) return { ok: true, items: publicUtilities() }
    const displaced = slots[targetSlot]
    slots[targetSlot] = slots[sourceSlot]
    slots[sourceSlot] = displaced
    slots.forEach((item, slot) => { if (item) item.slot = slot })
    store.set('customUtilities', slots)
    notifyUtilities()
    return { ok: true, items: publicUtilities() }
  })
  ipcMain.handle('utilities:remove', async (_e, rawId: unknown) => {
    const id = String(rawId || '')
    const slots = getCustomUtilities()
    const slot = slots.findIndex(item => item?.id === id)
    if (slot < 0) return { ok: false }
    slots[slot] = null
    store.set('customUtilities', slots)
    const result = await stopUtility(id, false)
    notifyUtilities()
    return result
  })
  ipcMain.handle('utilities:toggle', async (_e, rawId: UtilityId) => {
    const id = String(rawId || '')
    if (!getCustomUtilities().some(item => item?.id === id)) return { ok: false, error: 'Неизвестная функция' }
    if (profileSwitchBusy) return { ok: false, error: 'Дождитесь смены профиля' }
    if (enabledUtilities.has(id)) return stopUtility(id)
    if ([...utilityRuns.values()].some(run => run.id === id && run.stop)) {
      return { ok: false, error: 'Дождитесь остановки функции' }
    }
    return startUtility(id)
  })
  function notifyDetector(d?: any) {
    const data = d || store.get('detector')
    mainWindow?.webContents.send('detector:updated', data)
    for (const [, v] of views) {
      try { v.webContents.send('detector:updated', data) } catch {}
    }
  }
  ipcMain.handle('detector:toggle', async (_event, enabled?: boolean) => {
    const revision = ++detectorToggleRevision, epoch = utilityEpoch
    const d: any = (store as any).get('detector') || { watching: false, sound: true, count: 0, lastAt: 0 }
    const next = typeof enabled === 'boolean' ? enabled : !d.watching
    if (next) {
      const auth = await getFeatureAuth(true)
      if (!auth.authenticated || epoch !== utilityEpoch || revision !== detectorToggleRevision) return { ...(store.get('detector') as any), error: 'Войдите в аккаунт' }
    }
    d.watching = next
    if (!d.watching) { d.autoCollect = false; cancelCollections(); detectorPausedState = null }
    ;(store as any).set('detector', d)
    mainWindow?.webContents.send('detector:updated', d)
    for (const [, v] of views) {
      try { v.webContents.send('detector:updated', d) } catch {}
    }
    return d
  })
  ipcMain.handle('detector:sound', () => {
    const d: any = (store as any).get('detector') || { watching: false, sound: true, count: 0, lastAt: 0 }
    d.sound = d.sound === undefined ? false : !d.sound
    d.toast = d.sound
    if (!d.sound) for (const view of views.values()) view.webContents.executeJavaScript("document.querySelectorAll('[data-animeon-anomaly]').forEach(el => el.remove())").catch(() => {})
    ;(store as any).set('detector', d)
    mainWindow?.webContents.send('detector:updated', d)
    for (const [, v] of views) {
      try { v.webContents.send('detector:updated', d) } catch {}
    }
    return d
  })
  ipcMain.handle('detector:toast', () => {
    const d: any = (store as any).get('detector') || { watching: false, sound: true, count: 0, lastAt: 0 }
    d.toast = d.toast === undefined ? false : !d.toast
    d.sound = d.toast
    ;(store as any).set('detector', d)
    mainWindow?.webContents.send('detector:updated', d)
    for (const [, v] of views) {
      try { v.webContents.send('detector:updated', d) } catch {}
    }
    return d
  })
  ipcMain.handle('detector:openModal', () => {
    const view = activeTabId ? views.get(activeTabId) : [...views.values()][0]
    if (view && !view.webContents.isDestroyed()) {
      view.webContents.send('detector:open-modal')
      return true
    }
    return false
  })
  ipcMain.handle('tabs:getCount', () => ((store.get('tabs') as any[]) || []).length)
  const followLocks = new Map<string, { sender: number, owner: string, until: number }>()
  ipcMain.handle('detector:collect', async () => {
    const epoch = utilityEpoch, runEpoch = collectionEpoch
    if (!await getFeatureAuth(true).then(s => s.authenticated) || epoch !== utilityEpoch || runEpoch !== collectionEpoch) return store.get('detector')
    const d: any = store.get('detector') || {}
    d.autoCollect = AUTO_COLLECT_AVAILABLE && !!d.watching && !d.autoCollect
    if (!d.autoCollect) cancelCollections()
    store.set('detector', d)
    mainWindow?.webContents.send('detector:updated', d)
    for (const [, v] of views) {
      try { v.webContents.send('detector:updated', d) } catch {}
    }
    return d
  })
  ipcMain.handle('afk:log', (_event, type: string, data: any) => {
    logAfk(type, data)
    return true
  })
  const collectAttempts = new Map<string, number>()
  const collectInFlight = new Set<string>()
  ipcMain.handle('anomaly:claim', async event => {
    const sender = event.sender
    const view = [...views.values()].find(v => v.webContents === sender)
    if (!view || sender.isDestroyed()) return { status: 'skipped' }
    const profile = String((view as any).__accountId)
    const originUrl = normalizeAnimeonUrl(sender.getURL())
    if (!originUrl) return { status: 'skipped' }
    const origin = new URL(originUrl).origin
    const epoch = utilityEpoch
    const runEpoch = collectionEpoch
    const allowed = () => {
      const d: any = store.get('detector') || {}
      return AUTO_COLLECT_AVAILABLE && runEpoch === collectionEpoch && !profileSwitchBusy && epoch === utilityEpoch && d.watching && d.autoCollect && !sender.isDestroyed() &&
        [...views.values()].includes(view) && String((view as any).__accountId) === profile &&
        normalizeAnimeonUrl(sender.getURL()) && new URL(sender.getURL()).origin === origin
    }
    if (!allowed() || collectInFlight.has(profile) || Date.now() - (collectAttempts.get(profile) || 0) < 60000) return { status: 'skipped' }
    collectInFlight.add(profile)
    collectAttempts.set(profile, Date.now())
    try {
      if (!await waitForCollection() || !allowed()) return { status: 'skipped' }
      // Fresh server eligibility after the delay; no DOM/button requirement or navigation.
      const ready = await sender.executeJavaScript(`(async()=>{
        const r=await fetch('/api/event/boar/anomaly/state',{credentials:'include',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(10000)});
        if(!r.ok)throw new Error('state HTTP '+r.status);
        const j=await r.json();return j?.eligible===true;
      })()`, true)
      if (!ready || !allowed()) return { status: 'skipped' }
      const result = await sender.executeJavaScript(`(async()=>{
        const r=await fetch('/api/event/boar/anomaly/claim',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'include',redirect:'error',signal:AbortSignal.timeout(10000)});
        const j=await r.json().catch(()=>null);
        return {status:r.ok&&!(j&&(j.success===false||j.ok===false||j.error))?'accepted':'failed',httpStatus:r.status};
      })()`, true)
      const payload = { status: result?.status === 'accepted' ? 'accepted' : 'failed', httpStatus: result?.httpStatus, profileId: profile, time: Date.now() }
      if (allowed()) {
        mainWindow?.webContents.send('anomaly:collect-result', payload)
        for (const [, v] of views) {
          try { v.webContents.send('anomaly:collect-result', payload) } catch {}
        }
      }
      return result
    } catch {
      const payload = { status: 'unknown', profileId: profile, time: Date.now() }
      if (allowed()) {
        mainWindow?.webContents.send('anomaly:collect-result', payload)
        for (const [, v] of views) {
          try { v.webContents.send('anomaly:collect-result', payload) } catch {}
        }
      }
      return { status: 'unknown' }
    } finally {
      collectAttempts.set(profile, Date.now())
      collectInFlight.delete(profile)
    }
  })
  let activeAnomalyAlerted = false
  ipcMain.handle('anomaly:action', (event, action: string) => {
    const view = [...views.values()].find(v => v.webContents === event.sender)
    const d: any = store.get('detector') || {}
    if (!view || !d.watching || !normalizeAnimeonUrl(event.sender.getURL())) return false
    if (action === 'gone') { activeAnomalyAlerted = false; return true }
    if (action === 'refresh') return false
    return false
  })
  const profileForSender = (sender: Electron.WebContents) => {
    const view = [...views.values()].find(view => view.webContents.id === sender.id)
    return view ? String((view as any).__accountId) : null
  }
  const followState = () => {
    const profile = String(store.get('activeAccountId') || '1')
    const states: any = store.get('followbackStates') || {}
    const lists: any = store.get('followListsByProfile') || {}
    return { enabled: !!store.get('followBackEnabled'), profileId: profile, whitelist: lists[profile]?.whitelist || [], blacklist: lists[profile]?.blacklist || [], ...(states[profile] || {}) }
  }
  ipcMain.handle('followback:state', followState)
  const saveFollowList = (names: unknown, profile: string, kind: 'whitelist' | 'blacklist') => {
    if (profileSwitchBusy || profile !== String(store.get('activeAccountId'))) throw new Error('Профиль изменился')
    if (!Array.isArray(names) || names.length > 500 || names.some(n => typeof n !== 'string' || n.length > 100)) throw new Error('Некорректный список ников')
    const normalized = [...new Set(names.map(n => n.normalize('NFKC').trim().replace(/^@/, '').toLowerCase()).filter(Boolean))]
    const lists: any = store.get('followListsByProfile') || {}
    lists[profile] = { whitelist: [], blacklist: [], ...lists[profile], [kind]: normalized }
    store.set('followListsByProfile', lists)
    mainWindow?.webContents.send('followback:stateChanged')
    return normalized
  }
  ipcMain.handle('followback:whitelist', (_e, names: unknown, profile: string) => saveFollowList(names, profile, 'whitelist'))
  ipcMain.handle('followback:blacklist', (_e, names: unknown, profile: string) => saveFollowList(names, profile, 'blacklist'))
  ipcMain.handle('followback:lists', event => {
    const profile = profileForSender(event.sender)
    const lists: any = store.get('followListsByProfile') || {}
    return profile ? (lists[profile] || { whitelist: [], blacklist: [] }) : { whitelist: [], blacklist: [] }
  })
  ipcMain.handle('followback:claim', (event, owner: string, renew: boolean) => {
    const profile = profileForSender(event.sender)
    if (!profile || !store.get('followBackEnabled') || typeof owner !== 'string' || !owner.trim()) return { ok: false }
    const now = Date.now(), lock = followLocks.get(profile)
    if (renew) {
      if (!lock || lock.sender !== event.sender.id || lock.owner !== owner || lock.until < now) return { ok: false }
      lock.until = now + 60000
      return { ok: true }
    }
    if (lock && lock.until > now) return { ok: false }
    const states: any = store.get('followbackStates') || {}
    if (states[profile]?.owner === owner && states[profile]?.nextAt > now) return { ok: false }
    followLocks.set(profile, { sender: event.sender.id, owner, until: now + 60000 })
    return { ok: true }
  })
  ipcMain.handle('followback:finish', (event, summary: any, claimed: boolean) => {
    const profile = profileForSender(event.sender)
    if (!profile || !summary || typeof summary !== 'object') return
    const lock = followLocks.get(profile)
    if (claimed && lock?.sender !== event.sender.id) return
    if (!claimed && lock && lock.until > Date.now()) return
    if (claimed) followLocks.delete(profile)
    const states: any = store.get('followbackStates') || {}
    const ts = Date.now()
    states[profile] = { owner: lock?.owner || '', lastCheck: summary.ok ? ts : (states[profile]?.lastCheck || 0), nextAt: ts + 600000, error: summary.error || '' }
    store.set('followbackStates', states)
    if (summary.ok) store.set('followbackLastCheck', ts)
    store.set('followbackLastSummary', { ...summary, ts })
    mainWindow?.webContents.send('followback:stateChanged')
    mainWindow?.webContents.send('followback:tick', summary.ok ? ts : 0, { ...summary, ts })
  })
  ipcMain.handle('followback:toggle', async () => {
    const revision = ++followToggleRevision, epoch = utilityEpoch
    const v = !store.get('followBackEnabled')
    if (v) {
      const auth = await getFeatureAuth(true)
      if (!auth.authenticated || epoch !== utilityEpoch || revision !== followToggleRevision) return false
    }
    store.set('followBackEnabled', v)
    if (v) {
      store.set('followbackStates', {})
      for (const view of views.values()) view.webContents.executeJavaScript('window.__animeonFollowback?.wake()').catch(() => {})
    }
    mainWindow?.webContents.send('followback:stateChanged')
    return v
  })
  // Детектор сообщает о замеченной аномалии: только уведомляем (звук + тост
  // + журнал в рендерере). Анти-спам: один раз на время присутствия аномалии.
  let lastAnomalyNotify = 0
  ipcMain.handle('anomaly:detected', (_e, info: unknown) => {
    if (!(store.get('detector') as any)?.watching) return false
    const now = Date.now()
    if (activeAnomalyAlerted && now - lastAnomalyNotify < 3600000) return false
    if (now - lastAnomalyNotify < 30000) return false
    lastAnomalyNotify = now
    activeAnomalyAlerted = true
    try {
      const d: any = (store as any).get('detector') || { watching: false, sound: true, count: 0, lastAt: 0 }
      d.count = (d.count || 0) + 1; d.lastAt = now
      ;(store as any).set('detector', d)
      mainWindow?.webContents.send('detector:updated', d)
    } catch {}
    debugLog('anomaly:detected', JSON.stringify(info || {}).slice(0, 200))
    let wantToast = true
    try {
      const dd: any = (store as any).get('detector') || {}
      wantToast = dd.sound !== false
    } catch {}
    mainWindow?.webContents.send('anomaly:detected', { ...((info as any) || {}), toast: wantToast })
    // Тост дублируем внутрь активной вкладки: App-тост висит в зоне
    // таб-стрипа и на виде сайта почти не виден, а внутристраничный —
    // поверх сайта. Журнал и счётчик идут всегда, звук — своим тумблером.
    if (wantToast) {
      try { getActiveViewForToast()?.webContents.executeJavaScript('window.__animeonToast&&window.__animeonToast.anomaly()').catch(() => {}) } catch {}
    }
    return true
  })
  // Вкладка-лидер сообщает о взаимных подписках: показываем тост уровня
  // приложения (виден поверх любой вкладки) и пишем в журнал мгновенно,
  // не дожидаясь 30-секундного опроса Dashboard.
  ipcMain.handle('followback:diag', (_e, msg: unknown) => {
    try { debugLog(String(msg ?? '').slice(0, 4000).replace(/[\r\n]/g, ' ')) } catch {}
    return true
  })
  ipcMain.handle('followback:heartbeat', () => {
    try {
      const ts = Number(store.get('followbackLastCheck')) || Date.now()
      const summary = store.get('followbackLastSummary') || null
      mainWindow?.webContents.send('followback:tick', ts, summary)
    } catch {}
    return true
  })
  ipcMain.handle('followback:reset', () => {
    try { store.set('followbackDoneByOwner', {}); store.set('followbackFailuresByOwner', {}) } catch {}
    debugLog('followback:reset history cleared')
    return true
  })
  ipcMain.handle('followback:notify', (_e, names: unknown) => {
    const list = Array.isArray(names) ? names.map(String).filter(Boolean).slice(0, 5) : []
    debugLog('followback:notify', list.join(','))
    mainWindow?.webContents.send('followback:done', list)
    // Тост рисуем в АКТИВНОЙ вкладке (а не в лидере): имена уходят в
    // очередь внутристраничных тостов активного view — по одному, 6с каждый.
    try {
      const v = getActiveViewForToast()
      if (v && list.length) v.webContents.executeJavaScript(`window.__animeonToast&&window.__animeonToast.follow(${JSON.stringify(list)})`).catch(() => {})
    } catch {}
    return true
  })
  ipcMain.on('win:minimize', () => mainWindow?.minimize())
  ipcMain.on('win:maximize', () => { if (mainWindow?.isMaximized()) mainWindow?.unmaximize(); else mainWindow?.maximize() })
  ipcMain.on('win:close', () => mainWindow?.close())
}

// Session-scoped marks are reset on start/quit: follow-back starts a fresh
// 10-minute grid instead of counting down the leftovers of
// the previous session. Stale leadership is cleared too, otherwise the new
// instance would lose the claim to its own dead predecessor (TTL shadow).
function resetRunFlags() {
  cancelCollections()
  detectorPausedState = null
  authCache = null; detectorToggleRevision++; followToggleRevision++
  mainWindow?.webContents.send('journal:clear')
  ;(store as any).delete('followbackLastSummary')
  try { (store as any).delete('followbackLastCheck'); (store as any).delete('followbackOwner') } catch {}
  store.set('followBackEnabled', false)
  store.set('followbackStates', {})
  // Run-only switches reset; sound, whitelist and profile preferences remain saved.
  try {
    const d: any = (store as any).get('detector') || {}
    d.watching = false; d.autoCollect = false; d.count = 0; d.lastAt = 0
    ;(store as any).set('detector', d)
  } catch {}
}

// Detect logout even while the Functions screen is closed, or auto-resume if auth recovered.
const authWatchTimer = setInterval(() => {
  if ((store.get('detector') as any)?.watching || store.get('followBackEnabled') || detectorPausedState) void getFeatureAuth(false)
}, 90000)
authWatchTimer.unref()

const singleInstanceLock = app.requestSingleInstanceLock()
if (!singleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    try {
      if (await relocatePortableLauncher()) {
        app.exit(0)
        return
      }
    } catch (error) {
      debugLog('Portable launcher relocation failed:', String(error))
    }
    // После системного сна Chromium возобновляет таймеры не одновременно.
    // Просим каждый живой view немедленно перепроверить аномалию, не создавая
    // новый цикл polling и не перезагружая страницу пользователя.
    powerMonitor.on('resume', () => {
      debugLog('system resumed: refreshing detector views and surfaces')
      layoutViews()
      refreshActiveViewSurface()
      for (const [, view] of views) {
        try { view.webContents.executeJavaScript('window.__animeonDetector?.wake?.()', true).catch(() => {}) } catch {}
      }
      mainWindow?.webContents.send('system:resumed', Date.now())
    })
    powerMonitor.on('unlock-screen', () => {
      debugLog('system unlocked: refreshing view surface')
      layoutViews()
      refreshActiveViewSurface()
    })
    // Pinned tabs survive relaunches; a fresh home tab only when nothing pinned.
    const savedTabs: any[] = (store.get('tabs') as any[]) || []
    const pinnedTabs = getTabOrder(savedTabs, store.get('tabOrder'))
      .map(id => savedTabs.find(t => t.id === id))
      .filter(t => t.pinned).slice(0, 7).map(t => ({ ...t, audible: false }))
    const startupAccount = String(store.get('activeAccountId') || '1')
    const tabsAtLaunch = pinnedTabs.length ? pinnedTabs : [
      { id: `startup-${Date.now()}`, url: store.get('baseUrl') as string, title: 'AnimeOn — старт', favicon: '', partition: `persist:animeon-acc-${startupAccount}`, pinned: false, muted: false },
    ]
    const launchId = tabsAtLaunch[0]?.id
    store.set('tabs', tabsAtLaunch)
    store.set('tabOrder', tabsAtLaunch.map(t => t.id))
    store.set('activeTabId', launchId)
    activeTabId = launchId
    resetRunFlags()
    // Always start on the site tab, never remember Dashboard/Settings/Secrets.
    activeViewMode = 'site'
    store.set('activeView', 'site')
    const isOAuth = (url: string) =>
      url.includes('accounts.google.com') ||
      url.includes('consent.google.com') ||
      url.includes('myaccount.google.com') ||
      url.includes('oauth.telegram.org') ||
      url.includes('t.me/')
    const isGoogleOrTelegram = (url: string) =>
      url.includes('google.com') || url.includes('google.') ||
      url.includes('telegram.org') || url.includes('t.me')

    const routeSet = new Set<number>()
    const loadCallbackIntoTab = (contents: Electron.WebContents, ev?: Electron.Event) => {
      const url = contents.getURL()
      debugLog('route:nav-check', safeUrl(url))
      if (!url || url.startsWith('about:') || url.startsWith('blob:')) return
      if (isGoogleOrTelegram(url)) return
      if (normalizeAnimeonUrl(url)) {
        debugLog('route:MATCH -> tab', safeUrl(url), 'hasCode=', url.includes('code='))
        if (ev) ev.preventDefault()
        const id = activeTabId || (store.get('tabOrder') as string[])?.[0]
        const v = id ? views.get(id) : null
        if (v) v.webContents.loadURL(url)
        const win = BrowserWindow.fromWebContents(contents)
        if (win && !win.isDestroyed()) setTimeout(() => { if (!win.isDestroyed()) win.close() }, 200)
      }
    }
    const routeOAuthCallback = (contents: Electron.WebContents) => {
      const key = contents.id
      if (routeSet.has(key)) return
      routeSet.add(key)
      contents.once('destroyed', () => routeSet.delete(key))
      contents.on('will-navigate', (ev, nextUrl) => {
        debugLog('oauth:will-navigate', safeUrl(nextUrl))
        if (!nextUrl || nextUrl.startsWith('about:') || nextUrl.startsWith('blob:')) return
        if (isGoogleOrTelegram(nextUrl)) return
        if (normalizeAnimeonUrl(nextUrl)) {
          debugLog('oauth:will-navigate MATCH -> tab', safeUrl(nextUrl))
          ev.preventDefault()
          const id = activeTabId || (store.get('tabOrder') as string[])?.[0]
          const v = id ? views.get(id) : null
          if (v) v.webContents.loadURL(nextUrl)
          const win = BrowserWindow.fromWebContents(contents)
          if (win && !win.isDestroyed()) setTimeout(() => { if (!win.isDestroyed()) win.close() }, 200)
        }
      })
        contents.on('did-navigate', (...a: any[]) => { debugLog('oauth:did-navigate', safeUrl(a[1])); loadCallbackIntoTab(contents) })
        contents.on('did-navigate-in-page', (...a: any[]) => { debugLog('oauth:did-navigate-in-page', safeUrl(a[1])); loadCallbackIntoTab(contents) })
        contents.on('did-redirect-navigation', (...a: any[]) => { debugLog('oauth:did-redirect', safeUrl(a[1])); loadCallbackIntoTab(contents) })
        contents.on('did-fail-load', (...a: any[]) => { debugLog('oauth:did-fail-load', safeUrl(a[1]), a[2]) })
        contents.on('did-stop-loading', () => { debugLog('oauth:did-stop-loading url=', safeUrl(contents.getURL())); loadCallbackIntoTab(contents) })
    }

    const openOAuthWindow = async (url: string) => {
      if (profileSwitchBusy) return
      const now = Date.now()
      debugLog('openOAuthWindow called with', safeUrl(url))
      if (now - lastOAuthWindowTime < 2000) { debugLog('cooldown skip'); return }
      lastOAuthWindowTime = now
      try {
        const isTelegramBot = new URL(url).hostname === 't.me'
        const activeAcc = store.get('activeAccountId') as string | null
        const partition = activeAcc ? `persist:animeon-acc-${activeAcc}` : 'persist:animeon-acc-1'
        const ses = session.fromPartition(partition)
        const oauthWin = new BrowserWindow({
          width: 500,
          height: 620,
          parent: mainWindow!,
          autoHideMenuBar: true,
          title: url.includes('google') ? 'Google — вход' : 'Telegram — вход',
          webPreferences: {
            session: ses,
            // Leave WebAuthn and credentials APIs untouched in the login window.
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
          }
        })
        oauthWindows.add(oauthWin)
        oauthWin.on('closed', () => oauthWindows.delete(oauthWin))
        routeOAuthCallback(oauthWin.webContents)
        oauthWin.loadURL(url)
        oauthWin.webContents.on('did-finish-load', () => {
          oauthWin.webContents.insertCSS('::-webkit-scrollbar { display: none !important; }').catch(() => {})
        })
        oauthWin.on('closed', () => {
          // The site polls for bot confirmation in the original document.
          // Reloading on popup close would discard the pending login.
          if (isTelegramBot) return
          const tabs: any[] = (store.get('tabs') as any[]) || []
          for (const t of tabs) {
            const v = views.get(t.id)
            if (v) v.webContents.reload()
          }
        })
      } catch {}
    }

    app.on('web-contents-created', (_e, contents) => {
      contents.setWindowOpenHandler(({ url }) => {
        debugLog('main:window-open', url.split('?')[0], 'current=', contents.getURL().split('?')[0], 'isOAuth=', isOAuth(url))
        // A channel link is opened by the trusted click handler in the site preload.
        if (/^https?:\/\/t\.me\/(?:s\/)?animeon\/?(?:[?#]|$)/i.test(url)) return { action: 'deny' }
        if (url.startsWith('about:') || url.startsWith('tg://')) return { action: 'allow' }
        const currentUrl = contents.getURL()

        // Native popup preserves window.opener/postMessage and the originating session.
        let googlePopup = false
        try { const parsed = new URL(url); googlePopup = parsed.protocol === 'https:' && ['accounts.google.com', 'consent.google.com'].includes(parsed.hostname) } catch {}
        if (googlePopup && (normalizeAnimeonUrl(currentUrl) || popupContents.has(contents.id))) {
          if (profileSwitchBusy) return { action: 'deny' }
          return { action: 'allow', overrideBrowserWindowOptions: { width: 500, height: 620, autoHideMenuBar: true, webPreferences: { session: contents.session, preload: getPreloadPath('oauth.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } } }
        }

        // Other providers use an isolated window in the selected profile.
        if (isOAuth(url) && !!normalizeAnimeonUrl(currentUrl)) {
          openOAuthWindow(url).catch(() => {})
          return { action: 'deny' }
        }
        // Google/Telegram windows already inside the flow — let them be.
        if (isGoogleOrTelegram(currentUrl)) return { action: 'allow' }
        if (isOAuth(url)) {
          openOAuthWindow(url).catch(() => {})
          return { action: 'deny' }
        }
        if (url.startsWith('http') && !!normalizeAnimeonUrl(url)) {
          const isTabView = [...views.values()].some(v => v.webContents === contents)
          debugLog('DIAG window-open animeon isTabView=', isTabView, String(url).split('?')[0])
          if (isTabView) {
            createTabFromUrl(url)
            return { action: 'deny' }
          }
        }
        if (url.startsWith('http') && !normalizeAnimeonUrl(url)) {
          shell.openExternal(url)
          return { action: 'deny' }
        }
        return { action: 'allow' }
      })

      contents.on('will-navigate', (ev, url) => {
        const currentUrl = contents.getURL()
        debugLog('main:will-navigate', url.split('?')[0], 'current=', currentUrl.split('?')[0], 'isOAuth=', isOAuth(url), 'isPopup=', popupContents.has(contents.id))
        // Leave popups / OAuth windows alone — they need window.opener and
        // natural navigation to complete the flow.
        const isMainContext = mainWindow && contents === mainWindow.webContents
        const isTabView = [...views.values()].some(v => v.webContents === contents)
        if (!isMainContext && !isTabView) return
        // **Block Google navigation in tabs** — keep the tab on animeon so that
        // any Google OAuth popup we allow has a valid window.opener pointing here.
        // Without this, GIS (or the standard Google OAuth) redirects the tab and
        // we lose the opener needed for postMessage / id_token return.
        if (url.includes('google.com') || url.includes('google.') || url.includes('telegram.org') || url.includes('t.me/')) {
          ev.preventDefault()
          return
        }
        if (!normalizeAnimeonUrl(url) && !url.startsWith('about:') && url.startsWith('http')) {
          ev.preventDefault()
          shell.openExternal(url)
        }
      })

      contents.on('did-create-window', (win, details) => {
        try {
          if (['accounts.google.com', 'consent.google.com'].includes(new URL(details.url).hostname)) {
            popupContents.add(win.webContents.id)
            oauthWindows.add(win)
            const popupId = win.webContents.id
            win.on('closed', () => { popupContents.delete(popupId); oauthWindows.delete(win) })
            return
          }
        } catch {}
        const url = win.webContents.getURL()
        debugLog('main:did-create-window url=', url.split('?')[0])
        const popupId = win.webContents.id
        popupContents.add(popupId)
        win.once('closed', () => popupContents.delete(popupId))
        // A just-created popup often reports about:blank until it loads.
        // Let Google/Telegram popups flow naturally; they self-close on success.
        if (isGoogleOrTelegram(win.webContents.getURL())) return
        // Route an animeon callback opened in a stray window into the tab.
        win.webContents.on('did-start-navigation', (_ev, navUrl) => {
          if (normalizeAnimeonUrl(navUrl)) {
            const id = activeTabId || (store.get('tabOrder') as string[])?.[0]
            const v = id ? views.get(id) : null
            if (v) v.webContents.loadURL(navUrl)
            if (!win.isDestroyed()) win.close()
          }
        })
      })
    })

    registerIpcHandlers()
    createMainWindow()
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMainWindow() })
  })
}

app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => {
  if (!singleInstanceLock) return
  resetRunFlags()
  const tabs: any[] = (store.get('tabs') as any[]) || []
  const pinned = getTabOrder(tabs, store.get('tabOrder'))
    .map(id => tabs.find(t => t.id === id))
    .filter(t => t.pinned)
  store.set('tabs', pinned)
  store.set('tabOrder', pinned.map(t => t.id))
  store.set('activeTabId', pinned[0]?.id || null)
  clearInterval(authWatchTimer)
  for (const id of [...views.keys()]) destroyView(id)
})
