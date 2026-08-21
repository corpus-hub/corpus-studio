// Verifying citations as TWO-SIDED claims: a passage in the citing paper, and
// the specific block of the cited paper it refers to.
//
// Reference parsing already answers "paper X cites paper Y" — deterministically,
// for papers that are not even in the library yet. That is a different feature
// and it is untouched. This stage adds, on top of those edges, the thing a
// deterministic scan cannot produce: a CHECKED claim that a particular sentence
// really invokes a particular paper, and that it is invoking a particular part
// of it.
//
// `scope: 'corpus'`, and that is forced rather than stylistic. The question
// belongs to a PAIR of papers, and neither of them owns it: a document-scoped
// run keyed on the citing paper could never be woken by the cited paper's
// arrival, which is precisely the event the user asked to trigger on ("when a
// new doc is added and this doc is the CITED paper, run all papers CITING this
// doc against it"). Declaring `text.embeddings@v1` among the requires is what
// makes that happen — the scheduler wakes every corpus stage whose required
// tokens a finishing stage provides, so `embed` completing on a newly imported
// paper wakes this sweep with no stage id named anywhere.

import {
  citationPendingDigest,
  verificationHash,
  writeCitationLink,
  type CitationLinkWrite
} from '../../citations/verifyStore'
import {
  citationVerifyItemSchema,
  citationVerifyOutputSchema,
  getPrompt
} from '../../llm/prompts'
import { logCitationVerdict } from '../../devlog'
import { isLlmUnavailable, isTruncated } from '../../llm/provider'
import { insistOnValid } from '../../llm/repair'
import type { z } from 'zod'
import type { CitationCandidateRow, SemanticBlock, StageDefinition } from '../types'

/**
 * The model that verifies a citation, from the user's settings.
 *
 * `extractionModel`, because verification is a READING of a passage — the same
 * job extraction does — and the Settings screen offers no third control. Empty
 * means "whatever the provider defaults to", the one honest reading of a blank
 * field.
 *
 * This exists because the model was previously not passed at all and the
 * provider's constructor default answered instead: a silent substitution
 * visible only in the `model` column of a stored run.
 */
function verifyModel(ctx: { db: { modelSettings: () => { extractionModel: string } } }): string | undefined {
  const configured = ctx.db.modelSettings().extractionModel.trim()
  return configured === '' ? undefined : configured
}


/**
 * How many blocks of the cited paper the model chooses from.
 *
 * Scaled to the pair rather than fixed: a pair with one passage is one question,
 * and showing it twenty blocks pays for nineteen the passage cannot be about.
 * The ceiling is what bounds the prompt — twelve blocks at the cap below is
 * ~11k characters, comfortably inside the budget even before the passages.
 */
const BLOCKS_MIN = 6
const BLOCKS_MAX = 12
/** Blocks retrieved PER PASSAGE before the pair's union is ranked and cut. */
const PER_PASSAGE_K = 20

/**
 * How much of a block the model reads.
 *
 * 594 of this corpus's 809 chunks are longer than this, so most blocks ARE cut —
 * which is why the cut lands on a sentence boundary where one is available. A
 * block sliced mid-word reads as a different, garbled claim, and the model is
 * being asked to judge what the block says.
 */
const BLOCK_CHARS = 1100

/**
 * The prompt version this stage speaks.
 *
 * Named ONCE. It was written out at both call sites — the fingerprint and the
 * execute path — so a bump had to be made in two places or the stage would
 * fingerprint one version and run another, and every stored verdict would be
 * stamped with a prompt that did not produce it.
 */
const CITATION_VERIFY_VERSION = 'v4'

/**
 * Shortest quote that can carry a claim.
 *
 * "we" or "kcat" is printed in almost every block of a paper, so a quote below
 * this length is satisfied by the block being written in English rather than by
 * it stating the cited thing — and the check would pass everything it exists to
 * catch.
 */
const MIN_QUOTE_CHARS = 25

/**
 * Both sides flattened the same way before they are compared.
 *
 * A PDF text layer prints `k cat ∕ K m` and `10 5 s − 1 M − 1`, with the spacing
 * an artefact of glyph positions rather than of the author. A model copying such
 * a run will not reproduce those spaces byte for byte, and a verbatim comparison
 * would reject correct quotes on typesetting alone. Case, whitespace and the
 * unicode dash/quote variants are therefore removed from both — everything that
 * remains is the model's own word choice, which is what is under test.
 */
function flatten(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2010-\u2015\u2212-]/g, '-')
    .replace(/[\u2018\u2019\u201c\u201d]/g, "'")
    .replace(/\s+/g, '')
}

