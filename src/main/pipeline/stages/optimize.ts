// Recompress a PDF in place with qpdf, as a `document.file@v1` transformer.
//
// A TRANSFORMER, not a second producer: it requires and provides the same
// token, so `extract-text` reads whichever version is current without knowing
// this stage exists — and when qpdf is not installed the stage returns
// `skipped`, `ctx.input` falls through to `download`'s value, and nothing
// downstream notices. That fall-through is why the whole thing is optional
// without a single `if (optimized)` anywhere else.
//
// qpdf was chosen over ghostscript on measured evidence: across 20 papers qpdf
// changed item geometry in 0 of 20, ghostscript in 19 of 20. Geometry is what
// every evidence-span highlight is anchored to, so a "harmless" optimiser that
// moves text is not harmless here. (ghostscript is also AGPL.)

import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, statSync, unlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { platform } from 'node:process'
import { qpdfPath, qpdfWasmPath } from '../../resources'

/**
 * The qpdf the WASM build wraps, taken from `resources/payloads.json`.
 *
 * Stated here rather than read from the module because it is only ever used in
 * the fingerprint, and instantiating a wasm module to ask its version would mean
 * a wasm compile per cache decision. It must move whenever the pinned package
 * does — the manifest entry says so beside the hash it pins.
 */
const QPDF_WASM_VERSION = '12.2.0'
import type { DocumentFile } from '../capabilities'
import type { StageDefinition } from '../types'

/**
 * A file size the way a reader thinks about a PDF: MB, or KB when it is under
 * one. Raw byte counts are what the queue used to print, and "3894213 bytes ->
 * 2117884 bytes" makes the reader do the arithmetic the note exists to save.
 */
function fmtSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(bytes < 10_000 ? 1 : 0)} KB`
  return `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)} MB`
}

interface OptimizeWrite {
  relativePath: string
  sizeBytes: number
  sha256: string
}

/**
 * The qpdf we will run, or null.
 *
 * The SHIPPED binary is preferred over one on `PATH` so a user's ancient system
 * qpdf cannot change our output silently; `PATH` remains a fallback for a dev
 * tree whose payloads have not been provisioned.
 *
 * `qpdfPath()` is the ONE definition of that location, shared with
 * `verify:payloads`, `verify:resources` and the startup precondition check. When
 * this file computed the path itself it disagreed with all three — it looked
 * under `bin/linux` while the payload is provisioned to `bin/linux-x64` — and a
 * correctly installed qpdf was invisible to the only code that wanted it.
 */
function resolveQpdf(): string | null {
  const bundled = qpdfPath()
  if (existsSync(bundled)) return bundled
  try {
    const found = execFileSync(platform === 'win32' ? 'where' : 'which', ['qpdf'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
      .split(/\r?\n/)[0]
      .trim()
    return found.length > 0 ? found : null
  } catch {
    return null
  }
}

/**
 * The qpdf this host will actually run: a native binary, the wasm build, or none.
 *
 * NATIVE IS ALWAYS PREFERRED. Linux and Windows ship one and never reach the wasm
 * branch, so their behaviour is untouched by any of this; macOS ships only the
 * wasm build, because upstream publishes no macOS binary and there is no macOS
 * host here to compile one.
 *
 * A user's own `qpdf` on PATH still outranks wasm — it is the same tool, natively
 * compiled, and someone who installed one meant it to be used.
 *
 * Admissible only because it is the SAME qpdf. `optimize` transforms
 * document.file@v1 and every evidence-span highlight is anchored to item
 * geometry, which is why ghostscript was rejected (geometry moved in 19 of 20
 * papers). Measured before adopting this: wasm and native over 6 real papers with
 * identical arguments, compared through the same pdfjs the viewer anchors
 * against — 33,090 items, 0 moved, 0 text differences.
 */
type Qpdf = { kind: 'native'; bin: string } | { kind: 'wasm'; glue: string }

function resolveQpdfAny(): Qpdf | null {
  const bin = resolveQpdf()
  if (bin) return { kind: 'native', bin }
  const glue = qpdfWasmPath()
  return existsSync(glue) ? { kind: 'wasm', glue } : null
}

/**
 * Run the wasm qpdf over one file, through Emscripten's in-memory FS.
 *
 * Returns the process-shaped exit code the caller already knows how to read, so
 * the success/warning/failure rules below stay in ONE place rather than being
 * restated per flavour.
 *
 * NOT CANCELLABLE MID-RUN, and this is the one real behavioural difference from
 * the native path. `callMain` is a synchronous call into wasm with no yield
 * point, so an abort lands after it returns rather than killing it — where the
 * native path kills a child process. The caller's post-run abort check still
 * discards the output, so a cancel is honoured in effect; what it cannot do is
 * stop the work early. A fresh module per call keeps runs from sharing the
 * virtual FS.
 */
async function runWasmQpdf(
  glue: string,
  args: readonly string[],
  inPath: string,
  outPath: string
): Promise<number> {
  try {
    const { readFileSync: read, writeFileSync: write } = await import('node:fs')
    const { pathToFileURL } = await import('node:url')
    const mod = (await import(pathToFileURL(glue).href)) as {
      default: (opts: Record<string, unknown>) => Promise<{
        FS: { writeFile: (p: string, d: Uint8Array) => void; readFile: (p: string) => Uint8Array }
        callMain: (a: string[]) => number | undefined
      }>
    }
    const instance = await mod.default({
      // The .wasm sits beside the glue. Emscripten's default resolution is
      // relative to the CWD of the process, not to the script, and the app's CWD
      // is wherever it was launched from -- so without this the module loads on a
      // developer's machine and fails in an installed app.
      locateFile: (f: string) => join(dirname(glue), f),
      noInitialRun: true,
      print: () => {},
      printErr: () => {}
    })
    instance.FS.writeFile('/in.pdf', read(inPath))
    const code = instance.callMain([...args, '/in.pdf', '/out.pdf'])
    // Emscripten returns undefined when main() ran to completion without an
    // explicit exit; that is a success, not an unknown.
    const exit = code ?? 0
    if (exit !== 0 && exit !== 3) return exit
    write(outPath, Buffer.from(instance.FS.readFile('/out.pdf')))
    return exit
  } catch {
    // Same convention as a child process that could not be spawned.
    return -1
  }
}

/**
 * The version NUMBER, with the executable's own name stripped out.
 *
 * qpdf answers `--version` with "qpdf version 12.3.2" -- but the first word is
 * argv0, so the same binary invoked through a different path reports
 * "qpdf-copy version 12.3.2". That string reaches the stage fingerprint, and an
 * AppImage remounts itself at a fresh directory on every launch, so the name
 * alone was enough to re-hash the stage on every restart and mark every
 * optimized paper stale for ever.
 *
 * Only the digits identify the tool. Falls back to the whole line when the
 * output does not match, which keeps an unexpected format visible in the hash
 * rather than collapsing it to a constant.
 */
function qpdfVersion(bin: string): string {
  try {
    const line = execFileSync(bin, ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
      .split(/\r?\n/)[0]
      .trim()
    return /version\s+([0-9][0-9.]*)/i.exec(line)?.[1] ?? line
  } catch {
    return 'unknown'
  }
}

const optimize: StageDefinition<{ before: number; after: number }> = {
  id: 'optimize',
  label: 'Optimize PDF',
  version: '1.0.0',
  rank: 2,
  scope: 'document',
  provides: ['document.file@v1'],
  requires: ['document.file@v1'],
  transforms: 'document.file@v1',
  usesLlm: false,
  runtime: 'node',
  isolation: 'host',
  weight: 'heavy',
  // NATIVE: qpdf is a child process; a cancel kills the host, which kills it,
  // and there is no cooperative point inside a running qpdf to return from.
  //
  // WASM: there is no child to kill. `callMain` is one synchronous call into the
  // module, so an abort is honoured AFTER it returns -- the post-run check below
  // discards the output and reports `cancelled`, which is correct in effect, but
  // the work itself finishes first. A grace period would not change that; it
  // would only make the user wait longer to be told the same thing.
  cancelGraceMs: 0,

  // TOOL IDENTITY IS PART OF THE FINGERPRINT, and this is the whole reason a
  // cached `skipped` is safe. Without it, "qpdf not found" would be cached
  // forever: the user installs qpdf and nothing ever re-runs, because from the
  // cache's point of view no input changed.
  //
  // IDENTITY IS PRESENCE AND VERSION, NEVER THE PATH. An AppImage mounts itself
  // at a fresh random directory on every launch, so the same binary lives at
  // /tmp/.mount_corpusaGFLlB/... one run and /tmp/.mount_corpusBGEidE/... the
  // next. Folding that in re-hashed this stage on every restart and marked every
  // optimized paper stale for ever, on a machine where nothing had changed --
  // the user cleared 26 invalidations and got the same 26 back the next time
  // they opened the app.
  //
  // The version still moves when qpdf is genuinely upgraded, and `absent` still
  // separates "no tool" from "tool present", which is all the cache needs to
  // decide correctly.
  // THE FLAVOUR IS PART OF THE IDENTITY, not just the version. The wasm build
  // pins its own qpdf (12.2.0) while the native payload is 12.3.2, and the two
  // are different tools for caching purposes even when their versions agree: a
  // Mac that later gains a native qpdf on PATH must re-run, not serve a verdict
  // the other implementation produced. Reading the version out of the wasm
  // module would mean instantiating it on every fingerprint call -- a wasm
  // compile per cache decision -- so the version is taken from the manifest,
  // which is what pins it in the first place.
  fingerprint() {
    const q = resolveQpdfAny()
    if (!q) return 'qpdf|absent'
    return q.kind === 'native' ? `qpdf|${qpdfVersion(q.bin)}` : `qpdf|wasm|${QPDF_WASM_VERSION}`
  },

  async execute(ctx) {
    const file = ctx.input<DocumentFile>('document.file@v1')
    if (!file) return { status: 'skipped', reason: 'no document.file@v1 to optimize' }

    const qpdf = resolveQpdfAny()
    if (!qpdf) {
      // `skipped`, never `failed`. A missing optional tool is a fact about this
      // machine, not a broken paper, and painting the pipeline red for a
      // 15 %-smaller file would be a lie about how bad the situation is.
      return { status: 'skipped', reason: 'qpdf is not installed; leaving the PDF as it is' }
    }

    const tmp = join(dirname(file.absPath), `.optimize-${ctx.stageRunId}.pdf`)
    // ONE argument list for both flavours. They differ only in where the input
    // and output paths go: the native call names real files, the wasm call names
    // paths inside its own virtual FS.
    const args = [
      '--object-streams=generate',
      '--recompress-flate',
      '--compression-level=9',
      '--optimize-images',
      '--remove-unreferenced-resources=yes'
    ]

    const code =
      qpdf.kind === 'wasm'
        ? await runWasmQpdf(qpdf.glue, args, file.absPath, tmp)
        : await new Promise<number>((resolve) => {
            const child = spawn(qpdf.bin, [...args, file.absPath, tmp], { stdio: 'ignore' })
            const onAbort = (): void => {
              child.kill('SIGKILL')
            }
            ctx.signal.addEventListener('abort', onAbort, { once: true })
            child.once('error', () => resolve(-1))
            child.once('exit', (c) => {
              ctx.signal.removeEventListener('abort', onAbort)
              resolve(c ?? -1)
            })
          })

    if (ctx.signal.aborted) {
      try {
        unlinkSync(tmp)
      } catch {
        /* nothing was written */
      }
      return { status: 'failed', error: 'cancelled', retryable: true }
    }

    // qpdf exits 3 on warnings and still writes a valid file; 0 and 3 are both
    // successes and treating 3 as a failure would skip every PDF with a minor
    // spec violation, which is most of them.
    if (code !== 0 && code !== 3) {
      try {
        unlinkSync(tmp)
      } catch {
        /* may not exist */
      }
      return {
        status: 'skipped',
        reason: `qpdf exited ${code} on ${file.relativePath}; keeping the original`
      }
    }

    const before = file.sizeBytes
    const after = statSync(tmp).size
    if (after >= before) {
      // Already optimal. Replacing it would churn the hash — and therefore
      // supersede every downstream stage — for no gain at all.
      try {
        unlinkSync(tmp)
      } catch {
        /* best effort */
      }
      return {
        status: 'succeeded',
        result: { before, after: before },
        note: `already optimal (${fmtSize(before)})`
      }
    }

    copyFileSync(tmp, file.absPath)
    try {
      unlinkSync(tmp)
    } catch {
      /* best effort */
    }

    const { createHash } = await import('node:crypto')
    const { readFileSync } = await import('node:fs')
    const sha256 = createHash('sha256').update(readFileSync(file.absPath)).digest('hex')

    // The SAME relative path, so the existing `file_location` row is UPDATEd
    // rather than inserted alongside — `UNIQUE(base_dir_id, relative_path)`
    // makes an insert a collision, and two canonical rows for one document
    // would make "where are this document's bytes" ambiguous.
    ctx.emit('document.file@v1', { ...file, sizeBytes: after, sha256 } satisfies DocumentFile)
    ctx.write({ relativePath: file.relativePath, sizeBytes: after, sha256 } satisfies OptimizeWrite)

    return {
      status: 'succeeded',
      result: { before, after },
      note: `${fmtSize(before)} -> ${fmtSize(after)} (${Math.round((1 - after / before) * 100)}% smaller)`
    }
  },

  applyWrites(db, payload, ctx) {
    const w = payload as OptimizeWrite
    db.prepare(
      `UPDATE file_location
          SET hash = ?, size_bytes = ?, version = version + 1
        WHERE document_id = ? AND relative_path = ?`
    ).run(w.sha256, w.sizeBytes, ctx.documentId, w.relativePath)
  }
}

export default optimize
