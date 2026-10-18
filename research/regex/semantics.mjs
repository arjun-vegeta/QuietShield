// Under/over-blocking check of picked rewrites: randexp positives from the original + real-URL corpus.
import fs from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(process.env.TOOLS + '/package.json')
const RandExp = require('randexp')
const picked = JSON.parse(fs.readFileSync('research/regex/picked.json')).filter(p => p.pick)
const urls = fs.readFileSync(process.env.CORPUS, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).url)
console.log('corpus urls', urls.length)
let under = 0, totalPos = 0, overRules = 0, overHits = 0, origHits = 0
const rows = []
for (const p of picked) {
  const fl = p.cs ? '' : 'i'
  const orig = new RegExp(p.orig, fl)
  const news = p.pick.regexes.map(r => new RegExp(r, fl))
  const gen = new RandExp(new RegExp(p.orig.replace(/\(\?[=!][^()]*\)/g, ''), fl)); gen.max = 40
  let u = 0, n = 0
  for (let k = 0; k < 200; k++) { const s = gen.gen(); if (!orig.test(s)) continue; n++; if (!news.some(r => r.test(s))) u++ }
  under += u; totalPos += n
  let o = 0, oh = 0; const ex = []
  for (const url of urls) { const a = orig.test(url), b = news.some(r => r.test(url)); if (a) oh++; if (b && !a) { o++; if (ex.length < 2) ex.push(url.slice(0, 120)) } }
  origHits += oh
  if (o) { overRules++; overHits += o }
  rows.push({ i: p.i, tag: p.pick.tag, positives: n, under: u, corpusOrig: oh, corpusExtra: o, ex })
}
console.log({ rules: picked.length, positivesTested: totalPos, underBlocked: under, corpusOrigHits: origHits, rulesWithExtraCorpusHits: overRules, extraCorpusHits: overHits })
for (const r of rows.filter(r => r.corpusExtra || r.under)) console.log(JSON.stringify(r))
fs.writeFileSync('research/regex/semantics.json', JSON.stringify(rows, null, 1))
