// Provision the shipped binary payloads described by `resources/payloads.json`
// into the gitignored `resources/` tree.
//
//   npm run payloads                  # everything for THIS host's platform
//   npm run payloads -- --all         # every platform (for a release matrix)
//   npm run payloads -- --platform win32-x64 --platform darwin-arm64
//   npm run payloads -- --only qpdf
//   npm run payloads -- --check       # verify what is present; fetch nothing
//   npm run payloads -- --force       # re-fetch even if hashes already match
//
// THIS RUNS AT BUILD TIME, ON A DEVELOPER'S MACHINE — never in the shipped app.
// That distinction is the whole point: CLAUDE.md §2 requires the application to
// run with networking disabled, so everything it will ever need is fetched here
// and baked into the installer by electron-builder's `extraResources`. The app
// contains no URL from this manifest and no code that reads it;
// `npm run verify:offline` enforces both.
//
// The hash of an archive is checked BEFORE it is unpacked, not after. Unpacking
// first would mean a tar/zip parser had already consumed attacker-controlled
// bytes by the time the check ran, and path-traversal entries would already be
// on disk. Every extracted file is then hashed individually as well, because an
// archive hash says nothing about which member ended up at which destination.

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const repoRoot = resolve(__dirname, '..')
const resourcesDir = join(repoRoot, 'resources')
const manifestPath = join(resourcesDir, 'payloads.json')

