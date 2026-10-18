// CNAME-cloaked trackers → DNR rulesets, mirroring Brave's CNAME uncloaking semantics.
//
// Brave resolves the request host's CNAME and re-checks the request with the canonical host
// (brave_ad_block_tp_network_delegate_helper.cc). In Standard mode it skips that for first-party
// requests; in Aggressive mode it uncloaks everything. Extensions have no DNS API, so we use
// AdGuard's cname-trackers (MIT) map of cloaked host → canonical tracker host, keep the cloaked
// hosts whose canonical host Brave's lists would block (checked with the same wasm engines the
// service worker uses), and emit:
//   build/rules/cname.json             third-party loads (Standard and Aggressive)
//   build/rules/cname-aggressive.json  first-party loads (Aggressive only)
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import init, { WasmEngine } from '../extension/build/wasm/shields_engine_wasm.js'

const root = path.resolve(import.meta.dirname, '..')
const build = path.join(root, 'extension/build')
await init({ module_or_path: readFileSync(path.join(build, 'wasm/shields_engine_wasm_bg.wasm')) })
const engines = ['default', 'additional'].map(n => new WasmEngine(readFileSync(path.join(build, `engine/${n}.dat`))))
const blocks = (url, source, type) => engines.some(e => JSON.parse(e.check(url, source, type)).block)

const cats = ['trackers', 'ads', 'clickthroughs', 'microsites', 'mail_trackers']
const cloaked = new Map()
for (const cat of cats) {
  const map = JSON.parse(readFileSync(path.join(root, 'data/cname-trackers', `${cat}.json`), 'utf8'))
  for (const [host, target] of Object.entries(map)) cloaked.set(host.toLowerCase(), target.toLowerCase())
}

const targetBlocked = new Map()
const isTargetBlocked = (target, source) => {
  let v = targetBlocked.get(target)
  if (v === undefined) {
    // Brave re-checks the uncloaked request; the canonical host is third-party to the page.
    v = blocks(`https://${target}/t.js`, source, 'script') || blocks(`https://${target}/p.gif`, source, 'image')
    targetBlocked.set(target, v)
  }
  return v
}

const hosts = []
let alreadyBlocked = 0
for (const [host, target] of cloaked) {
  const source = 'https://example.org/'
  // Already blocked as a third-party request by the regular rules → nothing to add.
  if (blocks(`https://${host}/t.js`, source, 'script') && blocks(`https://${host}/p.gif`, source, 'image')) { alreadyBlocked++; continue }
  if (isTargetBlocked(target, `https://${host}/`)) hosts.push(host)
}

// Drop hosts covered by a parent already in the set (requestDomains matches subdomains).
const set = new Set(hosts)
const pruned = hosts.filter(h => {
  for (let r = h; r.includes('.');) { r = r.slice(r.indexOf('.') + 1); if (set.has(r)) return false }
  return true
}).sort()

const rule = (domainType) => [{ id: 1, priority: 10, action: { type: 'block' }, condition: { requestDomains: pruned, domainType } }]
writeFileSync(path.join(build, 'rules/cname.json'), JSON.stringify(rule('thirdParty')))
writeFileSync(path.join(build, 'rules/cname-aggressive.json'), JSON.stringify(rule('firstParty')))

const rulesetsPath = path.join(build, 'rulesets.json')
const rulesets = JSON.parse(readFileSync(rulesetsPath, 'utf8')).filter(r => !r.id.startsWith('cname'))
rulesets.push({ id: 'cname', enabled: true, path: 'build/rules/cname.json' })
rulesets.push({ id: 'cname-aggressive', enabled: false, path: 'build/rules/cname-aggressive.json' })
writeFileSync(rulesetsPath, JSON.stringify(rulesets))

const summaryPath = path.join(build, 'summary.json')
const summary = JSON.parse(readFileSync(summaryPath, 'utf8'))
summary.cname = { cloakedHosts: cloaked.size, alreadyBlocked, canonicalBlocked: hosts.length, requestDomains: pruned.length }
writeFileSync(summaryPath, JSON.stringify(summary))
console.log(`cname: ${cloaked.size} cloaked hosts, ${alreadyBlocked} already blocked, ${pruned.length} added (${targetBlocked.size} canonical hosts checked)`)
