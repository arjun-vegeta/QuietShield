// node tests/ext-eval.mjs <port> <extId> <expr> — opens the extension popup page in a tab and evaluates there
// (works even when the service worker is asleep; extension pages have the same chrome.* APIs).
const [port, extId, expr] = process.argv.slice(2)
const t = await fetch(`http://127.0.0.1:${port}/json/new?chrome-extension://${extId}/popup/popup.html`, { method: 'PUT' }).then(r => r.json())
const ws = new WebSocket(t.webSocketDebuggerUrl)
await new Promise(r => { ws.onopen = r })
await new Promise(r => setTimeout(r, 800))
ws.onmessage = async (e) => { const m = JSON.parse(e.data); if (m.id === 1) { console.log(JSON.stringify(m.result?.result?.value ?? m.result)); await fetch(`http://127.0.0.1:${port}/json/close/${t.id}`); process.exit(0) } }
ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }))
