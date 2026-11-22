// Список секреток из secrets.json на GitHub (0.5.3; иконки, награды и слияние по датам — 0.5.4).
// Настоящий Electron, заглушка GitHub API, временный userData, без сети.
// Запуск из compile после build:main и build:renderer: node scripts/check-secrets-catalog.cjs
const { _electron: electron } = require('playwright')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
process.chdir(root)
const catalog = require(path.join(root, 'dist/shared/secretsCatalog.js'))
const bundled = JSON.parse(fs.readFileSync(path.join(root, 'src/shared/secrets.json'), 'utf8'))
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'animeon-secrets-'))
const remoteFile = path.join(work, 'secrets.json')
const step = name => console.log('step:', name)

function writeRemote(extraDesc) {
  const data = JSON.parse(JSON.stringify(bundled))
  data.secrets.push(
    { name: 'Тестовая секретка', desc: extraDesc, steps: '1. Тестовый шаг.' },
    // Мусор из сети должен отсеиваться
    { name: 'Чужой владелец', desc: 'x', category: 'impossible', holder: '../../evil' },
    { name: '', desc: 'без названия' },
    { code: 'BAD CODE!', name: 'Плохой код', desc: 'код отброшен', onclick: 'alert(1)' }
  )
  data.hidden.push('secret_iddqd')
  fs.writeFileSync(remoteFile, JSON.stringify(data))
}

function checkSanitizer() {
  assert.equal(catalog.sanitizeSecretsCatalog(null), null)
  assert.equal(catalog.sanitizeSecretsCatalog({ schema: 2, secrets: [{ name: 'x' }] }), null)
  assert.equal(catalog.sanitizeSecretsCatalog({ schema: 1, secrets: [] }), null)
  const clean = catalog.sanitizeSecretsCatalog(JSON.parse(fs.readFileSync(remoteFile, 'utf8')))
  const names = clean.secrets.map(item => item.name)
  assert.ok(names.includes('Тестовая секретка'))
  assert.ok(!names.includes('Чужой владелец'), 'недостижимые секретки отброшены')
  const bad = clean.secrets.find(item => item.name === 'Плохой код')
  assert.equal(bad.code, null)
  assert.equal('onclick' in bad, false)
  assert.equal(catalog.sanitizeSecretsCatalog(bundled).secrets.length, bundled.secrets.length, 'встроенный список проходит проверку целиком')
  // У каждой встроенной секретки — код сайта, иконка и награда; иконка есть в приложении
  const icons = JSON.parse(fs.readFileSync(path.join(root, 'src/shared/secretIcons.json'), 'utf8')).icons
  for (const item of catalog.sanitizeSecretsCatalog(bundled).secrets) {
    // Без кода — только секретки «условия уточняются», которых ещё нет у владельца
    if (!item.code) { assert.equal(item.unconfirmed, true, item.name + ': нет кода'); continue }
    assert.match(item.code, /^secret_[a-z0-9_]+$/, item.name + ': плохой код')
    assert.ok(item.icon && icons[item.icon], item.name + ': нет иконки')
    assert.ok(Number.isInteger(item.trophies) && Number.isInteger(item.animon), item.name + ': нет награды')
  }
  const fields = catalog.sanitizeSecretsCatalog({ schema: 1, secrets: [
    { code: 'secret_a', name: 'A', icon: 'gi:cat', trophies: 300, animon: 500, unconfirmed: true },
    { code: 'secret_b', name: 'B', icon: 'javascript:alert(1)', trophies: -5, animon: 1.5 },
    { code: 'secret_c', name: 'C', category: 'impossible', holder: 'kattwod' }
  ] }).secrets
  assert.deepEqual([fields[0].icon, fields[0].trophies, fields[0].animon, fields[0].unconfirmed], ['gi:cat', 300, 500, true])
  assert.deepEqual([fields[1].icon, fields[1].trophies, fields[1].animon], [undefined, undefined, undefined])
  assert.equal(fields.length, 2, 'недостижимая секретка с владельцем тоже отброшена')
  assert.equal(catalog.extractSecretIconPath('<path fill="currentColor" d="M0 0h10v10z"/>'), 'M0 0h10v10z')
  assert.equal(catalog.extractSecretIconPath('<path fill="currentColor" d="M0 0"/><script>alert(1)</script>'), '')
  assert.equal(catalog.extractSecretIconPath('<path fill="currentColor" d="M0 0" onload="x"/>'), '')
  // Старый файл на GitHub (раньше встроенного) не затирает коды, иконки и награды и не скрывает секретки
  const base = { schema: 1, updated: '2026-11-21', hidden: [], secrets: [{ key: 'secret_x', code: 'secret_x', name: 'Икс', desc: 'новый текст', icon: 'gi:cat', trophies: 300 }] }
  const old = { schema: 1, updated: '2026-11-20', hidden: ['secret_x'], secrets: [{ key: 'old_x', code: null, name: 'Икс', desc: 'старый текст' }, { key: 'old_y', code: null, name: 'Игрек', desc: 'новая из старого' }] }
  const mergedOld = catalog.mergeSecretsCatalogs(base, old)
  assert.deepEqual([mergedOld.secrets[0].code, mergedOld.secrets[0].desc, mergedOld.secrets[0].icon, mergedOld.hidden.length], ['secret_x', 'новый текст', 'gi:cat', 0])
  assert.equal(mergedOld.secrets[1].name, 'Игрек', 'новые записи старого файла добавляются')
  const newer = { ...old, updated: '2026-12-01', hidden: [] }
  const mergedNew = catalog.mergeSecretsCatalogs(base, newer)
  assert.deepEqual([mergedNew.secrets[0].code, mergedNew.secrets[0].desc, mergedNew.secrets[0].icon], ['secret_x', 'старый текст', 'gi:cat'], 'новый файл обновляет текст, код/иконка/награда не затираются')
  // Снять «условия уточняются» можно правкой файла на GitHub
  const flagged = { ...base, secrets: [{ ...base.secrets[0], unconfirmed: true }] }
  assert.equal(catalog.mergeSecretsCatalogs(flagged, { ...newer, secrets: [{ key: 'x', code: 'secret_x', name: 'Икс', desc: 'проверено' }] }).secrets[0].unconfirmed, undefined)
}

