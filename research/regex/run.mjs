// Builds rewrite candidates for every rejected regex rule, validates them in CfT, picks the least lossy.
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { candidates } from './rewrite.mjs'
const rows = JSON.parse(fs.readFileSync('research/regex/categorized.json'))
const fails = rows.filter(r => r.res !== 'ok')
const flat = []
for (const r of fails) { r.cands = candidates(r.re); for (const c of r.cands) for (const re of c.regexes) flat.push({ regex: re, cs: r.cs }) }
const uniq = [...new Map(flat.map(x => [x.regex + '\u0000' + x.cs, x])).values()]
fs.writeFileSync('research/regex/cand-in.json', JSON.stringify(uniq))
execFileSync('node', ['research/regex/check.mjs', 'research/regex/cand-in.json', 'research/regex/cand-out.json'], { stdio: 'inherit' })
const out = JSON.parse(fs.readFileSync('research/regex/cand-out.json'))
const ok = new Map(uniq.map((x, i) => [x.regex + '\u0000' + x.cs, out[i]]))
const summary = {}
const picked = []
for (const r of fails) {
  const c = r.cands.find(c => c.regexes.every(re => ok.get(re + '\u0000' + r.cs).isSupported))
  const tag = c ? c.tag.replace(/cap\d+/, m => m) : 'still-rejected'
  summary[r.res + ' -> ' + (c ? (c.exact ? 'exact:' : 'lossy:') + c.tag : 'still-rejected')] = (summary[r.res + ' -> ' + (c ? (c.exact ? 'exact:' : 'lossy:') + c.tag : 'still-rejected')] || 0) + 1
  picked.push({ i: r.i, orig: r.re, cs: r.cs, res: r.res, pick: c ?? null })
}
console.log(Object.entries(summary).sort())
console.log('rescued', picked.filter(p => p.pick).length, 'of', fails.length, '; extra rules from splits', picked.reduce((a, p) => a + (p.pick ? p.pick.regexes.length - 1 : 0), 0))
fs.writeFileSync('research/regex/picked.json', JSON.stringify(picked, null, 1))
