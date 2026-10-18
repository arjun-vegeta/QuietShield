// One-shot build: resources → Rust compiler (DNR rules, cosmetic data, scriptlet bundles) →
// wasm engine → engine data built inside wasm → JS bundles → manifest.
import { execFileSync } from 'node:child_process'
import { cpSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import * as esbuild from 'esbuild'

const root = path.resolve(import.meta.dirname, '..')
const ext = path.join(root, 'extension')
const env = { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` }
const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: 'inherit', env })

run('node', ['scripts/build-resources.mjs'])
run('cargo', ['build', '--release', '--quiet'], path.join(root, 'compiler'))
run(path.join(root, 'compiler/target/release/shields-compiler'), [root])
run('cargo', ['build', '--release', '--quiet', '--target', 'wasm32-unknown-unknown'], path.join(root, 'engine-wasm'))
run('wasm-bindgen', ['--target', 'web', '--no-typescript', '--out-dir', path.join(ext, 'build/wasm'),
  path.join(root, 'engine-wasm/target/wasm32-unknown-unknown/release/shields_engine_wasm.wasm')])
run('node', ['scripts/build-engines.mjs'])

await esbuild.build({
  entryPoints: [path.join(ext, 'src/cosmetic.js')],
  bundle: true, format: 'iife', target: 'chrome120', outfile: path.join(ext, 'build/content/cosmetic.js'), logLevel: 'warning',
})
await esbuild.build({
  entryPoints: [path.join(ext, 'src/background.js')],
  bundle: true, format: 'esm', target: 'chrome120', outfile: path.join(ext, 'build/background.js'), logLevel: 'warning',
})
mkdirSync(path.join(ext, 'build/content'), { recursive: true })
cpSync(path.join(ext, 'src/hosts.js'), path.join(ext, 'build/content/hosts.js'))

const rulesets = JSON.parse(readFileSync(path.join(ext, 'build/rulesets.json'), 'utf8'))
const entityGlobs = JSON.parse(readFileSync(path.join(ext, 'build/scriptlets/entity-globs.json'), 'utf8'))
const manifest = {
  manifest_version: 3,
  name: 'QuietShield — Ad & Tracker Blocker',
  short_name: 'QuietShield',
  version: '0.1.0',
  description: "Blocks ads and trackers quietly. Powered by Brave's open-source adblock-rust engine. Not affiliated with Brave Software.",
  minimum_chrome_version: '128',
  permissions: ['declarativeNetRequest', 'declarativeNetRequestFeedback', 'scripting', 'storage', 'unlimitedStorage', 'activeTab'],
  host_permissions: ['<all_urls>'],
  background: { service_worker: 'build/background.js', type: 'module' },
  content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';" },
  action: { default_popup: 'popup/popup.html', default_title: 'QuietShield' },
  declarative_net_request: { rule_resources: rulesets },
  content_scripts: [
    {
      matches: ['<all_urls>'],
      js: ['build/cosmetic/generic.js', 'build/content/cosmetic.js'],
      run_at: 'document_start', all_frames: true, match_origin_as_fallback: true, world: 'ISOLATED',
    },
    {
      matches: ['<all_urls>'],
      include_globs: entityGlobs,
      js: ['build/scriptlets/entity.js'],
      run_at: 'document_start', all_frames: true, match_origin_as_fallback: true, world: 'MAIN',
    },
  ],
  web_accessible_resources: [{ resources: ['build/war/*'], matches: ['<all_urls>'], use_dynamic_url: true }],
}
writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify(manifest, null, 2))
console.log('extension built →', ext)
