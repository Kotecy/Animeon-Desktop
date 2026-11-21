const { _electron: electron } = require('playwright')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

process.chdir(path.resolve(__dirname, '..'))
const cycles = Number(process.env.ANIMEON_TEST_RESOURCE_CYCLES || 12)
if (!Number.isInteger(cycles) || cycles < 1) throw Error('Cycle count must be a positive integer')
const dwellMs = 3000
const base = 'https://v2.animeon.co/audit-media/'
const video = path.resolve('../scratch/maintenance-audit-clip.mp4')

async function measure(label, entryPoint) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'animeon-resource-audit-'))
  const tabs = ['primary', 'background'].map(id => ({ id, url: base + id, title: id, pinned: true, muted: true, partition: 'persist:animeon-acc-1' }))
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({
    tabs, tabOrder: tabs.map(tab => tab.id), activeTabId: 'primary', activeAccountId: '1',
    accounts: [{ id: '1', nickname: '', createdAt: 1 }, { id: '2', nickname: '', createdAt: 2 }]
  }))
  const env = { ...process.env, ANIMEON_TEST_MAIN: path.resolve(entryPoint), ANIMEON_TEST_USER_DATA: data, ANIMEON_TEST_VIDEO: video }
  delete env.ELECTRON_RUN_AS_NODE
  const instance = await electron.launch({ executablePath: require('electron'), args: ['scripts/electron-fixture.cjs'], env })
  try {
    const page = await instance.firstWindow()
    await page.waitForFunction(() => !!window.api)
    const invoke = (method, ...args) => page.evaluate(({method,args}) => window.api[method](...args), {method,args})
    const evaluateView = (url, code) => instance.evaluate(async ({BrowserWindow}, {url, code}) => {
      const view = BrowserWindow.getAllWindows()[0].getBrowserViews().find(view => view.webContents.getURL() === url)
      return view ? view.webContents.executeJavaScript(code, true) : null
    }, {url, code})
    const play = async url => {
      const deadline = Date.now() + 8000
      while (Date.now() < deadline) {
        const result = await evaluateView(url, 'document.querySelector("video")?.play().then(() => true)')
        if (result) return
        await page.waitForTimeout(80)
      }
      throw Error('Video did not start at ' + url)
    }
    const sample = point => instance.evaluate(({app,BrowserWindow,webContents}, point) => {
      const processes = app.getAppMetrics()
      return {
        point,
        views: BrowserWindow.getAllWindows()[0].getBrowserViews().length,
        contents: webContents.getAllWebContents().length,
        processes: processes.length,
        workingSetKiB: processes.reduce((sum, process) => sum + process.memory.workingSetSize, 0),
        privateKiB: processes.every(process => Number.isFinite(process.memory.privateBytes))
          ? processes.reduce((sum, process) => sum + process.memory.privateBytes, 0) : null
      }
    }, point)
    const prepareBackground = async () => {
      assert.equal(await invoke('tabsSwitch', 'background'), true)
      await play(base + 'background')
      assert.equal(await invoke('tabsSwitch', 'primary'), true)
      const before = await evaluateView(base + 'background', 'document.querySelector("video").currentTime')
      await page.waitForTimeout(600)
      const after = await evaluateView(base + 'background', 'document.querySelector("video").currentTime')
      assert.ok(Math.abs(after - before) > 0.1, 'Background MP4 time must advance')
    }
    await prepareBackground()
    await page.waitForTimeout(1500)
    const samples = [await sample('warm')]
    await instance.evaluate(({app}) => {
      const first = new Map()
      const last = new Map()
      const started = Date.now()
      const read = initial => {
        for (const entry of app.getAppMetrics()) {
          const key = `${entry.pid}:${entry.creationTime}`
          const cpu = entry.cpu.cumulativeCPUUsage
          if (!Number.isFinite(cpu)) continue
          if (!first.has(key)) first.set(key, initial ? cpu : 0)
          last.set(key, cpu)
        }
      }
      read(true)
      const interval = setInterval(() => read(false), 500)
      globalThis.finishCpuAudit = () => {
        clearInterval(interval)
        read(false)
        return {
          wallSeconds: (Date.now() - started) / 1000,
          sampledCpuSeconds: last.size ? [...last].reduce((total, [key, cpu]) => total + Math.max(0, cpu - first.get(key)), 0) : null
        }
      }
    })
    for (let cycle = 1; cycle <= cycles; cycle++) {
      const url = base + 'temporary-' + cycle
      const transient = await invoke('tabsCreate', url)
      await play(url)
      const nextEpisode = base + 'episode-' + cycle
      assert.equal((await invoke('tabsNavigate', 'primary', nextEpisode)).ok, true)
      await play(nextEpisode)
      const minimize = cycle % 6 === 0
      if (minimize) await instance.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].minimize())
      await page.waitForTimeout(dwellMs)
      samples.push(await sample('playing-' + cycle))
      if (minimize) await instance.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].restore())
      assert.equal(await invoke('tabsClose', transient.id), true)
      if (cycle % 4 === 0) {
        const profile = cycle % 8 === 0 ? '1' : '2'
        assert.equal(await invoke('accountsSelect', profile), true)
        await prepareBackground()
        await play(nextEpisode)
      }
      await page.waitForTimeout(500)
      const settled = await sample('closed-' + cycle)
      assert.equal(settled.views, 2)
      assert.equal(settled.contents, 3)
      samples.push(settled)
    }
    await page.waitForTimeout(5000)
    samples.push(await sample('cooldown'))
    const cpu = await instance.evaluate(() => globalThis.finishCpuAudit())
    return { label, cycles, dwellMs, cpu, samples }
  } finally {
    await instance.close()
  }
}

;(async () => {
  const entries = process.argv.slice(2)
  if (!entries.length) throw Error('Pass entry points for the builds to compare')
  const results = []
  for (const entry of entries) {
    const result = await measure(entry, entry)
    results.push(result)
    const report = process.env.ANIMEON_TEST_RESOURCE_REPORT || '../scratch/maintenance-resource-cycle.json'
    fs.writeFileSync(report, JSON.stringify(results, null, 2))
    const { samples } = result
    console.log(JSON.stringify({ label: result.label, cpu: result.cpu, warm: samples[0], final: samples.at(-1), peakWorkingSetKiB: Math.max(...samples.map(sample => sample.workingSetKiB)) }))
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
