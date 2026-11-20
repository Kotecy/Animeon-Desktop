const { _electron: electron } = require('playwright')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
process.chdir(root)
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'animeon-maintenance-'))
async function launch() {
  const env = { ...process.env, ANIMEON_TEST_USER_DATA: data }
  delete env.ELECTRON_RUN_AS_NODE
  const instance = await electron.launch({ executablePath: require('electron'), args: ['scripts/electron-fixture.cjs'], env, timeout: 30000 })
  instance.process().stderr.on('data', chunk => { if (/Error|FATAL/.test(String(chunk))) process.stderr.write(chunk) })
  const page = await instance.firstWindow()
  await page.waitForFunction(() => !!window.api)
  return { instance, page }
}

async function checkTabReordering(page, invoke, firstPinned) {
  const [, home] = await invoke('storeGet', 'tabOrder')
  const createTab = async name => (await invoke('tabsCreate', 'https://v2.animeon.co/' + name)).id
  const normalA = await createTab('normal-a')
  const normalB = await createTab('normal-b')
  const secondPinned = await createTab('second-pinned')
  await invoke('tabsTogglePinned', secondPinned)
  const list = page.locator('.signal-tablist')
  const tab = id => list.locator(`[data-tab-id="${id}"]`)
  await tab(secondPinned).and(list.locator('.pinned')).waitFor()

  const drag = async (id, target, right, beforeRelease = async () => {}) => {
    const source = await tab(id).boundingBox()
    const destination = await tab(target).boundingBox()
    await page.mouse.move(source.x + 12, source.y + source.height / 2)
    await page.mouse.down()
    await page.mouse.move(destination.x + destination.width * (right ? 0.75 : 0.25), destination.y + destination.height / 2)
    try { await beforeRelease() } finally { await page.mouse.up() }
  }
  const shown = () => list.locator('[data-tab-id]').evaluateAll(elements => elements.map(element => element.dataset.tabId))
  const original = [firstPinned, secondPinned, home, normalA, normalB]
  assert.deepEqual(await shown(), original)
  assert.deepEqual(await invoke('storeGet', 'tabOrder'), original)
  for (const [from, to, right] of [[home, secondPinned, false], [normalA, firstPinned, false], [firstPinned, normalA, true]]) {
    await drag(from, to, right, async () => assert.deepEqual(await shown(), original))
    assert.deepEqual(await invoke('storeGet', 'tabOrder'), original)
  }
  assert.equal(await invoke('tabsReorder', [home, firstPinned, secondPinned, normalA, normalB], home, original), false)
  assert.equal(await invoke('tabsReorder', [firstPinned, secondPinned, home, normalB, normalA, normalA], normalA, original), false)
  assert.equal(await invoke('tabsReorder', original.slice(1), home, original), false)
  assert.equal(await invoke('tabsReorder', [firstPinned, secondPinned, home, normalB, normalA, 'unknown'], normalA, original), false)
  assert.equal(await invoke('storeSet', 'tabOrder.0', secondPinned), false)
  assert.equal(await invoke('storeSet', 'tabOrder[0]', secondPinned), false)

  const waitForOrder = expected => page.waitForFunction(async expected => {
    const actual = [...document.querySelectorAll('.signal-tablist [data-tab-id]')].map(tab => tab.dataset.tabId)
    return JSON.stringify(actual) === JSON.stringify(expected)
      && JSON.stringify(await window.api.storeGet('tabOrder')) === JSON.stringify(expected)
  }, expected)
  await drag(normalA, normalB, true)
  const normalReordered = [firstPinned, secondPinned, home, normalB, normalA]
  await waitForOrder(normalReordered)
  await drag(normalA, normalB, false, () => list.dispatchEvent('pointercancel'))
  assert.deepEqual(await invoke('storeGet', 'tabOrder'), normalReordered)

  await drag(secondPinned, firstPinned, false)
  const pinnedReordered = [secondPinned, firstPinned, home, normalB, normalA]
  await waitForOrder(pinnedReordered)
  await drag(normalB, normalA, true, async () => {
    await invoke('tabsClose', normalA)
    await tab(normalA).waitFor({ state: 'detached' })
  })
  const afterClose = pinnedReordered.filter(id => id !== normalA)
  assert.deepEqual(await invoke('storeGet', 'tabOrder'), afterClose)
  assert.equal(await invoke('tabsReorder', pinnedReordered, normalB, normalReordered), false)
  assert.equal(await invoke('tabsTogglePinned', firstPinned), false)
  await tab(firstPinned).and(list.locator(':not(.pinned)')).waitFor()
  assert.deepEqual(await shown(), afterClose)
  assert.equal(await invoke('tabsTogglePinned', normalB), true)
  const newlyPinned = [secondPinned, normalB, firstPinned, home]
  await waitForOrder(newlyPinned)
  assert.equal(await invoke('tabsTogglePinned', normalB), false)
  await tab(normalB).and(list.locator(':not(.pinned)')).waitFor()
  assert.equal(await invoke('tabsTogglePinned', firstPinned), true)
  await waitForOrder([secondPinned, firstPinned, normalB, home])
  await drag(home, normalB, false)
  await waitForOrder(afterClose)
  assert.deepEqual(await invoke('storeGet', 'tabOrder'), afterClose)
  return [secondPinned, firstPinned]
}

