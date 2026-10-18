// Cosmetic filtering content script (ISOLATED world, document_start, all frames).
//
// Port of brave-core's components/cosmetic_filters/resources/data/content_cosmetic.ts
// (MPL-2.0) plus the C++ glue from cosmetic_filters_js_handler.cc that drives it. Where Brave
// calls into the browser process (`cf_worker.*`), we read precomputed per-host data from
// chrome.storage.local and ask the service worker's WebAssembly adblock-rust engine.

import { applyCompiledSelector, compileProceduralSelector } from './vendor/brave/procedural_filters'
import { candidateKeys, isSameSite, registrableLabel } from './hosts.js'

// ---- tunables (brave_shields features.cc defaults) ----------------------------------------
const maxTimeMSBeforeStart = 2500
const minAdTextChars = 30
const minAdTextWords = 5
const returnToMutationObserverIntervalMs = 10000
const selectorsPollingIntervalMs = 500
const scoreCalcIntervalMs = 1000
const pumpIntervalMinMs = 40
const pumpIntervalMaxMs = 1000
const maxWorkSize = 60
const VETTED_SEARCH_ENGINES = new Set(['duckduckgo', 'qwant', 'bing', 'startpage', 'google', 'yandex', 'ecosia', 'brave'])

const hostname = (() => {
  try { return location.hostname || new URL(self.origin).hostname } catch { return '' }
})()

const isCrossOriginToTop = (() => {
  if (window === window.top) return false
  try { return window.top.location.origin !== location.origin } catch { return true }
})()

const sendMessage = (msg) => chrome.runtime.sendMessage(msg).catch(() => undefined)

// ---- stylesheets ----------------------------------------------------------------------------
// Brave's "hide_selectors" path: a constructed sheet whose rules can be removed again by the
// first-party heuristics below.
const cosmeticStyleSheet = new CSSStyleSheet()
// Instant fallback for "force" rules until the USER-origin sheet from the service worker lands.
const forceStyleSheet = new CSSStyleSheet()
const allSelectorsToRules = new Map()

const adopt = (sheet) => {
  if (!document.adoptedStyleSheets.includes(sheet)) {
    document.adoptedStyleSheets = [sheet, ...document.adoptedStyleSheets]
  }
}

// Brave: InjectStylesheet → WebDocument::InsertStyleSheet(css, kUser).
const pendingUserCss = []
let userCssTimer
const injectStylesheet = (css) => {
  if (!css) return
  for (const rule of css.split('}\n')) {
    if (!rule.trim()) continue
    try { forceStyleSheet.insertRule(rule.endsWith('}') ? rule : rule + '}', forceStyleSheet.cssRules.length) } catch {}
  }
  adopt(forceStyleSheet)
  pendingUserCss.push(css)
  if (userCssTimer === undefined) {
    userCssTimer = setTimeout(() => {
      userCssTimer = undefined
      const css = pendingUserCss.splice(0).join('')
      sendMessage({ type: 'insertCSS', css }).then((ok) => {
        // Once the user-origin sheet is in place the page-visible copy is no longer needed.
        if (ok && pendingUserCss.length === 0) {
          document.adoptedStyleSheets = document.adoptedStyleSheets.filter(s => s !== forceStyleSheet)
          while (forceStyleSheet.cssRules.length) forceStyleSheet.deleteRule(0)
        }
      })
    }, 0)
  }
}

const forceHide = (selectors) => {
  if (!selectors.length) return
  injectStylesheet(selectors.map(s => `${s}{display:none !important}\n`).join(''))
}

// ---- state (Brave: window.content_cosmetic) ---------------------------------------------------
const CC = {
  hide1pContent: false,
  generichide: false,
  firstRunQueue: new Set(),
  secondRunQueue: new Set(),
  finalRunQueue: new Set(),
  alreadyUnhiddenSelectors: new Set(),
  alreadyKnownFirstPartySubtrees: new WeakSet(),
  _hasDelayOcurred: false,
  _startCheckingId: undefined,
  observingHasStarted: false,
  firstSelectorsPollingDelayMs: window === window.top ? undefined : 1000,
  switchToSelectorsPollingThreshold: 1000,
  fetchNewClassIdRulesThrottlingMs: 100,
  proceduralActionFilters: undefined,
  hasProceduralActions: false,
  vettedSearchEngine: false,
}
CC.allQueues = [CC.firstRunQueue, CC.secondRunQueue, CC.finalRunQueue]
CC.numQueues = CC.allQueues.length

