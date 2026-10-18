// Service worker: owns the WebAssembly adblock-rust engines, ruleset/mode state, the per-host
// cosmetic data in chrome.storage.local, and content-script registration.

import init, { WasmEngine } from '../build/wasm/shields_engine_wasm.js'

const BUILD = chrome.runtime.getURL('build/')
const DEFAULT_SETTINGS = { enabled: true, mode: 'standard', sites: {}, blockCrossSiteCookies: false }

// ---- WebAssembly engines (lazy; the worker may be torn down after 30s idle) ----------------
let enginesPromise
const engines = () => {
  enginesPromise ??= (async () => {
    const t = performance.now()
    await init({ module_or_path: BUILD + 'wasm/shields_engine_wasm_bg.wasm' })
    const load = async (name) => new WasmEngine(new Uint8Array(await (await fetch(BUILD + `engine/${name}.dat`)).arrayBuffer()))
    const [def, add] = await Promise.all([load('default'), load('additional')])
    console.log(`[shields] wasm engines ready in ${(performance.now() - t).toFixed(0)}ms`)
    return { def, add }
  })()
  return enginesPromise
}

// url → { d: exceptions[], a: exceptions[] } (Brave passes `exceptions` back with each query)
const exceptionCache = new Map()
const exceptionsFor = (eng, url) => {
  let e = exceptionCache.get(url)
  if (!e) {
    e = {
      d: JSON.parse(eng.def.urlCosmeticResources(url)).exceptions,
      a: JSON.parse(eng.add.urlCosmeticResources(url)).exceptions,
    }
    exceptionCache.set(url, e)
    if (exceptionCache.size > 200) exceptionCache.delete(exceptionCache.keys().next().value)
  }
  return e
}

// ---- settings ----------------------------------------------------------------------------------
const getSettings = async () => ({ ...DEFAULT_SETTINGS, ...(await chrome.storage.local.get('settings')).settings })

const SHIELDS_DOWN_RULE_BASE = 2_000_000

async function applySettings () {
  const settings = await getSettings()
  const all = await fetch(BUILD + 'rulesets.json').then(r => r.json())
  const ids = all.map(r => r.id)
  const aggressive = settings.mode === 'aggressive'
  const enable = settings.enabled ? ids.filter(id => aggressive || !id.endsWith('-aggressive')) : []
  await chrome.declarativeNetRequest.updateEnabledRulesets({
    enableRulesetIds: enable,
    disableRulesetIds: ids.filter(id => !enable.includes(id)),
  })

  // Dynamic rules: regex filters for the current mode, plus per-site "Shields down" (Brave's
  // per-site toggle). Everything is removed when the extension is switched off.
  const down = Object.entries(settings.sites ?? {}).filter(([, s]) => s.off).map(([d]) => d)
  const { regexRules = [] } = await chrome.storage.local.get('regexRules')
  const addRules = settings.enabled ? regexRules.filter(r => aggressive || !r.aggressive).map(r => r.rule) : []
  if (settings.enabled && down.length) {
    addRules.push({ id: SHIELDS_DOWN_RULE_BASE, priority: 10_000_000, action: { type: 'allowAllRequests' }, condition: { requestDomains: down, resourceTypes: ['main_frame', 'sub_frame'] } })
  }
  const existing = await chrome.declarativeNetRequest.getDynamicRules()
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: existing.map(r => r.id), addRules })
  await registerScriptlets(settings, down)
  await applyCookieSetting(settings)
}

// ---- cross-site cookies (opt-in; Brave blocks them by default) -------------------------------
// Uses the optional `privacy` permission, requested from the popup. Clearing our value hands the
// setting back to the user's own Chrome preference (also happens automatically on uninstall).
async function applyCookieSetting (settings) {
  if (!(await chrome.permissions.contains({ permissions: ['privacy'] }))) return
  const pref = chrome.privacy.websites.thirdPartyCookiesAllowed
  if (settings.enabled && settings.blockCrossSiteCookies) await pref.set({ value: false })
  else await pref.clear({})
}

// ---- regex rules (validated at runtime against Chrome's RE2 limits) --------------------------
// Each rule carries `alternatives`: the original regex first, then build-time rewrites
// (scripts/regex-alternatives.mjs). We keep the first alternative Chrome accepts; split rewrites
// become several rules. The result is stored and applied per mode by applySettings().
async function prepareRegexRules () {
  const rules = await fetch(BUILD + 'rules/regex.json').then(r => r.json())
  const supported = async (re, cs) => (await chrome.declarativeNetRequest.isRegexSupported({ regex: re, isCaseSensitive: cs })).isSupported
  const out = []
  let rewritten = 0
  let nextId = 1_000_000
  for (const r of rules) {
    if (out.length >= chrome.declarativeNetRequest.MAX_NUMBER_OF_REGEX_RULES - 50) break
    const { group, aggressive, alternatives = [[r.condition.regexFilter]], id, ...rule } = r
    const cs = !!rule.condition.isUrlFilterCaseSensitive
    for (const [i, alt] of alternatives.entries()) {
      let ok = true
      for (const re of alt) if (!(await supported(re, cs))) { ok = false; break }
      if (!ok) continue
      if (i > 0) rewritten++
      for (const re of alt) {
        out.push({ aggressive: !!aggressive, rule: { ...rule, id: nextId++, condition: { ...rule.condition, regexFilter: re } } })
      }
      break
    }
  }
  await chrome.storage.local.set({ regexRules: out })
  const kept = new Set(out.map(o => o.rule.priority + o.rule.condition.regexFilter)).size
  console.log(`[shields] regex: ${out.length} rules from ${rules.length} filters (${rewritten} via rewrites, ${kept} distinct)`)
}

