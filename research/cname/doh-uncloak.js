// Prototype: CNAME uncloaking in an MV3 service worker via DNS-over-HTTPS (observational).
//
// Needs the "webRequest" permission (observe-only; no blocking in MV3) to learn which first-party
// subdomains a page loads. declarativeNetRequest.onRuleMatchedDebug is unpacked-only, so it can't be
// the source in a store build. The first request to a cloaked host is NOT blocked (we only learn of it
// after it is sent); later requests are, once the dynamic rule lands (~1 DoH RTT later).
//
// isBlockedHost(host, pageHost) => bool  — supplied by the caller (wasm engine check of
// `https://<canonical>/` from the page, i.e. Brave's ShouldBlockAdWithOptionalCname re-check).

const DOH = 'https://cloudflare-dns.com/dns-query' // or https://dns.google/resolve (same JSON shape)
const CNAME = 5
const RULE_BASE = 3_000_000 // above SHIELDS_DOWN_RULE_BASE (2_000_000)
const MAX_RULES = 5_000     // dynamic budget for uncloaked hosts (shares the 30k dynamic cap)
const cache = new Map()     // host -> { chain: string[], exp: ms }
const inflight = new Map()

export async function cnameChain (host) {
  const c = cache.get(host)
  if (c && c.exp > Date.now()) return c.chain
  if (inflight.has(host)) return inflight.get(host)
  const p = (async () => {
    const r = await fetch(`${DOH}?name=${encodeURIComponent(host)}&type=CNAME`, { headers: { accept: 'application/dns-json' } })
    const j = await r.json()
    const ans = (j.Answer ?? []).filter(a => a.type === CNAME)
    const chain = ans.map(a => a.data.replace(/\.$/, '').toLowerCase())
    const ttl = Math.max(300, Math.min(...ans.map(a => a.TTL), 86400)) * 1000
    cache.set(host, { chain, exp: Date.now() + (chain.length ? ttl : 3600_000) })
    return chain
  })().finally(() => inflight.delete(host))
  inflight.set(host, p)
  return p
}

const etld1 = (h) => h.split('.').slice(-2).join('.') // TODO: use the PSL (adblock-rust has one in wasm)

export function startUncloaking ({ isBlockedHost }) {
  let nextId = RULE_BASE
  const ruled = new Set()
  chrome.webRequest.onBeforeRequest.addListener(async (d) => {
    if (!d.initiator) return
    const host = new URL(d.url).hostname
    const page = new URL(d.initiator).hostname
    // Only same-site subdomains can be "cloaked"; third-party hosts are matched by DNR already.
    if (host === page || etld1(host) !== etld1(page) || ruled.has(host)) return
    const chain = await cnameChain(host).catch(() => [])
    if (!chain.length || !chain.some(c => isBlockedHost(c, page))) return
    ruled.add(host)
    if (ruled.size > MAX_RULES) return
    await chrome.declarativeNetRequest.updateDynamicRules({
      addRules: [{ id: nextId++, priority: 12, action: { type: 'block' }, condition: { requestDomains: [host] } }],
    })
  }, { urls: ['<all_urls>'], types: ['script', 'image', 'xmlhttprequest', 'ping', 'sub_frame', 'other'] })
}
