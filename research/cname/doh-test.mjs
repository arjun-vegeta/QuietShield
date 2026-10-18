// node research/cname/doh-test.mjs <combined_disguised_trackers.json> [n] — DoH CNAME lookups only (no site visits).
import { readFileSync } from 'node:fs'
import init, { WasmEngine } from '../../extension/build/wasm/shields_engine_wasm.js'
await init({ module_or_path: readFileSync(new URL('../../extension/build/wasm/shields_engine_wasm_bg.wasm', import.meta.url)) })
const eng = ['default', 'additional'].map(n => new WasmEngine(readFileSync(new URL(`../../extension/build/engine/${n}.dat`, import.meta.url))))
const blocked = (h, page) => eng.some(e => JSON.parse(e.check(`https://${h}/t.js`, `https://${page}/`, 'script')).block)
const map = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const n = +(process.argv[3] ?? 60)
// one host per distinct target, deterministic spread
const byTarget = new Map(); for (const [h, t] of Object.entries(map)) if (!byTarget.has(t)) byTarget.set(t, h)
const hosts = [...byTarget.values()].filter((_, i, a) => i % Math.floor(a.length / n) === 0).slice(0, n)
const res = { n: hosts.length, hasCname: 0, chainBlocked: 0, listTargetMatches: 0, nx: 0, lat: [] }
await Promise.all(hosts.map(async (h, i) => {
  await new Promise(r => setTimeout(r, i * 40))
  const t = performance.now()
  const j = await fetch(`https://cloudflare-dns.com/dns-query?name=${h}&type=CNAME`, { headers: { accept: 'application/dns-json' } }).then(r => r.json()).catch(() => ({}))
  res.lat.push(performance.now() - t)
  if (j.Status === 3) res.nx++
  const chain = (j.Answer ?? []).filter(a => a.type === 5).map(a => a.data.replace(/\.$/, ''))
  if (chain.length) res.hasCname++
  if (chain.includes(map[h])) res.listTargetMatches++
  if (chain.some(c => blocked(c, h))) res.chainBlocked++
}))
res.lat.sort((a, b) => a - b)
console.log({ ...res, p50: res.lat[res.lat.length >> 1]?.toFixed(0), p95: res.lat[Math.floor(res.lat.length * 0.95)]?.toFixed(0), lat: undefined })
