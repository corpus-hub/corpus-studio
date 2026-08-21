// Generate the third-party attribution set that the About → Third-party
// licences screen reads.
//
//   npm run licences            # regenerate resources/licences/
//   npm run licences -- --check # fail if what is on disk is not what this
//                               # script would write (the anti-rot gate)
//
// WHY GENERATED, NOT HAND-WRITTEN
//
// Apache-2.0 §4 requires attribution, and this app ships five Apache-2.0
// payloads (qpdf, eng.traineddata, arctic-embed-s, ms-marco-MiniLM-L-6-v2,
// sqlite-vec) plus a ~110
// package npm closure. A hand-maintained list is wrong the first time someone
// runs `npm install`, and wrong SILENTLY — nothing fails, the app simply stops
// attributing something it ships. So both halves are read from the machine:
//
//   - payloads      -> resources/payloads.json, the tracked provenance manifest
//                      that already carries version/licence/source/SHA-256.
//   - npm packages  -> the installed node_modules metadata (`package.json`
//                      `license` + the package's own LICENSE file), walked over
//                      the PRODUCTION dependency closure, which is what
//                      electron-builder actually puts in the installer.
//
// `--check` makes staleness a build failure rather than a discovery at audit
// time. It is the reason this can be trusted a year from now.
//
// WHY AN ASSET TREE, NOT A TS MODULE
//
// The licence texts are ~400 KB. Inlining them as string literals would put
// them in the renderer bundle, parsed on every launch, and make every dependency
// bump a diff full of legal boilerplate. They ship the way every other non-JS
// payload here ships: as real files under resources/, resolved through
// src/main/resources.ts, read in MAIN and handed to the renderer over IPC.
// Nothing is fetched — CLAUDE.md §2.
//
// Texts are content-addressed (sha256 prefix) so the ~90 MIT copies collapse to
// a handful of files instead of one per package.

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join, resolve } from 'node:path'

const repoRoot = resolve(__dirname, '..')
const outDir = join(repoRoot, 'resources', 'licences')
const textsDir = join(outDir, 'texts')

/** One attributed third-party component, as the screen renders it. */
interface Entry {
  /** Stable id: `payload:<id>` or `npm:<package name>`. */
  id: string
  name: string
  kind: 'payload' | 'npm'
  version: string
  /** SPDX expression as declared upstream, e.g. `Apache-2.0 OR MIT`. */
  license: string
  homepage: string | null
  /** Why this component is in the app at all — a reader's first question. */
  purpose: string | null
  /** Basename under texts/, or null when upstream ships no licence FILE. */
  textFile: string | null
  /** Present only when there is no text file, saying why. */
  textNote: string | null
}

// --------------------------------------------------------------- licence text
const TEXT_NAMES = /^(LICEN[CS]E|COPYING|NOTICE)([-.].*)?$/i

/** The licence/notice files a package ships, concatenated, or null. */
function readLicenceText(dir: string): string | null {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return null
  const files = readdirSync(dir)
    .filter((f) => TEXT_NAMES.test(f))
    .filter((f) => {
      const p = join(dir, f)
      return statSync(p).isFile() && statSync(p).size > 0 && statSync(p).size < 2_000_000
    })
    .sort()
  if (files.length === 0) return null
  return files
    .map((f) => (files.length > 1 ? `===== ${f} =====\n\n` : '') + readFileSync(join(dir, f), 'utf8'))
    .join('\n\n')
    .replace(/\r\n/g, '\n')
    .trimEnd()
}

/**
 * The canonical text of a well-known SPDX id, for packages that declare a
 * licence but ship no file. Only SIMPLE ids are substituted — an expression
 * like `MIT OR Apache-2.0` is the recipient's choice to make, and picking one
 * silently would misstate the grant.
 */
function spdxText(license: string): { spdx: string; text: string } | null {
  const spdx = license.trim()
  if (!/^[A-Za-z0-9.\-+]+$/.test(spdx)) return null
  const p = join(repoRoot, 'resources', 'licences', 'spdx-texts', `${spdx}.txt`)
  if (!existsSync(p)) return null
  return { spdx, text: readFileSync(p, 'utf8').replace(/\r\n/g, '\n').trimEnd() }
}

const texts = new Map<string, string>()
/** Store a text content-addressed; returns its file name. */
function storeText(text: string): string {
  const name = `${createHash('sha256').update(text).digest('hex').slice(0, 16)}.txt`
  texts.set(name, text)
  return name
}

