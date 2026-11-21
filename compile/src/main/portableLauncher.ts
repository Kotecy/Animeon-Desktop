import { app, shell } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { constants, createReadStream, promises as fs } from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

function samePath(first: string, second: string) {
  return first.toLowerCase() === second.toLowerCase()
}

function shortcutFor(executable: string) {
  return path.join(path.dirname(executable), `${path.parse(executable).name}.lnk`)
}

// Один ярлык: новые версии с другим именем файла («AnimeOn.Desktop (1).exe») раньше
// давали каждая свой ярлык рядом с EXE. Теперь ярлык на launcher ищется на рабочем столе
// и рядом с EXE; найденный используется, новый создаётся на рабочем столе под постоянным
// именем, лишние уходят в корзину.
const SHORTCUT_NAME = 'AnimeOn Desktop.lnk'

// В тестах настоящий рабочий стол не трогаем: только ANIMEON_TEST_DESKTOP, иначе без него
function desktopFolder() {
  if (process.env.ANIMEON_TEST_USER_DATA) {
    const testDesktop = process.env.ANIMEON_TEST_DESKTOP
    return testDesktop && path.isAbsolute(testDesktop) ? path.resolve(testDesktop) : ''
  }
  try { return app.getPath('desktop') } catch { return '' }
}

function linkTarget(file: string) {
  try { return shell.readShortcutLink(file).target } catch { return '' }
}

async function shortcutsTo(folder: string, target: string) {
  let names: string[] = []
  try { names = await fs.readdir(folder) } catch { return [] }
  return names
    .filter(name => name.toLowerCase().endsWith('.lnk'))
    .map(name => path.join(folder, name))
    .filter(file => samePath(linkTarget(file), target))
}

async function statIfPresent(file: string) {
  try {
    return await fs.lstat(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

async function sha256(file: string) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

async function finishMove(target: string, pendingMove: string) {
  if (!(await statIfPresent(pendingMove))) return
  try {
    const { source, hash, shortcut: savedShortcut } = JSON.parse(await fs.readFile(pendingMove, 'utf8'))
    if (typeof source !== 'string' || !path.isAbsolute(source) || path.extname(source).toLowerCase() !== '.exe') return
    const original = await statIfPresent(source)
    if (samePath(source, target) || !original?.isFile()) return
    // Ярлык должен лежать на рабочем столе или рядом с исходным EXE и вести на launcher
    const desktop = desktopFolder()
    const allowedFolder = (file: string) => samePath(path.dirname(file), path.dirname(source)) || (!!desktop && samePath(path.dirname(file), desktop))
    const shortcut = typeof savedShortcut === 'string' && path.isAbsolute(savedShortcut)
      && path.extname(savedShortcut).toLowerCase() === '.lnk' && allowedFolder(savedShortcut) ? savedShortcut : shortcutFor(source)
    if (!samePath(linkTarget(shortcut), target)) return
    const [sourceHash, targetHash] = await Promise.all([sha256(source), sha256(target)])
    if (sourceHash !== hash || targetHash !== hash) return

    // The original portable wrapper may still be releasing its executable.
    for (let attempt = 0; ; attempt++) {
      const current = await statIfPresent(source)
      if (!current?.isFile() || current.ino !== original.ino || current.mtimeMs !== original.mtimeMs || current.size !== original.size) return
      try {
        await fs.unlink(source)
        return
      } catch (error) {
        const { code } = error as NodeJS.ErrnoException
        if (attempt === 10 || (code !== 'EBUSY' && code !== 'EPERM')) throw error
        await delay(250)
      }
    }
  } finally {
    await fs.rm(pendingMove, { force: true })
  }
}

export async function relocatePortableLauncher() {
  const portableFile = process.env.PORTABLE_EXECUTABLE_FILE
  if (process.platform !== 'win32' || !app.isPackaged || !portableFile || !path.isAbsolute(portableFile)) return

  const source = path.resolve(portableFile)
  const folder = path.join(app.getPath('userData'), 'launcher')
  const target = path.join(folder, 'AnimeOn Desktop.exe')
  const pendingMove = path.join(folder, 'pending-move.json')
  if (samePath(source, target)) {
    await finishMove(target, pendingMove)
    return
  }
  if (path.extname(source).toLowerCase() !== '.exe' || !(await statIfPresent(source))?.isFile()) return

  const sourceFolder = path.dirname(source)
  const desktop = desktopFolder()
  const folders = desktop && !samePath(desktop, sourceFolder) ? [desktop, sourceFolder] : [sourceFolder]
  const ours = (await Promise.all(folders.map(dir => shortcutsTo(dir, target)))).flat()
  const preferred = folders.map(dir => path.join(dir, SHORTCUT_NAME))
  // Приоритет: постоянное имя на рабочем столе → любой наш на рабочем столе → рядом с EXE
  let shortcut = ours.find(file => samePath(file, preferred[0]))
    || ours.find(file => samePath(path.dirname(file), folders[0]))
    || ours.find(file => preferred.some(name => samePath(file, name)))
    || ours[0]
  const existingShortcut = !!shortcut
  if (!shortcut) {
    // Постоянное имя занято чужим файлом — следующая папка, затем прежнее имя по EXE; всё занято — ничего не трогаем
    for (const candidate of [...preferred, shortcutFor(source)]) {
      if (!(await statIfPresent(candidate))) { shortcut = candidate; break }
    }
    if (!shortcut) return
  }
  const duplicates = ours.filter(file => !samePath(file, shortcut))

  await fs.mkdir(folder, { recursive: true })
  const suffix = randomUUID()
  const stagedExe = path.join(folder, `${suffix}.tmp`)
  const stagedLink = path.join(path.dirname(shortcut), `${suffix}.lnk`)
  try {
    await fs.copyFile(source, stagedExe, constants.COPYFILE_EXCL)
    const hash = await sha256(stagedExe)
    if (!existingShortcut && !shell.writeShortcutLink(stagedLink, { target, cwd: folder, description: 'AnimeOn Desktop' })) return

    await fs.rename(stagedExe, target)
    if (!existingShortcut) await fs.copyFile(stagedLink, shortcut, constants.COPYFILE_EXCL)
    await fs.writeFile(pendingMove, JSON.stringify({ source, hash, shortcut }))
  } finally {
    await Promise.allSettled([fs.unlink(stagedExe), fs.unlink(stagedLink)])
  }
  // Лишние ярлыки на тот же launcher от прошлых версий — в корзину (в тестах удаляем сразу)
  await Promise.allSettled(duplicates.map(file => process.env.ANIMEON_TEST_USER_DATA ? fs.unlink(file) : shell.trashItem(file)))
  app.relaunch({ execPath: target, args: process.argv.slice(1) })
  return true
}
