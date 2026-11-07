const { app, session } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const auditVideo = process.env.ANIMEON_TEST_VIDEO ? fs.readFileSync(process.env.ANIMEON_TEST_VIDEO) : null
// Fixture server is in-process; no site requests or account data are used.
app.whenReady().then(async () => {
  for (const partition of ['', 'persist:animeon-acc-1', 'persist:animeon-acc-2', 'persist:animeon-acc-3', 'persist:animeon-acc-4', 'persist:animeon-acc-5']) {
    await session.fromPartition(partition).protocol.handle('https', request => {
      const { pathname } = new URL(request.url)
      if (auditVideo && pathname === '/audit-clip.mp4') {
        const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get('range') || '')
        if (!range) return new Response(auditVideo, { headers: { 'Content-Type': 'video/mp4' } })
        const start = Number(range[1])
        const end = range[2] ? Math.min(Number(range[2]), auditVideo.length - 1) : auditVideo.length - 1
        if (start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${auditVideo.length}` } })
        return new Response(auditVideo.subarray(start, end + 1), { status: 206, headers: {
          'Content-Type': 'video/mp4',
          'Content-Range': `bytes ${start}-${end}/${auditVideo.length}`,
          'Accept-Ranges': 'bytes'
        } })
      }
      if (auditVideo && pathname.startsWith('/audit-media/')) {
        return new Response('<!doctype html><title>Offline video audit</title><video muted loop playsinline src="/audit-clip.mp4" width="640" height="360"></video>',
          { headers: { 'Content-Type': 'text/html' } })
      }
      if (request.url.includes('/api/achievements')) return new Response(JSON.stringify([{name:'Отошел за чаем',category:'special',completed:true},{name:'Ушёл за чаем',category:'special',completed:true}]), {headers:{'Content-Type':'application/json'}})
      if (request.url.includes('/api/')) return new Response('{}', { status: 401, headers: { 'Content-Type': 'application/json' } })
      return new Response('<!doctype html><title>AnimeOn fixture</title><h1>Offline fixture</h1>', { headers: { 'Content-Type': 'text/html' } })
    })
  }
  require(path.resolve(process.env.ANIMEON_TEST_MAIN || 'dist/main/index.js'))
})
