// Measure how often the model's quote is REALLY in the paragraph it named.
//
//   ELECTRON_RUN_AS_NODE=1 electron --import tsx scripts/prompt-lab.ts [--docs 12,3,20] [--model haiku|sonnet] [--variant A]
//
// The anchoring contract is: the document is shown as `[p0] …`, `[p1] …`, a fact
// must name the paragraph it copied from, and the quote must be found verbatim
// INSIDE that paragraph. Anything else is a fabrication and the fact is dropped.
// That rule is only worth having if the model can actually follow it, so this
// harness reports the hit rate per prompt variant rather than assuming one.
//
// It classifies every miss, because the two kinds mean different things:
//   WRONG-PARAGRAPH  the text is in the paper, under another id — a citation
//                    error, and a prompt problem
//   ABSENT           the text is nowhere in the paper — a real paraphrase, and
//                    dropping it is correct behaviour, not a defect to tune away
//
// Nothing here writes to the database. It reads the paragraphs a real run would
// have been given and calls the real gateway.

import { initDatabase } from '../src/main/db/connection'
import { defaultDbPath } from '../src/main/db/paths'
import { tagParagraphs, getPrompt } from '../src/main/llm/prompts'

import { CommunicatorLlmProvider, UnavailableLlmProvider, extractJson } from '../src/main/llm/provider'
import { selectProvider } from '../src/main/llm/select'

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

/** Same canonical form the pipeline anchors with. */
const canon = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{Nd}]+/gu, '')

/**
 * NO WINDOW. The stage sends the whole paper, so a measurement over a slice
 * measures an easier problem than the one that ships.
 *
 * A 140-paragraph window scored 89% while the live stage's own notes reported
 * 309 kept against 164 dropped — 65%. Twenty-four points of the difference was
 * the harness handing the model a third of a paper (doc18 has 318 paragraphs)
 * and a smaller output budget, so fewer facts competed for fewer ids. A number
 * that flatters the product is worse than no number.
 */
const SLICE_FROM = 0
const SLICE_SIZE = Number.MAX_SAFE_INTEGER

/**
 * The [pN](s) a fact names. `12`, `"12"`, `"p12"` and `[11, 12, 14]` are all
 * valid: a table's evidence spans several paragraphs, so an array is the normal
 * answer there rather than an error.
 */
function paraNums(v: unknown): number[] {
  const one = (x: unknown): number | null => {
    if (typeof x === 'number' && Number.isFinite(x)) return x
    const m = /\d+/.exec(String(x ?? ''))
    return m ? Number(m[0]) : null
  }
  const list = Array.isArray(v) ? v.map(one) : [one(v)]
  return list.filter((n): n is number => n !== null)
}

// ---------------------------------------------------------------- variants
// Each is a complete system prompt. They differ ONLY in how they state the
// anchoring contract, so a difference in hit rate is attributable to the wording.

const SHAPE =
  'Return ONLY one JSON object, no prose:\n' +
  '{"facts":[{"predicate":"...","value_text":"...","paragraph":<integer>,"quote":"..."}]}'