const configFile = dir => {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name)
    if (name === 'config.json') return full
    if (fs.statSync(full).isDirectory()) { const found = configFile(full); if (found) return found }
  }
  return null
}
function expireCache(dir) {
  const file = configFile(dir)
  const config = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.ok(config.secretsRemote, 'список сохранён в настройках')
  config.secretsRemote.checkedAt = 0
  fs.writeFileSync(file, JSON.stringify(config))
}

async function launch(dir, mode = 'ok') {
  const env = { ...process.env, ANIMEON_TEST_USER_DATA: dir, ANIMEON_TEST_SECRETS_FILE: remoteFile, ANIMEON_TEST_SECRETS_MODE: mode }
  delete env.ELECTRON_RUN_AS_NODE
  const instance = await electron.launch({ executablePath: require('electron'), args: ['scripts/electron-fixture.cjs'], env, timeout: 30000 })
  instance.process().stderr.on('data', chunk => { if (/Error|FATAL/.test(String(chunk))) process.stderr.write(chunk) })
  const page = await instance.firstWindow()
  await page.waitForFunction(() => !!window.api)
  const fixture = () => instance.evaluate(() => ({ ...(globalThis.__secretsFixture || { hits: 0, conditional: 0 }) }))
  const setMode = mode => instance.evaluate((_, mode) => { (globalThis.__secretsFixture ||= { hits: 0, conditional: 0 }).mode = mode }, mode)
  return { instance, page, fixture, setMode }
}
async function waitFor(check, message, timeout = 10000) {
  const until = Date.now() + timeout
  while (Date.now() < until) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 150)) }
  throw new Error(message)
}
const heading = (page, name) => page.getByRole('heading', { name, exact: true })
async function openSecrets(page) {
  await page.getByRole('button', { name: 'Секреты', exact: true }).click()
  await heading(page, 'Секреты').waitFor()
}

