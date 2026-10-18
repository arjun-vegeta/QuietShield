// Safety gate: a lossy rewrite is accepted only if every extra corpus hit is a URL uBO blocks anyway.
import fs from 'node:fs'
const picked = JSON.parse(fs.readFileSync('research/regex/picked.json')).filter(p => p.pick)
const lines = fs.readFileSync(process.env.UBO, 'utf8').split('\n').slice(1)
const rows = lines.filter(Boolean).map(l => l.split('\t'))
const blocked = new Set(rows.filter(r => r[3] === '1').map(r => r[0]))
const urls = [...new Set(rows.map(r => r[0]))]
console.log('ubo corpus', urls.length, 'blocked', blocked.size)
let accepted = 0; const rejected = []
for (const p of picked) {
  const fl = p.cs ? '' : 'i'
  const orig = new RegExp(p.orig, fl), news = p.pick.regexes.map(r => new RegExp(r, fl))
  const fp = urls.filter(u => !orig.test(u) && news.some(r => r.test(u)) && !blocked.has(u))
  if (fp.length === 0) accepted++; else rejected.push({ i: p.i, tag: p.pick.tag, fp: fp.length, ex: fp.slice(0, 2).map(u => u.slice(0, 100)) })
  p.gate = fp.length === 0
}
console.log('accepted', accepted, 'rejected', rejected.length); for (const r of rejected) console.log(JSON.stringify(r))
fs.writeFileSync('research/regex/picked-gated.json', JSON.stringify(picked, null, 1))
