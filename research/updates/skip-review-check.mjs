// node research/updates/skip-review-check.mjs <oldRulesDir> <newRulesDir>
// Approximates Chrome Web Store "skip review" eligibility for a rules-only update: every rule
// added, removed or changed (matched by id, as rulesets are keyed by id) must be a safe rule
// (block, allow, allowAllRequests, upgradeScheme). Also: `--simulate` renumbers a copy of the
// current build after deleting one early rule, to show what sequential ids do to the diff.
import fs from 'node:fs'
import path from 'node:path'
const SAFE = new Set(['block', 'allow', 'allowAllRequests', 'upgradeScheme'])
const load = (dir) => Object.fromEntries(fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'regex.json')
  .map(f => [f, JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))]))
function diff (oldSets, newSets) {
  const out = { added: 0, removed: 0, changed: 0, unsafeTouched: 0, perFile: {} }
  for (const f of new Set([...Object.keys(oldSets), ...Object.keys(newSets)])) {
    const a = new Map((oldSets[f] ?? []).map(r => [r.id, r])), b = new Map((newSets[f] ?? []).map(r => [r.id, r]))
    let u = 0
    for (const [id, r] of b) {
      const o = a.get(id)
      if (!o) { out.added++; if (!SAFE.has(r.action.type)) u++ } else if (JSON.stringify(o) !== JSON.stringify(r)) {
        out.changed++; if (!SAFE.has(r.action.type) || !SAFE.has(o.action.type)) u++
      }
    }
    for (const [id, r] of a) if (!b.has(id)) { out.removed++; if (!SAFE.has(r.action.type)) u++ }
    out.unsafeTouched += u; if (u) out.perFile[f] = u
  }
  out.eligible = out.unsafeTouched === 0
  return out
}
// Stable ids: hash of the rule body (minus id) into [1, 2^31); collisions resolved by probing.
export function stableIds (rules) {
  const used = new Set()
  return rules.map(r => {
    const { id, ...body } = r
    let h = 2166136261; for (const c of JSON.stringify(body)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0 }
    let nid = (h % 0x7ffffffe) + 1; while (used.has(nid)) nid = nid % 0x7ffffffe + 1
    used.add(nid); return { ...body, id: nid }
  })
}
const [a, b] = process.argv.slice(2)
if (a === '--simulate') {
  const cur = load(b)
  const mutate = (sets, ids) => Object.fromEntries(Object.entries(sets).map(([f, rs]) => {
    const k = rs.findIndex(x => SAFE.has(x.action.type))
    let r = f === 'default.json' ? rs.filter((x, i) => i !== k) : rs
    r = ids === 'seq' ? r.map((x, i) => ({ ...x, id: i + 1 })) : stableIds(r)
    return [f, r]
  }))
  const seqOld = Object.fromEntries(Object.entries(cur).map(([f, r]) => [f, r.map((x, i) => ({ ...x, id: i + 1 }))]))
  const stOld = Object.fromEntries(Object.entries(cur).map(([f, r]) => [f, stableIds(r)]))
  console.log(JSON.stringify({
    scenario: 'remove one safe block rule near the top of default.json',
    sequentialIds: diff(seqOld, mutate(cur, 'seq')),
    contentHashIds: diff(stOld, mutate(cur, 'hash')),
  }, null, 1))
} else {
  console.log(JSON.stringify(diff(load(a), load(b)), null, 1))
}