const VARIANTS: Record<string, string> = {
  // The prompt the APP actually sends. Every other entry here is a hypothesis;
  // this one is the product. Measuring a hand-written copy and reporting the
  // number as the product's is how a prompt change gets credited or blamed for
  // a result it had no part in — which happened: a table instruction was added
  // to prompts.ts, the lab measured variant A which never had it, and the drop
  // was read as the instruction backfiring.
  SHIPPED: getPrompt('extraction').system,

  // The v4 prompt as shipped: states the rule, explains the consequence.
  A:
    `You extract enzyme kinetics and thermostability facts from a scientific paper.\n\n` +
    `EVIDENCE IS MANDATORY. Every fact MUST carry:\n` +
    `  "paragraph": the number N of the [pN] tag the text came from, and\n` +
    `  "quote": a span copied CHARACTER FOR CHARACTER from inside that paragraph.\n\n` +
    `Copy the quote exactly as printed — same spelling, spacing, digits and symbols.\n` +
    `Do NOT normalise, correct, translate, re-order or join text from more than one\n` +
    `paragraph. Do not add an ellipsis. A quote that cannot be found verbatim in the\n` +
    `paragraph you named is a FABRICATION and the fact will be dropped. If you cannot\n` +
    `quote it exactly, omit the fact.\n\n${SHAPE}`,

  // B: SHORT quotes. The longer the span, the likelier it crosses a paragraph
  // boundary or picks up a line-break artefact the model silently smooths.
  B:
    `You extract enzyme kinetics and thermostability facts from a scientific paper.\n\n` +
    `The document is shown as numbered paragraphs: [p0], [p1], [p2]…\n\n` +
    `For each fact you MUST give:\n` +
    `  "paragraph": the integer from the [pN] tag — write 12, not "p12"\n` +
    `  "quote": text copied EXACTLY from inside that one paragraph\n\n` +
    `RULES FOR THE QUOTE:\n` +
    `1. Copy, do not retype. Character for character, including odd spacing like\n` +
    `   "k cat", stray symbols, and numbers written as printed.\n` +
    `2. Keep it SHORT — 5 to 15 words is ideal. A short exact quote beats a long\n` +
    `   approximate one. Never quote across two paragraphs.\n` +
    `3. No ellipsis, no "...", no joining separated text.\n` +
    `4. Before answering, find your quote in the paragraph you named and confirm it\n` +
    `   is there, character for character.\n\n` +
    `If you cannot copy an exact quote, OMIT the fact entirely. A dropped fact costs\n` +
    `nothing; an unverifiable one is worse than silence.\n\n${SHAPE}`,

  // C: as B, plus a worked example. Models follow a demonstrated format more
  // reliably than a described one, especially for the id's type.
  C:
    `You extract enzyme kinetics and thermostability facts from a scientific paper.\n\n` +
    `The document is shown as numbered paragraphs: [p0], [p1], [p2]…\n\n` +
    `For each fact you MUST give:\n` +
    `  "paragraph": the integer from the [pN] tag — write 12, not "p12"\n` +
    `  "quote": text copied EXACTLY from inside that one paragraph\n\n` +
    `RULES FOR THE QUOTE:\n` +
    `1. Copy, do not retype. Character for character, including odd spacing like\n` +
    `   "k cat", stray symbols, and numbers written as printed.\n` +
    `2. Keep it SHORT — 5 to 15 words. Never quote across two paragraphs.\n` +
    `3. No ellipsis, no joining separated text.\n` +
    `4. Re-read the paragraph you named and confirm your quote appears in it.\n\n` +
    `EXAMPLE. Given:\n` +
    `  [p41] Kinetic constants were measured at 25 °C. The R7 variant reached\n` +
    `  k cat / K M = 1990 M 1 s 1 , a 160-fold gain over the original design.\n` +
    `Correct answer:\n` +
    `  {"predicate":"kcat_km","value_text":"1990","paragraph":41,\n` +
    `   "quote":"k cat / K M = 1990 M 1 s 1"}\n` +
    `Note the quote keeps the spaced "k cat" and the odd unit spacing exactly as\n` +
    `printed. A quote of "kcat/KM = 1990 M^-1 s^-1" would be WRONG — it was retyped.\n\n` +
    `If you cannot copy an exact quote, OMIT the fact.\n\n${SHAPE}`,
  // D: written against the two failures A-C actually made on this corpus.
  // Off-by-one (`said p38, really p39`) says the model is COUNTING paragraphs
  // rather than reading the tag, so the tag is framed as a label to copy back.
  // "absent" quotes were fluent summaries of the paragraph, so the instruction
  // is to copy a fragment and to prefer the sentence containing the number.
  D:
    `You extract enzyme kinetics and thermostability facts from a scientific paper.\n\n` +
    `Every paragraph is prefixed with a LABEL like [p7] or [p214]. The label is\n` +
    `printed in the text — read it off the paragraph you are quoting and copy it\n` +
    `back. Do NOT count paragraphs and do not infer the number; the labels are not\n` +
    `always consecutive with what you would count.\n\n` +
    `For each fact give:\n` +
    `  "paragraph": the integer inside that label — from [p7] write 7\n` +
    `  "quote": a fragment COPIED from inside that same labelled paragraph\n\n` +
    `HOW TO QUOTE:\n` +
    `- Copy a contiguous run of characters that is already in the paragraph.\n` +
    `  Do not summarise it, tidy it, or write it in your own words.\n` +
    `- Prefer the shortest fragment that contains the value — usually the clause\n` +
    `  with the number in it, 4 to 12 words.\n` +
    `- Keep the paper's own spacing and symbols, including oddities like "k cat",\n` +
    `  "T m", "10 5" or a stray minus sign. They are in the text; reproduce them.\n` +
    `- Never join text from two paragraphs. Never add "...".\n\n` +
    `SELF-CHECK before you answer: for each fact, look at the paragraph whose\n` +
    `label you wrote and confirm your quote appears there character for character.\n` +
    `If it does not, either fix the label or drop the fact.\n\n${SHAPE}`
}

