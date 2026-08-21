import { basename } from 'node:path'
import { getDb } from '../db/connection'
import { defaultDbPath } from '../db/paths'
import { sessionCounters } from './status'
import { mcpInFlightTotal } from './queue'

/**
 * The `health` tool: is this thing connected to what I think it is connected to?
 *
 * The install COUNTS are the load-bearing part. A fresh install of this app is
 * legitimately empty — no projects, no papers, no analyses — so an agent that
 * searches and gets nothing cannot otherwise tell "correctly empty" from
 * "pointed at the wrong database", and will report an absence of evidence with
 * total confidence. The counts make that distinction available.
 *
 * The database's FULL PATH is not returned. It is
 * `/home/<username>/.config/...`, so returning it discloses the OS username to
 * whatever is on the other end of the socket — the same class of leak the plan
 * already redacts `zotero_data_path` for, and it would be odd to redact one and
 * volunteer the other. The basename plus the schema version answers the actual
 * question ("which file am I on?") for anyone who can also see the launch log.
 */
export function health(startedAt: number, toolCount: number, level: string): Record<string, unknown> {
  const db = getDb()
  const counts = db
    .prepare(
      'SELECT (SELECT COUNT(*) FROM project) AS projects, ' +
        '(SELECT COUNT(*) FROM work) AS works, ' +
        '(SELECT COUNT(*) FROM document) AS documents'
    )
    .get() as { projects: number; works: number; documents: number }
  const schemaVersion = db.pragma('user_version', { simple: true }) as number
  const s = sessionCounters()

  return {
    app: 'corpus-studio',
    db_file: basename(defaultDbPath()),
    schema_version: schemaVersion,
    migrated: schemaVersion > 0,
    projects: counts.projects,
    works: counts.works,
    documents: counts.documents,
    empty_install: counts.works === 0,
    scope_note:
      counts.projects === 0
        ? 'This install has no projects yet — it is correctly empty, not misconfigured.'
        : counts.works === 0
          ? 'Projects exist but no papers have been imported yet.'
          : null,
    uptime_seconds: Math.round((Date.now() - startedAt) / 1000),
    in_flight: mcpInFlightTotal(),
    calls_this_session: s.callsThisSession,
    tool_count: toolCount,
    permission_level: level
  }
}
