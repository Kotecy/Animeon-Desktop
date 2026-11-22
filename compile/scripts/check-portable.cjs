const {chromium}=require('playwright')
const {execFileSync,spawn}=require('node:child_process')
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net'),assert=require('node:assert/strict')
process.chdir(path.resolve(__dirname,'..'))
;(async()=>{
const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r))
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'animeon-portable-'))
const data = path.join(testRoot, 'profile')
const downloads = path.join(testRoot, 'Загрузки')
const download = path.join(downloads, 'AnimeOn Desktop test.exe')
const desktop = path.join(testRoot, 'Рабочий стол')
const shortcut = path.join(desktop, 'AnimeOn Desktop.lnk')
const target = path.join(data, 'launcher', 'AnimeOn Desktop.exe')
fs.mkdirSync(downloads)
fs.mkdirSync(desktop)
fs.copyFileSync(path.resolve('release/AnimeOn Desktop.exe'), download)
const env = { ...process.env, ANIMEON_TEST_USER_DATA: data, ANIMEON_TEST_DESKTOP: desktop }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(download, [`--remote-debugging-port=${port}`], { env, windowsHide: true, stdio: 'ignore' })
let browser
try{
const deadline=Date.now()+60000
while (fs.existsSync(download) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100))
assert.ok(!fs.existsSync(download), 'Downloaded executable should be replaced by the shortcut')
assert.ok(fs.existsSync(target), 'Relocated executable is missing')
while(Date.now()<deadline){try{browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);break}catch{await new Promise(r=>setTimeout(r,300))}}
assert.ok(browser,'Portable launcher must start browser')
const readShortcut = '[Console]::OutputEncoding = [Text.Encoding]::UTF8; [Console]::Write((New-Object -ComObject WScript.Shell).CreateShortcut($env:ANIMEON_TEST_SHORTCUT).TargetPath)'
const shortcutTarget = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', readShortcut], {
  env: { ...env, ANIMEON_TEST_SHORTCUT: shortcut },
  encoding: 'utf8',
  windowsHide: true,
})
assert.equal(shortcutTarget.toLowerCase(), target.toLowerCase())
assert.deepEqual(fs.readdirSync(downloads).filter(name => name.toLowerCase().endsWith('.lnk')), [], 'Shortcut belongs on the desktop, not next to the download')
const pages=browser.contexts()[0].pages();const page=pages.find(p=>p.url().startsWith('file:'));assert.ok(page)
await page.waitForFunction(()=>window.api)
assert.equal(await page.evaluate(()=>window.api.appVersion()),require('../package.json').version)
await page.getByRole('button',{name:'Секреты',exact:true}).click()
for(const name of ['Za Warudo','Теневое клонирование','Слоу-мо','Возвращение смертью','Ушёл за чаем']) assert.equal(await page.getByRole('heading',{name,exact:true}).count(),1)
const pinnedId = await page.evaluate(async () => {
  const tab = await window.api.tabsCreate()
  await window.api.tabsTogglePinned(tab.id)
  return tab.id
})
await page.waitForFunction(id => {
  const [first, second] = document.querySelectorAll('.signal-tablist [data-tab-id]')
  return first?.dataset.tabId === id && first.classList.contains('pinned')
    && second && !second.classList.contains('pinned')
    && getComputedStyle(second, '::before').backgroundImage.includes('linear-gradient')
}, pinnedId)
if (process.env.ANIMEON_TEST_TAB_PREVIEW) {
  await page.locator('.signal-tablist').screenshot({ path: process.env.ANIMEON_TEST_TAB_PREVIEW, animations: 'disabled' })
}
await page.evaluate(()=>window.api.winClose())
await browser.close(); browser = null
await new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve))
await new Promise(resolve => setTimeout(resolve, 4000)) // launcher освобождает EXE

// Повторный запуск новой версии из «Загрузок» с другим именем файла и лишним старым ярлыком
// рядом с ним: новый ярлык не создаётся, лишний убирается, остаётся один — на рабочем столе.
const second = path.join(downloads, 'AnimeOn.Desktop (1).exe')
fs.copyFileSync(path.resolve('release/AnimeOn Desktop.exe'), second)
const makeShortcut = '$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:ANIMEON_TEST_SHORTCUT); $s.TargetPath=$env:ANIMEON_TEST_TARGET; $s.Save()'
execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', makeShortcut], { env: { ...env, ANIMEON_TEST_SHORTCUT: path.join(downloads, 'AnimeOn Desktop old.lnk'), ANIMEON_TEST_TARGET: target }, windowsHide: true })
const s2 = net.createServer(); await new Promise(r => s2.listen(0, '127.0.0.1', r)); const port2 = s2.address().port; await new Promise(r => s2.close(r))
const child2 = spawn(second, [`--remote-debugging-port=${port2}`], { env, windowsHide: true, stdio: 'ignore' })
try {
  const deadline2 = Date.now() + 60000
  while (fs.existsSync(second) && Date.now() < deadline2) await new Promise(resolve => setTimeout(resolve, 100))
  assert.ok(!fs.existsSync(second), 'Second download should be removed after relocation')
  let browser2
  while (Date.now() < deadline2) { try { browser2 = await chromium.connectOverCDP(`http://127.0.0.1:${port2}`); break } catch { await new Promise(r => setTimeout(r, 300)) } }
  assert.ok(browser2, 'Second launch must start')
  await new Promise(resolve => setTimeout(resolve, 1000))
  const lnk = dir => fs.readdirSync(dir).filter(name => name.toLowerCase().endsWith('.lnk'))
  assert.deepEqual(lnk(desktop), ['AnimeOn Desktop.lnk'], 'Exactly one desktop shortcut must remain: ' + lnk(desktop).join(', '))
  assert.deepEqual(lnk(downloads), [], 'Old shortcut next to the download must be removed: ' + lnk(downloads).join(', '))
  const page2 = browser2.contexts()[0].pages().find(p => p.url().startsWith('file:'))
  if (page2) await page2.evaluate(() => window.api?.winClose()).catch(() => {})
  await browser2.close()
} finally { child2.kill() }
console.log('PASS: portable relocation and shortcut target, app launch, cards, pinned tabs and faded separators; shortcut on the desktop; second launch from downloads with another file name keeps exactly one desktop shortcut, using temporary data:',data)
} finally {
  if (!browser) browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1000 }).catch(() => null)
  if (browser) {
    const page = browser.contexts()[0]?.pages().find(p => p.url().startsWith('file:'))
    if (page) await page.evaluate(() => window.api?.winClose()).catch(() => {})
    await browser.close()
  }
  child.kill()
}
})().catch(e=>{console.error(e);process.exitCode=1})