async function run() {
  writeRemote('Первая версия описания')
  checkSanitizer()
  const dataA = path.join(work, 'a')
  let app
  try {
    step('startup fetch')
    app = await launch(dataA)
    await waitFor(async () => (await app.fixture()).hits >= 1, 'при запуске список не запрошен')
    await openSecrets(app.page)
    await heading(app.page, 'Тестовая секретка').waitFor()
    assert.equal(await app.page.getByText('Первая версия описания', { exact: true }).count(), 1)
    assert.equal(await heading(app.page, 'IDDQD').count(), 0, 'скрытая в secrets.json секретка не показывается')
    assert.equal(await heading(app.page, 'Ушёл за чаем').count(), 1, 'встроенные секретки на месте')
    assert.equal(await heading(app.page, 'Плохой код').count(), 1)
    assert.equal(await heading(app.page, 'Чужой владелец').count(), 0)
    await app.page.getByRole('button', { name: 'Как получить: Тестовая секретка' }).click()
    assert.match(await app.page.getByRole('dialog').innerText(), /Тестовый шаг/)
    await app.page.getByRole('dialog').getByRole('button', { name: 'Закрыть', exact: true }).click()

    step('manual sync picks up a change')
    writeRemote('Вторая версия описания')
    await new Promise(resolve => setTimeout(resolve, 31000)) // кнопка не чаще раза в 30 с
    const before = (await app.fixture()).hits
    await app.page.getByRole('button', { name: 'Синхронизировать' }).click()
    await app.page.getByText('Вторая версия описания', { exact: true }).waitFor({ timeout: 10000 })
    assert.equal((await app.fixture()).hits, before + 1)

    step('button throttled')
    await app.page.getByRole('button', { name: 'Синхронизировать' }).click()
    await app.page.waitForTimeout(1500)
    assert.equal((await app.fixture()).hits, before + 1, 'повторное нажатие в течение 30 с не идёт в GitHub')
    await app.instance.close(); app = null

    step('restart within 10 minutes: no request, cached list')
    app = await launch(dataA)
    await openSecrets(app.page)
    await app.page.getByText('Вторая версия описания', { exact: true }).waitFor()
    await app.page.waitForTimeout(1500)
    assert.equal((await app.fixture()).hits, 0)
    await app.instance.close(); app = null

    step('expired cache: conditional request, 304')
    expireCache(dataA)
    app = await launch(dataA)
    await waitFor(async () => (await app.fixture()).conditional === 1, 'не было условного запроса с ETag')
    await openSecrets(app.page)
    await heading(app.page, 'Тестовая секретка').waitFor()
    await app.instance.close(); app = null

    step('GitHub error: cached list stays')
    expireCache(dataA)
    app = await launch(dataA, 'fail')
    await waitFor(async () => (await app.fixture()).hits >= 1, 'запрос не выполнен')
    await openSecrets(app.page)
    await heading(app.page, 'Тестовая секретка').waitFor()
    await app.instance.close(); app = null

    step('first launch offline: bundled list')
    app = await launch(path.join(work, 'b'), 'fail')
    await openSecrets(app.page)
    await heading(app.page, 'Ушёл за чаем').waitFor()
    await heading(app.page, 'Пятница, 13-е').waitFor()
    assert.equal(await heading(app.page, 'IDDQD').count(), 1)
    assert.equal(await heading(app.page, 'Тестовая секретка').count(), 0)
    await app.instance.close(); app = null

    console.log('PASS: secrets catalog — startup fetch, manual sync, 30 s button limit, 10 min startup cache, ETag 304, error fallback to cache, offline bundled list, sanitizer, icons/rewards, date-aware merge.')
  } finally {
    if (app) await app.instance.close().catch(() => {})
    fs.rmSync(work, { recursive: true, force: true })
  }
}
run().catch(error => { console.error(error); process.exitCode = 1 })
