const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

async function build() {
  const publicBuild = process.argv.includes('--public')
  const root = path.resolve(__dirname, '..')
  process.chdir(root)
  execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.main.json'], { stdio: 'inherit' })
  const flags = path.join(root, 'dist/shared/buildFlags.js')
  if (publicBuild) {
    const code = fs.readFileSync(flags, 'utf8')
    if (!code.includes('AUTO_COLLECT_AVAILABLE = true')) throw Error('Build flag not found')
    fs.writeFileSync(flags, code.replace('AUTO_COLLECT_AVAILABLE = true', 'AUTO_COLLECT_AVAILABLE = false'))
  }
  const { build: viteBuild } = await import('vite')
  await viteBuild({ plugins: [{
    name: 'release-collector-variant', enforce: 'pre',
    transform(code, id) {
      if (publicBuild && id.replaceAll('\\', '/').endsWith('/src/shared/buildFlags.ts')) {
        if (!code.includes('AUTO_COLLECT_AVAILABLE = true')) throw Error('Renderer build flag not found')
        return code.replace('AUTO_COLLECT_AVAILABLE = true', 'AUTO_COLLECT_AVAILABLE = false')
      }
    }
  }] })
  await require('electron-builder').build({ publish: 'never', config: {
    win: { artifactName: 'AnimeOn Desktop.exe' },
    directories: { output: publicBuild ? 'Public' : 'DEV' }
  } })
  const asar = require('@electron/asar')
  const archivePath = path.join(root, publicBuild ? 'Public' : 'DEV', 'win-unpacked', 'resources', 'app.asar')
  if (asar.listPackage(archivePath).some(entry => /dist[\\\\/]renderer.*\\.exe$/i.test(entry))) throw Error('Nested executable in renderer assets')
  const packed = asar.extractFile(path.join(root, (publicBuild ? 'Public' : 'DEV') + '/win-unpacked/resources/app.asar'), path.join('dist','shared','buildFlags.js')).toString()
  if (!packed.includes('AUTO_COLLECT_AVAILABLE = ' + !publicBuild)) throw Error('Packaged variant mismatch')
  console.log('Verified packaged variant:', publicBuild ? 'public: collector disabled' : 'personal: collector available')
}
build().catch(error => { console.error(error); process.exitCode = 1 })
