// node tests/probe.mjs <port> <url> <js-expression> [waitMs]  — loads url in a new tab, evaluates in MAIN world.
const [port, url, expr, wait = '4000'] = process.argv.slice(2)
setTimeout(() => { console.log("\"TIMEOUT\""); process.exit(2) }, +(process.env.PROBE_TIMEOUT ?? 45000))
const t = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }).then(r => r.json())
const ws = new WebSocket(t.webSocketDebuggerUrl)
await new Promise(r => { ws.onopen = r })
let id = 0
const pending = new Map()
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
const send = (method, params = {}) => new Promise(r => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })) })
await send('Page.enable')
await send('Page.navigate', { url })
await new Promise(r => setTimeout(r, +wait))
const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
console.log(JSON.stringify(res.result?.result?.value ?? res.result))
await fetch(`http://127.0.0.1:${port}/json/close/${t.id}`)
process.exit(0)
