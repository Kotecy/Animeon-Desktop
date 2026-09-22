import { app, BrowserWindow, BrowserView, Menu, ipcMain, powerMonitor, session, shell, clipboard } from 'electron'
import path from 'path'
import fs from 'fs'
import Store from 'electron-store'
import { AUTO_COLLECT_AVAILABLE } from '../shared/buildFlags'

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
  localBase = path.join(appData.replace(/Roaming$/, 'Local'), 'AnimeonDesktop')
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

const store = new Store({
  cwd: localBase || undefined,
  defaults: {
    baseUrl: 'https://v2.animeon.co',
    accounts: [] as any[],
    activeAccountId: null,
    tabs: [] as any[],
    tabOrder: [] as string[],
    activeTabId: null,
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
  store.set('accounts', accounts)
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

const hookedDevTools = new WeakSet<Electron.WebContents>()
function toggleDevTools() {
  const contents = getActiveViewForToast()?.webContents || mainWindow?.webContents
  if (!contents) return false
  try {
    if (contents.isDevToolsOpened()) contents.closeDevTools()
    else {
      if (!hookedDevTools.has(contents)) {
        hookedDevTools.add(contents)
        contents.on('devtools-opened', () => {
          contents.devToolsWebContents?.on('before-input-event', (event: Electron.Event, input: Electron.Input) => {
            if (input.type === 'keyDown' && input.key === 'F12') { event.preventDefault(); contents.closeDevTools() }
          })
        })
      }
      contents.openDevTools({ mode: 'detach' })
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
  const id = Date.now().toString()
  const activeAcc = store.get('activeAccountId') as string | null
  const partition = activeAcc ? `persist:animeon-acc-${activeAcc}` : 'persist:animeon-acc-1'
  const tab = { id, url: safeUrl, title: 'Новая вкладка', favicon: '', partition, pinned: false, muted: false, audible: false }
  tabs.push(tab); store.set('tabs', tabs)
  const order: string[] = (store.get('tabOrder') as string[]) || []; order.push(id); store.set('tabOrder', order)
  ensureView(tab); layoutViews()
  mainWindow?.webContents.send('tabs:updated', tabs, activeTabId)
  return tab
}

function destroyView(tabId: string) {
  const timer = audibleReleaseTimers.get(tabId)
  if (timer) { clearTimeout(timer); audibleReleaseTimers.delete(tabId) }
  const old = views.get(tabId)
  if (old && mainWindow) {
    stopUtilitiesForTab(tabId)
    try { mainWindow.removeBrowserView(old); (old.webContents as any).destroy() } catch {}
    views.delete(tabId)
  }
}

// Applies the profile's isolated session (cookies live per partition) to all tabs.
// When switching profile, every tab reloads with the selected profile's session.
function applyAccountToTabs(accountId: string) {
  const partition = `persist:animeon-acc-${accountId}`
  const tabs: any[] = (store.get('tabs') as any[]) || []
  for (const tab of tabs) tab.partition = partition
  store.set('tabs', tabs)
  for (const tab of tabs) { destroyView(tab.id); ensureView(tab) }
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
let isHtmlFullscreen = false
const popupContents = new Set<number>()

type UtilityId = string
type UtilityState = { id: UtilityId; tabId: string; startedAt: number; accountId: string }
type CustomUtility = { id: string; name: string; description: string; source: string; slot: number; createdAt: number }
const utilityStates = new Map<string, UtilityState>()
const enabledUtilities = new Set<UtilityId>()
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
  const slots: Array<CustomUtility | null> = Array.from({ length: 9 }, (_, slot) => {
    const item = Array.isArray(raw) ? raw[slot] : null
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || typeof item.source !== 'string') return null
    return { id: item.id, name: String(item.name || 'Пользовательская функция').slice(0, 80), description: String(item.description || readUtilityDescription(item.source)).slice(0, 180), source: item.source, slot, createdAt: Number(item.createdAt) || Date.now() }
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
  mainWindow?.webContents.send('utilities:updated', publicUtilities())
}

function utilityKey(id: UtilityId, tabId: string) { return `${id}:${tabId}` }

function getUtilitySource(id: UtilityId) {
  return getCustomUtilities().find(item => item?.id === id)?.source || ''
}

function getUtilityView() {
  const id = activeTabId || (store.get('tabOrder') as string[])?.[0]
  const view = id ? views.get(id) : null
  if (!id || !view || view.webContents.isDestroyed() || !normalizeAnimeonUrl(view.webContents.getURL())) return null
  return { id, view }
}

async function stopUtilityInTab(id: UtilityId, tabId: string) {
  const active = utilityStates.get(utilityKey(id, tabId))
  if (!active) return
  const view = views.get(tabId)
  const stopExpression = `(async()=>{try{await window.__ANIMEON_CUSTOM_UTILITIES__?.[${JSON.stringify(id)}]?.stop?.()}catch{}})()`
  try { await view?.webContents.executeJavaScript(stopExpression, true) } catch {}
  utilityStates.delete(utilityKey(id, tabId))
}

async function stopUtility(id: UtilityId, notify = true) {
  enabledUtilities.delete(id)
  const running = [...utilityStates.values()].filter(state => state.id === id)
  await Promise.all(running.map(state => stopUtilityInTab(id, state.tabId)))
  if (notify) notifyUtilities()
  return { ok: true, active: false }
}

async function stopAllUtilities() {
  enabledUtilities.clear()
  const running = [...utilityStates.values()]
  await Promise.all(running.map(state => stopUtilityInTab(state.id, state.tabId)))
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
  if (!force && authCache?.profileId === profileId && authCache.epoch === epoch && Date.now() - authCache.checkedAt < 5000) return authCache
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

async function startUtilityInTab(id: UtilityId, tabId: string, view: BrowserView) {
  const epoch = utilityEpoch
  if (utilityStates.has(utilityKey(id, tabId))) return true
  try {
    const source = getUtilitySource(id)
    const accountId = String((view as any).__accountId || store.get('activeAccountId') || '1')
    if (!source) return false
    if (epoch !== utilityEpoch || !enabledUtilities.has(id)) return false
    const script = `(async()=>{try{
      const root=window.__ANIMEON_CUSTOM_UTILITIES__||(window.__ANIMEON_CUSTOM_UTILITIES__={});
      try{await root[${JSON.stringify(id)}]?.stop?.()}catch{}
      const module={exports:{}}; const exports=module.exports;
      const result=await (new Function('module','exports',${JSON.stringify(source)}))(module,exports);
      const candidate=(result&&typeof result==='object'?result:null)||module.exports;
      root[${JSON.stringify(id)}]=candidate&&typeof candidate.stop==='function'?candidate:{};
      return true;
    }catch(error){console.error('[AnimeOn Desktop custom function]',error);return false}})()`
    const started = await view.webContents.executeJavaScript(script, true)
    if (started === false) return false
    if (epoch !== utilityEpoch || !enabledUtilities.has(id)) {
      await view.webContents.executeJavaScript(`window.__ANIMEON_CUSTOM_UTILITIES__?.[${JSON.stringify(id)}]?.stop?.()`).catch(() => {})
      return false
    }
    utilityStates.set(utilityKey(id, tabId), { id, tabId, accountId, startedAt: Date.now() })
    return true
  } catch (error: any) {
    debugLog(`utility ${id} start failed in tab ${tabId}:`, String(error?.message || error))
    return false
  }
}

async function startUtility(id: UtilityId) {
  if (!getCustomUtilities().some(item => item?.id === id)) return { ok: false, error: 'Неизвестная функция' }
  enabledUtilities.add(id)
  const tabs: any[] = (store.get('tabs') as any[]) || []
  if (!tabs.length) { enabledUtilities.delete(id); notifyUtilities(); return { ok: false, error: 'Откройте вкладку AnimeOn для запуска инструмента' } }
  for (const tab of tabs) ensureView(tab)
  const started = await Promise.all(tabs.map(async tab => {
    const view = views.get(tab.id)
    return view && normalizeAnimeonUrl(view.webContents.getURL()) ? startUtilityInTab(id, tab.id, view) : false
  }))
  notifyUtilities()
  if (!started.some(Boolean)) {
    enabledUtilities.delete(id)
    notifyUtilities()
    return { ok: false, error: 'Не удалось запустить пользовательскую функцию' }
  }
  return { ok: true, active: true, tabs: started.filter(Boolean).length }
}

async function applyEnabledUtilitiesToView(tabId: string, view: BrowserView) {
  if (!normalizeAnimeonUrl(view.webContents.getURL())) return
  for (const id of enabledUtilities) await startUtilityInTab(id, tabId, view)
  notifyUtilities()
}

function clearUtilityStatesForTab(tabId: string) {
  for (const [key, state] of utilityStates) {
    if (state.tabId === tabId) utilityStates.delete(key)
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
  if (isHtmlFullscreen) {
    const [w, h] = mainWindow!.getSize()
    return { x: 0, y: 0, width: w, height: h }
  }
  const sidebarW = 72
  if (!mainWindow) return { x: sidebarW, y: 99, width: 1060, height: 712 }
  const [winW, winH] = mainWindow.getSize()
    return { x: sidebarW, y: 99, width: Math.max(1, winW - sidebarW), height: Math.max(1, winH - 99) }
}

// The site logs in via POST /api/auth/google with { id_token } (see its
// JS: authApi.googleAuth). GIS delivers the id_token into the site page via
// window.opener.postMessage, but Electron tabs have no window.opener, so the
// token is lost. We capture it from the /gsi/transform POST and replay it
// through the site's own backend in the tab, then reload to apply the session.
let googleAuthInFlight = false
const oauthWindows = new Set<BrowserWindow>()
function getGoogleIdToken(payload: unknown) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload || {})
  const match = body.match(/(?:id_token|credential)["'=:%3A]+([^&"'\s,}]+)/i)
  if (!match) return ''
  try { return decodeURIComponent(match[1].replace(/\+/g, '%20')) } catch { return match[1] }
}
async function completeGoogleAuthViaTab(idToken: string) {
  if (googleAuthInFlight) return
  googleAuthInFlight = true
  try {
    const id = activeTabId || (store.get('tabOrder') as string[])?.[0]
    const view = id ? views.get(id) : null
    if (!view) return
    const url = view.webContents.getURL()
    if (!normalizeAnimeonUrl(url)) { await view.webContents.loadURL('https://v2.animeon.co/') }
    const ok = await view.webContents.executeJavaScript(
      `(async()=>{try{const r=await fetch('/api/auth/google',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'include',body:JSON.stringify({id_token:${JSON.stringify(idToken)}})});if(!r.ok)return 'HTTP '+r.status;const j=await r.json().catch(()=>({}));return 'OK '+(j&&j.access_token?'token':'no-token')}catch(e){return 'ERR '+e.message}})()`,
      true
    )
    debugLog('googleAuth deliver:', ok)
    if (String(ok).startsWith('OK')) {
      for (const win of oauthWindows) {
        try { if (!win.isDestroyed()) win.close() } catch {}
      }
      oauthWindows.clear()
    }
    setTimeout(() => { try { view.webContents.reload() } catch {} }, 1200)
  } catch (e: any) { debugLog('googleAuth deliver failed:', e && e.message) }
  finally { googleAuthInFlight = false }
}

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
  if (!mainWindow) return
  const bounds = getContentBounds()
  const showSite = activeViewMode === 'site' && activeTabId && views.has(activeTabId)
  for (const [id, view] of views.entries()) {
    if (id === activeTabId && showSite) {
      view.setBounds(bounds as any)
    } else {
      view.setBounds({ x: -2000, y: -2000, width: 10, height: 10 } as any)
    }
  }
  applyFitZoom(bounds.height)
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
    // Вкладки продолжают выполнять таймеры и fetch, когда окно свёрнуто
    // или BrowserView временно вынесен за пределы окна.
    try { view.webContents.setBackgroundThrottling(false) } catch {}
    view.webContents.on('focus', () => mainWindow?.webContents.send('site:focused'))
    // Track audio emission independently of the tab's muted setting, without polling.
    const audioContents = view.webContents
    audioContents.on('audio-state-changed', event => setTabAudible(tab.id, event.audible))
    setTabAudible(tab.id, audioContents.isCurrentlyAudible())
    view.webContents.on('render-process-gone', (_e, details) => {
      debugLog('DIAG view render-process-gone tab=', tab.id, JSON.stringify(details))
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
    view.webContents.loadURL(tab.url)

    view.webContents.on('page-title-updated', (_e, title) => {
      const tabs: any[] = (store.get('tabs') as any[]) || []
      const t = tabs.find((x) => x.id === tab.id)
      if (t) { t.title = title; store.set('tabs', tabs); mainWindow?.webContents.send('tabs:updated', tabs, activeTabId) }
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
      const tabs: any[] = (store.get('tabs') as any[]) || []
      const t = tabs.find((x) => x.id === tab.id)
      if (t) { t.url = url; store.set('tabs', tabs) }
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
      // SPA-переходы (история/хеш) и навигации фреймов документ не
      // пересоздают: инжектированные скрипты живы, состояние не трогаем.
      // Иначе тумблер гаснет при каждом клике по сайту, хотя инструмент
      // продолжает работать.
      if (isInPlace || !isMainFrame) return
      // После перезагрузки page world очищается: убираем устаревшее состояние,
      // а did-finish-load подключит включённые инструменты заново.
      clearUtilityStatesForTab(tab.id)
      notifyUtilities()
    })
    view.webContents.on('did-finish-load', () => {
      injectPlugin(view!)
      injectNoScrollbarCSS(view!)
      void applyEnabledUtilitiesToView(tab.id, view!)
      // Pick up the nickname on our own after every page load (login, OAuth
      // reload, SPA navigation) instead of relying only on the Settings poll.
      // Delayed slightly so the site can hydrate client-side state first.
      const accountId = (view! as any).__accountId
      setTimeout(() => {
        try {
          if ((view! as any).__accountId !== accountId) return
          if (view!.webContents.isDestroyed()) return
          if (!normalizeAnimeonUrl(view!.webContents.getURL())) return
          syncAccountNickname(view!, String(accountId || '1'))
        } catch {}
      }, 2500)
    })
    view.webContents.on('did-fail-load', () => {})
    view.webContents.on('enter-html-full-screen', () => {
      isHtmlFullscreen = true
      setTimeout(layoutViews, 50)
    })
    view.webContents.on('leave-html-full-screen', () => {
      isHtmlFullscreen = false
      setTimeout(layoutViews, 50)
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
    const t = tabs.find(x => x.id === activeTabId) || tabs[0]
    if (t) ensureView(t)
  } catch {}
  layoutViews()
}

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

  const devUrl = 'http://localhost:5173'
  const prodPath = path.join(__dirname, '..', 'renderer', 'index.html')

  if (process.env.NODE_ENV === 'development' && !app.isPackaged) {
    mainWindow.loadURL(devUrl).catch(() => mainWindow?.loadFile(prodPath))
  } else {
    mainWindow.loadFile(prodPath)
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
    attachActiveTab()
    layoutViews()
  })
  // Renderer тоже остаётся живым при сворачивании: он получает статусы
  // инструментов и уведомления, пока фоновые вкладки продолжают наблюдение.
  try { mainWindow.webContents.setBackgroundThrottling(false) } catch {}

  // Diagnostics for "window disappears" reports: transparent window turns
  // invisible when its renderer dies, while the taskbar entry stays.
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    debugLog('DIAG main render-process-gone:', JSON.stringify(details))
  })
  mainWindow.on('unresponsive', () => debugLog('DIAG main window unresponsive'))
  mainWindow.on('responsive', () => debugLog('DIAG main window responsive again'))
  mainWindow.on('hide', () => debugLog('DIAG main window hide'))
  mainWindow.on('minimize', () => {
    debugLog('DIAG main window minimize')
    for (const [, view] of views) {
      try { view.webContents.setBackgroundThrottling(false) } catch {}
    }
  })
  mainWindow.on('close', () => { resetRunFlags(); debugLog('DIAG main window close') })

  mainWindow.on('resize', layoutViews)
  mainWindow.on('maximize', layoutViews)
  mainWindow.on('unmaximize', layoutViews)
  mainWindow.on('enter-full-screen', () => { isHtmlFullscreen = false; layoutViews() })
  mainWindow.on('leave-full-screen', () => { isHtmlFullscreen = false; layoutViews() })

  mainWindow.on('closed', () => {
    mainWindow = null
    for (const [, view] of views.entries()) {
      try { (view.webContents as any).destroy() } catch {}
    }
    views.clear()
  })

  ipcMain.handle('store:get', (_e, key) => (store as any).get(key))
  ipcMain.handle('store:set', (_e, key, val) => { (store as any).set(key, val); return true })
  ipcMain.handle('store:getAll', () => (store as any).store)
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
    store.set('accounts', accounts)
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
    const id = Date.now().toString()
    const tabs: any[] = (store.get('tabs') as any[]) || []
    if (tabs.length >= 7) { debugLog('DIAG tabs:create at limit'); notifyTabLimit(); return null }
    const activeAcc = store.get('activeAccountId') as string | null
    const partition = activeAcc ? `persist:animeon-acc-${activeAcc}` : 'persist:animeon-acc-1'
    const tab = { id, url: url || (store.get('baseUrl') as string), title: 'Новая вкладка', favicon: '', partition, pinned: false, muted: false, audible: false }
    tabs.push(tab); store.set('tabs', tabs)
    const order: string[] = (store.get('tabOrder') as string[]) || []; order.push(id); store.set('tabOrder', order)
    activeTabId = id; store.set('activeTabId', id)
    ensureView(tab); layoutViews()
    mainWindow?.webContents.send('tabs:updated', tabs, activeTabId)
    return tab
  })
  ipcMain.handle('tabs:close', (_e, id) => {
    const existing = ((store.get('tabs') as any[]) || []).find(t => t.id === id)
    if (existing?.pinned) return false
    const timer = audibleReleaseTimers.get(id); if (timer) { clearTimeout(timer); audibleReleaseTimers.delete(id) }
    const view = views.get(id)
    if (view && mainWindow) { stopUtilitiesForTab(id); mainWindow.removeBrowserView(view); (view.webContents as any).destroy(); views.delete(id) }
    let tabs: any[] = (store.get('tabs') as any[]) || []; tabs = tabs.filter((t) => t.id !== id); store.set('tabs', tabs)
    let order: string[] = (store.get('tabOrder') as string[]) || []; order = order.filter((o) => o !== id); store.set('tabOrder', order)
    if (activeTabId === id) { activeTabId = order[0] || tabs[0]?.id || null; store.set('activeTabId', activeTabId); layoutViews() }
    mainWindow?.webContents.send('tabs:updated', tabs, activeTabId)
    return true
  })
  ipcMain.handle('tabs:reorder', (_e, order: string[]) => { store.set('tabOrder', order); return true })
  ipcMain.handle('tabs:togglePinned', (_e, id: string) => {
    const tabs: any[] = (store.get('tabs') as any[]) || []
    const tab = tabs.find(t => t.id === id)
    if (!tab) return false
    tab.pinned = !tab.pinned
    store.set('tabs', tabs)
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
    activeTabId = id; store.set('activeTabId', id); activeViewMode = 'site'; store.set('activeView', 'site')
    try {
      const tabs: any[] = (store.get('tabs') as any[]) || []
      const tab = tabs.find(t => t.id === id)
      if (tab) ensureView(tab)
    } catch {}
    layoutViews(); return true
  })
  ipcMain.handle('tabs:navigate', (_e, id: string, url: string) => {
    const safeUrl = normalizeAnimeonUrl(url)
    if (!safeUrl) return { ok: false, error: 'Введите корректный адрес AnimeOn: animeon.cc, animeon.co, v1.animeon.co или v2.animeon.co.' }
    try {
      const tabs: any[] = (store.get('tabs') as any[]) || []
      const tab = tabs.find(t => t.id === id)
      if (tab) { ensureView(tab); tab.url = safeUrl; store.set('tabs', tabs) }
    } catch {}
    const v = views.get(id); if (v) v.webContents.loadURL(safeUrl); return { ok: true, url: safeUrl }
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
    if (!base) return false
    let host = ''
    try { host = new URL(base).host } catch { return false }
    const prev = String(store.get('baseUrl') || '')
    let prevHost = ''
    try { prevHost = new URL(prev).host } catch {}
    store.set('baseUrl', base)
    if (prevHost === host) return true
    const tabs: any[] = (store.get('tabs') as any[]) || []
    for (const tab of tabs) {
      try {
        if (typeof tab.url === 'string' && normalizeAnimeonUrl(tab.url)) {
          const u = new URL(tab.url as string)
          u.host = host
          tab.url = u.toString()
        } else {
          tab.url = base
        }
      } catch { tab.url = base }
    }
    store.set('tabs', tabs)
    if (prevHost) {
      const partitions = new Set<string>()
      for (const tab of tabs) {
        if (typeof tab.partition === 'string' && (tab.partition as string).startsWith('persist:')) partitions.add(tab.partition)
      }
      for (let i = 1; i <= 5; i++) partitions.add(`persist:animeon-acc-${i}`)
      for (const p of partitions) {
        try { await migrateSessionCookies(p, prevHost, host) } catch {}
      }
    }
    for (const tab of tabs) { destroyView(tab.id); ensureView(tab) }
    layoutViews()
    mainWindow?.webContents.send('tabs:updated', tabs, activeTabId)
    return true
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
  ipcMain.handle('address:contextMenu', (_e, currentUrl: string) => {
    if (!mainWindow) return
    const fullUrl = /^https?:\/\//i.test(currentUrl) ? currentUrl : `https://${currentUrl}`
    let clipText = ''
    try { clipText = clipboard.readText().trim() } catch {}
    Menu.buildFromTemplate([
      {
        label: 'Копировать адрес',
        click: () => {
          clipboard.writeText(fullUrl)
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
    activeViewMode = mode; if (mode !== 'commands') store.set('activeView', mode); layoutViews(); return true
  })
  ipcMain.handle('sidebar:setCollapsed', (_e, v: boolean) => { store.set('sidebarCollapsed', v); layoutViews(); return true })
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
  ipcMain.handle('clipboard:writeText', (_e, text: string) => {
    try { clipboard.writeText(String(text || '')); return true } catch { return false }
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
    if (!Number.isInteger(slot) || slot < 0 || slot >= 9) return { ok: false, error: 'Недопустимая позиция' }
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
    if (!Number.isInteger(targetSlot) || targetSlot < 0 || targetSlot >= 9) return { ok: false, error: 'Недопустимая позиция' }
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
    if (slot < 0) return false
    await stopUtility(id, false)
    slots[slot] = null
    store.set('customUtilities', slots)
    notifyUtilities()
    return true
  })
  ipcMain.handle('utilities:toggle', async (_e, rawId: UtilityId) => {
    const id = String(rawId || '')
    if (!getCustomUtilities().some(item => item?.id === id)) return { ok: false, error: 'Неизвестная функция' }
    if (enabledUtilities.has(id)) return stopUtility(id)
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
  ipcMain.handle('anomaly:action', (event, action: string) => {
    const view = [...views.values()].find(v => v.webContents === event.sender)
    const d: any = store.get('detector') || {}
    if (!view || !d.watching || !normalizeAnimeonUrl(event.sender.getURL())) return false
    if (action === 'gone') return true
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
  // + журнал в рендерере). Кулдаун против дублей с разных вкладок.
  let lastAnomalyNotify = 0
  ipcMain.handle('anomaly:detected', (_e, info: unknown) => {
    if (!(store.get('detector') as any)?.watching) return false
    const now = Date.now()
    if (now - lastAnomalyNotify < 30000) return false
    lastAnomalyNotify = now
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
    try { debugLog(String(msg ?? '')) } catch {}
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
  if ((store.get('detector') as any)?.watching || store.get('followBackEnabled') || detectorPausedState) void getFeatureAuth(true)
}, 15000)
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

  app.whenReady().then(() => {
    // После системного сна Chromium возобновляет таймеры не одновременно.
    // Просим каждый живой view немедленно перепроверить аномалию, не создавая
    // новый цикл polling и не перезагружая страницу пользователя.
    powerMonitor.on('resume', () => {
      debugLog('system resumed: refreshing detector views')
      for (const [, view] of views) {
        try { view.webContents.executeJavaScript('window.__animeonDetector?.wake?.()', true).catch(() => {}) } catch {}
      }
      mainWindow?.webContents.send('system:resumed', Date.now())
    })
    // Pinned tabs survive relaunches; a fresh home tab only when nothing pinned.
    const savedTabs: any[] = (store.get('tabs') as any[]) || []
    const pinnedTabs = savedTabs.filter(t => t.pinned).slice(0, 7).map(t => ({ ...t, audible: false }))
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
      if (url.includes('animeon') || url.includes('token') || url.includes('code=') || url.includes('oauth')) {
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
      contents.on('will-navigate', (ev, nextUrl) => {
        debugLog('oauth:will-navigate', safeUrl(nextUrl))
        if (!nextUrl || nextUrl.startsWith('about:') || nextUrl.startsWith('blob:')) return
        if (isGoogleOrTelegram(nextUrl)) return
        if (nextUrl.includes('animeon') || nextUrl.includes('code=') || nextUrl.includes('oauth') || nextUrl.includes('token')) {
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
        const activeAcc = store.get('activeAccountId') as string | null
        const partition = activeAcc ? `persist:animeon-acc-${activeAcc}` : 'persist:animeon-acc-1'
        const ses = session.fromPartition(partition)
        // The OAuth popup uses the account partition too. Capture GIS's
        // credential response there, since it must never navigate the tab.
        try {
          ses.webRequest.onBeforeRequest((details, cb) => {
            if (details.url.includes('gsi/transform') && details.method === 'POST') {
              const rb: any = (details as any).requestBody || {}
              let token = ''
              try {
                if (rb.formData) token = String(rb.formData.id_token || rb.formData.credential || '')
                if (!token && Array.isArray(rb.raw)) {
                  const raw = Buffer.concat(rb.raw.map((r: any) => Buffer.isBuffer(r.bytes) ? r.bytes : Buffer.from(r.bytes || ''))).toString('utf8')
                  const m = raw.match(/(?:id_token|credential)=([^&\s]+)/)
                  if (m) token = decodeURIComponent(m[1])
                }
              } catch {}
              debugLog('oauth popup transform tokenLen=', token.length)
              if (token.length > 20) completeGoogleAuthViaTab(token)
            }
            cb({})
          })
        } catch {}
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
        // CDP attach обязателен: webRequest НЕ отдаёт тело навигационного POST
        // gsi/transform (в логе: webRequest tokenLen=0 против CDP tokenLen=1196).
        // Без него токен не захватывается, вход виснет на белом окне transform.
        try {
          oauthWin.webContents.debugger.attach('1.3')
          oauthWin.webContents.debugger.on('message', (_event, method, params) => {
            if (method !== 'Network.requestWillBeSent') return
            const request = params?.request
            if (!request?.url?.includes('gsi/transform')) return
            const token = getGoogleIdToken(request.postData || '')
            debugLog('cdp transform tokenLen=', token.length)
            if (token.length > 20) completeGoogleAuthViaTab(token)
          })
          oauthWin.webContents.debugger.sendCommand('Network.enable').catch(() => {})
          oauthWin.on('closed', () => {
            try { if (oauthWin.webContents.debugger.isAttached()) oauthWin.webContents.debugger.detach() } catch {}
          })
        } catch (e: any) { debugLog('cdp attach failed=', e?.message) }
        routeOAuthCallback(oauthWin.webContents)
        oauthWin.loadURL(url)
        oauthWin.webContents.on('did-finish-load', () => {
          oauthWin.webContents.insertCSS('::-webkit-scrollbar { display: none !important; }').catch(() => {})
        })
        oauthWin.on('closed', () => {
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
        if (url.startsWith('about:') || url.startsWith('tg://')) return { action: 'allow' }
        const currentUrl = contents.getURL()

        // Native popup preserves window.opener/postMessage and the originating session.
        let googlePopup = false
        try { const parsed = new URL(url); googlePopup = parsed.protocol === 'https:' && ['accounts.google.com', 'consent.google.com'].includes(parsed.hostname) } catch {}
        if (googlePopup && (normalizeAnimeonUrl(currentUrl) || popupContents.has(contents.id))) {
          if (profileSwitchBusy) return { action: 'deny' }
          return { action: 'allow', overrideBrowserWindowOptions: { width: 500, height: 620, autoHideMenuBar: true, webPreferences: { session: contents.session, preload: getPreloadPath('oauth.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } } }
        }

        // Google Identity Services uses a POPUP that returns the token via
        // window.opener.postMessage from /gsi/transform. We MUST let it open
        // as a real popup so window.opener points back to the animeon tab.
        // GIS opens /o/oauth2/v2/auth and then /gsi/select as two popups of
        // the SAME flow — allow both (no global cooldown that drops the 2nd).
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
        popupContents.add(win.webContents.id)
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

    for (let i = 1; i <= 5; i++) { session.fromPartition(`persist:animeon-acc-${i}`) }

    const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
    const fixUA = (ses: Electron.Session) => {
      try { ses.setUserAgent(CHROME_UA) } catch {}
      ses.webRequest.onBeforeSendHeaders((details, cb) => {
        const h = details.requestHeaders
        h['User-Agent'] = CHROME_UA
        h['Sec-CH-UA'] = '"Chromium";v="130", "Not_A Brand";v="24"'
        h['Sec-CH-UA-Platform'] = '"Windows"'
        h['Sec-CH-UA-Mobile'] = '?0'
        cb({ requestHeaders: h })
      })
    }
    session.defaultSession.setUserAgent(CHROME_UA)
    for (const part of ['persist:animeon-acc-1','persist:animeon-acc-2','persist:animeon-acc-3','persist:animeon-acc-4','persist:animeon-acc-5']) {
      fixUA(session.fromPartition(part))
    }

    createMainWindow()
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMainWindow() })
  })
}

app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => {
  if (!singleInstanceLock) return
  resetRunFlags()
  const tabs: any[] = (store.get('tabs') as any[]) || []
  const pinned = tabs.filter(t => t.pinned)
  store.set('tabs', pinned)
  store.set('tabOrder', pinned.map(t => t.id))
  store.set('activeTabId', pinned[0]?.id || null)
  for (const [, view] of views.entries()) {
    try { (view.webContents as any).destroy() } catch {}
  }
  views.clear()
})

// Проверка обновлений отложена: дёргать сеть на уровне модуля тормозило запуск.
setTimeout(() => {
  try {
    const { autoUpdater } = require('electron-updater')
    // Test channel must never download or install the stable release automatically.
    autoUpdater.autoDownload = false
  } catch {}
}, 20000)
