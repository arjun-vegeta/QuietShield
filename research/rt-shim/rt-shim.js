// research/rea-fixes prototype: synthesize Resource Timing entries for scripts that DNR redirected to
// a web_accessible_resource (Chrome drops the entry when the final URL is chrome-extension:/data:).
// MAIN world, document_start. Entries mimic a cross-origin, non-TAO load (responseStatus 0,
// transferSize 0) — i.e. what plain Chrome reports for a real gpt.js without Timing-Allow-Origin —
// rather than Brave's tell-tale responseStatus 200.
(() => {
  const fakes = new WeakMap() // fake entry -> fields
  const list = [] // fake entries in insertion order
  const observers = new Set()
  const P = PerformanceResourceTiming.prototype
  const E = PerformanceEntry.prototype
  const realGetters = new Map()
  const toStr = Function.prototype.toString
  const native = new WeakMap() // wrapper -> original (for toString masking)
  const mask = (wrapper, orig) => { native.set(wrapper, orig); return wrapper }
  Function.prototype.toString = new Proxy(toStr, { apply (t, self, args) { return Reflect.apply(t, native.get(self) ?? self, args) } })
  native.set(Function.prototype.toString, toStr)

  // Patch every accessor on PerformanceResourceTiming/PerformanceEntry so brand checks pass on fakes.
  for (const proto of [P, E]) {
    for (const [k, d] of Object.entries(Object.getOwnPropertyDescriptors(proto))) {
      if (!d.get) continue
      const orig = d.get
      realGetters.set(proto === E ? 'E.' + k : k, orig)
      const g = new Proxy(orig, { apply (t, self, args) {
        const f = fakes.get(self); if (f) return f[k]
        try { return Reflect.apply(t, self, args) } catch (err) {
          // Cross-realm: a fresh same-origin iframe's getter applied to a fake from an ancestor realm.
          // Ask the ancestors' (patched) getters; no shared global is needed.
          for (let w = window; w !== w.parent;) {
            w = w.parent
            try { const d = Object.getOwnPropertyDescriptor((proto === E ? w.PerformanceEntry : w.PerformanceResourceTiming).prototype, k); return d.get.call(self) } catch {}
          }
          throw err
        }
      } })
      Object.defineProperty(proto, k, { ...d, get: g }); native.set(g, orig)
    }
  }
  const origToJSON = P.toJSON
  P.toJSON = new Proxy(origToJSON, { apply (t, self, args) { const f = fakes.get(self); return f ? { ...f } : Reflect.apply(t, self, args) } })
  native.set(P.toJSON, origToJSON)

  const merge = (real, filter) => {
    const fs = list.filter(filter)
    if (!fs.length) return real
    return [...real, ...fs].sort((a, b) => a.startTime - b.startTime)
  }
  for (const [name, filt] of [['getEntries', () => () => true], ['getEntriesByType', (t) => () => t === 'resource'], ['getEntriesByName', (n, t) => (e) => fakes.get(e).name === n && (t === undefined || t === 'resource')]]) {
    const orig = Performance.prototype[name]
    const w = new Proxy(orig, { apply (t, self, args) { return merge(Reflect.apply(t, self, args), filt(...args)) } })
    Performance.prototype[name] = w; native.set(w, orig)
  }
  // PerformanceObserver: deliver fakes to resource observers (incl. buffered:true).
  const OrigPO = PerformanceObserver
  const origObserve = OrigPO.prototype.observe
  const cbOf = new WeakMap()
  const POProxy = new Proxy(OrigPO, { construct (t, [cb], nt) { const o = Reflect.construct(t, [cb], nt); cbOf.set(o, cb); return o } })
  const observe = new Proxy(origObserve, { apply (t, self, args) {
    const opts = args[0] || {}
    if (opts.type === 'resource' || (opts.entryTypes || []).includes('resource')) {
      observers.add(self)
      if (opts.buffered && list.length) queueMicrotask(() => deliver(self, list.slice()))
    }
    return Reflect.apply(t, self, args)
  } })
  OrigPO.prototype.observe = observe; native.set(observe, origObserve)
  window.PerformanceObserver = POProxy; native.set(POProxy, OrigPO)
  const deliver = (o, entries) => {
    const cb = cbOf.get(o); if (!cb) return
    const elist = Object.create(PerformanceObserverEntryList.prototype)
    // Minimal list facade (a real implementation would patch the EntryList getters like above).
    Object.defineProperties(elist, { getEntries: { value: () => entries }, getEntriesByType: { value: (t) => t === 'resource' ? entries : [] }, getEntriesByName: { value: (n) => entries.filter(e => fakes.get(e).name === n) } })
    try { cb.call(o, elist, o) } catch (e) { setTimeout(() => { throw e }) }
  }

  const synth = (url, start, end) => {
    const e = Object.create(P)
    const f = { name: url, entryType: 'resource', startTime: start, duration: end - start, initiatorType: 'script', deliveryType: '', nextHopProtocol: '', renderBlockingStatus: 'non-blocking', contentType: '', workerStart: 0, redirectStart: 0, redirectEnd: 0, fetchStart: start, domainLookupStart: 0, domainLookupEnd: 0, connectStart: 0, connectEnd: 0, secureConnectionStart: 0, requestStart: 0, firstInterimResponseStart: 0, responseStart: 0, responseEnd: end, finalResponseHeadersStart: 0, transferSize: 0, encodedBodySize: 0, decodedBodySize: 0, responseStatus: 0, serverTiming: [], workerTiming: [] }
    fakes.set(e, f); list.push(e)
    for (const o of observers) deliver(o, [e])
  }
  // Detect redirected scripts: on load, a script whose URL has no real entry was served by us.
  const getByName = Performance.prototype.getEntriesByName
  const pending = new WeakMap()
  const onLoad = (ev) => {
    const s = ev.target
    if (!(s instanceof HTMLScriptElement) || !s.src || !/^https?:/.test(s.src)) return
    const start = pending.get(s) ?? performance.now() - 2
    const real = Reflect.apply(OrigGetByName, performance, [s.src])
    if (real.length === 0 && !list.some(e => fakes.get(e).name === s.src)) synth(s.src, start, performance.now())
  }
  const OrigGetByName = Object.getPrototypeOf(performance).getEntriesByName === getByName ? native.get(getByName) : getByName
  document.addEventListener('load', onLoad, true)
  // Record start time when a script src is attached (best effort).
  new MutationObserver(ms => { for (const m of ms) for (const n of m.addedNodes) if (n instanceof HTMLScriptElement && n.src) pending.set(n, performance.now()) }).observe(document, { childList: true, subtree: true })
})()
//# sourceURL=<anonymous>