/**
 * Is the quote actually printed in the block it was taken from?
 *
 * The anchor's falsifiability, and the reason `block_quote` exists. An id alone
 * is unfalsifiable — a block chosen because it is the closest of a mediocre set
 * looks byte-identical to the referent — and on this corpus that produced anchors
 * pointing at a paragraph merely on the same subject: a
 * claim about designed enzymes' efficiencies anchored to natural enzymes' kcat/Km,
 * a crystallography passage anchored to a kinetics block. Requiring a copied run
 * turns "which block is closest" into "show me the sentence", which the topical
 * near-miss cannot answer.
 */
function quoteIsPrinted(quote: string | null | undefined, blockText: string): boolean {
  if (!quote) return false
  const q = flatten(quote)
  if (q.length < MIN_QUOTE_CHARS) return false
  return flatten(blockText).includes(q)
}

/**
 * Sections of the CITED paper that can never be what a citation refers to.
 *
 * Everything else in this pipeline refuses rather than guesses — the callout
 * mapping gate, the ambiguous-ordinal drop, `looksLikeProse`, the author-year
 * refusal. The cited-side anchor had no such discipline, and it showed: 28 of
 * 188 anchors landed on a paper's TITLE/byline block and one on its
 * acknowledgements. One anchored a
 * claim about Kemp elimination to "supported by the US Office of Naval
 * Research… e-mail: peyga@ccit.arizona.edu".
 *
 * Those blocks are indexed because search over a whole paper should reach them;
 * they are simply never the ANSWER to "which passage is this citation about".
 * A masthead matches any citation of the paper on topic alone, which is exactly
 * why it wins when the true referent is the paper as a whole — and a reader
 * cannot tell an anchor on a byline from an anchor on the right paragraph.
 * The honest answer there is no anchor at all, which the schema already allows.
 */
const NON_REFERENT_SECTIONS = new Set(['title', 'acknowledgements', 'references'])

/** Passages per call. A pair with more costs a second call, never a truncation. */
const PASSAGE_BATCH = 12

/**
 * Pairs one sweep will verify before handing the queue back.
 *
 * The sweep is a SINGLETON: without a ceiling, a 3000-work library would put six
 * thousand sequential calls into one job, hold the size-1 LLM gate for hours
 * against every other paper in the app, and outlive its own 5-minute lease. With
 * one, the residue simply remains pending, which moves the fingerprint, which
 * wakes the sweep again — so the corpus drains in bounded slices with no state
 * beyond the rows already committed.
 */
const PAIR_BUDGET = 40

/** Enough of the passage on each side of the marker to be a claim, not a window. */
const PASSAGE_CHARS = 700

interface Pair {
  citingWorkId: number
  citedWorkId: number
  citedTitle: string
  citedYear: number | null
  citedChunkCount: number
  rows: CitationCandidateRow[]
}

interface VerifyWrite {
  links: CitationLinkWrite[]
}

/**
 * The passage with the callout under test marked.
 *
 * Marked because a healed passage routinely spans SEVERAL callouts pointing at
 * different papers — on this corpus 445 of 1230 inline passages contain more
 * than two numbers. Asked "does this passage reference B" about such a passage,
 * a model can answer yes on the strength of a neighbouring clause that cites C,
 * and the resulting link would be a verified-looking claim about the wrong pair.
 * The offsets needed to point at the right marker are already stored.
 */
function markPassage(row: CitationCandidateRow): string {
  const text = row.sentence
  if (row.ordinal == null) return text

  // The RECORDED position, when the scanner pinned one. Exact by construction —
  // it was carried through sentence healing rather than re-derived — so it does
  // not have the ambiguity the search below has.
  const at = row.markerInSentence
  if (at != null && at >= 0 && at < text.length) {
    for (const form of [`[${row.ordinal}]`, `(${row.ordinal})`, String(row.ordinal)]) {
      // CHECKED before it is trusted. The column is nullable and old rows carry
      // NULL, but a row whose sentence was rewritten after the offset was taken
      // would carry a stale number, and marking the wrong token is the failure
      // this whole function exists to avoid.
      if (!text.startsWith(form, at)) continue
      return `${text.slice(0, at)}«${form}»${text.slice(at + form.length)}`
    }
  }

  // No pin: fall back to the printed form, which is what the reader sees.
  const bracketed = [`[${row.ordinal}]`, `(${row.ordinal})`]
  for (const form of bracketed) {
    const found = text.indexOf(form)
    if (found === -1) continue
    // Only when it is UNAMBIGUOUS. A second occurrence means the first is a
    // coin toss, and a coin toss that lands wrong reads to the model as a
    // deliberate instruction to judge the wrong token.
    if (text.indexOf(form, found + form.length) !== -1) return text
    return `${text.slice(0, found)}«${form}»${text.slice(found + form.length)}`
  }
  // A superscript arrives as a BARE number, and a bare number must not be
  // matched inside another one: ordinal 6 marking the `6` of `∼2600` points the
  // model at a measurement and asks it to judge that as a citation. Both
  // neighbours must therefore be non-digits — which is also what makes the
  // marker the printed callout rather than a coincidence of digits.
  //
  // Even then, a scientific sentence repeats small numbers: measured on this
  // corpus, 104 of 1176 passages contain their own ordinal more than once, and
  // taking the first hit points at the wrong token in 89 of them. So a repeated
  // bare number is left UNMARKED.
  const bare = new RegExp(`(^|[^0-9.])(${row.ordinal})(?![0-9])`, 'g')
  const hits = [...text.matchAll(bare)]
  if (hits.length === 1) {
    const m = hits[0]
    const found = m.index + m[1].length
    return `${text.slice(0, found)}«${m[2]}»${text.slice(found + m[2].length)}`
  }
  // UNMARKED rather than marked wrongly. The prompt's instruction then has
  // nothing to point at, which costs precision on this passage; pointing it at
  // the wrong token would cost correctness on it, and a wrong verdict is not
  // distinguishable from a right one by looking at it.
  return text
}

