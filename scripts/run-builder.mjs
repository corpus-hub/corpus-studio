// Runs electron-builder, adding the update-feed publish config ONLY when one is
// configured in the environment.
//
// WHY THIS IS NOT IN electron-builder.yml. The feed has to be optional: a
// release is published to an update server, a developer build and a plain
// distributable are not. YAML cannot express "omit this key when the variable
// is unset" — `url: ${env.CORPUS_UPDATE_URL}` THROWS when the variable is
// missing, and setting it to an empty string is worse, because electron-builder
// then bakes `url: ''` into `app-update.yml` and the app reports itself as
// having a BROKEN updater config rather than none. Only the absence of the
// whole `publish` block produces an artifact with no `app-update.yml`, which is
// what "this build ships no updater" means. See the note in
// electron-builder.yml.
//
// Usage (via the dist:* scripts):
//   node scripts/run-builder.mjs --linux
//   CORPUS_UPDATE_URL=https://…/stable CORPUS_UPDATE_CHANNEL=stable \
//     node scripts/run-builder.mjs --linux

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const passthrough = process.argv.slice(2)
const url = process.env.CORPUS_UPDATE_URL?.trim()
const channel = process.env.CORPUS_UPDATE_CHANNEL?.trim()

const args = [...passthrough]

// A DMG can only be built ON macOS: dmg-builder drives `hdiutil` (to create and
// mount the image) and `sips` (to measure the background), neither of which
// exists elsewhere and neither of which has a faithful Linux substitute.
//
// Left in the target list on a Linux host, electron-builder writes BOTH zips
// correctly and then fails the run on the dmg — a non-zero exit for a build
// whose artifacts are all present and good, which is indistinguishable at a
// glance from a build that produced nothing. Dropping the target here means the
// macOS build SUCCEEDS on Linux with the zips as its output, and still produces
// dmg + zip when this same command is run on a Mac.
//
// The zip is a complete `.app` — unzip, drag to Applications — so nothing is
// lost but the disk-image wrapper.
// Both arches are named explicitly. A bare `-c.mac.target=zip` REPLACES the
// whole target entry from the YAML, taking `arch: [x64, arm64]` with it — that
// silently built x64 only and left a stale arm64 zip sitting in release/ that
// looked like a fresh one.
if (process.platform !== 'darwin' && passthrough.includes('--mac')) {
  args.push('--x64', '--arm64', '-c.mac.target=zip')
  console.log(
    '[run-builder] not on macOS — building the mac target as zip only, x64 + arm64 ' +
      '(a dmg needs hdiutil/sips). The zip is a complete .app.'
  )
}

if (url) {
  // A packaged build refuses a plain-http feed at runtime (src/main/updater.ts).
  // Failing here instead means the operator finds out while building rather
  // than from a user whose app silently never updates.
  if (!url.startsWith('https://')) {
    console.error(
      `[run-builder] CORPUS_UPDATE_URL must be an https:// url — got ${url}\n` +
        'A released build refuses a plain-http update feed, so this artifact ' +
        'would ship an updater that can never run.'
    )
    process.exit(1)
  }
  args.push('-c.publish.provider=generic', `-c.publish.url=${url}`)
  if (channel) args.push(`-c.publish.channel=${channel}`)
  console.log(`[run-builder] update feed: ${url}${channel ? ` (channel ${channel})` : ''}`)
} else {
  // Nothing to add: electron-builder.yml already carries `publish: null`, which
  // is what suppresses both the upload and the github feed electron-builder
  // would otherwise infer from the git remote.
  args.push('--publish', 'never')
  console.log(
    '[run-builder] no CORPUS_UPDATE_URL — building without an update feed; ' +
      'the artifact will contain no app-update.yml.'
  )
}

// Resolved from node_modules rather than taken from PATH, so the script behaves
// the same whether npm put the bin dir on PATH (`npm run dist:*`) or not
// (`node scripts/run-builder.mjs …`), and so it can never pick up a different
// electron-builder that happens to be installed globally.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const localBin = join(repoRoot, 'node_modules', '.bin', 'electron-builder')
const bin = existsSync(localBin) ? localBin : 'electron-builder'

const child = spawn(bin, args, { stdio: 'inherit', shell: false })
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 1)
})
