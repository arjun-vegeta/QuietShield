// node research/scriptlets/count.mjs — counts scriptlet (+js) and $redirect usage in data/lists.
// Output: research/scriptlets/usage.json
import fs from 'node:fs'
import path from 'node:path'
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..')
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')

// --- alias maps -------------------------------------------------------------------------------
const ubo = JSON.parse(read('data/ubo-scriptlets.json'))
const brave = JSON.parse(read('data/brave-resources.json'))
const scriptletAlias = new Map() // alias -> canonical
const origin = new Map() // canonical -> 'uBO (GPLv3)' | 'Brave (MPL-2.0)'
const addS = (r, o) => {
  const canon = r.name
  origin.set(canon, o)
  for (const n of [r.name, ...(r.aliases ?? [])]) {
    scriptletAlias.set(n, canon)
    if (!n.endsWith('.js')) scriptletAlias.set(n + '.js', canon)
    else scriptletAlias.set(n.slice(0, -3), canon)
  }
}
ubo.forEach(r => addS(r, 'uBO (GPLv3)'))
brave.forEach(r => addS(r, 'Brave (MPL-2.0)'))

// redirect resources: uBO redirect-resources.js map (alias: string|string[])
const rr = read('vendor/uBlock/src/js/redirect-resources.js')
const redirAlias = new Map()
const redirOrigin = new Map()
for (const m of rr.matchAll(/\[\s*'([^']+)'\s*,\s*\{([^}]*)\}/g)) {
  const name = m[1]; redirAlias.set(name, name); redirOrigin.set(name, 'uBO (GPLv3)')
  const a = m[2].match(/alias:\s*(\[[^\]]*\]|'[^']*')/)
  if (a) for (const x of a[1].matchAll(/'([^']+)'/g)) redirAlias.set(x[1], name)
}
for (const r of brave) if (r.kind?.mime && !redirAlias.has(r.name)) { /* brave resources are scriptlet-only here */ }

// --- scan -------------------------------------------------------------------------------------
const listDir = path.join(root, 'data/lists')
const files = fs.readdirSync(listDir).flatMap(d => fs.readdirSync(path.join(listDir, d)).map(f => path.join(listDir, d, f)))
const sCount = new Map(), sHosts = new Map(), sExc = new Map(), sUnknown = new Map()
const rCount = new Map(), rUnknown = new Map()
const seenLines = new Set()
let jsLines = 0, jsLinesUnique = 0, redirectLines = 0
const inc = (m, k, n = 1) => m.set(k, (m.get(k) ?? 0) + n)
for (const f of files) {
  for (let line of fs.readFileSync(f, 'utf8').split('\n')) {
    line = line.trim()
    if (!line || line.startsWith('!') || line.startsWith('[')) continue
    const js = line.match(/^([^#]*)#(@?)#\+js\((.*)\)$/)
    if (js) {
      jsLines++
      const dup = seenLines.has(line); seenLines.add(line); if (!dup) jsLinesUnique++
      if (dup) continue
      let name = js[3].split(',')[0].trim().replace(/^["']|["']$/g, '')
      if (!name) continue
      const canon = scriptletAlias.get(name) ?? scriptletAlias.get(name + '.js') ?? redirAlias.get(name) ?? redirAlias.get(name + '.js')
      const key = canon ?? name
      if (!canon) inc(sUnknown, name)
      if (js[2] === '@') { inc(sExc, key); continue }
      inc(sCount, key)
      inc(sHosts, key, js[1] ? js[1].split(',').length : 1)
      continue
    }
    if (line.includes('#')) continue // other cosmetic
    const opt = line.lastIndexOf('$')
    if (opt < 0) continue
    for (const o of line.slice(opt + 1).split(',')) {
      const mm = o.match(/^(redirect|redirect-rule|rewrite)=(.+)$/)
      if (!mm) continue
      if (seenLines.has(line)) break
      seenLines.add(line)
      redirectLines++
      let name = mm[2].replace(/:-?\d+$/, '')
      if (mm[1] === 'rewrite') name = name.replace(/^abp-resource:/, '')
      const canon = redirAlias.get(name)
      if (!canon) inc(rUnknown, name)
      inc(rCount, (canon ?? name) + (mm[1] === 'redirect-rule' ? ' [redirect-rule]' : ''))
    }
  }
}
const sorted = (m) => [...m].sort((a, b) => b[1] - a[1])
const curve = (arr) => {
  const total = arr.reduce((s, [, n]) => s + n, 0)
  const out = {}; let acc = 0
  arr.forEach(([, n], i) => { acc += n; if ([5, 10, 15, 20, 25, 30, 40, 50].includes(i + 1)) out['top' + (i + 1)] = +(100 * acc / total).toFixed(2) })
  return { total, distinct: arr.length, coveragePct: out }
}
const sArr = sorted(sCount)
const rArr = sorted(rCount)
const result = {
  listFiles: files.length,
  scriptlets: {
    filterLines: jsLines, uniqueFilterLines: jsLinesUnique,
    ...curve(sArr),
    hostWeighted: curve(sorted(sHosts)),
    byName: sArr.map(([k, n]) => ({ name: k, filters: n, hostEntries: sHosts.get(k), origin: origin.get(k) ?? redirOrigin.get(k) ?? 'unknown' })),
    byOrigin: sArr.reduce((o, [k, n]) => { const g = origin.get(k) ?? redirOrigin.get(k) ?? 'unknown'; o[g] = (o[g] ?? 0) + n; return o }, {}),
    exceptions: Object.fromEntries(sorted(sExc)),
    unresolvedNames: Object.fromEntries(sorted(sUnknown)),
  },
  redirects: {
    uniqueFilterLines: redirectLines,
    ...curve(rArr),
    byName: rArr.map(([k, n]) => ({ name: k, filters: n, origin: redirOrigin.get(k.replace(' [redirect-rule]', '')) ?? 'unknown' })),
    unresolvedNames: Object.fromEntries(sorted(rUnknown)),
  },
}
fs.writeFileSync(path.join(root, 'research/scriptlets/usage.json'), JSON.stringify(result, null, 1))
console.log(JSON.stringify({ ...result, scriptlets: { ...result.scriptlets, byName: result.scriptlets.byName.slice(0, 30) }, redirects: { ...result.redirects, byName: result.redirects.byName.slice(0, 25) } }, null, 1))
