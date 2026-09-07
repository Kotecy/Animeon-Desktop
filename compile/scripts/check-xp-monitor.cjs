const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const source = fs.readFileSync(path.join(__dirname, '../src/source/scripts/XP_Check.txt'), 'utf8')
assert.match(source, /by Suchka322/)
assert.doesNotMatch(source, /<input|input\.addEventListener/)
new vm.Script(source)
async function test() {
  const nodes = [], intervals = new Map(), timeouts = new Map(), requests = []
  let serial = 0
  function element() {
    const children = new Map(), classes = new Set()
    const node = { style: {}, textContent: '', innerHTML: '', removed: false,
      classList: { add: (...xs) => xs.forEach(x => classes.add(x)), remove: (...xs) => xs.forEach(x => classes.delete(x)), contains: x => classes.has(x), toggle: (x, active) => active ? classes.add(x) : classes.delete(x) },
      appendChild() {}, remove() { this.removed = true }, addEventListener() {},
      querySelector(selector) { if (!children.has(selector)) children.set(selector, element()); return children.get(selector) }
    }
    nodes.push(node)
    return node
  }
  const window = { addEventListener() {} }
  let xp = 1234
  const context = vm.createContext({ window, document: { createElement: element, documentElement: { appendChild() {} }, body: { appendChild() {} } }, AbortController,
    setInterval: fn => { intervals.set(++serial, fn); return serial }, clearInterval: id => intervals.delete(id),
    setTimeout: fn => { timeouts.set(++serial, fn); return serial }, clearTimeout: id => timeouts.delete(id),
    fetch: async (url, options) => { requests.push({ url, options }); return { ok: true, json: async () => ({ user: { total_xp: xp } }) } }
  })
  const tick = () => new Promise(resolve => setImmediate(resolve))
  vm.runInContext(source.replace("const TARGET_USER = 'username';", "const TARGET_USER = 'fixture';"), context)
  await tick()
  assert.equal(requests.length, 1)
  assert.match(requests[0].url, /^\/api\/users\/fixture\?xp_monitor=/)
  const panel = nodes.find(node => node.id === 'aoxp-panel')
  assert.equal(panel.querySelector('#aoxp-current').textContent.replace(/\s/g, ''), '1234')
  xp = null
  for (const fn of intervals.values()) fn()
  await tick()
  assert.equal(panel.querySelector('#aoxp-status-text').textContent, 'В ответе API нет total_xp')
  assert.equal(panel.querySelector('#aoxp-current').textContent.replace(/\s/g, ''), '1234', 'Missing XP must not become zero')
  window.__ANIMEON_XP_MONITOR__.stop()
  assert.equal(intervals.size, 0)
  assert.equal(timeouts.size, 0)
  assert.equal(panel.removed, true)
  assert.equal(nodes.find(node => node.id === 'aoxp-banner').removed, true)
  assert.equal(requests[0].options.signal instanceof AbortSignal, true)
  assert.equal(window.__ANIMEON_XP_MONITOR__, undefined)
  console.log('PASS: XP v2.1 syntax, attribution, automatic account, no manual input, missing-XP guard, stop and timer cleanup; no network.')
}
test().catch(error => { console.error(error); process.exitCode = 1 })