interface Miss {
  claimed: number | null
  quote: string
  where: 'wrong-paragraph' | 'absent' | 'no-anchor'
  actualPara?: number
}

async function scoreDoc(
  provider: CommunicatorLlmProvider,
  paras: string[],
  system: string
): Promise<{
  total: number
  hit: number
  misses: Miss[]
  elapsedMs: number
  arrayAnswers: number
  singleAnswers: number
}> {
  // Through the SAME size-1 gate the pipeline uses. This harness is a loop over
  // documents and variants, which is precisely the shape that would otherwise
  // put several calls upstream at once; the gate is the one place that rule is
  // enforced, so the measurement must respect it rather than route around it.
  //
  // A whole paper is 12-19k input tokens and answering it can run past the
  // gate's 900s wall-clock cap, which killed the first attempt at this
  // measurement. The hit rate is a property of the CONTRACT, not of the document
  // length, so a bounded slice measures the same thing far faster — and the
  // numbering is generated from exactly what is sent, so the ids stay honest.
  // NOT wrapped in LLM_GATE here. `callLLM` already acquires it through
  // GLOBAL_LLM_SEMAPHORE, so wrapping deadlocks: the outer acquisition holds the
  // single slot while the inner one waits for the same slot, forever. That is
  // what made every measurement hang until the 900s cap, while the identical
  // request over raw HTTP answered in under a second.
  const started = Date.now()
  const raw = await provider.callLLM(
    [
      { role: 'system', content: system },
      { role: 'user', content: tagParagraphs(paras.join('\n\n')) }
    ],
    // The SAME budget the pipeline gives it (`MAX_OUTPUT_TOKENS`).
    { maxTokens: 16384 }
  )
  const elapsedMs = Date.now() - started
  // A truncated answer still holds every fact the model finished writing, and
  // the shipped prompt now asks for more per fact (the paragraph array), so the
  // ceiling is reached more often. Throwing the whole response away would score
  // a prompt on how much of it fitted rather than on how well it anchored.
  let facts: Array<Record<string, unknown>> = []
  try {
    const parsed = extractJson(raw) as { facts?: Array<Record<string, unknown>> } | null
    facts = parsed?.facts ?? []
  } catch {
    facts = []
  }
  if (facts.length === 0 && raw.includes('"facts"')) {
    for (const m of raw.matchAll(/\{[^{}]*"quote"\s*:\s*"(?:[^"\\]|\\.)*"[^{}]*\}/g)) {
      try {
        facts.push(JSON.parse(m[0]) as Record<string, unknown>)
      } catch {
        /* a record that does not parse alone is simply not scored */
      }
    }
  }
  const canonParas = paras.map(canon)
  let hit = 0
  let arrayAnswers = 0
  let singleAnswers = 0
  const misses: Miss[] = []
  for (const f of facts) {
    const ids = paraNums(f.paragraph)
    if (Array.isArray(f.paragraph)) arrayAnswers++
    else if (ids.length > 0) singleAnswers++
    const q = String(f.quote ?? '')
    if (ids.length === 0 || q === '') {
      misses.push({ claimed: null, quote: q, where: 'no-anchor' })
      continue
    }
    const p = ids[0]
    const cq = canon(q)
    // The SAME condition the pipeline applies: the quote must be inside the
    // paragraph(s) named — joined in the order given, which is how a table's
    // evidence is presented.
    const inRange = ids.every((i) => i >= 0 && i < paras.length)
    const joined = inRange ? ids.map((i) => paras[i]).join('\n') : ''
    if (inRange && canon(joined).includes(cq)) {
      hit++
      continue
    }
    const actual = canonParas.findIndex((t) => t.includes(cq))
    misses.push({
      claimed: p,
      quote: q,
      where: actual === -1 ? 'absent' : 'wrong-paragraph',
      actualPara: actual === -1 ? undefined : actual
    })
  }
  return { total: facts.length, hit, misses, elapsedMs, arrayAnswers, singleAnswers }
}