async function run() {
  let instance
  try {
    let launched = await launch(); instance = launched.instance; let page = launched.page
    const invoke = (channel, ...args) => page.evaluate(({channel,args}) => window.api[channel](...args), {channel,args})
    const viewEval = expression => instance.evaluate(({BrowserWindow}, expression) => BrowserWindow.getAllWindows()[0].getBrowserViews()[0].webContents.executeJavaScript(expression), expression)
    await page.waitForTimeout(500)
    assert.equal(await viewEval('document.title'), 'AnimeOn fixture')
    const compatibility = await viewEval(`(async () => {
      const host = window.__animeon
      return {
        tabs: await host.getTabsCount(),
        saved: await host.storeSet('auditExtension.mode', 'local'),
        read: await host.storeGet('auditExtension.mode'),
        profileListHidden: (await host.storeGet('accounts[0]')) === undefined,
        detectorProtected: (await host.storeSet('detector[0]', true)) === false,
        followbackProtected: (await host.storeSet('followBackEnabled', true)) === false
      }
    })()`)
    assert.deepEqual(compatibility, { tabs: 1, saved: true, read: 'local', profileListHidden: true, detectorProtected: true, followbackProtected: true })
    const foreign = await instance.evaluate(async ({BrowserWindow}) => {
      const appWindow = BrowserWindow.getAllWindows()[0]
      const site = appWindow.getBrowserViews()[0].webContents
      const original = site.getURL()
      await site.loadURL('https://untrusted.invalid/')
      try {
        return await site.executeJavaScript(`(async () => {
          const host = window.__animeon
          return (await host.getTabsCount()) === undefined
            && (await host.storeGet('auditExtension.mode')) === undefined
            && (await host.storeSet('auditExtension.mode', 'untrusted')) === undefined
        })()`)
      } finally {
        await site.loadURL(original)
      }
    })
    assert.equal(foreign, true)
    assert.equal(await invoke('storeGet', 'auditExtension.mode'), 'local')
    const isolated = await instance.evaluate(async ({BrowserWindow}) => {
      const appWindow = BrowserWindow.getAllWindows()[0]
      const path = process.getBuiltinModule('node:path')
      const popup = new BrowserWindow({
        show: false,
        webPreferences: { preload: path.resolve('dist/preload/bridge.js'), sandbox: true, contextIsolation: true }
      })
      try {
        await popup.loadURL('https://v2.animeon.co/foreign-window')
        const blocked = await popup.webContents.executeJavaScript(`(async () => {
          const api = window.api
          const rejected = (await api.storeGetAll()) === undefined
            && (await api.tabsCreate('https://v2.animeon.co/')) === undefined
          api.winClose()
          return rejected
        })()`)
        await new Promise(resolve => setTimeout(resolve, 50))
        return blocked && !appWindow.isDestroyed()
      } finally { popup.destroy() }
    })
    assert.equal(isolated, true)
    const tab = await invoke('tabsCreate', 'https://v2.animeon.co/test')
    await page.waitForTimeout(300)
    await invoke('tabsToggleMuted', tab.id)
    assert.ok(await instance.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].getBrowserViews().some(v => v.webContents.isAudioMuted())))
    const script = await invoke('utilitiesImport', 0, 'fixture.js', 'window.__ticks=0; const timer=setInterval(()=>window.__ticks++,20); module.exports.stop=()=>{clearInterval(timer);window.__stopped=true}')
    assert.ok(script.ok)
    assert.ok((await invoke('utilitiesToggle', script.item.id)).ok)
    await page.waitForTimeout(100)
    assert.ok(await viewEval('window.__ticks > 0'))
    await invoke('utilitiesToggle', script.item.id)
    assert.equal(await viewEval('window.__stopped'), true)
    const ticks = await viewEval('window.__ticks')
    await page.waitForTimeout(100)
    assert.equal(await viewEval('window.__ticks'), ticks)
    const slow = await invoke('utilitiesImport', 1, 'slow.js', `
      window.__slowStarts = (window.__slowStarts || 0) + 1
      module.exports.stop = () => { window.__slowStops = (window.__slowStops || 0) + 1 }
      return new Promise(resolve => { window.__finishSlow = resolve })
    `)
    assert.ok(slow.ok)
    const starting = invoke('utilitiesToggle', slow.item.id)
    await instance.evaluate(async ({BrowserWindow}) => {
      for (const view of BrowserWindow.getAllWindows()[0].getBrowserViews()) {
        const ready = await view.webContents.executeJavaScript(`(async () => {
          for (let attempt = 0; attempt < 100; attempt++) {
            if (window.__finishSlow) return true
            await new Promise(resolve => setTimeout(resolve, 20))
          }
          return false
        })()`)
        if (!ready) throw new Error('Delayed script never started')
        // Simulate the load event racing with a manual start in the same document.
        view.webContents.emit('did-finish-load')
      }
    })
    const removing = invoke('utilitiesRemove', slow.item.id)
    await page.waitForFunction(async id => !(await window.api.utilitiesList()).some(item => item.id === id), slow.item.id)
    const replacement = await invoke('utilitiesImport', 1, 'replacement.js', 'window.__replacement = (window.__replacement || 0) + 1')
    assert.ok(replacement.ok)
    await instance.evaluate(async ({BrowserWindow}) => {
      await Promise.all(BrowserWindow.getAllWindows()[0].getBrowserViews()
        .map(view => view.webContents.executeJavaScript('window.__finishSlow()')))
    })
    assert.equal((await removing).ok, true)
    assert.equal((await starting).active, false)
    assert.equal(await viewEval('window.__slowStarts'), 1)
    assert.equal(await viewEval('window.__slowStops'), 1)
    assert.ok((await invoke('utilitiesList')).some(item => item.id === replacement.item.id))
    assert.equal(await viewEval("window.__animeon.storeGet('customUtilities')"), undefined)
    assert.equal(await viewEval("window.__animeon.storeGet('customUtilities[1].source')"), undefined)
    assert.equal((await invoke('utilitiesToggle', replacement.item.id)).active, true)
    assert.equal((await invoke('utilitiesToggle', replacement.item.id)).reloadRequired, true)
    assert.equal((await invoke('utilitiesToggle', replacement.item.id)).active, true)
    assert.equal(await viewEval('window.__replacement'), 1)
    assert.equal((await invoke('utilitiesToggle', replacement.item.id)).active, false)
    const hanging = await invoke('utilitiesImport', 2, 'hanging.js', 'return new Promise(() => {})')
    assert.equal((await invoke('utilitiesToggle', hanging.item.id)).active, true)
    assert.equal((await invoke('utilitiesToggle', hanging.item.id)).reloadRequired, true)
    await instance.evaluate(async ({session}) => {
      await session.fromPartition('persist:animeon-acc-1').cookies.set({url:'https://v2.animeon.co', name:'fixture',value:'profile1',expirationDate:Date.now()/1000+3600})
      await session.fromPartition('persist:animeon-acc-1').cookies.flushStore()
    })
    const profile = await invoke('accountsAdd'); assert.equal(profile.id, '2')
    await invoke('accountsSelect', '2')
    assert.equal(await instance.evaluate(async ({session}) => (await session.fromPartition('persist:animeon-acc-2').cookies.get({name:'fixture'})).length), 0)
    await invoke('accountsSelect', '1')
    assert.equal(await instance.evaluate(async ({session}) => (await session.fromPartition('persist:animeon-acc-1').cookies.get({name:'fixture'}))[0].value), 'profile1')
    await invoke('tabsTogglePinned', tab.id)
    assert.equal(await invoke('tabsClose', tab.id), false)
    // Video element plays an actual MediaStream while its tab is in background.
    await viewEval(`(()=>{const c=document.createElement('canvas');c.width=64;c.height=64;const v=document.createElement('video');v.muted=true;v.srcObject=c.captureStream(10);document.body.append(v);window.__video=v;setInterval(()=>c.getContext('2d').fillRect(0,0,64,64),100);return v.play().then(()=>true)})()`)
    await page.waitForTimeout(300)
    assert.ok(await viewEval('!window.__video.paused && window.__video.readyState >= 2'))
    await page.getByRole('button', {name:'Секреты',exact:true}).click()
    await page.getByRole('heading', {name:'Секреты',exact:true}).waitFor()
    await page.waitForFunction(()=>document.querySelector('.signal-kicker')?.textContent.includes('%'))
    assert.equal(await page.getByRole('heading', {name:'Ушёл за чаем',exact:true}).count(),1)
    assert.equal(await page.getByText('Отошел за чаем',{exact:true}).count(),0)
    await page.getByRole('button',{name:'Инструкция: Ушёл за чаем'}).click()
    assert.equal(await page.getByRole('dialog').getByText('Чай остыл.',{exact:true}).count(),1)
    assert.match(await page.getByRole('dialog').innerText(), /на один час или дольше/)
    await page.getByRole('button',{name:'Понятно'}).click()
    for (const name of ['Za Warudo','Теневое клонирование','Слоу-мо','Возвращение смертью']) {
      assert.equal(await page.getByRole('heading',{name,exact:true}).count(),1)
      await page.getByRole('button',{name:'Инструкция: '+name}).click()
      if(name==='Возвращение смертью') assert.match(await page.getByRole('dialog').innerText(), /минимум семь раз/)
      await page.getByRole('button',{name:'Понятно'}).click()
    }
    await invoke('viewSet','site')
    const disposable = await invoke('tabsCreate', 'https://v2.animeon.co/close-during-mirror-change')
    await instance.evaluate(({session}) => {
      const cookies = session.fromPartition('persist:animeon-acc-1').cookies
      const getCookies = cookies.get
      cookies.get = async (...args) => {
        cookies.get = getCookies
        await new Promise(resolve => { globalThis.finishMirrorCopy = resolve })
        return getCookies.apply(cookies, args)
      }
    })
    const mirrorChange = invoke('siteSetBaseUrl', 'https://v1.animeon.co')
    try {
      await instance.evaluate(async () => {
        for (let attempt = 0; attempt < 100; attempt++) {
          if (globalThis.finishMirrorCopy) return
          await new Promise(resolve => setTimeout(resolve, 20))
        }
        throw new Error('Mirror change never started copying cookies')
      })
      assert.equal(await invoke('accountsSelect', '2'), false)
      assert.equal(await invoke('tabsClose', disposable.id), true)
      assert.equal(await invoke('tabsToggleMuted', tab.id), false)
    } finally {
      await instance.evaluate(() => globalThis.finishMirrorCopy?.())
    }
    assert.equal(await mirrorChange, true)
    const switchedTabs = await invoke('storeGet', 'tabs')
    assert.ok(switchedTabs.every(item => new URL(item.url).host === 'v1.animeon.co'))
    assert.equal(switchedTabs.some(item => item.id === disposable.id), false)
    assert.equal(switchedTabs.find(item => item.id === tab.id).muted, false)
    assert.equal(await invoke('siteSetBaseUrl', 'https://v2.animeon.co'), true)

    const persistedOrder = await checkTabReordering(page, invoke, tab.id)
    const metrics = await instance.evaluate(({app,webContents}) => ({versions:process.versions,webContents:webContents.getAllWebContents().length,processes:app.getAppMetrics().length}))
    await instance.close(); instance=null
    launched=await launch();instance=launched.instance;page=launched.page
    await page.waitForTimeout(300)
    assert.equal(await instance.evaluate(async ({session}) => (await session.fromPartition('persist:animeon-acc-1').cookies.get({name:'fixture'}))[0].value), 'profile1')
    assert.equal(await instance.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].getBrowserViews().length),1)
    assert.deepEqual(await invoke('storeGet', 'tabOrder'), persistedOrder)
    assert.equal((await invoke('storeGet', 'tabs')).length, 2)
    console.log('PASS: real Electron, sender-restricted IPC, preserved script storage, drag protection and persisted pinned order, isolated profiles, mirror change, script lifecycle, background video, lazy restore.', JSON.stringify(metrics))
  } finally { if(instance) await instance.close(); console.log('Isolated test data:',data) }
}
run().catch(error=>{console.error(error);process.exitCode=1})
