// node research/cname/build-cname-rules.mjs <cname-trackers/data dir> [outDir]
// Turns AdGuard cname-trackers (MIT) "disguised" hosts into static DNR block rules, keeping only
// cloaked hosts whose CNAME target Brave's lists would block (what Brave's CNAME re-check does)
// and which our lists do not already block as first-party requests.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import init, { WasmEngine } from '../../extension/build/wasm/shields_engine_wasm.js'

const [dataDir, outDir = new URL('./out/', import.meta.url).pathname] = process.argv.slice(2)
await init({ module_or_path: readFileSync(new URL('../../extension/build/wasm/shields_engine_wasm_bg.wasm', import.meta.url)) })
const eng = ['default', 'additional'].map(n => new WasmEngine(readFileSync(new URL(`../../extension/build/engine/${n}.dat`, import.meta.url))))
const blocked = (url, src, type = 'script') => eng.some(e => JSON.parse(e.check(url, src, type)).block)
// Standard mode: the default engine (first_party_protections) never blocks first-party requests
// unless $important, so a cloaked host is "already blocked" only via the additional engine.
const blockedFirstPartyStandard = (url, src, type = 'script') => {
  if (JSON.parse(eng[1].check(url, src, type)).block) return true
  const d = JSON.parse(eng[0].check(url, src, type)); return d.block && d.important
}

const cats = ['trackers', 'ads', 'clickthroughs', 'microsites', 'mail_trackers']
const report = {}
mkdirSync(outDir, { recursive: true })
for (const cat of cats) {
  const map = JSON.parse(readFileSync(`${dataDir}/combined_disguised_${cat}.json`, 'utf8'))
  const targetBlocked = new Map()
  let already = 0, targetHit = 0, targetMiss = 0
  const add = []
  for (const [host, target] of Object.entries(map)) {
    const src = `https://${host}/`
    // Already blocked as a first-party (Standard mode) request? Check a script and an image.
    if (blockedFirstPartyStandard(`https://${host}/t.js`, src) || blockedFirstPartyStandard(`https://${host}/p.gif`, src, 'image')) { already++; continue }
    let tb = targetBlocked.get(target)
    if (tb === undefined) {
      // Brave re-checks the request with the canonical host substituted (third-party to the page).
      tb = blocked(`https://${target}/t.js`, src) || blocked(`https://${target}/p.gif`, src, 'image')
      targetBlocked.set(target, tb)
    }
    if (tb) { targetHit++; add.push(host) } else targetMiss++
  }
  // Collapse: prune hosts whose parent is also in the set (same as compiler finalize()).
  const set = new Set(add)
  const pruned = add.filter(h => { let r = h; while (r.includes('.')) { r = r.slice(r.indexOf('.') + 1); if (set.has(r)) return false } return true }).sort()
  const rule = { id: 1, priority: 12, action: { type: 'block' }, condition: { requestDomains: pruned } }
  const json = JSON.stringify([rule])
  writeFileSync(`${outDir}/cname-${cat}.json`, json)
  report[cat] = { cloakedHosts: Object.keys(map).length, distinctTargets: new Set(Object.values(map)).size,
    alreadyBlockedFirstPartyStandard: already, uncloakableByBraveLists: targetHit, targetNotInLists: targetMiss,
    newRequestDomains: pruned.length, rulesetBytes: json.length }
}
console.log(JSON.stringify(report, null, 1))
writeFileSync(`${outDir}/report.json`, JSON.stringify(report, null, 1))
