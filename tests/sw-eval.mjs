// node tests/sw-eval.mjs <port> <expr> — evaluates in the extension service worker.
const [port, expr] = process.argv.slice(2)
const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json())
const sw = targets.find(t => t.type === 'service_worker' && t.url.endsWith('/build/background.js'))
if (!sw) { console.log('no service worker target'); process.exit(1) }
const ws = new WebSocket(sw.webSocketDebuggerUrl)
await new Promise(r => { ws.onopen = r })
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id === 1) { console.log(JSON.stringify(m.result?.result?.value ?? m.result)); process.exit(0) } }
ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }))