/**
 * The passage as the model sees it, with the marker guaranteed to survive.
 *
 * `clip` takes a HEAD, and a marker past the cap would be cut away — leaving a
 * prompt that says "judge the token in «...»" beside a passage containing no
 * «...» at all. So when the marker is beyond the budget the window is taken
 * AROUND it instead, with an ellipsis on whichever side was dropped, so the
 * reader can see it is a window and not a truncated sentence.
 */
function passageForPrompt(row: CitationCandidateRow): string {
  const marked = markPassage(row)
  const at = marked.indexOf('«')
  if (at === -1 || at < PASSAGE_CHARS) return clip(marked, PASSAGE_CHARS)
  // Two thirds of the budget BEFORE the marker: a citation qualifies the clause
  // that precedes it, so that is the side carrying the claim being judged.
  const before = Math.floor(PASSAGE_CHARS * 0.66)
  const start = Math.max(0, at - before)
  const end = Math.min(marked.length, start + PASSAGE_CHARS)
  return `${start > 0 ? '…' : ''}${marked.slice(start, end).trim()}${end < marked.length ? '…' : ''}`
}

function clip(text: string, max: number): string {
  const t = text.trim()
  if (t.length <= max) return t
  const head = t.slice(0, max)
  // Cut on a sentence end where there is one in the last quarter, so the block
  // does not stop mid-clause and read as a claim its author did not make.
  const stop = Math.max(head.lastIndexOf('. '), head.lastIndexOf('.\n'))
  if (stop > max * 0.75) return head.slice(0, stop + 1)
  return `${head}…`
}

