// Renders store/assets/*.html to PNG through a CDP Chrome (default port 9335).
import { writeFileSync } from 'node:fs'
import path from 'node:path'
const port = process.env.CDP_PORT ?? 9335
const dir = path.resolve(import.meta.dirname, '../store/assets')
const jobs = [['hero.html', 1280, 800, 'screenshot-1-hero.png'], ['tile.html', 440, 280, 'promo-tile-440x280.png'], ['marquee.html', 1400, 560, 'marquee-1400x560.png']]
for (const [file, width, height, out] of jobs) {
  const t = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }).then(r => r.json())
  const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise(r => { ws.onopen = r })
  let id = 0; const pending = new Map()
  ws.onmessage = e => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  const send = (method, params = {}) => new Promise(r => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })) })
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  const nav = await send('Page.navigate', { url: 'file://' + path.join(dir, file) })
  if (nav.result?.errorText) { console.log('skip', file); await fetch(`http://127.0.0.1:${port}/json/close/${t.id}`); continue }
  await new Promise(r => setTimeout(r, 1200))
  const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width, height, scale: 1 } })
  writeFileSync(path.join(dir, out), Buffer.from(shot.result.data, 'base64'))
  await fetch(`http://127.0.0.1:${port}/json/close/${t.id}`)
  console.log(out)
}
process.exit(0)
