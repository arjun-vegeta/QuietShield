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
for (const r of document.querySelectorAll('input[name=mode]')) {
  r.addEventListener('change', () => { settings.mode = r.value; save() })
}
if (tab?.id !== undefined) {
  chrome.action.getBadgeText({ tabId: tab.id }).then(t => { document.getElementById('count').textContent = t || '0' })
}
