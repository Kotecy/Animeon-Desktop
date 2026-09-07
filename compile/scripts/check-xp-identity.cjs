const fs = require('node:fs')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const ts = require('typescript')
const main = fs.readFileSync('src/main/index.ts', 'utf8')
const source = main.slice(main.indexOf('async function getActiveNickname('), main.indexOf('async function startUtilityInTab('))
const context = vm.createContext({ store: { get: () => '1' } })
vm.runInContext(ts.transpile(source), context)
async function resolve(body, status = 200, changeProfile = false) {
  const requests = []
  const view = { __accountId: '1', webContents: { executeJavaScript: async code => {
    const result = await vm.runInNewContext(code, {
      AbortSignal,
      fetch: async (path, options) => {
        requests.push(path)
        assert.equal(options.credentials, 'include')
        return { status, ok: status === 200, json: async () => body }
      },
      get document() { throw Error('Must never read visited profile DOM') },
      get location() { throw Error('Must never read visited profile URL') }
    })
    if (changeProfile) view.__accountId = '2'
    return result
  } } }
  return (await context.getActiveNickname(view)).nickname
}
async function test() {
  assert.equal(await resolve({ data: { user: { username_slug: 'owner', nickname: 'Display Name' } } }), 'owner')
  assert.equal(await resolve({ user: { username: 'owner' } }), 'owner')
  assert.equal(await resolve({}), '')
  assert.equal(await resolve({ username: 'stale' }, 401), '')
  assert.equal(await resolve({ username: 'owner' }, 200, true), '')
  console.log('PASS: session owner only, API slug priority, no DOM/URL fallback, logout and profile-change guards; no network.')
}
test().catch(error => { console.error(error); process.exitCode = 1 })