// --------------------------------------------------------------- manifest types
interface FileSpec {
  /** Member path inside the archive, or a path relative to the payload baseUrl. */
  from?: string
  /** Standalone download URL, for a payload that is a bare file. */
  url?: string
  dest: string
  sha256?: string
  bytes?: number
  mode?: string
  reproducible?: boolean
}
interface ArchiveSpec {
  url: string
  sha256: string
}
interface PlatformSpec {
  archive?: ArchiveSpec
  baseUrl?: string
  build?: string
  dockerfile?: string
  baseImage?: string
  source?: ArchiveSpec
  files?: FileSpec[]
  unavailable?: string
}
interface Payload {
  id: string
  purpose: string
  optional: boolean
  version: string
  license: string
  platforms: Record<string, PlatformSpec>
}
interface Manifest {
  schemaVersion: number
  payloads: Payload[]
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest
if (manifest.schemaVersion !== 1) {
  throw new Error(`resources/payloads.json schemaVersion ${manifest.schemaVersion} is not supported`)
}

// --------------------------------------------------------------- args
const argv = process.argv.slice(2)
const has = (f: string): boolean => argv.includes(f)
const values = (f: string): string[] =>
  argv.flatMap((a, i) => (argv[i - 1] === f ? [a] : []))

const CHECK_ONLY = has('--check')
const FORCE = has('--force')
const ONLY = values('--only')

/**
 * The host's payload key. Payloads are keyed `<platform>-<arch>` and NOT by
 * platform alone: macOS ships separate x64 and arm64 apps and upstream
 * publishes a different sqlite-vec dylib for each, so a platform-only key would
 * load the wrong binary on half of all Macs.
 */
export function hostKey(): string {
  return `${process.platform}-${process.arch}`
}

const requested = values('--platform')
const targets: string[] = has('--all')
  ? [...new Set(manifest.payloads.flatMap((p) => Object.keys(p.platforms)))].filter(
      (k) => k !== 'all'
    )
  : requested.length > 0
    ? requested
    : [hostKey()]

// --------------------------------------------------------------- reporting
let failures = 0
let fetched = 0
let skipped = 0
const log = (s = ''): void => console.log(s)
function fail(msg: string): void {
  console.error(`FAIL  ${msg}`)
  failures++
}

// --------------------------------------------------------------- helpers
function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * True when `dest` already exists and matches what the manifest expects, so a
 * re-run can skip it.
 *
 * With no pinned hash — an unpinned build output — a bare existence test would
 * accept a file truncated by an interrupted earlier run and then skip the
 * re-fetch that would have repaired it, silently. The declared byte count is
 * therefore checked instead, which is the only assertion available; an unpinned
 * payload with no expected size is re-provisioned rather than assumed good.
 */
function satisfied(dest: string, sha256?: string, bytes?: number): boolean {
  if (!existsSync(dest)) return false
  if (sha256) return sha256File(dest) === sha256
  if (bytes) return statSync(dest).size === bytes
  return false
}

/**
 * Download to a temp file and verify the hash before the bytes are used for
 * anything. `curl` rather than fetch(): this script runs under
 * ELECTRON_RUN_AS_NODE like every other verify script, and curl gives
 * redirect-following, resume and proxy handling for free.
 */
function download(url: string, dest: string): void {
  mkdirSync(dirname(dest), { recursive: true })
  execFileSync('curl', ['-sSL', '--fail', '--retry', '3', '--max-time', '900', '-o', dest, url], {
    stdio: ['ignore', 'ignore', 'inherit']
  })
}

function verifyOrThrow(path: string, expected: string, label: string): void {
  const actual = sha256File(path)
  if (actual !== expected) {
    throw new Error(
      `${label}: SHA-256 MISMATCH\n    expected ${expected}\n    actual   ${actual}\n` +
        `  Refusing to use these bytes. Either the upstream asset was replaced under the ` +
        `same URL, or the download was tampered with. Investigate before touching the manifest.`
    )
  }
}

/** Write a file into the resources tree atomically, with its declared mode. */
function install(from: string, spec: FileSpec): void {
  const dest = join(resourcesDir, spec.dest)
  mkdirSync(dirname(dest), { recursive: true })
  const tmp = `${dest}.partial`
  copyFileSync(from, tmp)
  chmodSync(tmp, parseInt(spec.mode ?? '0644', 8))
  // Rename last: a half-copied executable that is already at its final path is
  // exactly the state a later `--check` would declare healthy.
  renameSync(tmp, dest)
}

/**
 * Unpack a staged archive. The format is taken from the manifest URL, not from
 * the staged file's name: the download is staged under a fixed temp name with
 * no extension, so sniffing the local path would classify every archive as
 * "unknown" — which it did.
 */
function extract(archive: string, url: string, into: string): void {
  mkdirSync(into, { recursive: true })
  if (/\.zip(\?|$)/i.test(url)) {
    execFileSync('unzip', ['-q', '-o', archive, '-d', into], { stdio: 'inherit' })
  } else if (/\.(tar\.gz|tgz)(\?|$)/i.test(url)) {
    execFileSync('tar', ['xzf', archive, '-C', into], { stdio: 'inherit' })
  } else {
    throw new Error(`unsupported archive type for ${url}`)
  }
}

// --------------------------------------------------------------- strategies
function provisionArchive(spec: PlatformSpec, label: string, tmp: string): void {
  const archive = join(tmp, 'archive')
  log(`    fetching ${spec.archive!.url}`)
  download(spec.archive!.url, archive)
  verifyOrThrow(archive, spec.archive!.sha256, `${label} archive`)
  log(`    archive sha256 ok`)
  const out = join(tmp, 'x')
  extract(archive, spec.archive!.url, out)
  for (const f of spec.files ?? []) {
    const src = join(out, f.from!)
    if (!existsSync(src)) throw new Error(`${label}: ${f.from} is not in the archive`)
    if (f.sha256) verifyOrThrow(src, f.sha256, `${label} ${f.from}`)
    install(src, f)
    log(`    ok  ${f.dest}`)
  }
}

function provisionFiles(spec: PlatformSpec, label: string, tmp: string): void {
  for (const f of spec.files ?? []) {
    const url = f.url ?? `${spec.baseUrl}/${f.from}`
    const staged = join(tmp, 'file')
    log(`    fetching ${url}`)
    download(url, staged)
    if (f.sha256) verifyOrThrow(staged, f.sha256, `${label} ${f.dest}`)
    install(staged, f)
    rmSync(staged, { force: true })
    log(`    ok  ${f.dest}`)
  }
}

/**
 * Build a payload from source in Docker.
 *
 * The manifest pins BOTH the source tarball's hash and the built binary's. The
 * output hash is only pinnable because this build was measured to be
 * bit-reproducible across a `--no-cache` rebuild from the same pinned
 * base-image digest; a `reproducible: false` file is installed without an
 * output check, so a toolchain that loses that property degrades to
 * source-pinning rather than failing every build.
 *
 * The source tarball is verified here — on the host, against the manifest —
 * before it is ever handed to the build.
 */
function provisionDocker(spec: PlatformSpec, label: string, tmp: string): void {
  const ctx = join(repoRoot, dirname(spec.dockerfile!))
  const src = join(ctx, 'qpdf-src.tar.gz')
  if (!satisfied(src, spec.source!.sha256)) {
    log(`    fetching ${spec.source!.url}`)
    download(spec.source!.url, src)
  }
  verifyOrThrow(src, spec.source!.sha256, `${label} source tarball`)
  log('    source sha256 ok')

  log('    docker build (this takes a few minutes)')
  execFileSync(
    'docker',
    [
      // THE BINARY COMES OUT AS A FILE, never as an image to be unpacked. The
      // build used to be tagged, then `docker create`d and `docker cp`ed --
      // three steps that all depend on the tag being visible in the daemon's
      // image list. On a daemon using the containerd snapshotter it is not:
      // buildx reports "naming to ... unpacking to ... DONE" and `docker images`
      // shows nothing, so `create` fails with "Unable to find image ... locally"
      // and then tries to PULL a tag that never left this machine.
      //
      // `--output type=local` writes the stage's filesystem straight to a
      // directory. No tag, no image store, no container to create and remove,
      // and it behaves the same on every daemon.
      'buildx',
      'build',
      '--target',
      'export',
      '--output',
      `type=local,dest=${tmp}/out`,
      '--build-arg',
      `QPDF_VERSION=${manifest.payloads.find((p) => p.id === 'qpdf')!.version}`,
      '--build-arg',
      `QPDF_SHA256=${spec.source!.sha256}`,
      ctx
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] }
  )
  {
    const staged = join(tmp, 'out', 'qpdf')
    for (const f of spec.files ?? []) {
      if (f.sha256 && f.reproducible !== false) {
        verifyOrThrow(staged, f.sha256, `${label} built binary`)
        log('    built-binary sha256 ok (reproducible build)')
      } else {
        log(`    built sha256 ${sha256File(staged).slice(0, 16)}… (output not pinned)`)
      }
      install(staged, f)
      log(`    ok  ${f.dest}`)
    }
  }
}

