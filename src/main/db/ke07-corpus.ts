// KE07 real-corpus loader. Reads the validated 20-paper KE07 Kemp-eliminase
// dataset that the SEEDER ingests at seed time. This module runs ONLY in the
// main process during seeding (`seed()`), which is a DEVELOPMENT AND TEST path:
// `npm run seed`, `npm run seed:fresh` and the e2e per-test fixtures. A user's
// install never calls it, and the JSON is not packaged. The renderer NEVER
// imports it — the seed-only-DB rule holds because the data ends up in SQLite
// and the UI reads only the DB via IPC.
//
// Path resolution must work from the TWO contexts that run the seed:
//   - tsx scripts (run-seed.ts / verify-backend.ts) under ELECTRON_RUN_AS_NODE,
//     where __dirname = <repo>/src/main/db and cwd may be a temp dir; and
//   - the bundled dev app (out/main/index.js), where __dirname = <repo>/out/main.
// $KE07_CORPUS_PATH overrides everything (used to pin an explicit path in
// hermetic harnesses).

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, isAbsolute } from 'node:path'

/** One author entry as it appears in the corpus JSON (ordered per paper). */
export interface CorpusAuthor {
  given: string
  family: string
  affiliation: string
}

/** One paper record from scripts/data/ke07-corpus.json. */
export interface CorpusPaper {
  title: string
  authors: CorpusAuthor[]
  doi: string
  pmid: string | null
  arxiv: string | null
  year: number | null
  venue: string | null
  abstract: string | null
  work_type: 'primary-research' | 'review' | 'method' | 'foundational' | 'preprint' | 'dataset'
  pdf_path: string
  cites: string[]
}

const CORPUS_REL = join('scripts', 'data', 'ke07-corpus.json')

/** Walk up from `start` until a dir containing scripts/data/ke07-corpus.json. */
function findUp(start: string): string | null {
  let dir = start
  // Bound the walk so a bad start can never loop forever.
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, CORPUS_REL))) return join(dir, CORPUS_REL)
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/** Resolve the absolute path to the corpus JSON, or throw with a clear message. */
export function resolveCorpusPath(): string {
  const explicit = process.env.KE07_CORPUS_PATH
  if (explicit && explicit.trim()) {
    const p = isAbsolute(explicit) ? explicit : join(process.cwd(), explicit)
    if (!existsSync(p)) {
      throw new Error(`KE07_CORPUS_PATH set but file not found: ${p}`)
    }
    return p
  }
  const fromModule = findUp(__dirname)
  if (fromModule) return fromModule
  const fromCwd = findUp(process.cwd())
  if (fromCwd) return fromCwd
  throw new Error(
    `Could not locate the KE07 corpus: no ${CORPUS_REL} found by walking up ` +
      `from ${__dirname} or ${process.cwd()}. This dataset is a dev/test ` +
      `fixture and is not shipped; run the seed from a repo checkout, or set ` +
      `KE07_CORPUS_PATH to the corpus JSON.`
  )
}

/** Load + parse the 20-paper KE07 corpus. Deterministic (file on disk). */
export function loadKe07Corpus(): CorpusPaper[] {
  const path = resolveCorpusPath()
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as CorpusPaper[]
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`KE07 corpus at ${path} is empty or not an array`)
  }
  return parsed
}
