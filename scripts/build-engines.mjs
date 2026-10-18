// Builds the serialized adblock-rust engines for the service worker *inside wasm* (the same
// module the extension loads), grouping lists exactly like the compiler: lists with Brave's
// `first_party_protections` form the default engine, the rest the additional engine.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import init, { buildEngine, WasmEngine } from '../extension/build/wasm/shields_engine_wasm.js'

const root = path.resolve(import.meta.dirname, '..')
await init({ module_or_path: readFileSync(path.join(root, 'extension/build/wasm/shields_engine_wasm_bg.wasm')) })

const catalog = JSON.parse(readFileSync(path.join(root, 'data/list_catalog.json'), 'utf8'))
const mobileOnly = e => e.platforms?.length && e.platforms.every(p => p === 'IOS' || p === 'ANDROID')
const groups = { default: { lists: [], perms: [] }, additional: { lists: [], perms: [] } }
for (const e of catalog.filter(e => e.default_enabled && !mobileOnly(e))) {
  const text = e.sources.map((_, i) => readFileSync(path.join(root, 'data/lists', e.uuid, `${i}.txt`), 'utf8')).join('\n')
  const g = e.first_party_protections ? groups.default : groups.additional
  g.lists.push(text)
  g.perms.push(e.permission_mask ?? 0)
}
mkdirSync(path.join(root, 'extension/build/engine'), { recursive: true })
for (const [name, g] of Object.entries(groups)) {
  const t = performance.now()
  const dat = buildEngine(g.lists, Uint8Array.from(g.perms))
  writeFileSync(path.join(root, `extension/build/engine/${name}.dat`), dat)
  const eng = new WasmEngine(dat)
  console.log(`${name}.dat ${(dat.length / 1024) | 0} KB in ${(performance.now() - t) | 0}ms; probe:`,
    eng.hiddenClassIdSelectors(['aff-content-col', 'cookie-banner'], ['bt-ads'], []))
  eng.free()
}
