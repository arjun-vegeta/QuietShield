// Downloads everything the compiler needs: Brave's filter list catalog, every
// default-enabled desktop list, Brave's own resources, and a uBlock Origin
// checkout (scriptlets + redirect resources), mirroring brave-core-crx-packager.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const data = path.join(root, 'data')
const CATALOG_URL = 'https://raw.githubusercontent.com/brave/adblock-resources/master/filter_lists/list_catalog.json'
const BRAVE_RESOURCES_URL = 'https://raw.githubusercontent.com/brave/adblock-resources/master/dist/resources.json'

async function get (url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${res.status} ${url}`)
  return res.text()
}

mkdirSync(path.join(data, 'lists'), { recursive: true })

const catalogText = await get(CATALOG_URL)
writeFileSync(path.join(data, 'list_catalog.json'), catalogText)
const catalog = JSON.parse(catalogText)

const mobileOnly = e => e.platforms?.length && e.platforms.every(p => p === 'IOS' || p === 'ANDROID')
const wanted = catalog.filter(e => e.default_enabled && !mobileOnly(e))
for (const entry of wanted) {
  const dir = path.join(data, 'lists', entry.uuid)
  mkdirSync(dir, { recursive: true })
  await Promise.all(entry.sources.map(async (src, i) => {
    const text = await get(src.url)
    writeFileSync(path.join(dir, `${i}.txt`), text)
    console.log(`${entry.uuid.slice(0, 8)} ${String(text.length).padStart(9)}  ${src.url}`)
  }))
}

writeFileSync(path.join(data, 'brave-resources.json'), await get(BRAVE_RESOURCES_URL))

// adblock-rust, pinned to the commit this project was verified against (crate 0.13.3).
const ADBLOCK_RUST_COMMIT = '6028a6d5735f1e81346eeef73c194c7240035248'
const abr = path.join(root, 'vendor', 'adblock-rust')
if (!existsSync(abr)) {
  execFileSync('git', ['clone', 'https://github.com/brave/adblock-rust.git', abr], { stdio: 'inherit' })
}
execFileSync('git', ['-C', abr, 'checkout', '--quiet', ADBLOCK_RUST_COMMIT], { stdio: 'inherit' })

const ubo = path.join(root, 'vendor', 'uBlock')
if (!existsSync(ubo)) {
  execFileSync('git', ['clone', '--depth', '1', 'https://github.com/gorhill/uBlock.git', ubo], { stdio: 'inherit' })
} else {
  execFileSync('git', ['-C', ubo, 'pull', '--ff-only'], { stdio: 'inherit' })
}