// Brave: kHideSelectorsInjectScript
const hideSelectors = (selectors) => {
  // With first-party hiding there is no unhide path, so rules go straight to the USER-origin sheet.
  if (CC.hide1pContent) return forceHide(selectors.filter(s => typeof s === 'string'))
  let nextIndex = cosmeticStyleSheet.cssRules.length
  for (const selector of selectors) {
    if (typeof selector !== 'string') continue
    if (!CC.hide1pContent && allSelectorsToRules.has(selector)) continue
    const rule = selector + '{display:none !important;}'
    try {
      cosmeticStyleSheet.insertRule(rule, nextIndex)
      if (!CC.hide1pContent) {
        allSelectorsToRules.set(selector, nextIndex)
        CC.firstRunQueue.add(selector)
      }
      nextIndex++
    } catch {
      // invalid selector for this engine
    }
  }
  if (cosmeticStyleSheet.cssRules.length) adopt(cosmeticStyleSheet)
}

// ---- class/id collection (content_cosmetic.ts) ----------------------------------------------
const classIdWithoutHtmlOrBody = '[id]:not(html):not(body),[class]:not(html):not(body)'
const queriedIds = new Set()
const queriedClasses = new Set()
const notYetQueriedElements = []
let notYetQueriedClasses = []
let notYetQueriedIds = []
let selectorsPollingIntervalId
let currentMutationScore = 0
let currentMutationStartTime = performance.now()
let nextFetchNewClassIdRulesCall = 0
let fetchNewClassIdRulesTimeoutId

const idleize = (onIdle, timeout) => {
  let idleId
  return function WillRunOnIdle () {
    if (idleId !== undefined) return
    idleId = window.requestIdleCallback(() => { idleId = undefined; onIdle() }, { timeout })
  }
}

const shouldThrottleFetchNewClassIdsRules = () => {
  if (fetchNewClassIdRulesTimeoutId) return true
  const now = performance.now()
  const msToWait = nextFetchNewClassIdRulesCall - now
  if (msToWait > 0) {
    fetchNewClassIdRulesTimeoutId = setTimeout(() => {
      fetchNewClassIdRulesTimeoutId = undefined
      fetchNewClassIdRules()
    }, msToWait)
    return true
  }
  nextFetchNewClassIdRulesCall = now + CC.fetchNewClassIdRulesThrottlingMs
  return false
}

const queueElementIdAndClasses = (element) => {
  const id = element.id
  if (id && !queriedIds.has(id)) {
    notYetQueriedIds.push(id)
    queriedIds.add(id)
  }
  for (const className of element.classList.values()) {
    if (className && !queriedClasses.has(className)) {
      notYetQueriedClasses.push(className)
      queriedClasses.add(className)
    }
  }
}

// Brave: cf_worker.hiddenClassIdSelectors → browser → adblock-rust; here: service worker → wasm.
const fetchNewClassIdRules = () => {
  for (const elements of notYetQueriedElements) {
    for (const element of elements) queueElementIdAndClasses(element)
  }
  notYetQueriedElements.length = 0
  if (notYetQueriedClasses.length === 0 && notYetQueriedIds.length === 0) return
  const classes = notYetQueriedClasses
  const ids = notYetQueriedIds
  notYetQueriedClasses = []
  notYetQueriedIds = []
  sendMessage({ type: 'classIds', classes, ids }).then(onHiddenClassIdSelectors)
}

// Brave: CosmeticFiltersJSHandler::OnHiddenClassIdSelectors
const onHiddenClassIdSelectors = (result) => {
  if (!result || CC.generichide) return
  forceHide(result.force ?? [])
  if (!CC.hide1pContent && CC.vettedSearchEngine) return
  const hide = result.hide ?? []
  if (CC.hide1pContent) {
    forceHide(hide)
  } else if (hide.length) {
    hideSelectors(hide)
    tryScheduleQueuePump()
  }
}

const useMutationObserver = () => {
  if (selectorsPollingIntervalId) {
    clearInterval(selectorsPollingIntervalId)
    selectorsPollingIntervalId = undefined
  }
  const observer = new MutationObserver(onMutations)
  observer.observe(document.documentElement, { subtree: true, childList: true, attributeFilter: ['id', 'class'] })
}

