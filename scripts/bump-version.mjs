// Decide the next version from a commit SUBJECT, and write it to package.json.
//
//   node scripts/bump-version.mjs "<commit subject>"          # writes package.json
//   node scripts/bump-version.mjs --print "<commit subject>"  # prints, writes nothing
//
// Every commit on main moves the version, so the category prefix is the ONLY
// input that decides by how much. It is REQUIRED: an unrecognised subject exits
// non-zero and the pipeline stops before anything is built or published. That is
// deliberate — the alternative is defaulting to a patch bump, which silently
// releases a breaking change as one, and the user only finds out from the
// upgrade that broke their install.
//
// The categories, and what each one means for the number:
//
//   breaking change:  MAJOR   an install that upgrades may lose or change
//                             behaviour it relied on — schema, contract, on-disk
//                             layout, a removed capability
//   feat:             MINOR   new capability, nothing existing taken away
//   fix:              PATCH   existing behaviour made correct
//   chore:            PATCH   no behaviour change at all — docs, CI, deps,
//                             refactor. Still moves, because a build was still
//                             produced and two different builds must never
//                             share a version.
//
// Accepted spellings, all case-insensitive: a scope in parens (`feat(graph):`),
// and `!` for a breaking change of any category (`feat!:`, `fix!:`), which is
// the conventional-commits marker and outranks the category it is attached to.

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Category → which component of `major.minor.patch` moves. */
const BUMP_BY_CATEGORY = {
  'breaking change': 'major',
  feat: 'minor',
  fix: 'patch',
  chore: 'patch'
}

/** Spelled out for the error message, in the order a reader should consider them. */
const CATEGORIES = ['breaking change', 'feat', 'fix', 'chore']

/**
 * The category of a commit subject, or null when it declares none.
 *
 * Returns the BUMP, not the category: `feat!` and `breaking change` are the
 * same instruction to this script, and collapsing them here means the caller
 * never has to know that `!` outranks the word in front of it.
 */
export function bumpFor(subject) {
  const m = /^\s*([a-z][a-z ]*?)\s*(\([^)]*\))?\s*(!)?\s*:/i.exec(subject ?? '')
  if (!m) return null
  const category = m[1].toLowerCase().replace(/\s+/g, ' ')
  const bump = BUMP_BY_CATEGORY[category]
  if (!bump) return null
  // `!` means breaking whatever it is attached to. `breaking change!` is
  // redundant rather than wrong, and lands in the same place.
  return m[3] ? 'major' : bump
}

/**
 * Apply a bump to a semver string.
 *
 * Lower components RESET, which is what makes the number readable: 0.1.2 with a
 * feature is 0.2.0, not 0.2.2. Any prerelease/build suffix is dropped — this
 * project ships plain `x.y.z` and electron-builder puts the version into
 * artifact filenames and the update manifest, where a suffix is a separate
 * decision no commit subject should be able to make by accident.
 */
export function nextVersion(current, bump) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(current)
  if (!m) throw new Error(`package.json version is not x.y.z: ${current}`)
  let [major, minor, patch] = m.slice(1, 4).map(Number)
  if (bump === 'major') return `${major + 1}.0.0`
  if (bump === 'minor') return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

function usage(subject) {
  return [
    `The commit subject declares no version category, so there is nothing to build.`,
    ``,
    `  subject: ${subject || '(empty)'}`,
    ``,
    `Start the subject with one of these and a colon:`,
    ...CATEGORIES.map((c) => `  ${c}:${' '.repeat(16 - c.length)}→ ${BUMP_BY_CATEGORY[c]}`),
    ``,
    `A scope is allowed (\`feat(graph): …\`), and \`!\` marks a breaking change of`,
    `any category (\`fix!: …\` → major).`
  ].join('\n')
}

function main(argv) {
  const printOnly = argv[0] === '--print'
  const subject = (printOnly ? argv[1] : argv[0]) ?? ''

  const bump = bumpFor(subject)
  if (!bump) {
    console.error(usage(subject.split('\n')[0]))
    process.exit(1)
  }

  const manifest = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'package.json')
  const raw = readFileSync(manifest, 'utf8')
  const doc = JSON.parse(raw)
  const version = nextVersion(doc.version, bump)

  if (printOnly) {
    console.log(version)
    return
  }

  // A targeted replacement of the version LINE rather than a re-serialisation of
  // the parsed object: `JSON.stringify` would reflow the whole manifest, turning
  // a one-field change into a diff nobody can review.
  const updated = raw.replace(
    /^(\s*"version"\s*:\s*")[^"]*(",?\s*)$/m,
    (_, head, tail) => `${head}${version}${tail}`
  )
  if (updated === raw) throw new Error('could not find the "version" line in package.json')
  writeFileSync(manifest, updated)
  console.log(`${doc.version} → ${version} (${bump})`)
}

// ONLY WHEN RUN, never when imported. `bump-plugins.mjs` imports `bumpFor` and
// `nextVersion` from here so that "what does feat! mean" has one answer rather
// than two that drift; without this guard that import would also RUN this,
// bumping package.json as a side effect of asking a question about a plugin.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
}
