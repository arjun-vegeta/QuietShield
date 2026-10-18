// Hostname helpers shared by the content scripts. Content scripts can't afford a full Public
// Suffix List per frame, so registrable domains are approximated: a suffix is "public" if it is
// one label, or two labels where the first is short (co.uk, com.br, ne.jp, ...).

const isLikelyPublicSuffix = (labels) =>
  labels.length === 1 || (labels.length === 2 && labels[0].length <= 3)

/** Registrable domain, e.g. "news.bbc.co.uk" → "bbc.co.uk". */
export const registrableDomain = (hostname) => {
  const labels = hostname.split('.')
  if (labels.length <= 2) return hostname
  const lastTwo = labels.slice(-2)
  const suffixLen = isLikelyPublicSuffix(lastTwo) && lastTwo[1].length === 2 ? 2 : 1
  return labels.slice(-(suffixLen + 1)).join('.')
}

/** First label of the registrable domain ("youtube"), or the whole domain when `full`. */
export const registrableLabel = (hostname, full = false) => {
  const d = registrableDomain(hostname)
  return full ? d : d.split('.')[0]
}

export const isSameSite = (a, b) => registrableDomain(a) === registrableDomain(b)

/**
 * Lookup order for precomputed per-host data: the host and each parent domain (most specific
 * first), then `entity.*` keys for every plausible public-suffix split.
 */
export const candidateKeys = (hostname) => {
  const out = []
  for (let h = hostname; h; ) {
    out.push(h)
    const i = h.indexOf('.')
    if (i < 0) break
    h = h.slice(i + 1)
  }
  const labels = hostname.split('.')
  for (let end = labels.length - 1; end >= 1; end--) {
    if (!isLikelyPublicSuffix(labels.slice(end))) continue
    for (let start = 0; start < end; start++) out.push(labels.slice(start, end).join('.') + '.*')
  }
  return out
}
