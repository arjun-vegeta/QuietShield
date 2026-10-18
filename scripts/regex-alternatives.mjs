// Adds `alternatives` to each regex rule in build/rules/regex.json.
//
// Chrome compiles DNR regexes with RE2 under a 2 KiB memory budget and rejects lookarounds, so
// about 40% of the lists' regex filters are refused. For rules that look at risk we precompute
// rewrites (scripts/lib/regex-rewrite.mjs): exact ones (collapsing, splitting alternations) and
// lossy ones (dropping lookarounds, capping counted repetitions). A lossy rewrite is kept only if
// every extra URL it matches in adblock-rust's 243k-request corpus is blocked by Brave's engine
// anyway. The service worker installs the first alternative Chrome accepts.
import { createReadStream, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import path from 'node:path'
import init, { WasmEngine } from '../extension/build/wasm/shields_engine_wasm.js'
import { candidates } from './lib/regex-rewrite.mjs'

const root = path.resolve(import.meta.dirname, '..')
const build = path.join(root, 'extension/build')
await init({ module_or_path: readFileSync(path.join(build, 'wasm/shields_engine_wasm_bg.wasm')) })
const engines = ['default', 'additional'].map(n => new WasmEngine(readFileSync(path.join(build, `engine/${n}.dat`))))
const CPT = { document: 'main_frame', subdocument: 'sub_frame' }
const blockedByEngine = (r) => engines.some(e => JSON.parse(e.check(r.url, r.frameUrl, CPT[r.cpt] ?? r.cpt)).block)

const corpus = []
const corpusPath = path.join(root, 'vendor/adblock-rust/data/requests.json')
for await (const line of createInterface({ input: createReadStream(corpusPath) })) {
  if (!line) continue
  const r = JSON.parse(line)
  corpus.push({ url: r.url, frameUrl: r.frameUrl, cpt: r.cpt })
}

// Counted repetitions and lookarounds are what break RE2's budget/syntax in practice.
const atRisk = (re) => /\{\d+(,\d*)?\}|\(\?<?[=!]/.test(re)

const rulesPath = path.join(build, 'rules/regex.json')
const rules = JSON.parse(readFileSync(rulesPath, 'utf8'))
let withAlternatives = 0
let lossyAccepted = 0
let lossyRejected = 0
for (const rule of rules) {
  const src = rule.condition.regexFilter
  rule.alternatives = [[src]]
  if (!atRisk(src)) continue
  const flags = rule.condition.isUrlFilterCaseSensitive ? '' : 'i'
  let orig
  try { orig = new RegExp(src, flags) } catch { continue }
  let cands
  try { cands = candidates(src) } catch { continue }
  for (const c of cands) {
    if (c.regexes.length === 1 && c.regexes[0] === src) continue
    let news
    try { news = c.regexes.map(r => new RegExp(r, flags)) } catch { continue }
    if (!c.exact) {
      const extra = corpus.filter(r => !orig.test(r.url) && news.some(n => n.test(r.url)))
      if (!extra.every(blockedByEngine)) {
        lossyRejected++
        if (/cap\d+$/.test(c.tag)) break // smaller caps only match more
        continue
      }
      lossyAccepted++
    }
    rule.alternatives.push(c.regexes)
  }
  if (rule.alternatives.length > 1) withAlternatives++
}
writeFileSync(rulesPath, JSON.stringify(rules))
console.log(`regex: ${rules.length} rules, ${withAlternatives} with rewrites (${lossyAccepted} lossy rewrites passed the corpus gate, ${lossyRejected} rejected), corpus ${corpus.length} requests`)