// ---- cosmetic data → storage.local -----------------------------------------------------------
async function installCosmeticData () {
  const t = performance.now()
  const hosts = await fetch(BUILD + 'cosmetic/hosts.json').then(r => r.json())
  const old = Object.keys(await chrome.storage.local.get(null)).filter(k => k.startsWith('h:'))
  if (old.length) await chrome.storage.local.remove(old)
  const entries = Object.entries(hosts)
  for (let i = 0; i < entries.length; i += 5000) {
    await chrome.storage.local.set(Object.fromEntries(entries.slice(i, i + 5000).map(([k, v]) => ['h:' + k, v])))
  }
  console.log(`[shields] ${entries.length} cosmetic host entries stored in ${(performance.now() - t).toFixed(0)}ms`)
}

// ---- scriptlets: MAIN world, document_start, before page scripts ------------------------------
async function registerScriptlets (settings, down) {
  const shards = await fetch(BUILD + 'scriptlets/shards.json').then(r => r.json())
  const existing = await chrome.scripting.getRegisteredContentScripts()
  const ours = existing.filter(s => s.id.startsWith('scriptlets-'))
  if (ours.length) await chrome.scripting.unregisterContentScripts({ ids: ours.map(s => s.id) })
  if (!settings.enabled) return
  const excludeMatches = down.flatMap(d => [`*://${d}/*`, `*://*.${d}/*`])
  await chrome.scripting.registerContentScripts(shards.map((s, i) => ({
    id: `scriptlets-${i}`,
    js: [s.file],
    matches: s.matches,
    excludeMatches,
    allFrames: true,
    matchOriginAsFallback: true,
    runAt: 'document_start',
    world: 'MAIN',
    persistAcrossSessions: true,
  })))
}

// ---- lifecycle ---------------------------------------------------------------------------------
chrome.runtime.onInstalled.addListener(async () => {
  const { settings } = await chrome.storage.local.get('settings')
  if (!settings) await chrome.storage.local.set({ settings: DEFAULT_SETTINGS })
  await Promise.all([installCosmeticData(), prepareRegexRules()])
  await applySettings()
  chrome.declarativeNetRequest.setExtensionActionOptions({ displayActionCountAsBadgeText: true })
  if (!isStoreInstall()) {
    chrome.alarms.create('update-check', { delayInMinutes: 1, periodInMinutes: 24 * 60 })
  }
  console.log('[shields] installed')
})

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) applySettings()
})

// ---- update check (GitHub installs only) --------------------------------------------------------
// Unpacked/GitHub installs never auto-update, so once a day we ask GitHub's public releases API
// whether a newer version exists and surface it in the popup. Web Store installs (which carry an
// injected `update_url`) update through the store and skip this. Users can turn it off.
const RELEASES_API = 'https://api.github.com/repos/arjun-vegeta/QuietShield/releases/latest'
const isStoreInstall = () => 'update_url' in chrome.runtime.getManifest()

const newerVersion = (latest, current) => {
  const a = latest.replace(/^v/, '').split('.').map(Number)
  const b = current.split('.').map(Number)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  }
  return false
}

async function checkForUpdates () {
  const settings = await getSettings()
  if (isStoreInstall() || settings.updateCheck === false) {
    await chrome.storage.local.remove('update')
    return null
  }
  try {
    const res = await fetch(RELEASES_API, { headers: { Accept: 'application/vnd.github+json' }, credentials: 'omit', cache: 'no-store' })
    if (!res.ok) return null
    const { tag_name: tag, html_url: url } = await res.json()
    const current = chrome.runtime.getManifest().version
    const update = tag && newerVersion(tag, current) ? { version: tag.replace(/^v/, ''), url, checkedAt: Date.now() } : null
    if (update) await chrome.storage.local.set({ update })
    else await chrome.storage.local.remove('update')
    return update
  } catch {
    return null
  }
}

chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'update-check') checkForUpdates() })
chrome.runtime.onStartup.addListener(() => checkForUpdates())

// ---- messages from content scripts -------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'classIds') {
    engines().then((eng) => {
      const url = sender.url ?? sender.origin
      // Brave merges both engines' exceptions and passes them to both lookups.
      const ex = exceptionsFor(eng, url)
      const all = [...ex.d, ...ex.a]
      sendResponse({
        hide: eng.def.hiddenClassIdSelectors(msg.classes, msg.ids, all),
        force: eng.add.hiddenClassIdSelectors(msg.classes, msg.ids, all),
      })
    }, () => sendResponse(null))
    return true
  }
  if (msg?.type === 'insertCSS' && sender.tab) {
    chrome.scripting.insertCSS({
      target: { tabId: sender.tab.id, frameIds: [sender.frameId ?? 0] },
      css: msg.css,
      origin: 'USER',
    }).then(() => sendResponse(true), () => sendResponse(false))
    return true
  }
  if (msg?.type === 'check') {
    // Debug/test hook: run Brave's network matcher (both engines) on a URL.
    engines().then((eng) => sendResponse({
      default: JSON.parse(eng.def.check(msg.url, msg.source, msg.requestType)),
      additional: JSON.parse(eng.add.check(msg.url, msg.source, msg.requestType)),
    }))
    return true
  }
  if (msg?.type === 'checkForUpdates') {
    checkForUpdates().then(sendResponse)
    return true
  }
  if (msg?.type === 'getSettings') {
    getSettings().then(sendResponse)
    return true
  }
  return false
})