const usePolling = (observer) => {
  if (observer) {
    observer.disconnect()
    notYetQueriedElements.length = 0
  }
  const futureTimeMs = Date.now() + returnToMutationObserverIntervalMs
  selectorsPollingIntervalId = setInterval(() => queryAttrsFromDocument(futureTimeMs), selectorsPollingIntervalMs)
}

const queueAttrsFromMutations = (mutations) => {
  let mutationScore = 0
  for (const aMutation of mutations) {
    if (aMutation.type === 'attributes') {
      const changedElm = aMutation.target
      if (aMutation.attributeName === 'class') {
        mutationScore += changedElm.classList.length
        for (const aClassName of changedElm.classList.values()) {
          if (!queriedClasses.has(aClassName)) {
            notYetQueriedClasses.push(aClassName)
            queriedClasses.add(aClassName)
          }
        }
      } else if (aMutation.attributeName === 'id') {
        const mutatedId = changedElm.id
        mutationScore++
        if (!queriedIds.has(mutatedId)) {
          notYetQueriedIds.push(mutatedId)
          queriedIds.add(mutatedId)
        }
      }
    } else if (aMutation.addedNodes.length > 0) {
      for (const node of aMutation.addedNodes) {
        if (node.nodeType !== 1) continue
        notYetQueriedElements.push([node])
        mutationScore += 1
        if (node.firstElementChild !== null) {
          const nodeList = node.querySelectorAll(classIdWithoutHtmlOrBody)
          notYetQueriedElements.push(nodeList)
          mutationScore += nodeList.length
        }
      }
    }
  }
  return mutationScore
}

const onMutations = (mutations, observer) => {
  const mutationScore = queueAttrsFromMutations(mutations)
  const now = performance.now()
  if (now > currentMutationStartTime + scoreCalcIntervalMs) {
    currentMutationStartTime = now
    currentMutationScore = 0
  }
  currentMutationScore += mutationScore
  if (currentMutationScore > CC.switchToSelectorsPollingThreshold) usePolling(observer)

  if (!CC.generichide && !shouldThrottleFetchNewClassIdsRules()) fetchNewClassIdRules()

  if (CC.hasProceduralActions) {
    const addedElements = []
    for (const mutation of mutations) {
      for (const n of mutation.addedNodes) {
        if (n.nodeType !== Node.ELEMENT_NODE) continue
        addedElements.push(n)
        for (const c of n.querySelectorAll('*')) addedElements.push(c)
      }
    }
    if (addedElements.length) executeProceduralActions(addedElements)
  }
}

// ---- first-party heuristics ------------------------------------------------------------------
const isRelativeUrl = (url) => !url.startsWith('//') && !url.startsWith('http://') && !url.startsWith('https://')

// Brave: cf_worker.isFirstPartyUrl → SameDomainOrHost(url, frame origin)
const isFirstPartyUrl = (url) => {
  if (isRelativeUrl(url)) return true
  try { return isSameSite(new URL(url, location.href).hostname, hostname) } catch { return false }
}

const stripChildTagsFromText = (elm, tagName, text) => {
  let localText = text
  for (const anElm of elm.getElementsByTagName(tagName)) localText = localText.replaceAll(anElm.innerText, '')
  return localText
}

const showsSignificantText = (elm) => {
  if (!('innerText' in elm)) return false
  let currentText = elm.innerText
  for (const aTagName of ['script', 'style']) currentText = stripChildTagsFromText(elm, aTagName, currentText)
  const trimmedText = currentText.trim()
  if (trimmedText.length < minAdTextChars) return false
  let wordCount = 0
  for (const aWord of trimmedText.split(' ')) if (aWord.trim().length) wordCount += 1
  return wordCount >= minAdTextWords
}