async function main(): Promise<void> {
  const db = initDatabase(defaultDbPath())
  // `--docs all` measures the WHOLE corpus. The default used to be three
  // documents, and a hit rate from three papers is not a hit rate — it is an
  // anecdote that happens to have a percent sign after it.
  const docsArg = arg('docs') ?? 'all'
  const docIds =
    docsArg === 'all'
      ? (
          db
            .prepare(
              `SELECT DISTINCT document_id FROM document_paragraph ORDER BY document_id`
            )
            .all() as Array<{ document_id: number }>
        ).map((r) => r.document_id)
      : docsArg
          .split(',')
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isFinite(n))
  const model = arg('model') === 'sonnet' ? 'claude-sonnet-4-6' : 'claude-haiku-4-5-20251001'
  const which = (arg('variant') ?? 'A,B,C').split(',')

  // Through `selectProvider`, not a bare constructor: the provider needs the
  // gateway CREDENTIAL, and constructing one directly defaults it to null. That
  // sends an empty bearer token, and the gateway neither answers nor rejects —
  // the call simply hangs until the gate's 900s cap kills it, which is what made
  // this harness look like a slow model rather than a misconfigured client.
  const selection = await selectProvider({ mode: 'live', model })
  if (selection.provider instanceof UnavailableLlmProvider) {
    console.log(`no live model: ${selection.provider.why}`)
    db.close()
    return
  }
  const provider = selection.provider as CommunicatorLlmProvider
  console.log(`model: ${provider.model}`)
  console.log(`documents: ${docIds.join(', ')}\n`)

  for (const name of which) {
    const system = VARIANTS[name]
    if (!system) {
      console.log(`no variant "${name}"`)
      continue
    }
    let total = 0
    let hit = 0
    const kinds = { 'wrong-paragraph': 0, absent: 0, 'no-anchor': 0 }
    let arrayAnswers = 0
    let singleAnswers = 0
    const samples: string[] = []
    for (const docId of docIds) {
      const paras = (
        db
          .prepare(
            `SELECT text FROM document_paragraph
              WHERE document_id = ? AND kind <> 'reference' ORDER BY rowid ASC`
          )
          .all(docId) as Array<{ text: string }>
      ).map((r) => r.text)
      if (paras.length === 0) continue
      // A bounded window keeps one measurement well inside the gate's cap. The
      // slice starts where a kinetics paper's results actually are rather than
      // at the title page, so the model has something to extract.
      const slice = paras.slice(SLICE_FROM, SLICE_FROM + SLICE_SIZE)
      if (slice.length === 0) continue
      process.stdout.write(`  [${name}] doc${docId}: ${slice.length} paras, calling…\n`)
      const r = await scoreDoc(provider, slice, system)
      arrayAnswers += r.arrayAnswers
      singleAnswers += r.singleAnswers
      process.stdout.write(`  [${name}] doc${docId}: ${r.total} facts in ${Math.round(r.elapsedMs/1000)}s\n`)
      total += r.total
      hit += r.hit
      for (const m of r.misses) {
        kinds[m.where]++
        if (samples.length < 4 && m.where !== 'no-anchor') {
          samples.push(
            `      [${m.where}${
              m.actualPara !== undefined ? ` — really p${m.actualPara}` : ''
            }] said p${m.claimed}: ${m.quote.slice(0, 62)}`
          )
        }
      }
    }
    const pct = total === 0 ? 0 : Math.round((100 * hit) / total)
    console.log(`variant ${name}: ${hit}/${total} anchored (${pct}%)`)
    console.log(
      `   wrong-paragraph ${kinds['wrong-paragraph']} · absent ${kinds.absent} · no-anchor ${kinds['no-anchor']}`
    )
    console.log(`   answered with an ARRAY ${arrayAnswers} · single id ${singleAnswers}`)
    for (const s of samples) console.log(s)
    console.log()
  }
  db.close()
  // The gate arms a 900s wall-clock timer per call and clears it on completion,
  // but a script that has finished still waits on Node's event loop for any
  // stragglers. Exiting explicitly keeps a measurement run from looking hung.
  process.exit(0)
}

void main()