const verifyCitations: StageDefinition<{
  pairsConsidered: number
  pairsVerified: number
  pairsUnverifiable: number
  candidates: number
  llmCalls: number
  verified: number
  rejected: number
  unverifiable: number
  abstained: number
  targeted: number
  invented: number
  unsupported: number
}> = {
  id: 'verify-citations',
  label: 'Verify citations',
  version: '1.0.0',
  rank: 10,
  scope: 'corpus',
  provides: ['refs.verified@v1'],
  // The trigger, declared rather than hardcoded. `refs.contexts@v1` is the
  // citing side (a new paper's callouts) and `text.embeddings@v1` is the CITED
  // side (a new paper now has blocks to be pointed at); `refs.resolved@v1` is
  // the promotion sweep, which turns an unresolved reference into an edge and so
  // mints candidates without either document changing. Any of the three
  // finishing wakes this one, and a fourth producer of any of them would too.
  requires: ['refs.contexts@v1', 'text.embeddings@v1', 'refs.resolved@v1'],
  usesLlm: true,
  runtime: 'node',
  weight: 'light',
  // INLINE, and not negotiable: finding the block in the cited paper needs
  // `ctx.semantic`, and a host has neither a database nor the search worker, so
  // `hostEntry` hands it a null and this stage refuses. Left to the default it
  // ran as a host and reported "semantic search is not available in this build"
  // on a machine where it works perfectly — the exact misdiagnosis that file
  // warns about. The work is a bounded number of gated LLM calls, not CPU, so
  // there was never a reason to want a host.
  isolation: 'inline',

  /**
   * WITHOUT this the sweep would run exactly once, ever — the same trap
   * `resolve-references` documents. The generic fingerprint folds in each
   * required capability's providers as resolved for THIS stage's subject, and
   * this stage's subject is `work_id = 0`, where no per-document run exists;
   * every provider reads `absent`, the fingerprint is constant, and the second
   * sweep is a cache hit forever.
   *
   * A COUNT of pending pairs is not enough either, and the difference is not
   * academic. Two pending sets of equal size are a cache hit, so a deletion and
   * an ingest coalesced into one 750 ms debounce window would silently skip the
   * new paper. Worse, the case the user actually asked about produces exactly
   * that: a cited paper with no embeddings yields `unverifiable` rows, the
   * pending count then stays put when it finally embeds, and the paper is never
   * verified. So the fingerprint hashes the pending SET — each passage with the
   * work it names and how many blocks that work currently has — which changes
   * when any of those three things does.
   *
   * A FAILURE COUNTER is folded in for the mirror-image reason: a call that
   * failed writes no row, so the pending set is unchanged and the sweep would
   * cache-hit its own outage. `stage_run.status` carries that, and reading it
   * here is what makes the next wake retry rather than remember.
   */
  fingerprint(ctx) {
    const p = getPrompt('citation-verify', CITATION_VERIFY_VERSION)
    // Both halves come from `verifyStore`, which owns the ONE definition of what
    // a candidate is. A stage does not hand-write SQL against a bulk table: it
    // would match rows a superseded run owns, and the offline gate bans it.
    const d = citationPendingDigest(ctx.db, p.version)
    return `pending=${d.pending}|attempted=${d.attempted}|prompt=${p.name}@${p.version}|set=${d.digest}`
  },

  async execute(ctx) {
    const prompt = getPrompt('citation-verify', CITATION_VERIFY_VERSION)
    const candidates = ctx.db.citationCandidates(prompt.version)
    if (candidates.length === 0) {
      return {
        status: 'empty',
        reason:
          'every in-text citation between papers in this library has already been checked ' +
          'against the paper it names'
      }
    }

    // Grouped into ORDERED PAIRS, because the question is about two papers: one
    // call shows the cited paper's blocks once and asks about every passage of
    // the citing paper at once. Asking per callout would multiply the same
    // blocks across 272 calls on this corpus to learn 82 papers' worth of answer.
    const pairs = new Map<string, Pair>()
    for (const row of candidates) {
      const key = `${row.citingWorkId}->${row.citedWorkId}`
      const existing = pairs.get(key)
      if (existing) {
        existing.rows.push(row)
        continue
      }
      pairs.set(key, {
        citingWorkId: row.citingWorkId,
        citedWorkId: row.citedWorkId,
        citedTitle: row.citedTitle,
        citedYear: row.citedYear,
        citedChunkCount: row.citedChunkCount,
        rows: [row]
      })
    }

    const links: CitationLinkWrite[] = []
    let llmCalls = 0
    let verified = 0
    let rejected = 0
    let unverifiable = 0
    let abstained = 0
    let targeted = 0
    let invented = 0
    /**
     * Anchors the model named but could not quote.
     *
     * REPORTED, not silently swallowed. The link is still verified — only its
     * cited-side anchor is dropped — and a run that quietly turned twenty
     * anchors into nulls would read as a retrieval that found nothing rather
     * than as a check doing its job.
     */
    let unsupported = 0
    let pairsVerified = 0
    let pairsUnverifiable = 0
    let unreachable = false
    let unusable = 0
    let pairsAttempted = 0
    let searchUnavailable = false
    let searchFailures = 0
    /**
     * Passages a sweep TRIED and got no verdict for.
     *
     * The load-bearing counter, and the one the first draft did not have. Every
     * one of these writes no row, so the pending set is byte-identical to what
     * it was before the attempt — and an `empty` outcome is CACHED and satisfies
     * dependents. Without this number in the run's result, one torn call or one
     * dead search worker would be remembered as "there was nothing to verify",
     * permanently. It goes into the next fingerprint, where it reopens the work.
     */
    let unresolvedAttempts = 0
    const ordered = [...pairs.values()]

    for (const pair of ordered) {
      if (ctx.signal.aborted) return { status: 'failed', error: 'cancelled', retryable: true }
      if (pairsAttempted >= PAIR_BUDGET) break

      // The cited paper has NOTHING to point at. Recorded as its own verdict
      // rather than passed to a model that would then be asked to choose from an
      // empty list — and rather than left absent, which is indistinguishable
      // from "not looked at yet". Work 16 of this corpus is a scan with no text
      // layer, so this is a real state, not a defensive branch.
      if (pair.citedChunkCount === 0) {
        pairsUnverifiable++
        for (const row of pair.rows) {
          unverifiable++
          links.push({
            contextId: row.contextId,
            citingWorkId: row.citingWorkId,
            citedWorkId: row.citedWorkId,
            verdict: 'unverifiable',
            targetChunkId: null,
            candidateCount: 0,
            topScore: null,
            spaceId: null,
            model: null,
            promptVersion: prompt.version,
            reason: 'the cited paper has no embedded text to point at',
            inputHash: verificationHash({
              sentence: row.sentence,
              citedWorkId: row.citedWorkId,
              rawBibText: row.rawBibText,
              candidateChunkIds: [],
              promptVersion: prompt.version
            })
          })
        }
        continue
      }

      if (!ctx.semantic) {
        // REFUSED below, not silently one-sided. A verification without the
        // cited side is not a weaker version of this stage's answer, it is a
        // different and unasked-for claim.
        searchUnavailable = true
        break
      }

      // The blocks. Searched per passage and UNIONED, so a pair whose passages
      // cite the paper for different reasons still shows each of them its own
      // best matches — a single query built from the concatenated passages would
      // average them into a centroid that is about neither.
      //
      // OUTSIDE any LLM call, deliberately. A vector query is ~115 ms and the
      // gate holds one request process-wide; running it inside the critical
      // section would stall every other paper in the app for the search.
      const blocks = new Map<number, SemanticBlock>()
      let spaceId: number | null = null
      try {
        for (const row of pair.rows.slice(0, PASSAGE_BATCH * 2)) {
          const res = await ctx.semantic(row.sentence, PER_PASSAGE_K, [pair.citedWorkId])
          // The space is recorded, and a CHANGE of space mid-pair discards the
          // blocks rather than mixing them. A cosine between two spaces is a
          // number rather than an error, so a union across a re-embed would rank
          // by noise while looking exactly like a ranked list of results.
          if (spaceId !== null && res.spaceId !== spaceId) {
            throw new Error(
              `the embedding space changed mid-pair (${spaceId} -> ${res.spaceId}); ` +
                'blocks from two spaces cannot be ranked against each other'
            )
          }
          spaceId = res.spaceId
          for (const hit of res.blocks) {
            // Scoped by the SEARCH, then checked again here. The worker applies
            // the work filter itself, but a block from another paper reaching
            // the prompt would let the model anchor this claim in a paper nobody
            // named — the one failure that cannot be told from a correct answer
            // by looking at it.
            if (hit.workId !== pair.citedWorkId) continue
            // Front matter is never a referent. Dropped HERE rather than after
            // the model answers, so it is not offered as an option at all — a
            // block the model cannot see is a block it cannot anchor to, and
            // asking it to decline something we already know is wrong spends a
            // slot the real referent needed.
            if (NON_REFERENT_SECTIONS.has(hit.section)) continue
            const prev = blocks.get(hit.chunkId)
            if (!prev || hit.score > prev.score) blocks.set(hit.chunkId, hit)
          }
        }
      } catch (err) {
        // COUNTED, not merely logged. These passages get no verdict and write no
        // row, so the pending set is unchanged — and without a count of them in
        // the run's result, a dead search worker would leave the sweep reporting
        // `empty` (a cacheable, positive finding) and never retrying. The tally
        // goes into the fingerprint, which is what turns an outage back into
        // work rather than an answer.
        unresolvedAttempts += pair.rows.length
        searchFailures++
        ctx.log(`block search failed for ${pair.citingWorkId}->${pair.citedWorkId}: ${(err as Error).message}`)
        continue
      }

      const shown = [...blocks.values()]
        .sort((a, b) => b.score - a.score)
        .slice(
          0,
          Math.min(BLOCKS_MAX, Math.max(BLOCKS_MIN, pair.rows.length * 2))
        )
      if (shown.length === 0) {
        // The cited paper HAS blocks (checked above) but none came back for any
        // of these passages. Counted for the same reason: it is a gap, not a
        // finding, and it must not settle as one.
        unresolvedAttempts += pair.rows.length
        continue
      }

      const byBlockId = new Map(shown.map((b, i) => [`b${i}`, b]))
      const blockPayload = shown.map((b, i) => ({
        id: `b${i}`,
        page: b.page,
        section: b.section,
        text: clip(b.text, BLOCK_CHARS)
      }))

      pairsAttempted++
      let pairProduced = 0

      for (let i = 0; i < pair.rows.length; i += PASSAGE_BATCH) {
        const batch = pair.rows.slice(i, i + PASSAGE_BATCH)
        const passagePayload = batch.map((row) => ({
          id: `p${row.contextId}`,
          section: row.section,
          page: row.page,
          // The printed bibliography line. THE first question is whether the
          // callout's own reference names this paper at all, and a model shown
          // only a title cannot see that it names something else.
          reference_line: row.rawBibText ? clip(row.rawBibText, 300) : null,
          passage: passageForPrompt(row)
        }))
        const user = JSON.stringify({
          cited_paper: { title: pair.citedTitle, year: pair.citedYear },
          blocks: blockPayload,
          passages: passagePayload
        })

        let text: string
        try {
          text = await ctx.llm.call(
            [
              { role: 'system', content: prompt.system },
              { role: 'user', content: prompt.buildUser(user) }
            ],
            // The answer is one short object per passage — twelve of them fit in
            // a fraction of this. Generous rather than tight because a ceiling
            // that clips mid-JSON discards the whole batch, which is what 4096
            // did to 29 of 40 extraction runs.
            // THE CONFIGURED MODEL, named. Omitting it fell through to the
            // provider's own constructor default (`claude-haiku`), so this
            // stage read citations on haiku while Settings said sonnet and
            // nothing anywhere reported the disagreement.
            { maxTokens: 8192, model: verifyModel(ctx) }
          )
        } catch (err) {
          if (isLlmUnavailable(err)) {
            // Terminal for this run: the provider decides reachability once per
            // process, so the next pair would fail identically. The pairs
            // already verified are committed.
            unreachable = true
            break
          }
          // A truncated or torn call leaves this batch unverified. The rows stay
          // pending, the fingerprint's failure counter moves, and the next wake
          // retries — rather than the outage being cached as an answer.
          ctx.log(
            `verification call failed for ${pair.citingWorkId}->${pair.citedWorkId}` +
              `${isTruncated(err) ? ' (truncated)' : ''}: ${(err as Error).message}`
          )
          for (const row of batch) {
            logCitationVerdict({
              contextId: row.contextId,
              citingWorkId: row.citingWorkId,
              citedWorkId: row.citedWorkId,
              sentence: row.sentence,
              candidateBlockIds: [...byBlockId.keys()],
              stored: 'not-stored',
              anchor: 'none',
              why:
                `the verification call failed${isTruncated(err) ? ' (truncated)' : ''}, so this ` +
                `passage was never judged: ${(err as Error).message}`
            })
          }
          continue
        }
        llmCalls++

        // An answer that arrived but did not validate is not the same as an
        // answer saying "none of these reference it". Rather than discard a
        // whole batch of verdicts over one malformed field, the model is told
        // exactly what was wrong and asked to correct it.
        let parsedData: z.infer<typeof citationVerifyOutputSchema>
        try {
          parsedData = await insistOnValid(citationVerifyOutputSchema, {
            // The repair turn is the SAME reading, so it must be the same
            // model — a retry that silently switched models would mean one
            // verification answered by two.
            chat: (m, o) =>
              ctx.llm.call(m, { ...(o as { maxTokens?: number }), model: verifyModel(ctx) }),
            systemPrompt: prompt.system,
            ask: async () => text,
            originalUser: prompt.buildUser(user),
            maxTokens: 8192,
            log: (m) => ctx.log(`verification: ${m}`),
            schemaName: 'citation-verify'
          })
        } catch {
          unusable++
          for (const row of batch) {
            logCitationVerdict({
              contextId: row.contextId,
              citingWorkId: row.citingWorkId,
              citedWorkId: row.citedWorkId,
              sentence: row.sentence,
              candidateBlockIds: [...byBlockId.keys()],
              stored: 'not-stored',
              anchor: 'none',
              why: 'the model never returned an answer matching the schema, even after being told what was wrong'
            })
          }
          continue
        }
        const parsed = { success: true as const, data: parsedData }

        const byId = new Map(batch.map((r) => [`p${r.contextId}`, r]))
        const claimed = new Set<string>()
        for (const raw of parsed.data.verifications) {
          // Parsed ONE AT A TIME, so one malformed element cannot discard the
          // eleven correct verdicts beside it.
          const item = citationVerifyItemSchema.safeParse(raw)
          if (!item.success) {
            // A verdict the model did produce, discarded for a shape fault. The
            // passage stays pending, which is indistinguishable from never
            // having been judged unless the malformed answer is recorded.
            const claimedId = typeof (raw as { id?: unknown })?.id === 'string'
              ? (raw as { id: string }).id
              : null
            logCitationVerdict({
              contextId: claimedId ? Number(claimedId.replace(/^p/, '')) || 0 : 0,
              citingWorkId: pair.citingWorkId,
              citedWorkId: pair.citedWorkId,
              stored: 'not-stored',
              anchor: 'none',
              why:
                'the model answered about this passage, but the answer did not match the ' +
                `schema: ${item.error.issues.map((s) => `${s.path.join('.')}: ${s.message}`).join('; ')}`
            })
            continue
          }
          const row = byId.get(item.data.id)
          if (!row || claimed.has(item.data.id)) {
            // Stored NOTHING, and for a reason a reader cannot otherwise
            // recover: the passage simply stays pending forever, which looks
            // identical to a model that never answered about it.
            logCitationVerdict({
              contextId: Number(item.data.id.replace(/^p/, '')) || 0,
              citingWorkId: pair.citingWorkId,
              citedWorkId: pair.citedWorkId,
              answered: {
                references: item.data.references ?? null,
                blockId: item.data.block_id ?? null,
                quote: item.data.block_quote ?? null,
                reason: item.data.reason ?? null
              },
              stored: 'not-stored',
              anchor: 'none',
              why: row
                ? 'the model judged this passage twice in one answer; the later verdict was discarded'
                : `the model answered about '${item.data.id}', which was not in the batch it was shown`
            })
            continue
          }
          claimed.add(item.data.id)

          if (!item.data.references) {
            // The model read the passage and said it does not reference this
            // paper. Stored, and never presented as a citation context — this
            // is what "we must only get real references" means in the data.
            rejected++
            pairProduced++
            logCitationVerdict({
              contextId: row.contextId,
              citingWorkId: row.citingWorkId,
              citedWorkId: row.citedWorkId,
              sentence: row.sentence,
              candidateBlockIds: [...byBlockId.keys()],
              topScore: shown[0]?.score ?? null,
              answered: {
                references: false,
                reason: item.data.reason ?? null
              },
              stored: 'rejected',
              anchor: 'none'
            })
            links.push({
              contextId: row.contextId,
              citingWorkId: row.citingWorkId,
              citedWorkId: row.citedWorkId,
              verdict: 'rejected',
              targetChunkId: null,
              candidateCount: shown.length,
              topScore: shown[0]?.score ?? null,
              spaceId,
              model: verifyModel(ctx) ?? ctx.llm.model,
              promptVersion: prompt.version,
              reason: item.data.reason ?? null,
              inputHash: verificationHash({
                sentence: row.sentence,
                citedWorkId: row.citedWorkId,
                rawBibText: row.rawBibText,
                candidateChunkIds: shown.map((b) => b.chunkId),
                promptVersion: prompt.version
              })
            })
            continue
          }

          // DROPPED, never repaired. A block id we did not show names no passage
          // of the cited paper, so coercing it to the nearest one would invent
          // an anchor the model did not choose — and an invented anchor is
          // indistinguishable from a found one to the reader who follows it.
          const named = item.data.block_id ? byBlockId.get(item.data.block_id) : undefined
          if (item.data.block_id && !named) invented++
          // The anchor stands only if the model could copy the sentence that
          // carries the cited claim. Compared against the CLIPPED text, which is
          // the only part of the block it was shown — a quote from the tail it
          // never read would be a quote it did not take from anything.
          let chosen = named
          if (named && !quoteIsPrinted(item.data.block_quote, clip(named.text, BLOCK_CHARS))) {
            unsupported++
            chosen = undefined
          }
          if (chosen) targeted++
          verified++
          pairProduced++
          logCitationVerdict({
            contextId: row.contextId,
            citingWorkId: row.citingWorkId,
            citedWorkId: row.citedWorkId,
            sentence: row.sentence,
            candidateBlockIds: [...byBlockId.keys()],
            topScore: shown[0]?.score ?? null,
            answered: {
              references: true,
              blockId: item.data.block_id ?? null,
              quote: item.data.block_quote ?? null,
              reason: item.data.reason ?? null
            },
            stored: 'verified',
            anchor: chosen
              ? 'targeted'
              : item.data.block_id && !named
                ? 'invented-block'
                : named
                  ? 'unsupported-quote'
                  : 'none',
            why: chosen
              ? null
              : item.data.block_id && !named
                ? `the model named block '${item.data.block_id}', which it was not shown`
                : named
                  ? 'the quote is not printed in the part of that block the model was shown'
                  : 'the model named no block, so the citation is verified but not anchored'
          })
          links.push({
            contextId: row.contextId,
            citingWorkId: row.citingWorkId,
            citedWorkId: row.citedWorkId,
            verdict: 'verified',
            targetChunkId: chosen?.chunkId ?? null,
            candidateCount: shown.length,
            topScore: shown[0]?.score ?? null,
            spaceId,
            model: verifyModel(ctx) ?? ctx.llm.model,
            promptVersion: prompt.version,
            reason: item.data.reason ?? null,
            inputHash: verificationHash({
              sentence: row.sentence,
              citedWorkId: row.citedWorkId,
              rawBibText: row.rawBibText,
              candidateChunkIds: shown.map((b) => b.chunkId),
              promptVersion: prompt.version
            })
          })
        }
        // Whatever the batch did not name, the model declined to judge — and
        // that is an ANSWER, so it is written down.
        //
        // It used to write nothing, which left the passage pending and offered
        // it again on every wake. The guard against that loop was a regex on the
        // candidate query refusing to ASK about anything not shaped like prose,
        // and it was the wrong instrument twice over: it made a judgement the
        // model is there to make, and it withheld real citing sentences whose
        // only defect was that extraction had clipped them short. Storing the
        // abstention ends the loop without anyone but the model deciding.
        for (const row of batch) {
          if (claimed.has(`p${row.contextId}`)) continue
          abstained++
          links.push({
            contextId: row.contextId,
            citingWorkId: row.citingWorkId,
            citedWorkId: row.citedWorkId,
            verdict: 'abstained',
            targetChunkId: null,
            candidateCount: shown.length,
            topScore: shown[0]?.score ?? null,
            spaceId,
            model: verifyModel(ctx) ?? ctx.llm.model,
            promptVersion: prompt.version,
            reason: 'the model was shown this passage and returned no verdict for it',
            inputHash: verificationHash({
              sentence: row.sentence,
              citedWorkId: row.citedWorkId,
              rawBibText: row.rawBibText,
              candidateChunkIds: shown.map((b) => b.chunkId),
              promptVersion: prompt.version
            })
          })
          logCitationVerdict({
            contextId: row.contextId,
            citingWorkId: row.citingWorkId,
            citedWorkId: row.citedWorkId,
            sentence: row.sentence,
            candidateBlockIds: [...byBlockId.keys()],
            topScore: shown[0]?.score ?? null,
            answered: null,
            stored: 'abstained',
            anchor: 'none',
            why: 'the model returned no verdict for this passage; recorded as an abstention'
          })
        }
      }

      if (pairProduced > 0) pairsVerified++
      if (unreachable) break
      ctx.progress(
        Math.round((pairsAttempted / Math.min(ordered.length, PAIR_BUDGET)) * 100),
        `${pairsVerified} pair(s) verified`
      )
    }

    if (searchUnavailable) {
      return {
        status: 'refused',
        reason:
          'semantic search is not available in this build, so the cited side of a citation ' +
          'cannot be located — and a one-sided result is a different claim, not a weaker one'
      }
    }

    if (links.length === 0) {
      if (unreachable) {
        return { status: 'refused', reason: 'no model could be reached to verify any citation' }
      }
      // ABSTENTION IS AN ANSWER, and the note must say which answer it was.
      //
      // A pair produces no verdict either because the model could not read the
      // passage — extraction leaves NMR peak lists, affiliation lines and
      // shattered table rows among the candidates — or because it genuinely
      // declined to judge. Both leave the rows pending so they are offered
      // again, which is right when the text might improve and misleading when
      // it will not: the same 20 unreadable passages come back on every wake
      // and the stage reports "none produced a verdict" forever, which reads as
      // permanently broken rather than as finished with nothing left to say.
      //
      // `not-needed` is the honest outcome when the model READ them and
      // declined: the stage ran, decided the right number of verdicts was zero,
      // and settles as a success instead of announcing itself. An unreadable
      // ANSWER is different — that is a fault, and stays `empty` for review.
      const declined = pairs.size - unusable
      if (unusable === 0 && declined > 0) {
        return {
          status: 'not-needed',
          reason:
            `${declined} paper pair(s) were checked and the model declined to link any of ` +
            'them — the citing passages do not support a verdict either way'
        }
      }
      return {
        status: 'empty',
        reason:
          `${pairs.size} paper pair(s) were offered for checking and none produced a verdict` +
          (unusable > 0 ? `; ${unusable} unreadable response(s) from the model` : '')
      }
    }

    ctx.write({ links } satisfies VerifyWrite)

    const remaining = ordered.length - pairsAttempted - pairsUnverifiable
    return {
      status: 'succeeded',
      result: {
        pairsConsidered: pairs.size,
        pairsVerified,
        pairsUnverifiable,
        candidates: candidates.length,
        llmCalls,
        // RETURNED, not merely counted. `citationPendingDigest` reads exactly
        // this key to build the failure-retry arm of the fingerprint, so
        // omitting it left that arm permanently zero — and a search-worker
        // outage or a torn LLM call was CACHED as an answer, which is the one
        // failure this stage's fingerprint exists to prevent.
        unresolvedAttempts,
        verified,
        rejected,
        unverifiable,
        abstained,
        targeted,
        invented,
        unsupported
      },
      note:
        `${verified} citation(s) confirmed across ${pairsVerified} paper pair(s), ` +
        `${targeted} anchored to a specific passage in the cited paper` +
        (rejected > 0 ? `; ${rejected} rejected — the passage does not reference that paper` : '') +
        (unverifiable > 0
          ? `; ${unverifiable} could not be checked — the cited paper has no readable text`
          : '') +
        (abstained > 0
          ? `; ${abstained} passage(s) the model declined to judge either way`
          : '') +
        (invented > 0
          ? `; ${invented} target(s) dropped — the model named a passage it was not shown`
          : '') +
        (unsupported > 0
          ? `; ${unsupported} target(s) dropped — the named passage does not state the cited claim`
          : '') +
        (unusable > 0 ? `; ${unusable} unreadable response(s) from the model` : '') +
        (unreachable ? '; stopped early — no model could be reached' : '') +
        // NAMED, not silent. A budgeted sweep that stops with work left must say
        // so, or a user reading "12 confirmed" concludes that is all there was.
        (remaining > 0
          ? `; ${remaining} more pair(s) remain and will be checked on the next pass`
          : ''),
      // WHAT ANSWERED, not what the provider was built with. `ctx.llm.model`
      // is the constructor default, chosen before any setting was read, so a
      // run under the configured model recorded the other one — provenance
      // that disagrees with reality is worse than none.
      provenance: { model: verifyModel(ctx) ?? ctx.llm.model, promptVersion: prompt.version }
    }
  },

  applyWrites(db, payload, ctx) {
    const w = payload as VerifyWrite
    const now = new Date().toISOString()
    // Written HERE rather than in `execute`, so the verdicts and this run's
    // terminal `stage_run` row commit together. A reclaimed executor would
    // otherwise leave rows nothing owns while its replacement re-spends the
    // calls that produced them.
    for (const link of w.links) writeCitationLink(db, link, ctx.stageRunId, now)
  }
}

export default verifyCitations