// ------------------------------------------------------------------- payloads
function payloadEntries(): Entry[] {
  const manifest = JSON.parse(
    readFileSync(join(repoRoot, 'resources', 'payloads.json'), 'utf8')
  ) as {
    payloads: Array<{
      id: string
      version: string
      license: string
      homepage?: string
      purpose?: string
      licenseText?: string
    }>
  }
  return manifest.payloads.map((p) => {
    // Every payload's licence text is checked in beside this script's output as
    // `resources/licences/payload-texts/<id>.txt`. It is NOT read out of the
    // provisioned tree: `resources/bin|lib|models` are gitignored, so on a fresh
    // clone (or any machine that has not run `npm run payloads`) they are absent
    // — and an attribution that disappears when the binaries are not provisioned
    // is exactly the compliance hole this file exists to close.
    const src = join(repoRoot, 'resources', 'licences', 'payload-texts', `${p.id}.txt`)
    if (!existsSync(src)) {
      throw new Error(
        `No licence text for payload '${p.id}'. Add the upstream text verbatim at ` +
          `resources/licences/payload-texts/${p.id}.txt (see ${p.homepage ?? 'upstream'}).`
      )
    }
    return {
      id: `payload:${p.id}`,
      name: p.id,
      kind: 'payload' as const,
      version: p.version,
      license: p.license,
      homepage: p.homepage ?? null,
      purpose: p.purpose ?? null,
      textFile: storeText(readFileSync(src, 'utf8').replace(/\r\n/g, '\n').trimEnd()),
      textNote: null
    }
  })
}

// ------------------------------------------------------------------ npm tree
//
// The production closure is what electron-builder ships from node_modules. The
// renderer's own libraries (react, d3, the fonts) are devDependencies because
// they are COMPILED INTO out/renderer rather than resolved at runtime — they are
// in the artifact all the same, so they are listed explicitly. electron is here
// for the same reason: it IS the runtime.
//
// Their OWN dependencies are walked too, and that is not a detail: `d3` is a
// meta-package containing no code at all, so attributing it attributes nothing.
// The bundle actually contains the ~30 `d3-*` submodules (ISC), `internmap`,
// `delaunator`, `robust-predicates`, and react's `scheduler`/`loose-envify`/
// `js-tokens` — every one of which carries a notice requirement of its own.
const ALSO_SHIPPED = [
  'electron',
  'react',
  'react-dom',
  'd3',
  '@fontsource/instrument-sans',
  '@fontsource/geist-mono'
]

/** Every transitive dependency of `root`, resolved through installed manifests. */
function transitiveFrom(root: string, into: Map<string, string>): void {
  const stack = [root]
  const seen = new Set<string>()
  while (stack.length) {
    const name = stack.pop()!
    if (seen.has(name)) continue
    seen.add(name)
    // npm hoists, so a package's deps almost always sit at the top level; the
    // nested path is checked first for the rare non-hoisted case.
    const parentDir = into.get(name)
    const candidates = [
      parentDir ? join(parentDir, 'node_modules') : null,
      join(repoRoot, 'node_modules')
    ].filter(Boolean) as string[]
    const dir = candidates.map((c) => join(c, name)).find((d) => existsSync(join(d, 'package.json')))
    if (!dir) continue
    if (!into.has(name)) into.set(name, dir)
    const meta = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    for (const dep of Object.keys(meta.dependencies ?? {})) stack.push(dep)
  }
}

function npmEntries(): Entry[] {
  const tree = JSON.parse(
    execFileSync('npm', ['ls', '--prod', '--all', '--json'], {
      cwd: repoRoot,
      maxBuffer: 64 * 1024 * 1024,
      encoding: 'utf8'
    })
  ) as Record<string, unknown>

  const paths = new Map<string, string>()
  const walk = (node: Record<string, unknown>): void => {
    const deps = (node.dependencies ?? {}) as Record<string, Record<string, unknown>>
    for (const [name, v] of Object.entries(deps)) {
      if (paths.has(name)) continue
      paths.set(name, (v.path as string) ?? join(repoRoot, 'node_modules', name))
      walk(v)
    }
  }
  walk(tree)
  for (const name of ALSO_SHIPPED) transitiveFrom(name, paths)

  const entries: Entry[] = []
  for (const [name, dir] of [...paths].sort((a, b) => a[0].localeCompare(b[0]))) {
    const pj = join(dir, 'package.json')
    if (!existsSync(pj)) continue
    const meta = JSON.parse(readFileSync(pj, 'utf8')) as {
      version?: string
      license?: string | { type?: string }
      licenses?: Array<{ type?: string }>
      homepage?: string
      description?: string
    }
    const license =
      (typeof meta.license === 'string' ? meta.license : meta.license?.type) ??
      meta.licenses?.map((l) => l.type).filter(Boolean).join(' OR ') ??
      'UNKNOWN'
    // A package that declares a licence but ships no text still owes the
    // recipient that text. For the copyleft ones this is not a nicety: LGPL-3.0
    // §4 requires the licence to accompany the work, and `@img/sharp-libvips-*`
    // (a real, shipped .so) is exactly that case. So the canonical text of the
    // licence the package NAMES is substituted from resources/licences/
    // spdx-texts/, and the entry says the substitution happened rather than
    // passing it off as upstream's own file.
    const declared = readLicenceText(dir)
    const spdxFallback = declared ? null : spdxText(license)
    const text = declared ?? spdxFallback?.text ?? null
    entries.push({
      id: `npm:${name}`,
      name,
      kind: 'npm',
      version: meta.version ?? '0.0.0',
      license,
      homepage: meta.homepage ?? `https://www.npmjs.com/package/${name}`,
      purpose: meta.description ?? null,
      textFile: text ? storeText(text) : null,
      // Never silently blank, and never silently PASSED OFF: a substituted text
      // says it is the canonical one, because a reader comparing it against
      // upstream must not conclude the app invented a licence file.
      textNote: declared
        ? null
        : spdxFallback
          ? `${name} ships no LICENSE file; it declares ${license} in its package manifest, ` +
            `so the canonical text of ${spdxFallback.spdx} is reproduced here.`
          : `${name} ships no LICENSE file; upstream declares ${license} in its package manifest.`
    })
  }
  return entries
}

