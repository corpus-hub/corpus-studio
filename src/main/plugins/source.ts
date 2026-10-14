import { getDb } from '../db/connection'
import { getSetting, setSetting } from '../db/repositories'

/**
 * WHO SUPPLIED a plugin, as a row in `setting` beside `plugin.<id>.enabled` and
 * `plugin.<id>.removed`.
 *
 * IN THE DATABASE for the same two reasons the removal record is: it must
 * survive a restart, and it must be readable BEFORE any plugin code runs — the
 * removal lock is checked in the IPC handler, which answers long before a
 * plugin's module is asked anything.
 *
 * ONE VALUE ONLY, `repository`, and absence means "the user brought this one
 * themselves". A row per supplier would be a table of provenances that nothing
 * reads; what the app actually has to decide is whether Remove applies, and that
 * is one question with one answer.
 *
 * It lives in its own module rather than in `host.ts` or `repository.ts` because
 * both of those need it and they already point at each other — the repository
 * installs through the host, and the host reports the supplier on every row.
 */
const SOURCE_KEY = (id: string): string => `plugin.${id}.source`

/** The only supplier that is written down. Anything else is a user's own folder. */
export const REPOSITORY_SOURCE = 'repository'

/** Whether this id was installed by the connected repository. */
export function isRepositorySupplied(id: string): boolean {
  return getSetting(getDb(), SOURCE_KEY(id)) === REPOSITORY_SOURCE
}

/** Record that the repository supplied this id, or that nothing does any more. */
export function setRepositorySupplied(id: string, supplied: boolean): void {
  setSetting(getDb(), SOURCE_KEY(id), supplied ? REPOSITORY_SOURCE : '')
}

/**
 * Every id the repository currently owns.
 *
 * By PREFIX, exactly as the removal records are enumerated, and for the same
 * reason: disconnecting has to release every lock, including one written for a
 * plugin whose folder has since been deleted by hand. The id is bounded by the
 * manifest's own shape so the two fixed affixes cannot be spoofed by a key in
 * the middle.
 */
export function repositorySuppliedIds(): string[] {
  const rows = getDb()
    .prepare<[], { key: string }>(
      "SELECT key FROM setting WHERE key LIKE 'plugin.%.source' AND value = ?"
    )
    .all(REPOSITORY_SOURCE)
  const out: string[] = []
  for (const row of rows) {
    const id = row.key.slice('plugin.'.length, -'.source'.length)
    if (/^[a-z][a-z0-9-]{1,62}$/.test(id)) out.push(id)
  }
  return out
}
