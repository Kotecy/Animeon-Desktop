const {_electron:electron}=require('playwright')
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict')
process.chdir(path.resolve(__dirname,'..'))
;(async()=>{
const env={...process.env,ANIMEON_TEST_USER_DATA:fs.mkdtempSync(path.join(os.tmpdir(),'animeon-packaged-'))};delete env.ELECTRON_RUN_AS_NODE
const a=await electron.launch({executablePath:path.resolve('release/win-unpacked/AnimeOn Desktop.exe'),args:[],env,timeout:30000})
try {
const page=await a.firstWindow();await page.waitForFunction(()=>window.api)
assert.equal(await page.evaluate(()=>window.api.appVersion()),require('../package.json').version)
assert.equal(await a.evaluate(({app})=>app.getPath('userData')),env.ANIMEON_TEST_USER_DATA)
assert.equal(await a.evaluate(({app})=>app.isPackaged),true)
await page.getByRole('button',{name:'Секреты',exact:true}).click()
await page.getByRole('heading',{name:'Ушёл за чаем',exact:true}).waitFor()
await page.screenshot({path:'ui-check/packaged.png'})
console.log('PASS: packaged application opens, current package version, isolated data directory, React screens and catalog. Real site login not automated.')
}finally{await a.close()}
})().catch(e=>{console.error(e);process.exitCode=1})
