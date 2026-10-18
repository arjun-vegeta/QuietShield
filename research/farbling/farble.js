// Prototype MAIN-world fingerprint farbling, modelled on brave-core's "Balanced" farbling:
//  - canvas: getImageData / toDataURL / toBlob return pixel data with a few low bits flipped,
//    chosen by a PRNG seeded from (session seed, top-level eTLD+1, image content) — stable for the
//    same image on the same site within a session, different across sites/sessions.
//  - audio: AudioBuffer.getChannelData / copyFromChannel and AnalyserNode.get*FrequencyData get a
//    tiny per-site multiplicative fudge (Brave: BraveSessionCache::FarbleAudioChannel).
//  - navigator.hardwareConcurrency: per-site value in [2, real] (Brave balanced).
// Wrappers are Proxies of the natives, so toString from any realm prints native code.
//
// The seed MUST be secret and per-session (Brave: per-session key, HMAC'd with eTLD+1). A static
// content script cannot carry runtime data synchronously; the intended delivery is
// chrome.userScripts.register({ js: [{ code: `(${farble})(${JSON.stringify(seed)})` }], world: 'MAIN',
// runAt: 'document_start', allFrames: true }) from the service worker, re-registered at startup with a
// fresh seed from crypto.getRandomValues (kept in chrome.storage.session).
function farble (SEED) {
  'use strict'
  // ---- seeded hashing / PRNG ------------------------------------------------------------------
  const imul = Math.imul
  const cyrb = (str, h1 = 0xdeadbeef, h2 = 0x41c6ce57) => {
    for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); h1 = imul(h1 ^ c, 2654435761); h2 = imul(h2 ^ c, 1597334677) }
    h1 = imul(h1 ^ (h1 >>> 16), 2246822507) ^ imul(h2 ^ (h2 >>> 13), 3266489909)
    h2 = imul(h2 ^ (h2 >>> 16), 2246822507) ^ imul(h1 ^ (h1 >>> 13), 3266489909)
    return (h1 >>> 0) ^ ((h2 >>> 0) * 0x9e3779b1 >>> 0)
  }
  const prng = (a) => () => { a |= 0; a = a + 0x6d2b79f5 | 0; let t = imul(a ^ a >>> 15, 1 | a); t = t + imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296 }
  // Top-level site: ancestorOrigins' last entry for iframes (Chromium). TODO: real PSL lookup.
  const topHost = (() => { try { const ao = location.ancestorOrigins; return new URL(ao && ao.length ? ao[ao.length - 1] : location.origin).hostname } catch { return location.hostname } })()
  const site = topHost.split('.').slice(-2).join('.')
  const domainKey = cyrb(SEED + '|' + site)

  const apply = Reflect.apply
  // ---- native-looking wrappers ----------------------------------------------------------------
  // Proxies around the native function: Function.prototype.toString (from ANY realm) prints the
  // target's native source, name/length/'prototype' are forwarded — no toString patch needed.
  // Errors thrown through the trap get our own frames stripped (V8 'stack' is an own data prop).
  const OWN = /^\s*at .*(chrome-extension:|moz-extension:).*$\n?/gm
  // If the page installed Error.prepareStackTrace, V8 will hand it CallSite objects that include our
  // frames when the stack is first read; force formatting now through a filter that drops them.
  const ownSite = (c) => /^(chrome|moz)-extension:/.test(String(c.getFileName?.() ?? ''))
  const clean = (e) => {
    try {
      const hook = Error.prepareStackTrace
      if (typeof hook === 'function') {
        Error.prepareStackTrace = (err, sites) => apply(hook, Error, [err, sites.filter(c => !ownSite(c))])
        try { void e.stack } finally { Error.prepareStackTrace = hook }
      } else if (e && typeof e.stack === 'string') e.stack = e.stack.replace(OWN, '')
    } catch {}
    return e
  }
  const wrap = (orig, fn) => new Proxy(orig, { apply (t, self, args) { try { return fn(t, self, args) } catch (e) { throw clean(e) } } })
  const wrapMethod = (proto, name, make) => {
    const d = Object.getOwnPropertyDescriptor(proto, name)
    if (!d || typeof d.value !== 'function') return
    d.value = wrap(d.value, make(d.value))
    Object.defineProperty(proto, name, d)
  }
  const wrapGetter = (proto, name, make) => {
    const d = Object.getOwnPropertyDescriptor(proto, name)
    if (!d || !d.get) return
    d.get = wrap(d.get, make(d.get))
    Object.defineProperty(proto, name, d)
  }
  // ---- canvas -----------------------------------------------------------------------------------
  const C2D = CanvasRenderingContext2D.prototype
  const origGetImageData = C2D.getImageData
  const origPut = C2D.putImageData
  const origGetCtx = HTMLCanvasElement.prototype.getContext
  const perturb = (data) => {
    const n = data.length
    if (!n) return data
    let h = domainKey
    for (let i = 0; i < n; i += Math.max(4, (n >> 8) & ~3)) h = imul(h ^ data[i] ^ (data[i + 1] << 8) ^ (data[i + 2] << 16), 16777619)
    const r = prng(h)
    const pixels = n >> 2
    const flips = Math.min(2048, Math.max(16, pixels >> 7))
    for (let k = 0; k < flips; k++) {
      const p = (r() * pixels | 0) << 2
      if (data[p + 3] === 0) continue // leave fully transparent pixels alone (Brave does too)
      data[p + (r() * 3 | 0)] ^= 1
    }
    return data
  }
  wrapMethod(C2D, 'getImageData', () => (t, self, a) => { const img = apply(t, self, a); perturb(apply(imgData, img, [])); return img })
  // Never call page-patchable globals from inside a wrapper: a page hook could take new Error().stack
  // there and see our frames. Capture every primitive we need up front.
  const createEl = Document.prototype.createElement
  const ownerDoc = Object.getOwnPropertyDescriptor(Node.prototype, 'ownerDocument').get
  const cw = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'width')
  const ch = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'height')
  const drawImage = C2D.drawImage
  const imgData = Object.getOwnPropertyDescriptor(ImageData.prototype, 'data').get
  const farbledCopy = (canvas) => {
    const w = apply(cw.get, canvas, []), h = apply(ch.get, canvas, [])
    if (!w || !h) return canvas
    const copy = apply(createEl, apply(ownerDoc, canvas, []), ['canvas'])
    apply(cw.set, copy, [w]); apply(ch.set, copy, [h])
    const cx = apply(origGetCtx, copy, ['2d'])
    apply(drawImage, cx, [canvas, 0, 0])
    const img = apply(origGetImageData, cx, [0, 0, w, h])
    perturb(apply(imgData, img, []))
    apply(origPut, cx, [img, 0, 0])
    return copy
  }
  wrapMethod(HTMLCanvasElement.prototype, 'toDataURL', () => (t, self, a) => apply(t, farbledCopy(self), a))
  wrapMethod(HTMLCanvasElement.prototype, 'toBlob', () => (t, self, a) => apply(t, farbledCopy(self), a))

  // ---- audio ------------------------------------------------------------------------------------
  const fudge = 0.99 + prng(domainKey ^ 0xa0d10)() * 0.01 // Brave balanced: multiplicative fudge in [0.99, 1)
  const done = new WeakSet()
  if (typeof AudioBuffer !== 'undefined') {
    wrapMethod(AudioBuffer.prototype, 'getChannelData', () => (t, self, a) => {
      const d = apply(t, self, a)
      if (!done.has(d)) { for (let i = 0; i < d.length; i++) d[i] *= fudge; done.add(d) }
      return d
    })
    wrapMethod(AudioBuffer.prototype, 'copyFromChannel', () => (t, self, a) => {
      const r = apply(t, self, a); const dest = a[0]; for (let i = 0; i < dest.length; i++) dest[i] *= fudge; return r
    })
  }
  if (typeof AnalyserNode !== 'undefined') {
    for (const m of ['getFloatFrequencyData', 'getFloatTimeDomainData']) {
      wrapMethod(AnalyserNode.prototype, m, () => (t, self, a) => { const r = apply(t, self, a); const arr = a[0]; for (let i = 0; i < arr.length; i++) arr[i] *= fudge; return r })
    }
  }

  // ---- navigator.hardwareConcurrency --------------------------------------------------------------
  wrapGetter(Navigator.prototype, 'hardwareConcurrency', () => (t, self, a) => {
    const real = apply(t, self, a)
    return real <= 2 ? real : 2 + (prng(domainKey ^ 0xc0c0)() * (real - 1) | 0)
  })
}
if (typeof module === 'object') module.exports = farble
