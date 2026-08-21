// Reads the GENERATED attribution set at resources/licences/ and serves it over
// IPC. Nothing here fetches, and nothing here hardcodes a component: the file it
// reads is produced by `scripts/gen-licences.ts` from resources/payloads.json
// plus the installed npm closure, and `npm run verify:licences` fails when that
// file is stale. See CLAUDE.md §2 (local-first, no CDN).
//
// This is not a repository: attribution is not application data and does not
// belong in the user's corpus.sqlite — it is a property of the BUILD, so it is
// read from the shipped resource tree via `resourcePath`, like every other
// non-JS payload.

import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { LicenceEntryDTO, LicenceTextDTO } from '../shared/contract'
import { resourcePath } from './resources'

interface RawEntry extends LicenceEntryDTO {
  textFile: string | null
  textNote: string | null
}

let cache: RawEntry[] | null = null

function load(): RawEntry[] {
  if (cache) return cache
  const idx = resourcePath('licences', 'index.json')
  if (!existsSync(idx)) {
    // Loud, not silent. An empty list would render an attribution screen that
    // claims the app bundles nothing — worse than an error, because it looks
    // like compliance while asserting something false.
    throw new Error(
      `Third-party licence index missing at ${idx}. Run \`npm run licences\` ` +
        `(and check electron-builder.yml ships resources/licences/).`
    )
  }
  const parsed = JSON.parse(readFileSync(idx, 'utf8')) as { entries?: RawEntry[] }
  if (!Array.isArray(parsed.entries) || parsed.entries.length === 0) {
    throw new Error(`Third-party licence index at ${idx} lists no components.`)
  }
  cache = parsed.entries
  return cache
}

/** Every attributed component. Payloads first, then the npm tree. */
export function listLicences(): LicenceEntryDTO[] {
  return load().map(({ id, name, kind, version, license, homepage, purpose }) => ({
    id,
    name,
    kind,
    version,
    license,
    homepage,
    purpose
  }))
}

/**
 * The full text for one component.
 *
 * The id is matched against the INDEX rather than mapped to a path: the file
 * name it resolves to comes from the generated manifest, so a caller cannot
 * name an arbitrary file. `basename` is a second barrier in case the manifest
 * itself is ever produced from a less careful source.
 */
export function getLicenceText(id: string): LicenceTextDTO {
  const entry = load().find((e) => e.id === id)
  if (!entry) throw new Error(`Unknown licence entry: ${id}`)
  if (!entry.textFile) return { id, text: null, note: entry.textNote }
  const p = join(resourcePath('licences', 'texts'), basename(entry.textFile))
  if (!existsSync(p)) {
    return {
      id,
      text: null,
      note: `The licence text file for ${entry.name} is missing from this build. Run \`npm run licences\`.`
    }
  }
  return { id, text: readFileSync(p, 'utf8'), note: null }
}