const isSubTreeFirstParty = (elm, possibleQueryResult) => {
  let queryResult
  let isTopLevel
  if (possibleQueryResult) {
    queryResult = possibleQueryResult
    isTopLevel = false
  } else {
    queryResult = { foundFirstPartyResource: false, foundThirdPartyResource: false, foundKnownThirdPartyAd: false }
    isTopLevel = true
  }
  if (elm.getAttribute) {
    if (elm.hasAttribute('id')) {
      const elmId = elm.getAttribute('id')
      if (elmId.startsWith('google_ads_iframe_') || elmId.startsWith('div-gpt-ad') || elmId.startsWith('adfox_')) {
        queryResult.foundKnownThirdPartyAd = true
        return false
      }
    }
    if (elm.hasAttribute('src')) {
      if (isFirstPartyUrl(elm.getAttribute('src'))) {
        queryResult.foundFirstPartyResource = true
        return true
      }
      queryResult.foundThirdPartyResource = true
    }
    if (elm.hasAttribute('style')) {
      const elmStyle = elm.getAttribute('style')
      if (elmStyle.includes('url(') || elmStyle.includes('//')) queryResult.foundThirdPartyResource = true
    }
    if (elm.hasAttribute('srcdoc') && elm.getAttribute('srcdoc').trim() === '') {
      queryResult.foundThirdPartyResource = true
    }
  }
  if (elm.firstChild) {
    isSubTreeFirstParty(elm.firstChild, queryResult)
    if (queryResult.foundKnownThirdPartyAd) return false
    if (queryResult.foundFirstPartyResource) return true
  }
  if (elm.nextSibling) {
    isSubTreeFirstParty(elm.nextSibling, queryResult)
    if (queryResult.foundKnownThirdPartyAd) return false
    if (queryResult.foundFirstPartyResource) return true
  }
  if (!isTopLevel) return !queryResult.foundThirdPartyResource
  return !queryResult.foundThirdPartyResource
}

// ---- move settled selectors to a USER-origin sheet ----------------------------------------------
// A selector that survived Brave's last first-party check is never unhidden again, so it can leave
// the page-visible adopted sheet. Pages then see no adoptedStyleSheet at steady state (Brave keeps
// its sheet, which exposes ~550 list selectors to document.adoptedStyleSheets) and cannot remove
// the rules (USER !important also beats author !important).
const pendingSettled = []
let settleTimer
const dropRule = (selector) => {
  const idx = allSelectorsToRules.get(selector)
  if (idx === undefined) return
  cosmeticStyleSheet.deleteRule(idx)
  allSelectorsToRules.delete(selector)
  for (const [s, i] of allSelectorsToRules) if (i > idx) allSelectorsToRules.set(s, i - 1)
}
const settleSelector = (selector) => {
  if (!allSelectorsToRules.has(selector)) return
  pendingSettled.push(selector)
  if (settleTimer !== undefined) return
  settleTimer = setTimeout(() => {
    settleTimer = undefined
    const batch = pendingSettled.splice(0)
    // One rule per selector: an invalid selector must not poison the batch.
    const css = batch.map(s => `${s}{display:none !important}\n`).join('')
    sendMessage({ type: 'insertCSS', css }).then((ok) => {
      if (!ok) return
      for (const s of batch) dropRule(s)
      if (cosmeticStyleSheet.cssRules.length === 0) {
        document.adoptedStyleSheets = document.adoptedStyleSheets.filter(s => s !== cosmeticStyleSheet)
      }
    })
  }, 50)
}

const unhideSelectors = (selectors) => {
  if (selectors.size === 0) return
  // Rebuild index after deletion; simpler and less error-prone than Brave's in-place resync.
  for (const selector of selectors) {
    const idx = allSelectorsToRules.get(selector)
    if (idx === undefined) continue
    cosmeticStyleSheet.deleteRule(idx)
    allSelectorsToRules.delete(selector)
    for (const [s, i] of allSelectorsToRules) if (i > idx) allSelectorsToRules.set(s, i - 1)
  }
}

let queueIsSleeping = false
const pumpCosmeticFilterQueues = () => {
  if (queueIsSleeping) return
  let didPumpAnything = false
  for (let queueIndex = 0; queueIndex < CC.numQueues; queueIndex += 1) {
    const currentQueue = CC.allQueues[queueIndex]
    const nextQueue = CC.allQueues[queueIndex + 1]
    if (currentQueue.size === 0) continue
    const currentWorkLoad = Array.from(currentQueue.values()).slice(0, maxWorkSize)
    let matchingElms = []
    try { matchingElms = document.querySelectorAll(currentWorkLoad.join(',')) } catch {
      // One invalid selector poisons the combo; fall back to individual queries.
      matchingElms = currentWorkLoad.flatMap(s => { try { return [...document.querySelectorAll(s)] } catch { return [] } })
    }
    const newlyIdentifiedFirstPartySelectors = new Set()
    for (const aMatchingElm of matchingElms) {
      if (CC.alreadyKnownFirstPartySubtrees.has(aMatchingElm)) continue
      if (!(isSubTreeFirstParty(aMatchingElm) || showsSignificantText(aMatchingElm))) continue
      for (const selector of currentWorkLoad) {
        let matches = false
        try { matches = aMatchingElm.matches(selector) } catch {}
        if (!matches || CC.alreadyUnhiddenSelectors.has(selector)) continue
        newlyIdentifiedFirstPartySelectors.add(selector)
        CC.alreadyUnhiddenSelectors.add(selector)
      }
      CC.alreadyKnownFirstPartySubtrees.add(aMatchingElm)
    }
    unhideSelectors(newlyIdentifiedFirstPartySelectors)
    for (const aUsedSelector of currentWorkLoad) {
      currentQueue.delete(aUsedSelector)
      if (newlyIdentifiedFirstPartySelectors.has(aUsedSelector)) continue
      if (nextQueue) nextQueue.add(aUsedSelector)
      else settleSelector(aUsedSelector)
    }
    didPumpAnything = true
    break
  }
  if (didPumpAnything) {
    queueIsSleeping = true
    setTimeout(() => {
      queueIsSleeping = false
      pumpCosmeticFilterQueuesOnIdle()
    }, pumpIntervalMinMs)
  }
}
const pumpCosmeticFilterQueuesOnIdle = idleize(pumpCosmeticFilterQueues, pumpIntervalMaxMs)

