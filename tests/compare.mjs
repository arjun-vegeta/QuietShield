// Loads the same pages in several CDP-enabled browsers and records what each one blocks.
//   node tests/compare.mjs [--keep] [label=port ...] -- url ...
// Defaults: brave=9333 (Brave Shields), chrome-ext=9334 (Chrome for Testing + this extension),
// chrome-plain=9335 (Chrome for Testing, no extension, if running).
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const keep = args.includes('--keep')
const sep = args.indexOf('--')
const browserArgs = (sep < 0 ? args : args.slice(0, sep)).filter(a => a.includes('='))
const urls = sep < 0 ? [] : args.slice(sep + 1)
const browsers = browserArgs.length
  ? browserArgs.map(a => { const [label, port] = a.split('='); return { label, port: +port } })
  : [{ label: 'brave', port: 9333 }, { label: 'chrome-ext', port: 9334 }, { label: 'chrome-plain', port: 9335 }]
const outDir = path.resolve(import.meta.dirname, 'out')
mkdirSync(outDir, { recursive: true })

// Elements that only exist/are visible when ads load.
const AD_PROBE = `(() => {
  const sel = '[id^="google_ads_iframe"],iframe[src*="doubleclick.net"],iframe[src*="googlesyndication"],ins.adsbygoogle,[id^="div-gpt-ad"],iframe[id*="taboola"],[id^="taboola-"],.OUTBRAIN,iframe[src*="amazon-adsystem"],[data-ad-slot],[class*="ad-slot"],[id*="ad-slot"],[class^="ad-container"]';
  let visible = 0, total = 0;
  for (const el of document.querySelectorAll(sel)) {
    total++;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (r.width > 1 && r.height > 1 && cs.display !== 'none' && cs.visibility !== 'hidden') visible++;
  }
  const text = document.body ? document.body.innerText : '';
  const detect = /ad ?block(er)? (is )?(detected|enabled|active)|disable your ad ?block|turn off your ad ?block|whitelist|allowlist us/i.test(text);
  const score = (text.match(/(\\d{1,3}(\\.\\d+)?) ?(%|\\/ ?100|points)/) || [])[0] || null;
  return { adSlotsVisible: visible, adSlotsTotal: total, adblockDetectedText: detect, score, title: document.title.slice(0, 80) };
})()`

class CDP {
  constructor (ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = []
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data)
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id)
        this.pending.delete(m.id)
        m.error ? reject(new Error(m.error.message)) : resolve(m.result)
      } else if (m.method) {
        for (const h of this.handlers) h(m)
      }
    })
  }

  static async connect (url) {
    const ws = new WebSocket(url)
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
    return new CDP(ws)
  }

  send (method, params = {}) {
    const id = ++this.id
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
  }

  on (fn) { this.handlers.push(fn) }
  close () { this.ws.close() }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function visit (browser, url) {
  const target = await fetch(`http://127.0.0.1:${browser.port}/json/new?about:blank`, { method: 'PUT' }).then(r => r.json())
  const cdp = await CDP.connect(target.webSocketDebuggerUrl)
  const requests = new Map()
  let blocked = 0
  let redirectedToExtension = 0
  const blockedHosts = new Map()
  cdp.on((m) => {
    if (m.method === 'Network.requestWillBeSent') {
      requests.set(m.params.requestId, m.params.request.url)
      if (m.params.request.url.startsWith('chrome-extension://')) redirectedToExtension++
    } else if (m.method === 'Network.loadingFailed' && /BLOCKED_BY_CLIENT/.test(m.params.errorText)) {
      blocked++
      try {
        const h = new URL(requests.get(m.params.requestId)).hostname
        blockedHosts.set(h, (blockedHosts.get(h) ?? 0) + 1)
      } catch {}
    }
  })
  await cdp.send('Network.enable')
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  const loaded = new Promise(r => cdp.on(m => m.method === 'Page.loadEventFired' && r()))
  const t0 = Date.now()
  await cdp.send('Page.navigate', { url })
  await Promise.race([loaded, sleep(25000)])
  const loadMs = Date.now() - t0
  await sleep(6000)
  const probe = (await cdp.send('Runtime.evaluate', { expression: AD_PROBE, returnByValue: true })).result.value
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  const slug = new URL(url).hostname.replace(/^www\./, '') + new URL(url).pathname.replace(/[^a-z0-9]+/gi, '_').replace(/_$/, '')
  const shotPath = path.join(outDir, `${slug}.${browser.label}.png`)
  writeFileSync(shotPath, Buffer.from(shot.data, 'base64'))
  if (!keep) {
    cdp.close()
    await fetch(`http://127.0.0.1:${browser.port}/json/close/${target.id}`)
  }
  const topBlocked = [...blockedHosts].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([h, n]) => `${h}×${n}`)
  return { browser: browser.label, url, loadMs, requests: requests.size, blocked, redirectedToExtension, ...probe, topBlocked, shotPath, targetId: target.id }
}

const results = []
for (const url of urls) {
  const row = await Promise.all(browsers.map(b => visit(b, url).catch(e => ({ browser: b.label, url, error: e.message }))))
  for (const r of row) {
    results.push(r)
    console.log(JSON.stringify(r))
  }
}
writeFileSync(path.join(outDir, `results-${Date.now()}.json`), JSON.stringify(results, null, 2))
process.exit(0)
