// RE2-budget rewriter for adblock regex filters that Chrome DNR rejects.
// Usage as module: import { candidates } from './rewrite.mjs'
// A tiny parser for the regex subset used in filter lists (no backrefs in Brave's lists).
const INF = Infinity

export function parse (src) {
  let i = 0
  function alt () {
    const branches = [seq()]
    while (src[i] === '|') { i++; branches.push(seq()) }
    return { t: 'alt', branches }
  }
  function seq () {
    const items = []
    while (i < src.length && src[i] !== '|' && src[i] !== ')') {
      let atom = atomP()
      const q = quant()
      if (q) atom = { t: 'rep', atom, ...q }
      items.push(atom)
    }
    return { t: 'seq', items }
  }
  function quant () {
    const c = src[i]
    let q = null
    if (c === '*') { i++; q = { min: 0, max: INF } } else if (c === '+') { i++; q = { min: 1, max: INF } } else if (c === '?') { i++; q = { min: 0, max: 1 } } else if (c === '{') {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(src.slice(i))
      if (m) { i += m[0].length; q = { min: +m[1], max: m[2] ? (m[3] === '' ? INF : +m[3]) : +m[1] } }
    }
    if (q && src[i] === '?') { i++; q.lazy = true }
    return q
  }
  function atomP () {
    const c = src[i]
    if (c === '(') {
      i++
      let kind = 'cap'
      if (src[i] === '?') {
        const m = /^\?(:|=|!|<=|<!)/.exec(src.slice(i))
        kind = m[1]; i += m[0].length
      }
      const a = alt()
      if (src[i] !== ')') throw new Error('unbalanced at ' + i)
      i++
      return { t: 'group', kind, alt: a }
    }
    if (c === '[') {
      let j = i + 1
      if (src[j] === '^') j++
      if (src[j] === ']') j++
      while (src[j] !== ']') { if (src[j] === '\\') j++; j++ }
      const s = src.slice(i, j + 1); i = j + 1
      return { t: 'class', s }
    }
    if (c === '\\') { const s = src.slice(i, i + 2); i += 2; return { t: /^\\[bB]$/.test(s) ? 'anchor' : 'char', s } }
    if (c === '^' || c === '$') { i++; return { t: 'anchor', s: c } }
    i++
    return { t: 'char', s: c }
  }
  const ast = alt()
  if (i !== src.length) throw new Error('trailing at ' + i)
  return ast
}

export function ser (n) {
  switch (n.t) {
    case 'alt': return n.branches.map(ser).join('|')
    case 'seq': return n.items.map(ser).join('')
    case 'group': return '(' + (n.kind === 'cap' ? '?:' : '?' + n.kind) + ser(n.alt) + ')'
    case 'rep': {
      const a = ser(n.atom)
      const q = n.min === 0 && n.max === INF ? '*' : n.min === 1 && n.max === INF ? '+' : n.min === 0 && n.max === 1 ? '?' : n.min === n.max ? `{${n.min}}` : `{${n.min},${n.max === INF ? '' : n.max}}`
      return a + q + (n.lazy ? '?' : '')
    }
    default: return n.s
  }
}

const clone = (x) => JSON.parse(JSON.stringify(x, (k, v) => v === INF ? 'INF' : v), (k, v) => v === 'INF' ? INF : v)
function walk (n, f) { f(n); if (n.t === 'alt') n.branches.forEach(b => walk(b, f)); else if (n.t === 'seq') n.items.forEach(x => walk(x, f)); else if (n.t === 'group') walk(n.alt, f); else if (n.t === 'rep') walk(n.atom, f) }

// Exact: collapse runs of identical atoms ([0-9a-f][0-9a-f]... -> [0-9a-f]{32}). Same RE2 program, but makes capping possible.
export function collapse (ast) {
  walk(ast, (n) => {
    if (n.t !== 'seq') return
    const out = []
    for (const it of n.items) {
      const prev = out[out.length - 1]
      const key = (x) => x.t === 'rep' ? ser(x.atom) : ser(x)
      const cnt = (x) => x.t === 'rep' ? [x.min, x.max] : [1, 1]
      if (prev && (it.t === 'class' || (it.t === 'rep' && it.atom.t === 'class')) && (prev.t === 'class' || (prev.t === 'rep' && prev.atom.t === 'class')) && key(prev) === key(it) && !prev.lazy && !it.lazy) {
        const [a, b] = cnt(prev); const [c, d] = cnt(it)
        out[out.length - 1] = { t: 'rep', atom: prev.t === 'rep' ? prev.atom : prev, min: a + c, max: b + d }
      } else out.push(it)
    }
    n.items = out
  })
  return ast
}

// Broadening: drop lookarounds.
export function dropLook (ast) {
  let changed = false
  walk(ast, (n) => { if (n.t === 'seq') { const l = n.items.length; n.items = n.items.filter(x => !(x.t === 'group' && ['=', '!', '<=', '<!'].includes(x.kind))); changed ||= l !== n.items.length } })
  return changed
}

// Broadening: cap every counted repetition at K: X{n,m} -> X{min(n,K),} when n>K or (finite m)>K.
export function capReps (ast, K) {
  let changed = false
  walk(ast, (n) => {
    if (n.t !== 'rep') return
    if (n.min > K || (n.max !== INF && n.max > K)) { n.min = Math.min(n.min, K); n.max = INF; changed = true }
  })
  return changed
}

// Exact: split a top-level alternation into separate regexes, keeping a shared ^ anchor where needed.
export function splitTop (src) {
  const ast = parse(src)
  if (ast.branches.length > 1) return ast.branches.map(ser)
  // Also split the first group alternation after a leading ^...: ^a(?:x|y)b -> ^axb, ^ayb (only if ≤8 branches)
  return [src]
}

// Ordered candidate list, least lossy first. Each: { regexes: [..], lossy: tag }
export function candidates (src) {
  const out = []
  const base = ser(collapse(parse(src)))
  out.push({ tag: 'collapse', exact: true, regexes: [base] })
  const parts = splitTop(base)
  if (parts.length > 1) out.push({ tag: 'split', exact: true, regexes: parts })
  const lk = parse(base)
  const hadLook = dropLook(lk)
  const noLook = ser(lk)
  if (hadLook) out.push({ tag: 'drop-lookaround', exact: false, regexes: splitTop(noLook) })
  for (const K of [48, 32, 24, 16, 12, 10, 8, 6, 4, 3, 2, 1]) {
    const a = parse(noLook)
    if (capReps(a, K)) out.push({ tag: (hadLook ? 'drop-lookaround+' : '') + 'cap' + K, exact: false, K, regexes: splitTop(ser(a)) })
  }
  return out
}
