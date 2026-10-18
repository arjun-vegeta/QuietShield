import { registrableDomain } from '../build/content/hosts.js'

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
const url = tab?.url ? new URL(tab.url) : null
const site = url && /^https?:$/.test(url.protocol) ? registrableDomain(url.hostname) : null
document.getElementById('host').textContent = site ?? '(not a web page)'

const { settings = { enabled: true, mode: 'standard', sites: {} } } = await chrome.storage.local.get('settings')
const siteBox = document.getElementById('site')
siteBox.checked = !(site && settings.sites?.[site]?.off)
siteBox.disabled = !site
for (const r of document.querySelectorAll('input[name=mode]')) r.checked = r.value === (settings.mode ?? 'standard')

const save = () => chrome.storage.local.set({ settings })
siteBox.addEventListener('change', () => {
  settings.sites ??= {}
  if (siteBox.checked) delete settings.sites[site]
  else settings.sites[site] = { off: true }
  save()
})
const cookiesBox = document.getElementById('cookies')
cookiesBox.checked = !!settings.blockCrossSiteCookies
cookiesBox.addEventListener('change', async () => {
  if (cookiesBox.checked) {
    // Optional permission: requested only when the user opts in (needs this click as the gesture).
    const granted = await chrome.permissions.request({ permissions: ['privacy'] })
    if (!granted) { cookiesBox.checked = false; return }
  }
  settings.blockCrossSiteCookies = cookiesBox.checked
  save()
})
for (const r of document.querySelectorAll('input[name=mode]')) {
  r.addEventListener('change', () => { settings.mode = r.value; save() })
}
// The badge itself shows Chrome's live count; getBadgeText only returns a placeholder for it, so
// read matched rules instead (allowed for the active tab while the popup is open via activeTab).
const countLine = document.querySelector('.count')
if (tab?.id !== undefined && site) {
  chrome.declarativeNetRequest.getMatchedRules({ tabId: tab.id })
    .then(({ rulesMatchedInfo }) => { document.getElementById('count').textContent = String(rulesMatchedInfo.length) })
    .catch(() => { countLine.hidden = true })
} else {
  countLine.hidden = true
}

// Updates (GitHub installs only; Web Store installs update automatically)
const manifest = chrome.runtime.getManifest()
document.getElementById('version').textContent = `v${manifest.version}`
if (!('update_url' in manifest)) {
  const row = document.getElementById('updateRow')
  const box = document.getElementById('updateCheck')
  row.hidden = false
  box.checked = settings.updateCheck !== false
  box.addEventListener('change', () => { settings.updateCheck = box.checked; save() })
  const showUpdate = (u) => {
    if (!u) return
    const a = document.getElementById('update')
    a.textContent = `Update available: v${u.version} — download`
    a.href = u.url
    a.hidden = false
  }
  const { update } = await chrome.storage.local.get('update')
  showUpdate(update)
}
