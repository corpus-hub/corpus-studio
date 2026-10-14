import { test, expect, api } from './helpers/electron'
import type {
  AnalysisRunDTO,
  RankingRowDTO,
  ProjectDTO,
  GraphDTO
} from '../src/shared/contract'

/**
 * Compact invariant suite. Re-asserts the core product guarantees so future
 * changes are caught early. All assertions are DB-backed via window.api.
 */
test.describe('regression invariants', () => {
  test('seed-only DB: window.api returns real data', async ({ launch }) => {
    const { window } = await launch()
    const projects = await api<ProjectDTO[]>(window, 'listProjects')
    // The corpus seeds EXACTLY one project (KE07 Kemp Eliminase Engineering).
    expect(projects.length).toBe(1)
    const graph = await api<GraphDTO>(window, 'getGraph', 1, { limit: 60, minRelevance: 0 })
    expect(graph.total_works).toBeGreaterThan(0)
    expect(graph.nodes.length).toBeGreaterThan(0)
  })

  test('superseded uniqueness is surfaced: exactly one current run per key', async ({ launch }) => {
    const { window } = await launch()
    const analyses = await api<AnalysisRunDTO[]>(window, 'getWorkAnalyses', 2, 1)
    const extraction = analyses.filter((r) => r.analysis_type === 'extraction' && r.project_id === 1)
    expect(extraction.length).toBeGreaterThanOrEqual(2) // a current + a superseded
    const superseded = extraction.filter((r) => r.superseded === 1)
    expect(superseded.length).toBeGreaterThanOrEqual(1)

    // The uniqueness key includes `schema_id` (migration v15): extraction fans
    // out per attached schema, and before v15 a run under a second schema
    // silently retired the first schema's results. So the invariant is ONE
    // current run per (work, project, type, SCHEMA) — demanding one per
    // (work, project, type) would now demand exactly the data loss v15 exists
    // to prevent.
    const current = extraction.filter((r) => r.superseded === 0)
    expect(current.length, 'extraction is current under more than one schema').toBeGreaterThan(1)
    const bySchema = new Map<number, number>()
    for (const r of current) bySchema.set(r.schema_id, (bySchema.get(r.schema_id) ?? 0) + 1)
    for (const [schemaId, n] of bySchema) {
      expect(n, `exactly one current run for schema ${schemaId}`).toBe(1)
    }
    // …and the schemas are genuinely distinct, so the per-schema counts above
    // cannot be satisfied by every run collapsing onto one id.
    expect(bySchema.size, 'each current run has its own schema').toBe(current.length)
    // Each current run names the schema it belongs to; an unnamed one would
    // make the two tabs indistinguishable to a reader.
    for (const r of current) {
      expect(r.schema_id, 'a per-schema run is not the generic slot').toBeGreaterThan(0)
      expect(r.schema_name, `run ${r.id} names its schema`).toBeTruthy()
    }
  })

  test('relevance and expansion remain two distinct scores', async ({ launch }) => {
    const { window } = await launch()
    const rows = await api<RankingRowDTO[]>(window, 'getRanking', 1, 'relevance')
    const differing = rows.some(
      (r) =>
        r.relevance !== null &&
        r.expansion_priority !== null &&
        r.relevance !== r.expansion_priority
    )
    expect(differing, 'at least one row has distinct relevance vs expansion').toBe(true)
  })
})
