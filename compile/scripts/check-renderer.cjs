const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const esbuild = require('esbuild')

// Разметка гайдов: ссылки только на сайт и на выбранный адрес, HTML — текстом
const GUIDE_SAMPLE = '### 1. Код\n1. Откройте https://animeon.cc/roadmap.\n2. Введите `NYA` и **Enter**\n- пункт\n' +
  '> примечание [сайт](https://evil.example/x) <img src=x onerror=alert(1)> [свой](https://animeon.co/tv/link)\n' +
  'https://animeon.cc:8443/x https://user@animeon.cc/y javascript:alert(1)'

async function main() {
  const root = path.resolve(__dirname, '..')
  const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json')))
  const displayedVersion = RegExp.escape(version)
  const result = await esbuild.build({
    stdin: { contents: `import React from 'react'; import { renderToString } from 'react-dom/server';
      import App from './src/renderer/App.jsx'; import Settings from './src/renderer/pages/Settings.jsx';
      import Dashboard from './src/renderer/pages/Dashboard.jsx'; import Secrets from './src/renderer/pages/Secrets.jsx';
      import TabStrip from './src/renderer/components/TabStrip.jsx';
      import GuideText from './src/renderer/components/GuideText.jsx';
      export const guide = renderToString(<GuideText baseUrl="https://v3.animeon.co" text={${JSON.stringify(GUIDE_SAMPLE)}} />);
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
  const { guide } = compiled.exports
  assert.match(guide, /<h3>1\. Код<\/h3>/)
  assert.match(guide, /<ol start="1"><li>Откройте <a href="https:\/\/v3\.animeon\.co\/roadmap">v3\.animeon\.co\/roadmap<\/a>\.<\/li>/, 'ссылка на сайт ведёт на выбранный адрес, точка не входит в ссылку')
  assert.match(guide, /<code>NYA<\/code>/)
  assert.match(guide, /<strong>Enter<\/strong>/)
  assert.match(guide, /<ul><li>пункт<\/li><\/ul>/)
  assert.match(guide, /class="secret-md-note"/)
  assert.match(guide, /<a href="https:\/\/v3\.animeon\.co\/tv\/link">свой<\/a>/)
  assert.doesNotMatch(guide, /href="https:\/\/evil|href="javascript|href="[^"]*8443|href="[^"]*user@/, 'чужие ссылки не кликабельны')
  assert.doesNotMatch(guide, /<img/, 'HTML из гайда выводится текстом')
  assert.match(guide, /&lt;img/)
  assert.match(pages.app, /МСК/)
  assert.match(pages.app, new RegExp(`V(?:<!-- -->)?${displayedVersion}`))
  assert.match(pages.settings, new RegExp(`v(?:<!-- -->)?${displayedVersion}`))
  assert.match(pages.settings, /Настройки/)
  assert.match(pages.settings, /Добавить профиль/)
  assert.match(pages.dashboard, /Пользовательские/)
  const dashboardSource = fs.readFileSync(path.join(root, 'src/renderer/pages/Dashboard.jsx'), 'utf8')
  assert.doesNotMatch(dashboardSource, /XP Монитор/)
  assert.match(dashboardSource, /signal-custom-grid/)
  assert.equal((pages.dashboard.match(/signal-custom-grid/g) || []).length, 1)
  assert.match(pages.secrets, /Скрытые задания AnimeOn/)
  assert.match(pages.secrets, /Не проверено/)
  assert.match(pages.secrets, /Как получить/)
  assert.match(pages.secrets, /Условия уточняются/)
  assert.match(pages.secrets, /Ва-банк/)
  assert.doesNotMatch(pages.secrets, /Первый ключ|единственном экземпляре/)
  const mainSource = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf8')
  const bridge = fs.readFileSync(path.join(root, 'src/preload/bridge.ts'), 'utf8')
  assert.doesNotMatch(mainSource + bridge, /nya-logger|morse-decoder|utilitiesRunMorse|__NYA_LOGGER__/)
  assert.match(mainSource, /'AnimeonDesktop'/)
  assert.match(mainSource, /remaining_today >= 0/)
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json')))
  assert.equal(lock.version, version)
  assert.equal(lock.packages[''].version, version)
  console.log('PASS: four React screens render; release data path, version, remaining=0 and removed utilities verified.')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
