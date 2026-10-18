// node research/cname/netprobe.mjs <port> <pageUrl> <host,host,...> — fetches https://<host>/t.js from the page
// and prints CDP Network.loadingFailed errorText/blockedReason per host (ERR_BLOCKED_BY_CLIENT = DNR block).
const [port, url, hosts] = process.argv.slice(2)
const t = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }).then(r => r.json())
const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise(r => { ws.onopen = r })
let id = 0; const pend = new Map(); const reqs = new Map(); const out = {}
ws.onmessage = (e) => { const m = JSON.parse(e.data)
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) }
  if (m.method === 'Network.requestWillBeSent') reqs.set(m.params.requestId, new URL(m.params.request.url).hostname)
  if (m.method === 'Network.loadingFailed') out[reqs.get(m.params.requestId)] = m.params.blockedReason ?? m.params.errorText }
const send = (method, params = {}) => new Promise(r => { pend.set(++id, r); ws.send(JSON.stringify({ id, method, params })) })
await send('Network.enable'); await send('Page.enable'); await send('Page.navigate', { url })
await new Promise(r => setTimeout(r, 1500))
await send('Runtime.evaluate', { expression: `Promise.allSettled(${JSON.stringify(hosts.split(','))}.map(h=>fetch('https://'+h+'/t.js',{mode:'no-cors'})))`, awaitPromise: true })
await new Promise(r => setTimeout(r, 500))
for (const h of hosts.split(',')) console.log(h, out[h])
await fetch(`http://127.0.0.1:${port}/json/close/${t.id}`); process.exit(0)
