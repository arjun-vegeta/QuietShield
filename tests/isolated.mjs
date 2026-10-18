// node tests/isolated.mjs <port> <url> <expr> — evaluates in the extension's ISOLATED world and MAIN world.
const [port, url, expr] = process.argv.slice(2)
const t = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }).then(r => r.json())
const ws = new WebSocket(t.webSocketDebuggerUrl)
await new Promise(r => { ws.onopen = r })
let id = 0
const pending = new Map(); const contexts = []; const logs = []
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  if (m.method === 'Runtime.executionContextCreated') contexts.push(m.params.context)
  if (m.method === 'Runtime.exceptionThrown') logs.push('EXC ' + JSON.stringify(m.params.exceptionDetails).slice(0, 400))
  if (m.method === 'Runtime.consoleAPICalled') logs.push('LOG ' + m.params.args.map(a => a.value ?? a.description).join(' ').slice(0, 300))
}
const send = (method, params = {}) => new Promise(r => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })) })
await send('Runtime.enable'); await send('Page.enable')
await send('Page.navigate', { url })
await new Promise(r => setTimeout(r, 8000))
for (const c of contexts.filter(c => c.auxData?.frameId && (c.auxData.type === 'isolated' || c.auxData.isDefault))) {
  const res = await send('Runtime.evaluate', { expression: expr, contextId: c.id, returnByValue: true, awaitPromise: true })
  console.log(c.auxData.type ?? 'default', c.name || '(main)', c.origin, '→', JSON.stringify(res.result?.result?.value ?? res.result?.exceptionDetails?.text ?? res.error))
}
console.log(logs.join('\n'))
await fetch(`http://127.0.0.1:${port}/json/close/${t.id}`)
process.exit(0)
