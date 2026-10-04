const fs = require('node:fs')
const vm = require('node:vm')
const ts = require('typescript')
const assert = require('node:assert/strict')
const main = fs.readFileSync('src/main/index.ts', 'utf8')
const block = main.slice(main.indexOf('  const collectAttempts ='), main.indexOf("  ipcMain.handle('anomaly:action'"))
async function fixture(options = {}) {
  const handlers = {}, requests = [], messages = []
  const data = { detector: { watching: options.watching !== false, autoCollect: options.autoCollect !== false } }
  let ctx, release
  const gate = options.defer ? new Promise(resolve => { release = resolve }) : null
  const sender = { isDestroyed: () => false, getURL: () => 'https://v2.animeon.co/leaderboard', executeJavaScript: async source => {
    const result = await vm.runInNewContext(source, { AbortSignal, fetch: async (url, init) => {
      requests.push({ url, init })
      assert.equal(init.credentials, 'include')
      assert.equal(init.redirect, 'error')
      if (url.endsWith('/state')) {
        if (gate) await gate
        if (options.switchProfile) ctx.utilityEpoch++
        if (options.disableDuringCheck) data.detector.autoCollect = false
        return { ok: options.stateError !== true, status: options.stateError ? 401 : 200, json: async () => ({ eligible: options.eligible !== false }) }
      }
      assert.equal(url, '/api/event/boar/anomaly/claim')
      assert.equal(init.method, 'POST')
      assert.equal(init.headers['Content-Type'], 'application/json')
      assert.ok(!('body' in init), 'The request must have an empty body')
      assert.ok(!('Cookie' in init.headers), 'Never embed copied credentials')
      if (options.timeout) throw Error('timeout')
      return { ok: !options.rejected, status: options.rejected ? 429 : 200, json: async () => options.body || {} }
    } })
    return result
  } }
  const view = { __accountId: '1', webContents: sender }
  const sibling = { ...sender }
  ctx = vm.createContext({ Map, Set, Date, URL, utilityEpoch: 0, collectionEpoch: 0, AUTO_COLLECT_AVAILABLE: true, waitForCollection: async () => options.cancelWait !== true, profileSwitchBusy: false,
    views: new Map([['a', view], ['b', { __accountId: '1', webContents: sibling }]]),
    normalizeAnimeonUrl: url => url, store: { get: k => data[k] },
    mainWindow: { webContents: { send: (...args) => messages.push(args) } },
    ipcMain: { handle: (name, fn) => { handlers[name] = fn } }
  })
  vm.runInContext(ts.transpile(block, { target: ts.ScriptTarget.ES2022 }), ctx)
  const claim = (s = sender) => handlers['anomaly:claim']({ sender: s })
  return { claim, requests, messages, release, sibling }
}
async function run() {
  let f = await fixture()
  assert.equal((await f.claim()).status, 'accepted')
  assert.equal(f.requests.length, 2)
  assert.equal((await f.claim()).status, 'skipped', 'Cooldown blocks duplicate claims')
  assert.equal((await f.claim(f.sibling)).status, 'skipped', 'Cooldown is shared across profile tabs')
  for (const options of [{ watching: false }, { autoCollect: false }, { cancelWait: true }]) {
    f = await fixture(options); assert.equal((await f.claim()).status, 'skipped'); assert.equal(f.requests.length, 0)
  }
  for (const options of [{ eligible: false }, { switchProfile: true }, { disableDuringCheck: true }]) {
    f = await fixture(options); assert.equal((await f.claim()).status, 'skipped'); assert.equal(f.requests.length, 1)
  }
  for (const options of [{ rejected: true }, { body: { success: false } }, { body: { error: 'not ready' } }]) {
    f = await fixture(options); assert.equal((await f.claim()).status, 'failed')
  }
  f = await fixture({ timeout: true }); assert.equal((await f.claim()).status, 'unknown'); assert.equal((await f.claim()).status, 'skipped')
  f = await fixture({ stateError: true }); assert.equal((await f.claim()).status, 'unknown'); assert.equal(f.requests.length, 1)
  f = await fixture({ defer: true }); const pending = f.claim(); assert.equal((await f.claim(f.sibling)).status, 'skipped'); f.release(); assert.equal((await pending).status, 'accepted')
  const content = fs.readFileSync('src/preload/content.ts', 'utf8')
  assert.ok(content.includes('host()?.anomalyClaim()'))
  assert.ok(!content.includes('location.reload()'))
  assert.ok(!content.includes('btn.click()'))
  console.log('PASS: empty-body API claim without DOM/reload, fresh eligibility, run switches, account change, per-profile concurrency/cooldown, rejection and timeout; no network.')
}
run().catch(error => { console.error(error); process.exitCode = 1 })
