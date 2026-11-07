const { _electron: electron } = require('playwright')
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
process.chdir(path.resolve(__dirname, '..'))

async function run() {
  const observing = process.argv.includes('--observe')
  const env = { ...process.env, ANIMEON_TEST_USER_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'animeon-recovery-')) }
  delete env.ELECTRON_RUN_AS_NODE
  const instance = await electron.launch({ executablePath: require('electron'), args: ['scripts/electron-fixture.cjs'], env })
  try {
    const page = await instance.firstWindow()
    await page.waitForFunction(() => !!window.api)
    const invoke = (method, ...args) => page.evaluate(({method,args}) => window.api[method](...args), {method,args})
    const [first] = await invoke('storeGet', 'tabOrder')
    const other = await invoke('tabsCreate', 'https://v2.animeon.co/recovery-other')
    await invoke('tabsSwitch', first)
    const measure = () => instance.evaluate(({BrowserWindow,webContents}) => {
      const window = BrowserWindow.getAllWindows()[0]
      return { minimized: window.isMinimized(), views: window.getBrowserViews().map(view => ({id:view.webContents.id, bounds:view.getBounds()})), contents:webContents.getAllWebContents().length }
    })
    const waitFor = async (check, timeout = 4000) => {
      const deadline = Date.now() + timeout
      while (Date.now() < deadline) {
        if (await check()) return true
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      return false
    }
    const getView = (index, script) => instance.evaluate(({BrowserWindow},{index,script}) =>
      BrowserWindow.getAllWindows()[0].getBrowserViews()[index].webContents.executeJavaScript(script, true), {index,script})
    if (!observing) {
      await getView(0, `(() => {
        const menu = document.createElement('div')
        menu.id = 'audit-profile-menu'
        menu.textContent = 'Мой профиль · Настройки · Выйти'
        document.body.append(menu)
      })()`)
      assert.ok(await waitFor(() => getView(0, 'document.getElementById("audit-profile-menu").style.overflowY === "auto"'), 1500),
        'Menu inserted after page load must get scroll styling')
      assert.equal(await getView(0, `(() => {
        window.__animeonToast.limit(250)
        return !!document.querySelector('[data-animeon-limit]')
      })()`), true)
      assert.ok(await waitFor(() => getView(0, '!document.querySelector("[data-animeon-limit]")')))
    }
    await getView(0, 'document.documentElement.requestFullscreen()')
    assert.ok(await waitFor(async () => (await measure()).views[0].bounds.x === 0), 'HTML fullscreen must reach the window edge')
    await invoke('tabsSwitch', other.id)
    const otherViewNormal = (await measure()).views[1].bounds.x > 0
    await invoke('tabsSwitch', first)
    await getView(0, 'document.fullscreenElement ? document.exitFullscreen() : Promise.resolve()')
    assert.ok(await waitFor(async () => (await measure()).views[0].bounds.x > 0), 'Exit fullscreen must restore normal bounds')
    const priorIds = (await measure()).views.map(view => view.id)
    await instance.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].minimize())
    assert.ok(await waitFor(async () => (await measure()).minimized))
    await instance.evaluate(({BrowserWindow,powerMonitor}) => {
      BrowserWindow.getAllWindows()[0].restore()
      powerMonitor.emit('resume')
      powerMonitor.emit('unlock-screen')
    })
    assert.ok(await waitFor(async () => !(await measure()).minimized))
    assert.deepEqual((await measure()).views.map(view => view.id), priorIds)

    await getView(0, 'window.auditTelegramPending = true; window.open("https://t.me/animeon_fixture_bot"); true')
    assert.ok(await waitFor(() => instance.evaluate(({BrowserWindow}) =>
      BrowserWindow.getAllWindows().some(window => window.webContents.getURL().startsWith('https://t.me/')))))
    await instance.evaluate(({BrowserWindow}) => {
      BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith('https://t.me/')).close()
    })
    await page.waitForTimeout(350)
    const telegramPreserved = await getView(0, 'window.auditTelegramPending === true')

    const script = await invoke('utilitiesImport', 0, 'recovery.js', 'window.auditRecoveryRuns = (window.auditRecoveryRuns || 0) + 1; module.exports.stop = () => {}')
    assert.equal((await invoke('utilitiesToggle', script.item.id)).ok, true)
    assert.equal(await getView(0, 'window.auditRecoveryRuns'), 1)
    await instance.evaluate(({BrowserWindow}) => {
      const site = BrowserWindow.getAllWindows()[0].getBrowserViews()[0].webContents
      return new Promise(resolve => {
        site.once('render-process-gone', () => resolve(true))
        site.forcefullyCrashRenderer()
      })
    })
    const reload = await invoke('tabsReloadActive')
    const tabRecovered = reload.ok && await waitFor(async () => {
      try { return await getView(0, 'document.title === "AnimeOn fixture" && window.auditRecoveryRuns === 1') } catch { return false }
    })

    await instance.evaluate(({BrowserWindow}) => {
      const shell = BrowserWindow.getAllWindows()[0].webContents
      return new Promise(resolve => {
        shell.once('render-process-gone', () => resolve(true))
        shell.forcefullyCrashRenderer()
      })
    })
    const shellRecovered = await waitFor(() => instance.evaluate(async ({BrowserWindow}) => {
      const shell = BrowserWindow.getAllWindows()[0].webContents
      if (shell.isCrashed() || shell.isLoadingMainFrame()) return false
      try { return await shell.executeJavaScript('!!window.api && document.querySelectorAll(".signal-tablist [data-tab-id]").length === 2') }
      catch { return false }
    }))
    const finalState = await measure()
    console.log(JSON.stringify({ otherViewNormal, telegramPreserved, tabRecovered, shellRecovered, sameViews: JSON.stringify(finalState.views.map(view => view.id)) === JSON.stringify(priorIds), contents: finalState.contents }))
    if (!observing) {
      assert.ok(otherViewNormal, 'Fullscreen must not transfer to the next tab')
      assert.ok(telegramPreserved, 'Closing Telegram must preserve the original document')
      assert.ok(tabRecovered, 'Reload must restore the site and inject the script once')
      assert.ok(shellRecovered, 'Application shell must reload after a renderer crash')
      assert.deepEqual(finalState.views.map(view => view.id), priorIds)
      assert.equal(finalState.contents, 3)
    }
  } finally { await instance.close() }
}
run().catch(error => { console.error(error); process.exitCode = 1 })
