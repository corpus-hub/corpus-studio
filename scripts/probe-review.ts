// Ask the reviewer every question the current corpus produces, and print what it
// says — against the REAL gateway, over the user's own DB, without touching a
// stored row.
//
//   npm run probe:review
//   CORPUS_DB_PATH=… npm run probe:review
//
// WHY IT EXISTS. The eleven checks that moved to the reviewer were retired on the
// strength of an argument: that a rule which has not read the paper cannot answer
// questions about the paper without sometimes being wrong. An argument is not a
// measurement. This runs the replacement over the exact records the old checks
// failed and prints the verdicts, so "the model gets `>95 °C` right" is something
// that was observed rather than expected.
//
// READ-ONLY, deliberately. It opens the DB, asks the questions and writes
// nothing: a probe that mutated the corpus could not be run twice on the same
// question, which is the only way to see whether an answer is stable.

import { openDatabaseReadOnly } from '../src/main/db/connection'
import { defaultDbPath } from '../src/main/db/paths'
import { getPrompt } from '../src/main/llm/prompts'
import { recordReviewItemSchema, recordReviewOutputSchema } from '../src/main/llm/prompts'
import { extractJson } from '../src/main/llm/provider'
import { selectProvider } from '../src/main/llm/select'
import { batchQuestions, buildReviewQuestions, renderBatch } from '../src/main/llm/review'

async function main(): Promise<void> {
  const db = openDatabaseReadOnly(process.env.CORPUS_DB_PATH ?? defaultDbPath())
  const sel = await selectProvider()
  if (!sel.live) {
    console.error(`no model: ${sel.reason}`)
    process.exit(1)
  }
  console.log(`model: ${sel.provider.model}\n`)

  const prompt = getPrompt('record-review')
  const runs = db
    .prepare(
      `SELECT id, work_id, schema_id FROM analysis_run
        WHERE superseded = 0 AND analysis_type = 'extraction' ORDER BY id ASC`
    )
    .all() as Array<{ id: number; work_id: number; schema_id: number | null }>

  const tally = new Map<string, { ok: number; problem: number; unclear: number }>()
  const only = process.argv.slice(2).filter((a) => !a.startsWith('-'))

  for (const r of runs) {
    let questions = buildReviewQuestions(db, r.id)
    if (only.length > 0) questions = questions.filter((q) => only.includes(q.checkKey))
    if (questions.length === 0) continue

    for (const batch of batchQuestions(questions)) {
      let text: string
      try {
        text = await sel.provider.callLLM(
          [
            { role: 'system', content: prompt.system },
            { role: 'user', content: prompt.buildUser(renderBatch(batch)) }
          ],
          { maxTokens: 4000 }
        )
      } catch (err) {
        console.log(`  [call failed] ${err instanceof Error ? err.message : String(err)}`)
        continue
      }
      const parsed = recordReviewOutputSchema.safeParse(extractJson(text))
      if (!parsed.success) {
        console.log(`  [unparseable answer] ${text.slice(0, 200)}`)
        continue
      }
      const byId = new Map(batch.questions.map((q) => [q.id, q]))
      for (const raw of parsed.data.reviews) {
        const item = recordReviewItemSchema.safeParse(raw)
        if (!item.success) continue
        const q = byId.get(item.data.id)
        if (q === undefined) continue
        const t = tally.get(q.checkKey) ?? { ok: 0, problem: 0, unclear: 0 }
        t[item.data.verdict]++
        tally.set(q.checkKey, t)
        console.log(
          `work ${r.work_id} run ${r.id} · ${q.checkKey} · m=${q.measurementId ?? '-'} f=${q.factId ?? '-'}`
        )
        console.log(`  -> ${item.data.verdict.toUpperCase()}: ${(item.data.note ?? '').trim()}`)
      }
    }
  }

  console.log('\n--- tally ---')
  for (const [k, v] of [...tally].sort()) {
    console.log(`${k}: ok=${v.ok} problem=${v.problem} unclear=${v.unclear}`)
  }
}

void main()
