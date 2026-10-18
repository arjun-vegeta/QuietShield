// node research/regex/check.mjs <in.json: [{regex, cs}]> <out.json>
// Runs chrome.declarativeNetRequest.isRegexSupported from an extension page in CfT (port 9334).
import fs from 'node:fs'
const [inp, out] = process.argv.slice(2)
const EXT = process.env.EXT_ID ?? 'coblejookfghmojlafkklmhediembhlj'
const items = JSON.parse(fs.readFileSync(inp, 'utf8'))
const t = await fetch(`http://127.0.0.1:9334/json/new?chrome-extension://${EXT}/popup/popup.html`, { method: 'PUT' }).then(r => r.json())
await new Promise(r => setTimeout(r, 3000))
const ws = new WebSocket(t.webSocketDebuggerUrl)
await new Promise(r => { ws.onopen = r })
const expr = `(async()=>{const items=${JSON.stringify(items)};const o=[];for(const it of items){o.push(await chrome.declarativeNetRequest.isRegexSupported({regex:it.regex,isCaseSensitive:!!it.cs}))}return o})()`
ws.onmessage = async (e) => { const m = JSON.parse(e.data); if (m.id === 1) { if(!m.result?.result?.value) console.error(JSON.stringify(m).slice(0,800)); fs.writeFileSync(out, JSON.stringify(m.result?.result?.value ?? m.result)); await fetch(`http://127.0.0.1:9334/json/close/${t.id}`); process.exit(0) } }
ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }))
