// Builds {entityLabel: [suffix, ...]} for every `label.*` entity used in network-filter domain options,
// from (a) concrete hostnames the lists themselves mention and (b) the N most common public suffixes.
// node research/regex/entity-suffixes.mjs [topN=0] > research/regex/entity-suffixes.json
import fs from 'node:fs'
const topN = +(process.argv[2] ?? 0)
const cat = JSON.parse(fs.readFileSync('data/list_catalog.json'))
let text = ''
for (const e of cat) { if (!e.default_enabled) continue; for (let i = 0; i < e.sources.length; i++) { try { text += fs.readFileSync(`data/lists/${e.uuid}/${i}.txt`, 'utf8') + '\n' } catch {} } }
const entities = new Set()
for (const m of text.matchAll(/(?:domain|from|to)=([^,\s$]+)/g)) for (const d of m[1].split('|')) { const x = d.replace(/^~/, ''); if (x.endsWith('.*')) entities.add(x.slice(0, -2)) }
for (const m of text.matchAll(/^([^#\s]*?)#[@?$%]?#/gm)) for (const d of m[1].split(',')) { const x = d.replace(/^~/, ''); if (x.endsWith('.*')) entities.add(x.slice(0, -2)) }
const hosts = new Set(text.toLowerCase().match(/[a-z0-9][-a-z0-9.]*\.[a-z][-a-z0-9]{1,62}(?![-a-z0-9.]*\*)/g))
const FILE_EXT = new Set('js css php html htm json png gif jpg jpeg svg txt xml mp4 mp3 webp woff woff2 ttf ico swf aspx asp jsp cgi gz zip m3u8 ts vtt map webm avif'.split(' '))
const isSuffix = (s) => { if (FILE_EXT.has(s)) return false; const p = s.split('.'); return p.length === 1 ? /^[a-z]{2,24}$|^xn--/.test(p[0]) : p.length === 2 && p[0].length <= 3 && /^[a-z]{2,3}$/.test(p[1]) }
const suffixFreq = new Map()
const bySuffixedLabel = new Map()
for (const h of hosts) {
  const labels = h.split('.')
  for (let k = labels.length - 1; k >= 1; k--) {
    const suf = labels.slice(k).join('.')
    if (!isSuffix(suf)) continue
    if (k === labels.length - 1) suffixFreq.set(suf, (suffixFreq.get(suf) || 0) + 1)
    for (let s = 0; s < k; s++) { const lab = labels.slice(s, k).join('.'); if (!bySuffixedLabel.has(lab)) bySuffixedLabel.set(lab, new Set()); bySuffixedLabel.get(lab).add(suf) }
  }
}
const top = [...suffixFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN).map(([s]) => s)
const out = {}
let total = 0, withObserved = 0
for (const e of [...entities].sort()) {
  const obs = [...(bySuffixedLabel.get(e) ?? [])]
  if (obs.length) withObserved++
  out[e] = [...new Set([...obs, ...top])].sort()
  total += out[e].length
}
console.error(JSON.stringify({ entities: entities.size, withObservedSuffix: withObserved, totalDomains: total, avgPerEntity: +(total / entities.size).toFixed(1), topSuffixes: top.slice(0, 20) }))
process.stdout.write(JSON.stringify(out))