// --------------------------------------------------------------- Chromium
//
// Electron's npm LICENSE covers Electron itself; the browser engine inside it
// is thousands of separately-licensed projects, credited in
// `electron/dist/LICENSES.chromium.html`. That file IS the attribution Chromium
// expects downstream apps to carry, and every Electron app ships the engine, so
// omitting it would mean the largest single body of third-party code in the
// artifact went unattributed.
//
// The HTML is converted to text here rather than rendered: the screen must not
// interpret third-party markup, and the file references `chrome://` stylesheets
// that do not resolve outside the browser UI anyway.
function chromiumEntry(): Entry | null {
  const src = join(repoRoot, 'node_modules', 'electron', 'dist', 'LICENSES.chromium.html')
  if (!existsSync(src)) return null
  const version = JSON.parse(
    readFileSync(join(repoRoot, 'node_modules', 'electron', 'package.json'), 'utf8')
  ).version as string
  const text = readFileSync(src, 'utf8')
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(div|p|h1|h2|h3|pre|tr|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return {
    id: 'npm:chromium',
    name: 'Chromium (bundled in Electron)',
    kind: 'npm',
    version,
    license: 'BSD-3-Clause and others',
    homepage: 'https://source.chromium.org/chromium',
    purpose:
      'The browser engine Electron embeds. Its own credits list every third-party project inside it.',
    textFile: storeText(text),
    textNote: null
  }
}

// ----------------------------------------------------------------- emit
const check = process.argv.includes('--check')

const chromium = chromiumEntry()
const entries = [...payloadEntries(), ...npmEntries(), ...(chromium ? [chromium] : [])]
const index = {
  $comment: [
    'GENERATED by `npm run licences` — do not edit by hand.',
    'Sources: resources/payloads.json + the installed production npm closure.',
    '`npm run licences -- --check` fails when this is stale.'
  ],
  generator: 'scripts/gen-licences.ts',
  entries
}

const wanted = new Map<string, string>([
  ['index.json', JSON.stringify(index, null, 2) + '\n'],
  ...[...texts].map(([n, t]) => [join('texts', n), t] as [string, string])
])

function currentOnDisk(): Map<string, string> {
  const cur = new Map<string, string>()
  const idx = join(outDir, 'index.json')
  if (existsSync(idx)) cur.set('index.json', readFileSync(idx, 'utf8'))
  if (existsSync(textsDir)) {
    for (const f of readdirSync(textsDir)) {
      cur.set(join('texts', f), readFileSync(join(textsDir, f), 'utf8'))
    }
  }
  return cur
}

if (check) {
  const cur = currentOnDisk()
  const problems: string[] = []
  for (const [k, v] of wanted) if (cur.get(k) !== v) problems.push(`stale or missing: ${k}`)
  for (const k of cur.keys()) if (!wanted.has(k)) problems.push(`orphaned: ${k}`)
  if (problems.length) {
    console.error(
      `resources/licences/ is out of date (${problems.length} file(s)).\n` +
        problems.slice(0, 10).map((p) => `  ${p}`).join('\n') +
        `\nRun \`npm run licences\`.`
    )
    process.exit(1)
  }
  console.log(`ok  resources/licences/ is current — ${entries.length} components`)
} else {
  rmSync(textsDir, { recursive: true, force: true })
  mkdirSync(textsDir, { recursive: true })
  for (const [k, v] of wanted) writeFileSync(join(outDir, k), v)
  const byLicense = new Map<string, number>()
  for (const e of entries) byLicense.set(e.license, (byLicense.get(e.license) ?? 0) + 1)
  console.log(`wrote resources/licences/ — ${entries.length} components, ${texts.size} texts`)
  for (const [l, n] of [...byLicense].sort((a, b) => b[1] - a[1])) console.log(`  ${n}× ${l}`)
  const missing = entries.filter((e) => !e.textFile).map((e) => e.name)
  if (missing.length) console.log(`  ${missing.length} without an upstream LICENSE file`)
}
