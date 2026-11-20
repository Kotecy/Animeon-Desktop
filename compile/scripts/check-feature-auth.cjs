const fs=require('node:fs'), vm=require('node:vm'), ts=require('typescript'), assert=require('node:assert/strict')
const src=fs.readFileSync('src/main/index.ts','utf8')
const helpers=src.slice(src.indexOf('let authCache:'),src.indexOf('async function startUtilityInTab'))
const detector=src.slice(src.indexOf("  ipcMain.handle('detector:toggle'"),src.indexOf("  ipcMain.handle('detector:sound'"))
const collect=src.slice(src.indexOf("  ipcMain.handle('detector:collect'"),src.indexOf('  const collectAttempts'))
const follow=src.slice(src.indexOf("  ipcMain.handle('followback:toggle'"),src.indexOf('  // Детектор сообщает'))
function fixture() {
  const data={activeAccountId:'1',accounts:[{id:'1',nickname:'stale'}],detector:{watching:false,autoCollect:false},followBackEnabled:false}, handlers={},events=[]
  let loggedIn=false, gate=null, calls=0
  const view={__accountId:'1',webContents:{isDestroyed:()=>false,getURL:()=> 'https://v2.animeon.co/',executeJavaScript:async()=>{}}}
  const ctx=vm.createContext({Date,Map,Promise,utilityEpoch:0,collectionEpoch:0,profileSwitchBusy:false,AUTO_COLLECT_AVAILABLE:true,
    views:new Map([['1',view]]),normalizeAnimeonUrl:url=>url,
    store:{get:k=>data[k],set:(k,v)=>data[k]=v},mainWindow:{webContents:{send:(...args)=>events.push(args)}},
    cancelCollections:()=>{ctx.collectionEpoch++},getActiveNickname:async()=>{calls++;if(gate)await gate;return {nickname:loggedIn?'owner':''}},
    ipcMain:{handle:(name,fn)=>handlers[name]=fn}})
  vm.runInContext(ts.transpile(helpers+detector+collect+follow,{target:ts.ScriptTarget.ES2022}),ctx)
  return {data,handlers,ctx,events,login:v=>loggedIn=v,gate:p=>gate=p,calls:()=>calls}
}
async function run(){
  let f=fixture()
  assert.equal((await f.handlers['detector:toggle'](null,true)).watching,false,'Saved nickname does not authorize')
  assert.equal(await f.handlers['followback:toggle'](),false)
  assert.equal((await f.handlers['detector:collect']()).autoCollect,false)
  f.login(true)
  assert.equal((await f.handlers['detector:toggle'](null,true)).watching,true)
  assert.equal(await f.handlers['followback:toggle'](),true)
  assert.equal((await f.handlers['detector:collect']()).autoCollect,true)
  f.login(false)
  await vm.runInContext('getFeatureAuth(true)',f.ctx)
  assert.equal(f.data.detector.watching,false);assert.equal(f.data.detector.autoCollect,false);assert.equal(f.data.followBackEnabled,false)
  f=fixture();f.login(true);let release;f.gate(new Promise(r=>release=r))
  const pending=f.handlers['detector:toggle'](null,true); f.ctx.utilityEpoch++;f.data.activeAccountId='2';release()
  assert.equal((await pending).watching,false,'Cannot enable after profile changed during auth check')
  f=fixture();f.login(true);f.gate(new Promise(r=>release=r))
  const a=vm.runInContext('getFeatureAuth()',f.ctx), b=vm.runInContext('getFeatureAuth()',f.ctx)
  assert.equal(f.calls(),1,'Concurrent auth queries share one API request');release();await Promise.all([a,b])
  console.log('PASS: logged-out gating, stale nickname ignored, authenticated enable, logout stops detector/collector/follow, profile race and request deduplication; no network.')
}
run().catch(e=>{console.error(e);process.exitCode=1})
