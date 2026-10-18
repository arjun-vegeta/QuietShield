// Re-splits "already blocked" by engine: Standard mode ignores default-engine (first_party_protections)
// blocks on first-party requests unless $important, so only additional-engine or important hits count.
import { readFileSync } from 'node:fs'
import init, { WasmEngine } from '../../extension/build/wasm/shields_engine_wasm.js'
await init({ module_or_path: readFileSync(new URL('../../extension/build/wasm/shields_engine_wasm_bg.wasm', import.meta.url)) })
const [def, add] = ['default', 'additional'].map(n => new WasmEngine(readFileSync(new URL(`../../extension/build/engine/${n}.dat`, import.meta.url))))
const map = JSON.parse(readFileSync(process.argv[2], 'utf8'))
let addHit = 0, defImportant = 0, defOnly = 0, none = 0
for (const host of Object.keys(map)) {
  const u = `https://${host}/t.js`, s = `https://${host}/`
  if (JSON.parse(add.check(u, s, 'script')).block) { addHit++; continue }
  const d = JSON.parse(def.check(u, s, 'script'))
  if (d.block && d.important) defImportant++; else if (d.block) defOnly++; else none++
}
console.log({ total: Object.keys(map).length, addHit, defImportant, defOnlyFppSuppressed: defOnly, none })
