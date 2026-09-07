const fs = require('node:fs')
const vm = require('node:vm')
const ts = require('typescript')
const assert = require('node:assert/strict')
const source = fs.readFileSync('src/main/index.ts', 'utf8')
const helper = source.slice(source.indexOf('async function clearProfileSession('), source.indexOf('const UTILITY_FILES:'))
const remove = source.slice(source.indexOf("  ipcMain.handle('accounts:remove'"), source.indexOf("  ipcMain.handle('tabs:create'"))
async function run(key, fail = false) {
  const data = { accounts: [{ id: '1', nickname: 'first' }, { id: '2', nickname: 'second' }], activeAccountId: key,
    tabs: [1, 2].map(n => ({ id: 't' + n, partition: 'persist:animeon-acc-' + n })), tabOrder: ['t1', 't2'], activeTabId: 't' + key }
  const events = [], handlers = {}, sessions = new Map()
  for (const n of [1, 2]) sessions.set('persist:animeon-acc-' + n, Object.fromEntries(
    ['closeAllConnections', 'clearStorageData', 'clearAuthCache', 'clearCache'].map(method => [method, async () => {
      events.push(`${n}:${method}`)
      if (fail && method === 'clearStorageData') throw Error('disk failure')
    }]).concat([['cookies', { flushStore: async () => events.push(`${n}:flush`) }]])))
  const windows = [1, 2].map(n => ({ isDestroyed: () => false, webContents: { session: sessions.get('persist:animeon-acc-' + n) }, destroy: () => events.push('window:' + n) }))
  const ctx = vm.createContext({
    profileSwitchBusy: false, accountMutationEpoch: 0, utilityEpoch: 0, activeTabId: data.activeTabId,
    store: { get: k => data[k], set: (k, v) => { data[k] = v } },
    session: { fromPartition: p => { assert.ok(sessions.has(p)); return sessions.get(p) } },
    BrowserWindow: { getAllWindows: () => windows }, mainWindow: { webContents: { send() {} } },
    destroyView: id => events.push('view:' + id), layoutViews() {},
    normalizeAccounts: () => data.accounts, notifyAccounts() {}, resetRunFlags() {}, stopUtility: async () => {},
    createTabFromUrl: () => null, ipcMain: { handle: (name, fn) => { handlers[name] = fn } }
  })
  vm.runInContext(ts.transpile(helper + remove, { target: ts.ScriptTarget.ES2022 }), ctx)
  if (fail) {
    await assert.rejects(handlers['accounts:remove'](null, key), /disk failure/)
    assert.ok(data.accounts.some(a => a.id === key), 'Failed cleanup must keep profile for retry')
  } else {
    assert.equal(await handlers['accounts:remove'](null, key), true)
    assert.equal(data.tabs.length, 1)
    assert.equal(data.tabs[0].id, key === '1' ? 't2' : 't1')
    assert.deepEqual(events, ['view:t' + key, 'window:' + key, key + ':closeAllConnections', key + ':clearStorageData', key + ':clearAuthCache', key + ':clearCache', key + ':flush'])
    if (key === '1') { assert.equal(data.accounts.length, 2); assert.equal(data.accounts.find(a => a.id === '1').nickname, '') }
    else assert.ok(!data.accounts.some(a => a.id === key))
  }
  assert.equal(ctx.profileSwitchBusy, false)
}
;(async () => {
  await run('1'); await run('2'); await run('2', true)
  assert.match(source, /await clearProfileSession\(String\(n\)\)/)
  console.log('PASS: profile 1 reset, profile 2 deletion, exact session cleanup, other session preserved, failure retry, fresh-slot cleanup. Mock sessions only.')
})().catch(error => { console.error(error); process.exitCode = 1 })
