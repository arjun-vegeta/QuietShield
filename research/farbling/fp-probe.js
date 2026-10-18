// Evaluated in the page MAIN world (tests/probe.mjs). Returns fingerprints + farbling-detection signals.
(async () => {
  const h = (s) => { let x = 2166136261; for (let i = 0; i < s.length; i++) x = Math.imul(x ^ s.charCodeAt(i), 16777619); return (x >>> 0).toString(16) }
  const draw = (c) => { c.width = 220; c.height = 40; const x = c.getContext('2d'); x.textBaseline = 'top'; x.font = '14px Arial'; x.fillStyle = '#f60'; x.fillRect(100, 1, 62, 20); x.fillStyle = '#069'; x.fillText('QuietShield fp ☺', 2, 15); x.fillStyle = 'rgba(102,204,0,0.7)'; x.fillText('QuietShield fp ☺', 4, 17); return x }
  const canvasFp = (win = window) => { const c = win.document.createElement('canvas'); const x = draw(c); return { dataURL: h(win.HTMLCanvasElement.prototype.toDataURL.call(c)), imageData: h(Array.from(win.CanvasRenderingContext2D.prototype.getImageData.call(x, 0, 0, 220, 40).data).join()) } }
  const audioFp = async () => {
    const ctx = new OfflineAudioContext(1, 44100, 44100); const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = 10000
    const comp = ctx.createDynamicsCompressor(); o.connect(comp); comp.connect(ctx.destination); o.start(0)
    const buf = await ctx.startRendering(); const d = buf.getChannelData(0); let s = 0; for (let i = 4500; i < 5000; i++) s += Math.abs(d[i]); return s.toString()
  }
  const nativeRe = /^function \w*\(\) \{\s*\[native code\]\s*\}$/
  const ts = Function.prototype.toString
  const out = { host: location.host, canvas: canvasFp(), audio: await audioFp(), cores: navigator.hardwareConcurrency }
  const det = {}
  det.toDataURL_native = nativeRe.test(ts.call(HTMLCanvasElement.prototype.toDataURL))
  det.toString_native = nativeRe.test(ts.call(Function.prototype.toString))
  det.toString_viaIframe = (() => { const f = document.createElement('iframe'); document.body.append(f); const r = nativeRe.test(f.contentWindow.Function.prototype.toString.call(HTMLCanvasElement.prototype.toDataURL)); f.remove(); return r })()
  det.hasPrototypeProp = 'prototype' in HTMLCanvasElement.prototype.toDataURL
  det.getterNative = nativeRe.test(ts.call(Object.getOwnPropertyDescriptor(Navigator.prototype, 'hardwareConcurrency').get).replace('get hardwareConcurrency', 'hardwareConcurrency'))
  det.illegalInvocationStack = (() => { try { HTMLCanvasElement.prototype.toDataURL.call({}) } catch (e) { return e.stack.split('\n').slice(0, 3).join(' | ') } })()
  det.toStringOnProxyThrows = (() => { try { ts.call(new Proxy(() => {}, {})); return 'ok' } catch (e) { return e.message } })()
  // fresh realm: synchronous about:blank iframe, used before any injection could run
  det.freshIframe = (() => { const f = document.createElement('iframe'); document.body.append(f); const r = canvasFp(f.contentWindow); f.remove(); return r })()
  det.freshIframeMatchesTop = det.freshIframe.dataURL === out.canvas.dataURL
  // worker realm: content scripts never run in workers
  det.worker = await new Promise((res) => {
    const src = `const c=new OffscreenCanvas(220,40),x=c.getContext('2d');x.textBaseline='top';x.font='14px Arial';x.fillStyle='#f60';x.fillRect(100,1,62,20);x.fillStyle='#069';x.fillText('QuietShield fp ☺',2,15);x.fillStyle='rgba(102,204,0,0.7)';x.fillText('QuietShield fp ☺',4,17);
      const d=x.getImageData(0,0,220,40).data;let h=2166136261;const s=Array.from(d).join();for(let i=0;i<s.length;i++)h=Math.imul(h^s.charCodeAt(i),16777619);postMessage({imageData:(h>>>0).toString(16),cores:navigator.hardwareConcurrency})`
    const w = new Worker(URL.createObjectURL(new Blob([src])))
    w.onmessage = (e) => res(e.data); w.onerror = (e) => res('err ' + e.message); setTimeout(() => res('timeout'), 3000)
  })
  out.det = det
  return out
})()
