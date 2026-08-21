// Stage order resolution + boot-time graph validation.
//
// Ordering is DERIVED from capability tokens, never enumerated. A mis-declared
// stage fails at app launch with the offending token named, because the
// alternative — discovering it when a user's paper silently skips a stage — is
// not a failure anyone can act on.

import { inputsOf } from './types'
import type { Capability, ResolvedStage, StageDefinition } from './types'

export class StageGraphError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StageGraphError'
  }
}

export interface ResolvedRegistry {
  /** Stages in execution order. */
  readonly order: readonly ResolvedStage[]
  byId(id: string): ResolvedStage | undefined
  /**
   * The provider chain for `cap` visible to the stage at `index`, NEAREST
   * FIRST — i.e. every provider positioned strictly before it, latest first.
   *
   * A chain rather than a single stage because a transformer that declined to
   * run must be transparent: `ctx.input` walks the chain until it finds a
   * provider that actually produced something. Resolving to one stage would let
   * any no-op transformer starve everything behind it.
   *
   * "Strictly before" is also what stops a transformer resolving its own
   * unwritten output.
   */
  providersFor(cap: Capability, index: number): readonly StageDefinition[]
  /**
   * The stages a stage at `index` must wait for: the nearest provider of each
   * required token, plus every `before:` gate that names a token this stage
   * provides.
   *
   * The planner builds `job_dependency` from exactly this, so the dependency
   * edges and `ctx.input`'s resolution can never disagree.
   */
  dependenciesFor(stageId: string): readonly string[]
}

const tokenName = (cap: Capability): string => cap.split('@')[0]

