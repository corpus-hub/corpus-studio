// Bundle every bundled plugin's TypeScript into the single JS file its
// `plugin.json` names as its entry.
//
// WHY A PLUGIN IS BUILT AT ALL. The host loads `entry` with `require`, so it
// must be JavaScript the runtime can already run — the app does not carry a
// TypeScript compiler into production so a third party's folder can be
// transpiled on the way in. That means the plugins shipped with this app go
// through exactly the build a third party's would: `npm run build` runs this
// first, and if it were skipped the shipped plugin would be as unloadable as
// anyone else's un-built one. That equivalence is the point — a shipped plugin
// that took a shortcut is a shipped plugin whose install path is untested.
//
// `better-sqlite3` and `undici` are EXTERNAL. Both are the application's own
// runtime dependencies: bundling better-sqlite3 would load a second native
// binding against the same database file, and the plugin only ever holds
// `Database` as a type. `undici` is reached through `services().borrow()` at
// runtime and appears here only as an erased type import.

import { readdirSync, existsSync, readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const pluginsRoot = join(repo, 'plugins')

if (!existsSync(pluginsRoot)) {
  // Deleting `plugins/` must not break the build any more than it breaks the
  // launch. Nothing to do is a success.
  console.log('build:plugins → no plugins/ directory; nothing to build')
  process.exit(0)
}

let built = 0
for (const name of readdirSync(pluginsRoot, { withFileTypes: true })) {
  if (!name.isDirectory()) continue
  const dir = join(pluginsRoot, name.name)
  const manifestPath = join(dir, 'plugin.json')
  if (!existsSync(manifestPath)) continue

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    id: string
    entry: string
  }
  const outfile = resolve(dir, manifest.entry)
  // The SOURCE is a convention, not a manifest field: `entry` is the built
  // artefact, and a manifest that also named the source would be describing this
  // repository's layout to an app that has no business knowing it.
  const entrySource = join(dir, 'src', 'index.ts')
  if (!existsSync(entrySource)) {
    console.error(`build:plugins → ${manifest.id} has no src/index.ts`)
    process.exit(1)
  }

  buildSync({
    entryPoints: [entrySource],
    outfile,
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    sourcemap: false,
    // The tsconfig path alias `@shared/*` is deliberately NOT provided. A plugin
    // that resolved it would be one that only builds inside this checkout, which
    // is the property this whole restructure exists to remove.
    external: ['better-sqlite3', 'undici', 'electron'],
    logLevel: 'warning'
  })
  console.log(`build:plugins → ${manifest.id} → ${manifest.entry}`)
  built += 1
}

console.log(`build:plugins → ${built} plugin(s)`)
