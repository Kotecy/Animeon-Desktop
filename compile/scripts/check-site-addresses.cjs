// Адреса сайта 0.5.2 и устойчивость пользовательских функций.
// Настоящий Electron, локальная HTTPS-заглушка, временный userData.
// Запуск из compile после build:main и build:renderer: node scripts/check-site-addresses.cjs
const { _electron: electron } = require('playwright')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
process.chdir(root)
const hosts = require(path.join(root, 'dist/shared/siteHosts.js'))
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'animeon-addresses-'))

function checkWhitelist() {
  const allowed = ['animeon.cc', 'https://animeon.cc/anime/1', 'www.animeon.cc', 'v3.animeon.co', 'animeon.co', 'a-b.v9.animeon.co', 'V4.AnimeOn.CO']
  const denied = ['example.com', 'animeon.co.evil.com', 'evilanimeon.co', 'animeon.cloud', 'http://animeon.cc', 'https://animeon.cc:8443', 'https://user@animeon.cc', '-x.animeon.co', 'x-.animeon.cc', 'animeon.cc.', '', 'javascript:alert(1)']
  for (const value of allowed) assert.ok(hosts.normalizeSiteUrl(value), 'должен проходить: ' + value)
  for (const value of denied) assert.equal(hosts.normalizeSiteUrl(value), null, 'должен отклоняться: ' + value)
  assert.deepEqual(hosts.normalizeSiteAddresses(undefined), ['https://animeon.cc', 'https://v3.animeon.co'])
  assert.deepEqual(hosts.normalizeSiteAddresses(['https://v1.animeon.co', 'https://v2.animeon.co']), ['https://animeon.cc', 'https://v3.animeon.co'])
  assert.deepEqual(hosts.normalizeSiteAddresses(['https://v5.animeon.co', 'https://evil.com']), ['https://v5.animeon.co', 'https://v3.animeon.co'])
  assert.deepEqual(hosts.normalizeSiteAddresses(['https://v3.animeon.co', 'https://v3.animeon.co']), ['https://v3.animeon.co', 'https://animeon.cc'])
}

async function launch() {
  const env = { ...process.env, ANIMEON_TEST_USER_DATA: data }
  delete env.ELECTRON_RUN_AS_NODE
  const instance = await electron.launch({ executablePath: require('electron'), args: ['scripts/electron-fixture.cjs'], env, timeout: 30000 })
  instance.process().stderr.on('data', chunk => { if (/Error|FATAL/.test(String(chunk))) process.stderr.write(chunk) })
  const page = await instance.firstWindow()
  await page.waitForFunction(() => !!window.api)
  const invoke = (channel, ...args) => page.evaluate(({ channel, args }) => window.api[channel](...args), { channel, args })
  return { instance, page, invoke }
}
const cookieValue = (instance, host) => instance.evaluate(async ({ session }, host) => {
  const cookies = await session.fromPartition('persist:animeon-acc-1').cookies.get({ name: 'auth' })
  return cookies.find(cookie => cookie.domain === host)?.value || null
}, host)
const viewFor = (instance, tabUrlPart, expression) => instance.evaluate(async ({ BrowserWindow }, { tabUrlPart, expression }) => {
  const view = BrowserWindow.getAllWindows()[0].getBrowserViews().find(item => item.webContents.getURL().includes(tabUrlPart))
  if (!view || view.webContents.isCrashed() || view.webContents.isLoadingMainFrame() && view.webContents.getURL() === '') return '__missing__'
  return Promise.race([view.webContents.mainFrame.executeJavaScript(expression), new Promise(resolve => setTimeout(() => resolve('__timeout__'), 1500))])
}, { tabUrlPart, expression })
const step = name => console.log('step:', name)
async function waitFor(check, message, timeout = 8000) {
  const until = Date.now() + timeout
  while (Date.now() < until) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)) }
  throw new Error(message)
}

