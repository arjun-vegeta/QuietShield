import { readFileSync } from 'node:fs'
import init, { WasmEngine } from '../extension/build/wasm/shields_engine_wasm.js'

const t0 = performance.now()
await init({ module_or_path: readFileSync(new URL('../extension/build/wasm/shields_engine_wasm_bg.wasm', import.meta.url)) })
const t1 = performance.now()
const eng = new WasmEngine(readFileSync(new URL('../extension/build/engine/default.dat', import.meta.url)))
const t2 = performance.now()
console.log(`wasm init ${(t1 - t0).toFixed(1)}ms, deserialize default.dat ${(t2 - t1).toFixed(1)}ms`)

const cases = [
  ['https://securepubads.g.doubleclick.net/tag/js/gpt.js', 'https://www.cnn.com/', 'script'],
  ['https://www.google-analytics.com/analytics.js', 'https://example.com/', 'script'],
  ['https://example.com/app.js', 'https://example.com/', 'script'],
  ['https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js', 'https://news.example/', 'script'],
]
for (const c of cases) console.log(eng.check(...c), c[0])
let t = performance.now()
for (let i = 0; i < 10000; i++) eng.check(cases[i % 4][0], cases[i % 4][1], cases[i % 4][2])
console.log(`check: ${((performance.now() - t) / 10000 * 1000).toFixed(1)}µs/request`)
t = performance.now()
const sel = eng.hiddenClassIdSelectors(['ad-banner', 'adsbygoogle', 'content', 'sidebar-ad'], ['ad_unit', 'main'], [])
console.log('hiddenClassIdSelectors', sel, `${(performance.now() - t).toFixed(2)}ms`)
console.log(JSON.parse(eng.urlCosmeticResources('https://www.youtube.com/')).hide_selectors.length, 'hide selectors for youtube')
