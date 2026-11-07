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
    const { source, hash } = JSON.parse(await fs.readFile(pendingMove, 'utf8'))
    if (typeof source !== 'string' || !path.isAbsolute(source) || path.extname(source).toLowerCase() !== '.exe') return
    const original = await statIfPresent(source)
    if (samePath(source, target) || !original?.isFile()) return
    const shortcut = shortcutFor(source)
    if (!samePath(shell.readShortcutLink(shortcut).target, target)) return
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

  const shortcut = shortcutFor(source)
  const existingShortcut = await statIfPresent(shortcut)
  if (existingShortcut && !samePath(shell.readShortcutLink(shortcut).target, target)) return

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
    await fs.writeFile(pendingMove, JSON.stringify({ source, hash }))
  } finally {
    await Promise.allSettled([fs.unlink(stagedExe), fs.unlink(stagedLink)])
  }
  app.relaunch({ execPath: target, args: process.argv.slice(1) })
  return true
}