const queryAttrsFromDocument = (switchToMutationObserverAtTime) => {
  if (!CC.generichide) {
    for (const elm of document.querySelectorAll(classIdWithoutHtmlOrBody)) queueElementIdAndClasses(elm)
    fetchNewClassIdRules()
  }
  if (CC.hasProceduralActions) executeProceduralActions()
  if (switchToMutationObserverAtTime !== undefined && Date.now() >= switchToMutationObserverAtTime) useMutationObserver()
}

const startObserving = () => {
  queryAttrsFromDocument()
  useMutationObserver()
}

const scheduleQueuePump = (hide1pContent, genericHide) => {
  if (CC._hasDelayOcurred) {
    pumpCosmeticFilterQueuesOnIdle()
    return
  }
  if (CC._startCheckingId !== undefined) return
  CC._startCheckingId = window.requestIdleCallback(() => {
    CC._hasDelayOcurred = true
    if (!genericHide || CC.hasProceduralActions) {
      if (CC.firstSelectorsPollingDelayMs === undefined) startObserving()
      else setTimeout(startObserving, CC.firstSelectorsPollingDelayMs)
    }
    if (!hide1pContent) pumpCosmeticFilterQueuesOnIdle()
  }, { timeout: maxTimeMSBeforeStart })
}

const tryScheduleQueuePump = () => {
  if (!CC.observingHasStarted) {
    CC.observingHasStarted = true
    scheduleQueuePump(CC.hide1pContent, CC.generichide)
  } else {
    scheduleQueuePump(false, false)
  }
}

// ---- procedural filters ----------------------------------------------------------------------
const generateRandomAttr = () => {
  const min = Number.parseInt('a000000000', 36)
  const max = Number.parseInt('zzzzzzzzzz', 36)
  return Math.floor(Math.random() * (max - min) + min).toString(36)
}
const globalStyleAttr = generateRandomAttr()
const styleAttrMap = new Map()

const executeProceduralActions = (added) => {
  if (CC.proceduralActionFilters === undefined) return
  const getStyleAttr = (style) => {
    let styleAttr = styleAttrMap.get(style)
    if (styleAttr === undefined) {
      styleAttr = generateRandomAttr()
      styleAttrMap.set(style, styleAttr)
      injectStylesheet(`[${globalStyleAttr}][${styleAttr}]{${style}}\n`)
    }
    return styleAttr
  }
  const performAction = (element, action) => {
    if (action === undefined) {
      const attr = getStyleAttr('display: none !important')
      element.setAttribute(globalStyleAttr, '')
      element.setAttribute(attr, '')
    } else if (action.type === 'style') {
      const attr = getStyleAttr(action.arg)
      element.setAttribute(globalStyleAttr, '')
      element.setAttribute(attr, '')
    } else if (action.type === 'remove') {
      element.remove()
    } else if (action.type === 'remove-attr') {
      element.removeAttribute(action.arg)
    } else if (action.type === 'remove-class') {
      if (element.classList.contains(action.arg)) element.classList.remove(action.arg)
    }
  }
  for (const { selector, action } of CC.proceduralActionFilters) {
    try {
      let matchingElements
      let startOperator
      if (selector[0].type === 'css-selector' && added === undefined) {
        matchingElements = document.querySelectorAll(selector[0].arg)
        startOperator = 1
      } else if (added === undefined) {
        matchingElements = document.querySelectorAll('*')
        startOperator = 0
      } else {
        matchingElements = added
        startOperator = 0
      }
      if (startOperator === selector.length) {
        matchingElements.forEach((elem) => performAction(elem, action))
      } else {
        const filter = compileProceduralSelector(selector.slice(startOperator))
        applyCompiledSelector(filter, matchingElements).forEach((elem) => performAction(elem, action))
      }
    } catch {
      // malformed filter for this page
    }
  }
}

