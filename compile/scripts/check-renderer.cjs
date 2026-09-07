const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const esbuild = require('esbuild')

async function main() {
  const root = path.resolve(__dirname, '..')
  const result = await esbuild.build({
    stdin: { contents: `import React from 'react'; import { renderToString } from 'react-dom/server';
      import App from './src/renderer/App.jsx'; import Settings from './src/renderer/pages/Settings.jsx';
      import Dashboard from './src/renderer/pages/Dashboard.jsx'; import Secrets from './src/renderer/pages/Secrets.jsx';
      import TabStrip from './src/renderer/components/TabStrip.jsx';
      export const soundTabs = renderToString(<TabStrip tabs={[{id:'sound',title:'Playing',audible:true},{id:'muted',title:'Muted',muted:true},{id:'quiet',title:'Quiet'}]} order={['sound','muted','quiet']} />);
      export const pages = {app: renderToString(<App />), settings: renderToString(<Settings baseUrl="https://v2.animeon.co" />), dashboard: renderToString(<Dashboard />), secrets: renderToString(<Secrets />)};`,
      resolveDir: root, loader: 'jsx' },
    bundle: true, platform: 'node', format: 'cjs', write: false,
    external: ['react', 'react-dom/server'], loader: { '.png': 'dataurl', '.mp3': 'dataurl' },
    logLevel: 'silent'
  })
  const compiled = new Module(path.join(root, 'renderer-smoke.cjs'), module)
  compiled.filename = path.join(root, 'renderer-smoke.cjs')
  compiled.paths = Module._nodeModulePaths(root)
  compiled._compile(result.outputFiles[0].text, compiled.filename)
  const { pages } = compiled.exports
  assert.match(compiled.exports.soundTabs, /Отключить звук вкладки/)
  assert.match(compiled.exports.soundTabs, /Включить звук вкладки/)
  assert.equal((compiled.exports.soundTabs.match(/class="tab-audio"/g) || []).length, 3)
  assert.doesNotMatch(compiled.exports.soundTabs, /domain-dot/)
  assert.match(pages.app, /МСК/)
  assert.match(pages.settings, /Настройки/)
  assert.match(pages.settings, /Добавить профиль/)
  assert.match(pages.dashboard, /Дополнительные функции/)
  const dashboardSource = fs.readFileSync(path.join(root, 'src/renderer/pages/Dashboard.jsx'), 'utf8')
  assert.match(dashboardSource, /XP Монитор/)
  assert.equal((dashboardSource.match(/Coming Soon/g) || []).length, 3)
  assert.equal((pages.dashboard.match(/Coming Soon/g) || []).length, 0, 'Tools start collapsed')
  assert.match(pages.secrets, /Нажми на/)
  assert.match(pages.secrets, /не синхронизировано/)
  const mainSource = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf8')
  const bridge = fs.readFileSync(path.join(root, 'src/preload/bridge.ts'), 'utf8')
  assert.doesNotMatch(mainSource + bridge, /nya-logger|morse-decoder|utilitiesRunMorse|__NYA_LOGGER__/)
  assert.match(mainSource, /'AnimeonDesktop'/)
  assert.match(mainSource, /autoUpdater\.autoDownload = false/)
  assert.match(mainSource, /remaining_today >= 0/)
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version, '0.4.0')
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'))).version, '0.4.0')
  console.log('PASS: four React screens render; release data path, version, remaining=0 and removed utilities verified.')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