async function run() {
  checkWhitelist()
  let instance
  try {
    step('defaults')
    // 1. Первый запуск: адреса по умолчанию.
    let app = await launch(); instance = app.instance
    let { page, invoke } = app
    let state = await invoke('siteGetAddresses')
    assert.deepEqual(state, { addresses: ['https://animeon.cc', 'https://v3.animeon.co'], baseUrl: 'https://animeon.cc' })
    assert.equal(await invoke('storeSet', 'siteAddresses', ['https://evil.com']), false, 'адреса меняются только выделенной командой')

    step('legacy v2 state')
    // 2. Состояние прежней версии: выбран v2, вход в профиль на v2, закреплённая вкладка на v2.
    assert.equal(await invoke('siteSetBaseUrl', 'https://v2.animeon.co'), true)
    await instance.evaluate(async ({ session }) => {
      const cookies = session.fromPartition('persist:animeon-acc-1').cookies
      await cookies.set({ url: 'https://v2.animeon.co', name: 'auth', value: 'legacy-session', expirationDate: Date.now() / 1000 + 3600 })
      await cookies.flushStore()
    })
    const legacyTab = (await invoke('storeGet', 'tabs'))[0]
    await invoke('tabsTogglePinned', legacyTab.id)
    await instance.close(); instance = null

    step('migration on restart')
    // 3. Перезапуск: v2 переезжает на v3 вместе с входом и вкладками.
    app = await launch(); instance = app.instance; page = app.page; invoke = app.invoke
    state = await invoke('siteGetAddresses')
    assert.equal(state.baseUrl, 'https://v3.animeon.co')
    assert.deepEqual(state.addresses, ['https://animeon.cc', 'https://v3.animeon.co'])
    let tabs = await invoke('storeGet', 'tabs')
    assert.ok(tabs.every(tab => new URL(tab.url).host === 'v3.animeon.co'), 'вкладки переехали на v3')
    assert.equal(await cookieValue(instance, 'v3.animeon.co'), 'legacy-session', 'вход перенесён на v3')

    step('replace selected')
    // 4. Замена выбранного адреса: вход переносится, вкладки переходят.
    for (const bad of ['example.com', 'animeon.co.evil.com', 'http://v4.animeon.co', 'animeon.cc']) {
      assert.equal((await invoke('siteReplaceAddress', 1, bad)).ok, false, 'отклоняется: ' + bad)
    }
    assert.equal((await invoke('siteReplaceAddress', 5, 'v4.animeon.co')).ok, false)
    let replaced = await invoke('siteReplaceAddress', 1, 'v4.animeon.co')
    assert.equal(replaced.ok, true)
    assert.deepEqual(replaced.addresses, ['https://animeon.cc', 'https://v4.animeon.co'])
    assert.equal(replaced.baseUrl, 'https://v4.animeon.co')
    tabs = await invoke('storeGet', 'tabs')
    assert.ok(tabs.every(tab => new URL(tab.url).host === 'v4.animeon.co'))
    assert.equal(await cookieValue(instance, 'v4.animeon.co'), 'legacy-session', 'вход перенесён на новый адрес')

    step('replace other')
    // 5. Замена невыбранного адреса не трогает текущий; переключение на него переносит вход.
    replaced = await invoke('siteReplaceAddress', 0, 'https://www.animeon.cc/some/path')
    assert.deepEqual(replaced.addresses, ['https://www.animeon.cc', 'https://v4.animeon.co'])
    assert.equal(replaced.baseUrl, 'https://v4.animeon.co')
    assert.equal(await invoke('siteSetBaseUrl', 'https://www.animeon.cc'), true)
    assert.equal(await cookieValue(instance, 'www.animeon.cc'), 'legacy-session', 'вход перенесён на домен .cc')
    assert.equal(await invoke('siteSetBaseUrl', 'https://v4.animeon.co'), true)

    step('address bar')
    // 6. Адресная строка: любой поддомен из белого списка, остальное отклоняется.
    const tab = tabs[0]
    assert.equal((await invoke('tabsNavigate', tab.id, 'v9.animeon.cc/anime')).ok, true)
    assert.equal((await invoke('tabsNavigate', tab.id, 'animeon.co/anime')).ok, true)
    for (const bad of ['example.com', 'animeon.co.evil.com', 'http://animeon.cc']) {
      const result = await invoke('tabsNavigate', tab.id, bad)
      assert.equal(result.ok, false, 'адресная строка отклоняет: ' + bad)
      assert.match(result.error, /поддомены/)
    }

    step('settings ui')
    // 7. Интерфейс: два адреса, кнопка и окно замены.
    await page.getByRole('button', { name: 'Настройки', exact: true }).click()
    await page.getByRole('heading', { name: 'Адрес сайта', exact: true }).waitFor()
    assert.equal(await page.getByRole('button', { name: /www\.animeon\.cc/ }).count(), 1)
    assert.equal(await page.getByRole('button', { name: /v4\.animeon\.co/ }).count(), 1)
    await page.getByRole('button', { name: 'Заменить адрес', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Заменить адрес' })
    await dialog.waitFor()
    await dialog.getByRole('radio', { name: /www\.animeon\.cc/ }).click()
    await dialog.getByRole('textbox', { name: 'Новый адрес' }).fill('example.com')
    assert.equal(await dialog.getByRole('button', { name: 'Заменить', exact: true }).isDisabled(), true)
    assert.match(await dialog.getByRole('alert').innerText(), /Разрешены только/)
    await dialog.getByRole('textbox', { name: 'Новый адрес' }).fill('animeon.cc')
    await dialog.getByRole('button', { name: 'Заменить', exact: true }).click()
    await page.getByRole('dialog', { name: 'Заменить адрес' }).waitFor({ state: 'hidden' })
    assert.deepEqual((await invoke('siteGetAddresses')).addresses, ['https://animeon.cc', 'https://v4.animeon.co'])
    assert.equal(await page.getByRole('button', { name: /^animeon\.cc/ }).count(), 1)
    await invoke('viewSet', 'site')

    step('script without load')
    // 8. Функция запускается, даже если страница не доходит до полной загрузки.
    const script = await invoke('utilitiesImport', 0, 'counter.js', 'window.__starts = (window.__starts || 0) + 1; const t = setInterval(() => { window.__ticks = (window.__ticks || 0) + 1 }, 50); module.exports.stop = () => clearInterval(t)')
    assert.equal((await invoke('utilitiesToggle', script.item.id)).active, true)
    assert.equal((await invoke('tabsNavigate', tab.id, 'https://v4.animeon.co/slow-page')).ok, true)
    await waitFor(async () => (await viewFor(instance, '/slow-page', 'window.__starts || 0')) === 1, 'функция не запустилась на странице без load')
    assert.notEqual(await viewFor(instance, '/slow-page', 'document.readyState'), 'complete', 'страница действительно не загрузилась полностью')
    await new Promise(resolve => setTimeout(resolve, 500))
    assert.equal(await viewFor(instance, '/slow-page', 'window.__starts'), 1, 'один запуск на документ')

    step('crash reload')
    // 9. После падения вкладки она перезагружается сама, функция запускается снова.
    await invoke('tabsNavigate', tab.id, 'https://v4.animeon.co/crash-test')
    await waitFor(async () => (await viewFor(instance, '/crash-test', 'window.__starts || 0')) === 1, 'функция не запустилась после навигации')
    await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBrowserViews().find(view => view.webContents.getURL().includes('/crash-test')).webContents.forcefullyCrashRenderer())
    await waitFor(async () => {
      try { return (await viewFor(instance, '/crash-test', 'window.__starts || 0')) === 1 && (await viewFor(instance, '/crash-test', 'window.__ticks || 0')) > 0 } catch { return false }
    }, 'вкладка не восстановилась после падения', 15000)
    assert.equal((await invoke('utilitiesList')).find(item => item.id === script.item.id).active, true)

    step('throttling')
    // 10. Фоновая вкладка с работающей функцией не замедляется; без функции — замедляется.
    const other = await invoke('tabsCreate', 'https://v4.animeon.co/other')
    await invoke('tabsSwitch', other.id)
    const throttled = () => instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBrowserViews().find(view => view.webContents.getURL().includes('/crash-test')).webContents.getBackgroundThrottling())
    await waitFor(async () => (await throttled()) === false, 'фоновая вкладка со скриптом замедлена')
    assert.equal((await invoke('utilitiesToggle', script.item.id)).active, false)
    await waitFor(async () => (await throttled()) === true, 'фоновая вкладка без скрипта не замедлена')

    console.log('PASS: whitelist *.animeon.cc/*.animeon.co, v2→v3 migration with session, address replace (selected and not), address bar, settings modal, script start without load event, crash auto-reload with script restart, background throttling only without scripts.')
  } finally {
    if (instance) await instance.close()
    console.log('Isolated test data:', data)
  }
}
run().catch(error => { console.error(error); process.exitCode = 1 })
