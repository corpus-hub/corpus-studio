// A REPLAY provider for the verification scripts. NOT part of the app.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS CANNOT BE THE MOCK COMING BACK
//
// The mock was reachable from the shipping app: `selectProvider` returned it,
// `src/main/index.ts` handed it to the queue, and a run it produced was written
// to the user's database and rendered beside genuine ones. This is not that, and
// the difference is STRUCTURAL rather than a matter of discipline:
//
//   1. It lives under `scripts/`, which is outside `src/` entirely. The app
//      bundle is built by electron-vite from `src/main/index.ts`; nothing under
//      `scripts/` is reachable from that graph, so this file is not merely
//      unused in the build — it is not IN the build. `verify:offline` greps the
//      built `out/` for its marker string and fails if one appears.
//   2. Nothing in `src/` imports it, and nothing can: `selectProvider` has
//      exactly two outcomes now, the real gateway or `UnavailableLlmProvider`,
//      and there is no parameter, env var or setting that admits a third.
//   3. It has no lookup fallback. The mock's terminal `return {"facts":[]}` is
//      what made a missing fixture indistinguishable from a model finding
//      nothing; this THROWS on an unknown key, so a test that drifts away from
//      its recording fails loudly instead of quietly asserting against silence.
//
// The recordings themselves are real model responses, captured from the gateway
// by `scripts/testing/record-fixtures.ts`, so the offline suite is exercising
// the shape of output a model actually produces rather than one we imagined.

import { createHash } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  GLOBAL_LLM_SEMAPHORE,
  type CallOpts,
  type LlmMessage,
  type LlmProvider
} from '../../src/main/llm/provider'

/** Greppable, and grepped: `verify:offline` fails if this reaches `out/`. */
export const TEST_ONLY_PROVIDER_MARKER = 'CORPUS_TEST_ONLY_RECORDED_PROVIDER'

export const FIXTURE_PATH = join(__dirname, 'fixtures', 'llm-responses.json')

type Recordings = Record<string, string>

export function recordingKey(messages: LlmMessage[]): string {
  return createHash('sha256').update(JSON.stringify(messages)).digest('hex').slice(0, 32)
}

export class RecordedLlmProvider implements LlmProvider {
  /**
   * Named so it is unmistakable in any row it might touch.
   *
   * If one of these EVER appears in a shipped database, the name says exactly
   * what happened and where to look — as opposed to `mock-provider`, which read
   * like a legitimate mode of operation.
   */
  readonly name = 'recorded-test-fixture'
  readonly model = 'recorded-test-fixture'

  private readonly recordings: Recordings

  constructor(recordings?: Recordings) {
    this.recordings =
      recordings ??
      (existsSync(FIXTURE_PATH)
        ? (JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Recordings)
        : {})
  }

  /**
   * Artificial latency, from `CORPUS_TEST_LLM_DELAY_MS`.
   *
   * A real provider takes seconds; a replay returns in the same tick, which
   * makes every state that only EXISTS while a paper is being analysed — the
   * queue's in-flight count, the close-mid-analysis prompt — impossible for a
   * test to observe.
   */
  private get delayMs(): number {
    return Math.max(0, Number(process.env.CORPUS_TEST_LLM_DELAY_MS ?? 0) || 0)
  }

  async callLLM(messages: LlmMessage[], opts?: CallOpts): Promise<string> {
    // The SAME gate as the real provider. A test provider that bypassed it would
    // verify the serialisation invariant against something that never contends
    // for it, which is the easiest possible case and proves nothing.
    return GLOBAL_LLM_SEMAPHORE.run(async () => {
      if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs))
      const key = recordingKey(messages)
      const hit = this.recordings[key]
      if (hit === undefined) {
        // LOUD. See the header: a silent empty answer here is the precise bug
        // this whole change exists to eliminate.
        throw new Error(
          `no recorded LLM response for key ${key}. Re-record with ` +
            `\`npm run test:record\` against a live gateway, or assert on an ` +
            `outcome that does not require a model.`
        )
      }
      return hit
    }, opts?.signal)
  }
}

/**
 * Answers a fixed sequence of responses, in order, and THROWS when exhausted.
 *
 * For the backend/pipeline checks, whose subject is what the pipeline does with
 * a response — supersede-then-insert, evidence anchoring, measurement linking,
 * the deterministic checks — rather than what a model would say. Those need a
 * known input, not a realistic one, and pinning them to a recording would make
 * a prompt edit fail an assertion about transaction semantics.
 *
 * Exhaustion throws for the same reason `RecordedLlmProvider` does: a script
 * that quietly starts returning empty answers turns "we asked N times" into
 * "the model found nothing N-k times", silently.
 */
export class ScriptedLlmProvider implements LlmProvider {
  readonly name = 'scripted-test-fixture'
  readonly model = 'scripted-test-fixture'
  private i = 0
  /** Every message list this provider was asked, for a caller to assert on. */
  readonly seen: LlmMessage[][] = []

  constructor(private readonly responses: string[]) {}

  async callLLM(messages: LlmMessage[], opts?: CallOpts): Promise<string> {
    return GLOBAL_LLM_SEMAPHORE.run(async () => {
      this.seen.push(messages)
      if (this.i >= this.responses.length) {
        throw new Error(
          `scripted provider exhausted after ${this.responses.length} response(s); ` +
            `call ${this.i + 1} has no scripted answer`
        )
      }
      return this.responses[this.i++]
    }, opts?.signal)
  }
}
