const fs = require('node:fs')
const vm = require('node:vm')
const ts = require('typescript')
const assert = require('node:assert/strict')
const src = fs.readFileSync('src/main/index.ts', 'utf8')
const block = src.slice(src.indexOf('let collectionEpoch ='), src.indexOf('let lastLimitInject ='))
async function run() {
  for (const random of [0, .5, .999999]) {
    let callback, duration, clears = 0
    const ctx = vm.createContext({ Set, Promise, Math: { random: () => random, floor: Math.floor },
      setTimeout: (fn, ms) => { callback = fn; duration = ms; return 1 }, clearTimeout: () => clears++ })
    vm.runInContext(ts.transpile(block, { target: ts.ScriptTarget.ES2022 }), ctx)
    const waiting = vm.runInContext('waitForCollection()', ctx)
    assert.ok(duration >= 3000 && duration <= 10000)
    callback(); assert.equal(await waiting, true)
    const cancelled = vm.runInContext('waitForCollection()', ctx)
    vm.runInContext('cancelCollections()', ctx)
    assert.equal(await cancelled, false)
    assert.equal(vm.runInContext('pendingCollections.size', ctx), 0)
    assert.equal(vm.runInContext('collectionEpoch', ctx), 1)
    assert.ok(clears >= 2)
  }
  console.log('PASS: random delay bounds, timer completion, immediate cancellation, cleanup and epoch invalidation; no waiting or network.')
}
run().catch(error => { console.error(error); process.exitCode = 1 })
