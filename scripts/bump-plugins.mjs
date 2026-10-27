// Bump the version of every bundled plugin whose OWN FILES changed, and only those.
//
//   node scripts/bump-plugins.mjs <subject> <since>..<until>   # writes plugin.json
//   node scripts/bump-plugins.mjs --print <subject> <range>    # prints, writes nothing
//
// WHY A PLUGIN NEEDS ITS OWN NUMBER AT ALL. The app's version says nothing
// about a plugin: they are distributed separately, through a repository behind
// a key, and a connected install decides whether to fetch one by comparing the
// version it holds to the version the index offers. If that number does not
// move when the code moves, the fleet never updates — and if it moves when the
// code did not, every install downloads an archive identical to the one it
// already has.
//
// WHY IT IS PER-PLUGIN AND NOT PER-COMMIT. `plugins/` holds several unrelated
// programs. Bumping all of them on any commit would republish four plugins
// because one changed, and each of those republishes is an automatic install on
// every connected machine. So the range is asked, per plugin, whether ITS
// directory changed, and only those move.
//
// THE CATEGORY COMES FROM THE COMMIT SUBJECT, exactly as the app's does, and
// `bumpFor` is imported from `bump-version.mjs` rather than reimplemented — two
// copies of "what does feat! mean" is how the two answers diverge and a plugin
// ships a breaking change as a patch.
//
// A PUBLISHED VERSION IS IMMUTABLE. The service refuses to replace the bytes of
// a version it already holds (409), so a plugin whose code changed under an
// unmoved version cannot be published at all. That refusal is the backstop this
// script exists to keep clear of.

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bumpFor, nextVersion } from './bump-version.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pluginsRoot = join(repo, 'plugins')

/**
 * The files this plugin's ARCHIVE is built from, changed in `range`.
 *
 * Asked of git rather than of a timestamp, because the question is "did this
 * plugin change in the commits being released", and a checkout's mtimes answer
 * a different one.
 *
 * `dist/` IS EXCLUDED. It is build output, gitignored in some plugins and
 * committed in others, and counting it would bump a plugin because CI rebuilt
 * it. The source is what changed or did not.
 */
function changedIn(range, dir) {
  let out = ''
  try {
    out = execFileSync('git', ['diff', '--name-only', range, '--', `plugins/${dir}`], {
      cwd: repo,
      encoding: 'utf8'
    })
  } catch (err) {
    // A range git cannot resolve is a broken invocation, not "nothing changed".
    // Answering "no" here would silently skip every bump.
    throw new Error(`could not read the change list for ${dir}: ${err.message}`)
  }
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((f) => !f.startsWith(`plugins/${dir}/dist/`))
}

function main(argv) {
  const printOnly = argv[0] === '--print'
  const args = printOnly ? argv.slice(1) : argv
  const subject = args[0] ?? ''
  const range = args[1] ?? ''

  if (!range) {
    console.error('usage: bump-plugins.mjs [--print] "<commit subject>" <since>..<until>')
    process.exit(1)
  }

  // The SAME refusal the app's bump makes. A subject with no category cannot
  // decide how far a plugin's number moves either, and guessing a patch is how
  // a breaking plugin change reaches a fleet as routine.
  const bump = bumpFor(subject)
  if (!bump) {
    console.error(`the commit subject declares no version category: ${subject.split('\n')[0]}`)
    process.exit(1)
  }

  if (!existsSync(pluginsRoot)) {
    console.log('no plugins/ directory; nothing to bump')
    return
  }

  const results = []
  for (const dir of readdirSync(pluginsRoot).sort()) {
    const manifestPath = join(pluginsRoot, dir, 'plugin.json')
    if (!existsSync(manifestPath)) continue

    const raw = readFileSync(manifestPath, 'utf8')
    const doc = JSON.parse(raw)
    const changed = changedIn(range, dir)
    if (changed.length === 0) {
      results.push({ id: doc.id, from: doc.version, to: doc.version, moved: false })
      continue
    }

    const version = nextVersion(doc.version, bump)
    results.push({ id: doc.id, from: doc.version, to: version, moved: true, files: changed.length })

    if (!printOnly) {
      // The version LINE, not a re-serialisation: `JSON.stringify` reflows the
      // whole manifest and turns a one-field change into an unreviewable diff.
      // A plugin manifest is also a document its author wrote, with their own
      // ordering and their own prose in `blurb` and `discloses`.
      const updated = raw.replace(
        /^(\s*"version"\s*:\s*")[^"]*(",?\s*)$/m,
        (_, head, tail) => `${head}${version}${tail}`
      )
      if (updated === raw) {
        throw new Error(`could not find a "version" line to replace in plugins/${dir}/plugin.json`)
      }
      writeFileSync(manifestPath, updated)
    }
  }

  for (const r of results) {
    if (r.moved) console.log(`${r.id}: ${r.from} → ${r.to} (${r.files} file(s) changed)`)
    else console.log(`${r.id}: ${r.from} unchanged`)
  }

  const moved = results.filter((r) => r.moved)
  console.log(`\n${moved.length} of ${results.length} plugin(s) bumped`)
}

main(process.argv.slice(2))
