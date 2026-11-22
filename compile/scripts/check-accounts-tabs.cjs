const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict')
const source=fs.readFileSync('src/main/index.ts','utf8')
let writes=0
const data={accounts:[{id:'1',nickname:'kept',createdAt:1}],activeAccountId:'1'}
const ctx=vm.createContext({store:{get:k=>structuredClone(data[k]),set:(k,v)=>{writes++;data[k]=v}},Date,JSON})
vm.runInContext(ts.transpile(source.slice(source.indexOf('function normalizeAccounts()'),source.indexOf('\nnormalizeAccounts()')), {target:ts.ScriptTarget.ES2022}),ctx)
for(let n=0;n<100;n++)ctx.normalizeAccounts()
assert.equal(writes,0,'Reading valid accounts must not write settings')
assert.equal(data.accounts[0].nickname,'kept')
data.accounts.push({...data.accounts[0]});ctx.normalizeAccounts();assert.equal(writes,1);assert.equal(data.accounts.length,1)
let cancelled=0,closed=0
const views=new Map([['tab',{webContents:{isDestroyed:()=>false,close:()=>closed++}}]])
const timers=new Map([['tab',123]])
const life=vm.createContext({views,fullscreenTabId:null,audibleReleaseTimers:timers,clearTimeout:()=>cancelled++,stopUtilitiesForTab:()=>{},mainWindow:{removeBrowserView:()=>{throw Error('window already closed')}}})
vm.runInContext(ts.transpile(source.slice(source.indexOf('function destroyView('),source.indexOf('// Applies the profile'))),life)
life.destroyView('tab');life.destroyView('tab')
assert.equal(cancelled,1);assert.equal(closed,1);assert.equal(views.size,0);assert.equal(timers.size,0)
console.log('PASS: 100 account reads without writes, duplicate repair preserves nickname; idempotent tab cleanup closes contents even if detach fails.')
