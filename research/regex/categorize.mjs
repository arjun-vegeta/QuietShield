import fs from 'node:fs'
const rules = JSON.parse(fs.readFileSync('extension/build/rules/regex.json'))
const res = JSON.parse(fs.readFileSync('research/regex/orig-out.json'))
const c = {}; const feats = {}
const feat = (re) => {
  const f = []
  if (/\(\?[=!<]/.test(re)) f.push('lookaround')
  if (/\\[1-9]/.test(re)) f.push('backref')
  const reps = [...re.matchAll(/\{(\d+)(?:,(\d*))?\}/g)].map(m => Math.max(+m[1], m[2] ? +m[2] : 0))
  const mx = Math.max(0, ...reps)
  if (mx >= 20) f.push('rep>=20'); else if (mx >= 8) f.push('rep8-19'); else if (reps.length) f.push('rep<8')
  const sumrep = reps.reduce((a, b) => a + b, 0)
  if (sumrep >= 30) f.push('sumrep>=30')
  if (/\\d|\\w|\\s/.test(re)) f.push('class-escape')
  if (/\|/.test(re)) f.push('alternation')
  if (/\.\*|\.\+/.test(re)) f.push('dotstar')
  if (!re.startsWith('^')) f.push('unanchored')
  return f
}
const rows = rules.map((r, i) => ({ i, group: r.group, re: r.condition.regexFilter, cs: !!r.condition.isUrlFilterCaseSensitive, res: res[i].isSupported ? 'ok' : res[i].reason, f: feat(r.condition.regexFilter), len: r.condition.regexFilter.length, action: r.action.type }))
for (const r of rows) { c[r.res] = (c[r.res] || 0) + 1; for (const f of r.f) { feats[f] ??= { ok: 0, memoryLimitExceeded: 0, syntaxError: 0 }; feats[f][r.res]++ } }
console.log(c); console.table(feats)
const byGroup = {}; for (const r of rows) { byGroup[r.group] ??= {}; byGroup[r.group][r.res] = (byGroup[r.group][r.res] || 0) + 1 }; console.log(byGroup)
const byAction = {}; for (const r of rows) { byAction[r.action] ??= {}; byAction[r.action][r.res] = (byAction[r.action][r.res] || 0) + 1 }; console.log(byAction)
console.log('syntax errors:'); for (const r of rows.filter(r => r.res === 'syntaxError')) console.log(r.re)
console.log('len stats fail/ok', ['ok', 'memoryLimitExceeded'].map(k => { const l = rows.filter(r => r.res === k).map(r => r.len).sort((a, b) => a - b); return k + ' median ' + l[l.length >> 1] }))
console.log('sample mem fails:'); for (const r of rows.filter(r => r.res === 'memoryLimitExceeded').slice(0, 40)) console.log(r.i, r.re)
fs.writeFileSync('research/regex/categorized.json', JSON.stringify(rows, null, 1))
