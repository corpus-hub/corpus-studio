// The corpus sweep: re-match every stored unresolved reference against the
// library as it is NOW.
//
// This is the cheap half of citation invalidation and the reason it deserves a
// stage at all. Matching is relative to the set of known works, so adding ONE
// paper can turn an existing unresolved reference into a real edge in EVERY
// paper that cited it — a parse that was correct yesterday is incomplete today
// through no change to its own PDF. Crucially it re-reads no PDF: the parsed
// fields are already in `unresolved_reference`, so this is an in-memory pass
// over a few hundred rows rather than 20 seconds of pdfjs per paper.
//
// `scope: 'corpus'` with `work_id = 0`: it is about the library, not a paper.
// The scheduler plans it as a debounced singleton with a generation counter,
// through machinery that is general over corpus-scoped stages rather than a
// special case named after this one.

import { findStaleParses, rematchUnresolved } from '../../citations/store'
import type { StageDefinition } from '../types'

const resolveReferences: StageDefinition<null> = {
  id: 'resolve-references',
  label: 'Resolve references',
  version: '1.0.0',
  rank: 9,
  scope: 'corpus',
  provides: ['refs.resolved@v1'],
  // The sweep consumes parse OUTPUT, and declaring it is what tells the
  // scheduler which stage finishing should wake it — no stage id is hardcoded
  // anywhere, so a second consumer of the same token wakes it too.
  requires: ['refs.parsed@v1'],
  usesLlm: false,
  runtime: 'node',
  weight: 'light',

  // WITHOUT this the sweep would run exactly once, ever.
  //
  // The generic fingerprint folds in each required capability's providers as
  // resolved for THIS stage's subject — and this stage's subject is
  // `work_id = 0`, where no per-document `references` run exists. Every
  // provider would read `absent`, the fingerprint would be constant, and the
  // second sweep would be a cache hit forever. So it names the corpus state it
  // actually depends on: how many works there are to match against, and how
  // many references are still looking for one.
  fingerprint(ctx) {
    const works = (ctx.db.prepare('SELECT COUNT(*) AS n FROM work').get() as { n: number }).n
    const unresolved = (
      ctx.db.prepare('SELECT COUNT(*) AS n FROM unresolved_reference').get() as { n: number }
    ).n
    return `works=${works}|unresolved=${unresolved}`
  },

  async execute(ctx) {
    // The body is entirely a WRITE, so it runs in `applyWrites`:
    // `rematchUnresolved` promotes references and moves their contexts in one
    // transaction, and doing that from `execute` would commit it separately
    // from the terminal `stage_run` row — the exact split that makes "the blast
    // radius of any stop is one stage" false.
    ctx.write({})
    return { status: 'succeeded', result: null }
  },

  applyWrites(db) {
    const promoted = rematchUnresolved(db)
    const stale = findStaleParses(db).length
    // The counts go in the ARTIFACT, which is written in this same
    // transaction. They are deliberately not in `execute`'s `result`: nothing
    // there could know them yet, and a plausible-looking zero would be a
    // fabricated report of what the sweep did.
    return [['refs.resolved@v1', { promoted, stale }]]
  }
}

export default resolveReferences