// Brave: kProceduralActionsScript — pure `selector:style(...)` rules become a stylesheet.
const setupProceduralActions = (jsonFilters) => {
  let stylesheet = ''
  const filters = []
  for (const json of jsonFilters) {
    let f
    try { f = JSON.parse(json) } catch { continue }
    if (f.selector.length === 1 && f.selector[0].type === 'css-selector' && f.action && f.action.type === 'style') {
      stylesheet += f.selector[0].arg + '{' + f.action.arg + '}\n'
    } else {
      filters.push(f)
    }
  }
  CC.proceduralActionFilters = filters
  CC.hasProceduralActions = filters.length > 0
  injectStylesheet(stylesheet)
}

// AdBlockEngineWrapper::StripProceduralFilters keeps single `css-selector` filters (actions).
const isActionOnlyFilter = (json) => {
  try {
    const f = JSON.parse(json)
    return f.selector.length === 1 && f.selector[0].type === 'css-selector'
  } catch { return false }
}

// ---- entry point (Brave: ProcessURL + ApplyRules + CSSRulesRoutine) ---------------------------
const pickEntry = (store) => {
  for (const k of candidateKeys(hostname)) {
    const v = store['h:' + k]
    if (v !== undefined) return v
  }
  return null
}

async function main () {
  if (!hostname) return
  const keys = candidateKeys(hostname)
  const store = await chrome.storage.local.get(['settings', ...keys.map(k => 'h:' + k)])
  const settings = store.settings ?? {}
  if (settings.enabled === false) return
  const site = settings.sites?.[registrableLabel(hostname, true)] ?? {}
  if (site.off) return
  const aggressive = (site.mode ?? settings.mode ?? 'standard') === 'aggressive'

  const G = globalThis.SHIELDS_GENERIC ?? { d: [], a: [], ghd: [], gha: [] }
  const entry = { ...(pickEntry(store) ?? {}) }
  // URL-pattern `$generichide` exceptions, evaluated per URL like Brave does.
  const href = location.href
  const matchesAny = (sources) => (sources ?? []).some(src => { try { return new RegExp(src, 'i').test(href) } catch { return false } })
  if (matchesAny(G.ghd)) entry.dg = true
  if (matchesAny(G.gha)) entry.ag = true
  CC.generichide = !!(entry.gh || entry.dg || entry.ag)
  CC.hide1pContent = aggressive || isCrossOriginToTop || registrableLabel(hostname) === 'youtube'
  CC.vettedSearchEngine = VETTED_SEARCH_ENGINES.has(registrableLabel(hostname))

  const exceptD = new Set(entry.du ?? [])
  const exceptA = new Set(entry.au ?? [])
  // Each engine applies its own misc generic selectors unless *it* matched $generichide.
  let hide = [...(entry.dg ? [] : G.d.filter(s => !exceptD.has(s))), ...(entry.d ?? [])]
  const force = [...(entry.ag ? [] : G.a.filter(s => !exceptA.has(s))), ...(entry.a ?? [])]

  // Standard mode (AdBlockEngineWrapper::UrlCosmeticResources): drop `:has(` selectors and
  // procedural filters from the default engine, but keep plain-selector action filters.
  let procedural = entry.pa ?? []
  if (CC.hide1pContent) {
    procedural = [...procedural, ...(entry.p ?? [])]
  } else {
    hide = hide.filter(s => !s.includes(':has('))
    procedural = [...procedural, ...(entry.p ?? []).filter(isActionOnlyFilter)]
  }
  if (!CC.hide1pContent && CC.vettedSearchEngine) hide = []

  if (procedural.length) setupProceduralActions(procedural)
  if (CC.hide1pContent) forceHide(hide)
  else hideSelectors(hide)
  forceHide(force)

  tryScheduleQueuePump()
  if (CC.hasProceduralActions) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => executeProceduralActions(), { once: true })
    else executeProceduralActions()
  }
}

main()