// --------------------------------------------------------------- main
log(`payloads → ${resourcesDir}`)
log(`targets: ${targets.join(', ')}${CHECK_ONLY ? '   (--check: verifying only)' : ''}`)

for (const payload of manifest.payloads) {
  if (ONLY.length > 0 && !ONLY.includes(payload.id)) continue
  log(`\n${payload.id}  ${payload.version}  ${payload.license}`)

  // `all` = platform-independent data (the model, the traineddata). It is
  // provisioned once regardless of which targets were asked for.
  const keys = Object.keys(payload.platforms).filter(
    (k) => k === 'all' || targets.includes(k)
  )
  if (keys.length === 0) {
    log('  (nothing for the requested targets)')
    continue
  }

  for (const key of keys) {
    const spec = payload.platforms[key]
    log(`  ${key}`)
    if (spec.unavailable) {
      log(`    UNAVAILABLE — ${spec.unavailable}`)
      skipped++
      continue
    }

    const allPresent = (spec.files ?? []).every((f) =>
      satisfied(
        join(resourcesDir, f.dest),
        f.reproducible === false ? undefined : f.sha256,
        f.bytes
      )
    )
    if (allPresent && !FORCE) {
      log('    present, hashes ok')
      skipped++
      continue
    }
    if (CHECK_ONLY) {
      for (const f of spec.files ?? []) {
        const dest = join(resourcesDir, f.dest)
        if (!existsSync(dest)) fail(`${payload.id} ${key}: missing ${f.dest}`)
        else if (f.reproducible !== false && f.sha256 && sha256File(dest) !== f.sha256) {
          fail(`${payload.id} ${key}: hash mismatch for ${f.dest}`)
        }
      }
      continue
    }

    const tmp = mkdtempSync(join(tmpdir(), 'corpus-payload-'))
    try {
      if (spec.build === 'docker') provisionDocker(spec, `${payload.id} ${key}`, tmp)
      else if (spec.archive) provisionArchive(spec, `${payload.id} ${key}`, tmp)
      else provisionFiles(spec, `${payload.id} ${key}`, tmp)
      fetched++
    } catch (err) {
      fail(`${payload.id} ${key}: ${(err as Error).message}`)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }
}

// A machine-readable record of what this tree actually contains, so
// verify:resources and the packaged artifact can be compared against a
// concrete provisioning event rather than against the manifest's intentions.
if (!CHECK_ONLY && failures === 0) {
  const installed: Record<string, { sha256: string; bytes: number; mode: string }> = {}
  for (const payload of manifest.payloads) {
    for (const spec of Object.values(payload.platforms)) {
      for (const f of spec.files ?? []) {
        const dest = join(resourcesDir, f.dest)
        if (!existsSync(dest)) continue
        const st = statSync(dest)
        installed[f.dest] = {
          sha256: sha256File(dest),
          bytes: st.size,
          mode: (st.mode & 0o777).toString(8).padStart(4, '0')
        }
      }
    }
  }
  writeFileSync(
    join(resourcesDir, 'payloads.lock.json'),
    `${JSON.stringify({ generatedAt: new Date().toISOString(), installed }, null, 2)}\n`
  )
  log(`\nwrote resources/payloads.lock.json (${Object.keys(installed).length} files)`)
}

log(`\n${fetched} provisioned · ${skipped} already present or unavailable · ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
