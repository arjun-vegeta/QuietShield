// node research/cname/eph-test.mjs <port> — 3p cookie/storage behaviour with chrome.privacy + browsingData.
const port = process.argv[2]
const A = 'https://shields-test.example:8443/detect.html', B = 'https://shields-3p.example:8443/cosmetic.html'
const conn = async (wsUrl) => { const ws = new WebSocket(wsUrl); await new Promise(r => { ws.onopen = r }); let id = 0; const p = new Map()
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id) } }
  return (method, params = {}) => new Promise(r => { p.set(++id, r); ws.send(JSON.stringify({ id, method, params })) }) }
const list = () => fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json())
const sw = await conn((await list()).find(t => t.type === 'service_worker' && t.url.endsWith('/sw.js')).webSocketDebuggerUrl)
const swEval = async (e) => (await sw('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result.result.value
const tab = async () => { const t = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }).then(r => r.json()); return { t, s: await conn(t.webSocketDebuggerUrl) } }
const ev = async (s, e, ctx) => (await s('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true, ...(ctx ? { contextId: ctx } : {}) })).result.result?.value
async function round (tag) {
  const { t, s } = await tab(); await s('Page.enable'); await s('Page.navigate', { url: A }); await new Promise(r => setTimeout(r, 1500))
  await ev(s, `new Promise(r=>{const f=document.createElement('iframe');f.src='${B}';f.onload=r;document.body.append(f)})`)
  // cross-site iframe is an OOPIF: its own CDP target
  const ift = (await list()).find(x => x.type === 'iframe' && x.url === B)
  const fs = await conn(ift.webSocketDebuggerUrl)
  const inFrame = await ev(fs, `document.cookie='${tag}=1; SameSite=None; Secure; max-age=3600'; localStorage.setItem('${tag}','3p'); ({cookie: document.cookie, ls: localStorage.getItem('${tag}')})`)
  await fetch(`http://127.0.0.1:${port}/json/close/${t.id}`)
  const b = await tab(); await b.s('Page.enable'); await b.s('Page.navigate', { url: B }); await new Promise(r => setTimeout(r, 1500))
  const top = await ev(b.s, `({cookie: document.cookie, ls: localStorage.getItem('${tag}')})`)
  await fetch(`http://127.0.0.1:${port}/json/close/${b.t.id}`)
  return { inFrame, topLevelB: top }
}
console.log('default', JSON.stringify(await swEval(`chrome.privacy.websites.thirdPartyCookiesAllowed.get({})`)), JSON.stringify(await round('c1')))
console.log('set false', JSON.stringify(await swEval(`setTp(false)`)), JSON.stringify(await round('c2')))
console.log(await swEval(`clearOrigin('https://shields-3p.example:8443')`))
const b = await tab(); await b.s('Page.navigate', { url: B }); await new Promise(r => setTimeout(r, 1500))
console.log('after browsingData.remove', JSON.stringify(await ev(b.s, `({cookie: document.cookie, ls: localStorage.length})`)))
process.exit(0)
