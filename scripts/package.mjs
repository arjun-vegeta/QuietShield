// Zips the built extension for the Chrome Web Store: dist/quietshield-<version>.zip
// Excludes sources only needed at build time and Chrome's generated _metadata.
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const ext = path.join(root, 'extension')
const { version } = JSON.parse(readFileSync(path.join(ext, 'manifest.json'), 'utf8'))
if (!existsSync(path.join(ext, 'build/background.js'))) throw new Error('run `npm run build` first')
mkdirSync(path.join(root, 'dist'), { recursive: true })
const out = path.join(root, 'dist', `quietshield-${version}.zip`)
rmSync(out, { force: true })
execFileSync('zip', ['-r', '-X', '-q', out, '.', '-x', 'src/*', '_metadata/*', '.DS_Store', '*/.DS_Store'], { cwd: ext, stdio: 'inherit' })
// Stable name for https://github.com/<repo>/releases/latest/download/quietshield.zip
copyFileSync(out, path.join(root, 'dist', 'quietshield.zip'))
console.log(`${out} (${(readFileSync(out).length / 1048576).toFixed(1)} MB)`)
