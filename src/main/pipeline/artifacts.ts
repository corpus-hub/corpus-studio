// The generic artifact store — how a stage publishes a capability's value and
// how a later stage reads it back.
//
// Rows are keyed by (stage_run_id, capability), never by work or document. That
// scoping is the whole point: after a transformer runs there are legitimately
// two inventories for the same token, and a consumer that queried by work id
// would match both and merge two incompatible datasets without noticing.

import type { DB } from '../db/connection'
import type { ResolvedRegistry } from './registry'
import { currentRunsOfStage } from './stageRun'
import type { Capability, StageDefinition, StagePlanContext } from './types'

export function writeArtifact(
  db: DB,
  stageRunId: number,
  cap: Capability,
  value: unknown
): void {
  db.prepare(
    `INSERT INTO stage_artifact (stage_run_id, key, json) VALUES (?, ?, ?)
       ON CONFLICT(stage_run_id, key) DO UPDATE SET json = excluded.json`
  ).run(stageRunId, cap, JSON.stringify(value))
}

export function readArtifact<T>(db: DB, stageRunId: number, cap: Capability): T | undefined {
  const row = db
    .prepare('SELECT json FROM stage_artifact WHERE stage_run_id = ? AND key = ?')
    .get(stageRunId, cap) as { json: string } | undefined
  if (!row) return undefined
  return JSON.parse(row.json) as T
}

/**
 * Resolve a required capability for the stage at `index`.
 *
 * Walks the provider chain nearest-first and returns the first value anyone
 * actually produced. A transformer that declined to run (`skipped`) is
 * therefore TRANSPARENT — `segment` still sees `extract-text`'s pages when
 * `ocr` had nothing to rewrite. Resolving to the single nearest provider
 * instead would let any no-op transformer starve the entire pipeline behind
 * it, which is a much worse failure than the coupling it was meant to remove.
 *
 * `empty` and `refused` are NOT transparent: those are positive claims that
 * there is nothing, and falling through them would resurrect data a stage
 * deliberately retired.
 */
export function resolveInput<T>(
  db: DB,
  registry: ResolvedRegistry,
  consumer: StageDefinition,
  ctx: StagePlanContext,
  cap: Capability
): T | undefined {
  const self = registry.byId(consumer.id)
  if (!self) return undefined
  for (const provider of registry.providersFor(cap, self.index)) {
    // Every current run of the provider, because a fanned-out stage has one per
    // key and a single `fanout_key = ''` lookup would find none of them.
    const runs = currentRunsOfStage(db, provider.id, ctx, provider.scope)
    if (runs.length === 0) continue
    if (runs.some((r) => r.status === 'empty' || r.status === 'refused')) return undefined
    for (const run of runs) {
      if (run.status !== 'succeeded') continue
      const value = readArtifact<T>(db, run.id, cap)
      if (value !== undefined) return value
    }
  }
  return undefined
}
