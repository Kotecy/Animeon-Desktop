const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const ts = require('typescript')
const source = fs.readFileSync(path.join(__dirname, '../src/preload/content.ts'), 'utf8')
const readers = source.slice(source.indexOf('  const normalizeNick'), source.indexOf('  function escapeHtml'))
const engine = source.slice(source.indexOf('  let fbRunning = false'), source.indexOf('  ;(window as any).__animeonFollowback'))
const compiled = ts.transpileModule(readers + engine + '\nglobalThis.run = checkFollowBacks;', { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText
const user = (slug, nickname) => ({ username_slug: slug, username: nickname || slug })
async function test(options = {}) {
  const mutations = [], reports = []
  let identities = 0
  const context = vm.createContext({
    console, Date, Map, Set, Promise,
    FOLLOWBACK_CHECK_MS: 600000, FOLLOWBACK_MAX_PER_RUN: 5,
    host: () => ({ followbackLists: async () => ({ whitelist: options.whitelist || [], blacklist: options.blacklist || [] }), followbackClaim: async () => ({ ok: options.lease !== false }), followbackFinish: async s => reports.push(s) }),
    storeGet: async key => key === 'followBackEnabled' ? options.enabled !== false : options.whitelist || [],
    sleep: async () => {}, diag: () => {}, notifyFollowed: async () => {},
    fetchWithTimeout: async (url, init = {}) => {
      if (init.method) {
        mutations.push([init.method, url])
        return { ok: !options.mutationFail, status: options.mutationFail ? 429 : 200 }
      }
      if (url === '/api/auth/me') {
        identities++
        return { ok: !options.loggedOut, status: options.loggedOut ? 401 : 200, json: async () => ({ user: { username_slug: options.accountChanged && identities > 1 ? 'other' : 'owner' } }) }
      }
      const parsed = new URL(url, 'https://fixture.invalid')
      const kind = parsed.pathname.endsWith('/followers') ? 'followers' : 'following'
      const page = Number(parsed.searchParams.get('page'))
      if (options.failPage && kind === 'followers' && page === 2) return { ok: false, status: 500 }
      if (options.invalid && kind === 'followers') return { ok: true, json: async () => ({ error: 'bad shape' }) }
      const rows = options[kind] || []
      const size = options.pageSize || 50
      const result = { users: rows.slice((page - 1) * size, page * size) }
      if (!options.noTotal) result.total = rows.length + (options.incomplete && kind === 'followers' ? 1 : 0)
      return { ok: true, status: 200, json: async () => result }
    }
  })
  vm.runInContext(compiled, context)
  await context.run()
  return { mutations, reports }
}
async function main() {
  let r = await test({ followers: [user('Mutual')], following: [user('mutual'), user('lost')] })
  assert.deepEqual(r.mutations, [['DELETE', '/api/users/lost/follow']])
  r = await test({ followers: [user('new')], following: [user('favorite', 'Любимый')] , whitelist: [' @ЛЮБИМЫЙ '] })
  assert.deepEqual(r.mutations, [['POST', '/api/users/new/follow']])
  for (const option of [{ failPage: true, pageSize: 1 }, { incomplete: true }, { invalid: true }, { accountChanged: true }, { loggedOut: true }, { lease: false }, { enabled: false }]) {
    r = await test({ followers: [user('a'), user('b')], following: [user('lost')], ...option })
    assert.equal(r.mutations.length, 0, JSON.stringify(option))
  }
  r = await test({ followers: [], following: [user('lost')] })
  assert.equal(r.mutations[0][0], 'DELETE', 'A verified empty followers list is valid')
  r = await test({ followers: [user('a'), user('b')], following: [user('a'), user('b')], pageSize: 1, noTotal: true })
  assert.equal(r.mutations.length, 0, 'Read all pages even without total')
  r = await test({ followers: [user('new')], following: [user('lost')], mutationFail: true })
  assert.equal(r.mutations.length, 1, 'Stop batch after server failure')
  assert.equal(r.reports[0].ok, false)
  r = await test({ following: Array.from({ length: 8 }, (_, i) => user('lost' + i)) })
  assert.equal(r.mutations.length, 5, 'Bound mutation batch')
  r = await test({ followers: [user('blocked'), user('allowed')], blacklist: ['@BLOCKED'] })
  assert.equal(r.mutations.length, 1)
  assert.equal(r.mutations[0][1], '/api/users/allowed/follow')
  console.log('PASS: followback mocked API: mutual/lost followers, aliases, whitelist/blacklist, pagination, incomplete/error lists, account change, disabled state, lease, rate failure and batch limit. No network requests made.')
}
main().catch(e => { console.error(e); process.exitCode = 1 })
