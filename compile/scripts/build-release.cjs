const path = require('node:path')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')

async function build() {
  const root = path.resolve(__dirname, '..')
  process.chdir(root)
  const isPublic = process.argv.includes('--public') || process.env.PUBLIC_BUILD === '1'
  const flagsPath = path.join(root, 'src', 'shared', 'buildFlags.ts')
  const originalFlags = fs.readFileSync(flagsPath, 'utf8')

  try {
    if (isPublic) {
      console.log('Building Public Release (AUTO_COLLECT_AVAILABLE = false)...')
      fs.writeFileSync(flagsPath, '// Public build: automatic collector disabled\nexport const AUTO_COLLECT_AVAILABLE = false\n', 'utf8')
    } else {
      console.log('Building Standard Release (AUTO_COLLECT_AVAILABLE = true)...')
      fs.writeFileSync(flagsPath, '// Standard build: automatic collector enabled\nexport const AUTO_COLLECT_AVAILABLE = true\n', 'utf8')
    }

    execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.main.json'], { stdio: 'inherit' })
    const { build: viteBuild } = await import('vite')
    await viteBuild()
    await require('electron-builder').build({ publish: 'never', config: {
      win: { artifactName: 'AnimeOn Desktop.exe' },
      directories: { output: 'release' }
    } })
    const asar = require('@electron/asar')
    const archivePath = path.join(root, 'release', 'win-unpacked', 'resources', 'app.asar')
    if (asar.listPackage(archivePath).some(entry => /dist[\\/]renderer.*\.exe$/i.test(entry))) throw Error('Nested executable in renderer assets')
    const packed = asar.extractFile(archivePath, path.join('dist', 'shared', 'buildFlags.js')).toString()
    if (isPublic) {
      if (!packed.includes('AUTO_COLLECT_AVAILABLE = false')) throw Error('Expected AUTO_COLLECT_AVAILABLE = false in public release')
      console.log('Verified public release: automatic collector excluded/disabled')
    } else {
      if (!packed.includes('AUTO_COLLECT_AVAILABLE = true')) throw Error('Automatic collector is missing from standard release')
      console.log('Verified common release: automatic collector available')
    }
  } finally {
    fs.writeFileSync(flagsPath, originalFlags, 'utf8')
  }
}

build().catch(error => { console.error(error); process.exitCode = 1 })
