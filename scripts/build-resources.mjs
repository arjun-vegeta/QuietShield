// Turns uBlock Origin's builtin scriptlets into adblock-rust `Resource`s the
// same way brave-core-crx-packager does (lib/adBlockRustUtils.js), and also
// emits the scriptlet function library that the extension injects into the
// page's MAIN world.
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const scriptletsPath = path.join(root, 'vendor/uBlock/src/js/resources/scriptlets.js')
const { builtinScriptlets } = await import(pathToFileURL(scriptletsPath).href)

const byName = new Map(builtinScriptlets.map(s => [s.name, s]))
for (const s of builtinScriptlets) {
  for (const dep of s.dependencies ?? []) {
    if (!byName.has(dep)) console.warn(`missing dependency ${dep} of ${s.name}`)
  }
}

const resources = builtinScriptlets.map(s => ({
  name: s.name,
  aliases: s.aliases ?? [],
  kind: { mime: 'application/javascript' },
  content: Buffer.from(s.fn.toString()).toString('base64'),
  dependencies: s.dependencies ?? [],
  // uBO "trusted" scriptlets only run from lists granted bit 0 (Brave's
  // default lists are), matching brave-core's PermissionMask handling.
  ...(s.requiresTrust ? { permission: 1 } : {})
}))
writeFileSync(path.join(root, 'data/ubo-scriptlets.json'), JSON.stringify(resources))

// Map of resource name -> JS function name, used by the compiler to rewrite
// each host's assembled script into compact calls against the shared library.
const fnNames = Object.fromEntries(builtinScriptlets.map(s => [s.name, s.fn.name]))
writeFileSync(path.join(root, 'data/ubo-scriptlet-fn-names.json'), JSON.stringify(fnNames))

console.log(`${resources.length} uBO scriptlet resources, ${resources.filter(r => r.permission).length} trusted`)
