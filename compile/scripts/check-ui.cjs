// Optional browser regression test: requires Playwright and a local Chrome installation.
const fs = require('node:fs')
const path = require('node:path')
const esbuild = require('esbuild')
const { chromium } = require('playwright')
const assert = require('node:assert/strict')
const http = require('node:http')
async function run() {
  const root = path.resolve(__dirname, '..')
  const browser = await chromium.launch({ channel: process.env.UI_BROWSER_CHANNEL || 'msedge', headless: true })
  let server
  try {
    const page = await browser.newPage({ viewport: { width: 1260, height: 900 } })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    const css = fs.readFileSync(path.join(root, 'src/renderer/signal.css'), 'utf8')
    for (const publicBuild of [true, false]) {
      const built = await esbuild.build({ stdin: { resolveDir: root, loader: 'jsx', contents: `
        import React from 'react'; import { createRoot } from 'react-dom/client';
        import Dashboard from './src/renderer/pages/Dashboard.jsx';
        import Settings from './src/renderer/pages/Settings.jsx';
        import TabStrip from './src/renderer/components/TabStrip.jsx';
        const subscriptions = {};
        let detector={watching:false,autoCollect:false,sound:true}; let authorized=false;
        window.setAuthorized=value=>{authorized=value;emit('auth',{profileId:'1',authenticated:value})};
        const subscribe=name=>cb=>{(subscriptions[name]??=[]).push(cb); return ()=>{subscriptions[name]=subscriptions[name].filter(x=>x!==cb)}};
        const emit=(name,data)=>subscriptions[name]?.forEach(cb=>cb(data));
        window.api={authState:async()=>({profileId:'1',authenticated:authorized}),onAuthUpdated:subscribe('auth'),storeGetAll:async()=>({detector,accounts:[{id:'1'}],activeAccountId:'1',tabs:[]}),storeGet:async key=>key==='detector'?detector:key==='activeAccountId'?'1':[],
          appVersion:async()=>'0.4.0',accountsList:async()=>[{id:'1'}],anomalyState:async()=>({ok:false,error:'Войдите в аккаунт'}),utilitiesList:async()=>[{id:'xp-checker'}],
          followbackState:async()=>({profileId:'1',enabled:false}),onDetectorUpdated:subscribe('detector'),onUtilitiesUpdated:subscribe('utilities'),
          detectorToggle:async()=>{detector={...detector,watching:!detector.watching,autoCollect:false};emit('detector',detector);return detector},
          detectorCollect:async()=>{detector={...detector,autoCollect:detector.watching&&!detector.autoCollect};emit('detector',detector);return detector}};
        const app=createRoot(document.getElementById('root'));
        window.screen=(name)=>app.render(name==='settings'?<Settings baseUrl="https://v2.animeon.co"/>:name==='tabs'?<TabStrip tabs={[{id:'1',title:'AnimeOn',audible:true,muted:true},{id:'2',title:'Тихая вкладка',muted:true}]} order={['1','2']}/>:<Dashboard/>);
        window.screen('dashboard');` }, bundle: true, write: false, jsx: 'automatic', loader: { '.png': 'dataurl', '.mp3': 'dataurl' },
        plugins: [{ name: 'variant', setup(build) { build.onLoad({ filter: /buildFlags\.ts$/ }, () => ({ contents: `export const AUTO_COLLECT_AVAILABLE = ${!publicBuild}`, loader: 'ts' })) } }] })
      const js = built.outputFiles[0].text
      server = http.createServer((req, res) => {
        if (req.url === '/app.js') { res.setHeader('Content-Type','text/javascript'); res.end(js) }
        else { res.setHeader('Content-Type','text/html; charset=utf-8'); res.end(`<html><head><style>*{box-sizing:border-box}body{margin:0;background:#0b0b10}button{font:inherit;background:none;border:0;color:inherit;cursor:pointer}h1,h2,p{margin:0}${css}</style></head><body><div id="root"></div><script src="/app.js"></script></body></html>`) }
      })
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
      await page.goto('http://127.0.0.1:' + server.address().port)
      await page.getByRole('heading', { name: 'XP Монитор' }).waitFor()
      const detectorButton=page.getByRole('button',{name:'Включить',exact:true})
      const followSwitch=page.getByRole('switch',{name:'Переключить автоподписку',exact:true})
      assert.equal(await detectorButton.isDisabled(),true)
      assert.equal(await followSwitch.isDisabled(),true)
      await page.evaluate(()=>window.setAuthorized(true))
      await page.waitForFunction(()=>!document.querySelector('.signal-detector-actions button').disabled)
      assert.equal(await followSwitch.isDisabled(),false)
      const collect=page.getByRole('switch',{name:'Автоматический сбор',exact:true})
      if(publicBuild) assert.equal(await collect.count(),0)
      else {
        assert.equal(await collect.isDisabled(),true)
        await page.getByRole('button',{name:'Включить',exact:true}).click()
        await collect.click(); assert.equal(await collect.getAttribute('aria-checked'),'true')
        await page.getByRole('button',{name:'Выключить',exact:true}).click()
        assert.equal(await collect.isDisabled(),true);assert.equal(await collect.getAttribute('aria-checked'),'false')
      }
      await page.evaluate(()=>window.setAuthorized(false))
      await page.waitForFunction(()=>document.querySelector('.signal-detector-actions button').disabled)
      assert.equal(await followSwitch.isDisabled(),true)
      await page.getByRole('button',{name:'Дополнительные функции'}).click()
      assert.equal(await page.getByText('Coming Soon',{exact:true}).count(),3)
      fs.mkdirSync(path.join(root,'ui-check'),{recursive:true})
      await page.screenshot({path:path.join(root,'ui-check',publicBuild?'public.png':'dev.png'),fullPage:true})
      await new Promise(resolve => server.close(resolve));server=null
    }
    await page.evaluate(()=>window.screen('settings'))
    await page.getByRole('heading',{name:'Настройки',exact:true}).waitFor()
    await page.keyboard.type('nya');await page.getByText('NYA-D7E6-0187').waitFor()
    assert.equal(await page.getByText('NYA-D7E6-0187').evaluate(el=>getComputedStyle(el).position),'absolute')
    await page.screenshot({path:path.join(root,'ui-check/settings.png'),fullPage:true})
    await page.getByText('NYA-D7E6-0187').waitFor({state:'hidden',timeout:12000})
    await page.evaluate(()=>window.screen('tabs'))
    await page.locator('.tab-audio-slot.visible').waitFor()
    assert.equal(await page.locator('.tab-audio-slot.visible').count(),1)
    assert.deepEqual(errors,[])
    console.log('PASS: Public/DEV layout, disabled collector dependency, XP loading, three placeholders, NYA overlay/expiry, muted playing vs silent tabs; mocked API, no account actions.')
  } finally { if(server) await new Promise(resolve=>server.close(resolve)); await browser.close() }
}
run().catch(error=>{console.error(error);process.exitCode=1})