export function resolveRegistry(stages: readonly StageDefinition[]): ResolvedRegistry {
  // ---------------------------------------------------------------- shape
  const seen = new Set<string>()
  for (const s of stages) {
    if (seen.has(s.id)) throw new StageGraphError(`duplicate stage id '${s.id}'`)
    seen.add(s.id)
    if (s.transforms) {
      if (!s.requires.includes(s.transforms) || !s.provides.includes(s.transforms)) {
        throw new StageGraphError(
          `stage '${s.id}' declares transforms '${s.transforms}' but does not both require ` +
            'and provide it — an unseen transform degrades into a second plain provider'
        )
      }
    }
  }

  // ---------------------------------------------------------------- providers
  // A token may have many providers only if all but one are transformers: two
  // stages independently claiming to produce the same shape means `ctx.input`
  // has no defensible answer about which one a consumer gets.
  const providersOf = new Map<Capability, StageDefinition[]>()
  for (const s of stages) {
    for (const cap of s.provides) {
      const list = providersOf.get(cap) ?? []
      list.push(s)
      providersOf.set(cap, list)
    }
  }
  for (const [cap, list] of providersOf) {
    const roots = list.filter((s) => s.transforms !== cap)
    if (roots.length > 1) {
      throw new StageGraphError(
        `capability '${cap}' has ${roots.length} non-transformer providers ` +
          `(${roots.map((s) => s.id).join(', ')}); exactly one stage may originate a token`
      )
    }
    if (roots.length === 0) {
      throw new StageGraphError(
        `capability '${cap}' is only ever transformed (${list
          .map((s) => s.id)
          .join(', ')}), never originated`
      )
    }
  }

  const requireResolvable = (s: StageDefinition, cap: Capability, kind: string): void => {
    if (providersOf.has(cap)) return
    // Name the near-miss: a version bump is by far the likeliest cause, and
    // "text.pages@v1 is unprovided" is much less useful than saying @v2 exists.
    const near = [...providersOf.keys()].filter((c) => tokenName(c) === tokenName(cap))
    throw new StageGraphError(
      `stage '${s.id}' ${kind} '${cap}', which no stage provides` +
        (near.length > 0 ? ` — did you mean ${near.join(' or ')}?` : '')
    )
  }
  for (const s of stages) {
    for (const cap of s.requires) requireResolvable(s, cap, 'requires')
    // An OPTIONAL input still has to be a real token. "Optional" means the stage
    // runs without a VALUE, never that it may name a shape nothing in the graph
    // produces — that spelling would be unresolvable forever and silently, since
    // no absence of it is ever an error.
    for (const cap of s.enriches ?? []) requireResolvable(s, cap, 'enriches')
    for (const cap of s.before ?? []) requireResolvable(s, cap, 'declares before')
    for (const cap of s.enriches ?? []) {
      if (s.requires.includes(cap)) {
        throw new StageGraphError(
          `stage '${s.id}' declares '${cap}' as both requires and enriches — ` +
            'one token cannot be a precondition and an optional enrichment at once'
        )
      }
    }
  }

  // ---------------------------------------------------------------- edges
  // `before:` is the inverse declaration: a front gate that nothing consumes
  // has no consumer to be ordered against, so without it inserting a stage at
  // the FRONT would mean editing whoever currently runs first.
  const edges = new Map<string, Set<string>>(stages.map((s) => [s.id, new Set<string>()]))
  const addEdge = (from: string, to: string): void => {
    if (from === to) return
    edges.get(to)?.add(from)
  }
  for (const s of stages) {
    for (const cap of inputsOf(s)) {
      for (const p of providersOf.get(cap) ?? []) {
        // A transformer of a token depends on the token's other providers, but
        // not on itself, and a plain consumer depends on all of them so it is
        // ordered after the last rewrite.
        addEdge(p.id, s.id)
      }
    }
    for (const cap of s.before ?? []) {
      for (const p of providersOf.get(cap) ?? []) addEdge(s.id, p.id)
    }
  }

  // ---------------------------------------------------------------- sort
  // Kahn, with ties broken by rank then id so the order is deterministic —
  // the Queue screen and the e2e ids depend on it. `rank` decides NOTHING a
  // token could decide; it only makes an under-constrained layer stable.
  const indegree = new Map<string, number>()
  for (const s of stages) indegree.set(s.id, edges.get(s.id)?.size ?? 0)
  const byId = new Map(stages.map((s) => [s.id, s]))
  const tieBreak = (a: string, b: string): number => {
    const sa = byId.get(a) as StageDefinition
    const sb = byId.get(b) as StageDefinition
    const ra = sa.rank ?? Number.MAX_SAFE_INTEGER
    const rb = sb.rank ?? Number.MAX_SAFE_INTEGER
    return ra !== rb ? ra - rb : a.localeCompare(b)
  }

  const order: StageDefinition[] = []
  const ready = stages.filter((s) => (indegree.get(s.id) ?? 0) === 0).map((s) => s.id)
  ready.sort(tieBreak)
  while (ready.length > 0) {
    const id = ready.shift() as string
    order.push(byId.get(id) as StageDefinition)
    for (const s of stages) {
      if (!edges.get(s.id)?.has(id)) continue
      const left = (indegree.get(s.id) ?? 0) - 1
      indegree.set(s.id, left)
      if (left === 0) {
        ready.push(s.id)
        ready.sort(tieBreak)
      }
    }
  }
  if (order.length !== stages.length) {
    const stuck = stages.filter((s) => !order.includes(s)).map((s) => s.id)
    throw new StageGraphError(
      `stage graph has a cycle among: ${stuck.join(' -> ')} (including any before: edges)`
    )
  }

  const indexOf = new Map(order.map((s, i) => [s.id, i]))
  const resolved: ResolvedStage[] = order.map((stage, index) => ({ stage, index }))

  return {
    order: resolved,
    byId: (id) => resolved.find((r) => r.stage.id === id),
    providersFor: (cap, index) =>
      (providersOf.get(cap) ?? [])
        .filter((p) => (indexOf.get(p.id) ?? -1) < index)
        .sort((a, b) => (indexOf.get(b.id) ?? 0) - (indexOf.get(a.id) ?? 0)),
    dependenciesFor: (stageId) => {
      const self = byId.get(stageId)
      if (!self) return []
      const idx = indexOf.get(stageId) ?? 0
      const deps = new Set<string>()
      // Optional inputs included. A stage that reads a token IF IT IS THERE
      // still has to be scheduled after whoever might produce it — otherwise
      // "absent" would mean "has not run yet" as often as it means "there is
      // none", and the enrichment would be dropped by a race rather than by a
      // fact about the paper.
      for (const cap of inputsOf(self)) {
        const chain = (providersOf.get(cap) ?? []).filter(
          (p) => (indexOf.get(p.id) ?? -1) < idx
        )
        // Every earlier provider, not just the nearest: `ctx.input` may fall
        // through to any of them, so waiting on only the last one would let the
        // stage read a producer that had not run yet.
        for (const p of chain) deps.add(p.id)
      }
      // A `before:` gate must be an actual dependency, or its `refused` outcome
      // cancels nothing and the gate does not gate.
      for (const other of stages) {
        for (const cap of other.before ?? []) {
          if (self.provides.includes(cap)) deps.add(other.id)
        }
      }
      deps.delete(stageId)
      return [...deps]
    }
  }
}
