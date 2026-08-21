// The stage host pool.
//
// better-sqlite3 is SYNCHRONOUS and lives in main, so a stage that spends 12
// seconds inside tesseract or 30 inside pdfjs freezes the database, the IPC and
// the window for exactly that long. Moving those bodies into a child process is
// the whole reason this file exists.
//
// `utilityProcess`, not `worker_threads`, and the reason is cancellation:
// `kill()` interrupts a wedged synchronous native call and `terminate()` does
// not. With OCR at ~12.5 s/page, a cancel that cannot interrupt is not a cancel.

import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { hostEnv, MAX_ENVELOPE_BYTES } from './protocol'
import type { DispatchMessage, FromHostMessage, ToHostMessage } from './protocol'
import type { StageOutcome } from '../types'

export interface DispatchRequest {
  message: Omit<DispatchMessage, 'kind' | 'token'>
  signal: AbortSignal
  onProgress: (pct: number, note?: string) => void
  onLog: (msg: string) => void
  /** Runs in main, holding the size-1 gate for its duration. */
  callLlm: (
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    opts?: { model?: string; maxTokens?: number }
  ) => Promise<string>
}

export interface DispatchResult {
  outcome: StageOutcome
  emitted: Array<[string, unknown]>
  writes: unknown[]
}

/**
 * How many host exits inside the window open the breaker.
 *
 * A stage that reliably kills its host would otherwise burn five attempts on
 * EVERY paper in the corpus, and each permanent failure cancels its whole
 * downstream — a corpus-wide outage recoverable only job by job. The breaker
 * stops dispatching to hosts instead, so the jobs wait rather than retire.
 */
const BREAKER_THRESHOLD = 5
const BREAKER_WINDOW_MS = 60_000
const BREAKER_OPEN_MS = 30_000

/**
 * The cancel grace a stage gets when it declares no `cancelGraceMs`.
 *
 * An opportunity to stop cleanly, not a wait: a stage whose body is ordinary
 * async JS observes `ctx.signal` and returns within it, and one wedged inside a
 * native call never will. Stages in the second category declare `0` and are
 * killed immediately — waiting two seconds for a cancel that cannot be observed
 * is two seconds of a user watching nothing happen.
 */
export const DEFAULT_CANCEL_GRACE_MS = 2_000

/**
 * The payload of a parent-side `'message'` event, whichever shape it arrives in.
 *
 * `utilityProcess`'s parent-side listener is handed the POSTED VALUE DIRECTLY —
 * it is not a `MessageEvent`, so there is no `.data`. Reading `e.data` yields
 * `undefined`, and the very next line (`msg.kind`) throws inside an event
 * handler, which takes main's event loop down with it: every host-isolated
 * stage then hangs forever with no error surface. Verified against the shipped
 * host under Electron 33 (`tmp/prod-verify/probe-pool-shape.js`).
 *
 * Both shapes are accepted rather than just the observed one because this is an
 * undocumented detail of Electron's IPC that has changed before; a pool that
 * only understands today's shape is one upgrade away from the same silent hang.
 */
function payloadOf(e: unknown): FromHostMessage | null {
  if (typeof e !== 'object' || e === null) return null
  const direct = e as { data?: unknown; kind?: unknown }
  const inner = direct.data
  if (typeof inner === 'object' && inner !== null && 'kind' in inner) {
    return inner as FromHostMessage
  }
  return typeof direct.kind === 'string' ? (e as FromHostMessage) : null
}

interface Host {
  proc: import('electron').UtilityProcess
  pid: number
  busy: boolean
  runFile: string | null
}

interface HostPoolOpts {
  size?: number
  /** Absolute path to the built host entry. Injected so tests can point elsewhere. */
  entryPath: string
  /** Where `run/host-*.json` liveness files go. */
  runDir: string
  instanceId: string
}

export class HostPool {
  private readonly hosts: Host[] = []
  private readonly opts: Required<HostPoolOpts>
  private nextToken = 1
  private stopped = false
  /** token -> the host executing it, so a cancel can find the right process. */
  private readonly byToken = new Map<number, Host>()
  private readonly exitTimes: number[] = []
  private breakerOpenUntil = 0
  /**
   * Hosts this pool killed ON PURPOSE, so their exits are not read as crashes.
   *
   * The breaker exists to stop a stage that reliably kills its host from
   * burning five attempts on every paper. A cancel produces an identical exit
   * and means the opposite — the work was withdrawn, nothing is broken — so
   * without this distinction cancelling a handful of OCR jobs would pause every
   * host-isolated stage in the app.
   */
  private readonly intentionalKills = new Set<Host>()

  constructor(opts: HostPoolOpts) {
    this.opts = { size: 2, ...opts }
    mkdirSync(this.opts.runDir, { recursive: true })
    this.sweepOrphanHosts()
  }

  /**
   * True when host dispatch is unavailable *right now* for a reason that is
   * session state rather than a property of the work.
   *
   * The scheduler consults this INSTEAD of claiming host-isolated jobs, so a
   * crash loop costs those jobs nothing: no attempt is burned, and nothing is
   * cached. Putting the crash count into a fingerprint instead would either
   * make every app restart invalidate every cached run, or cache a transient
   * crash as a permanent skip.
   */
  breakerOpen(): boolean {
    return Date.now() < this.breakerOpenUntil
  }

  /**
   * Kill hosts left behind by a PREVIOUS app instance.
   *
   * Not "kill anything running our entry point" — that would kill a second live
   * instance's hosts, and this repo has a documented history of two instances
   * contending for one DB. Each host writes a file naming its pid, its start
   * time and its parent; the sweep kills only a process whose (pid, start-time)
   * pair STILL matches and whose recorded parent is gone. Start-time is what
   * defeats pid reuse, which is the failure that makes a naive sweep worse than
   * no sweep.
   */
  private sweepOrphanHosts(): void {
    let files: string[]
    try {
      files = readdirSync(this.opts.runDir).filter((f) => f.startsWith('host-') && f.endsWith('.json'))
    } catch {
      return
    }
    for (const f of files) {
      const path = join(this.opts.runDir, f)
      let rec: { pid: number; startTicks: string; parentPid: number; instanceId: string }
      try {
        rec = JSON.parse(readFileSync(path, 'utf8'))
      } catch {
        try {
          unlinkSync(path)
        } catch {
          /* a file we cannot read and cannot delete is not worth failing over */
        }
        continue
      }
      if (rec.instanceId === this.opts.instanceId) continue
      if (procStartTicks(rec.pid) !== rec.startTicks) {
        // Gone, or the pid was reused by something that is not ours. Either way
        // there is nothing of ours to kill.
        try {
          unlinkSync(path)
        } catch {
          /* best effort */
        }
        continue
      }
      if (procStartTicks(rec.parentPid) !== null) continue // the owning app still lives
      try {
        process.kill(rec.pid, 'SIGKILL')
      } catch {
        /* already gone between the check and the kill */
      }
      try {
        unlinkSync(path)
      } catch {
        /* best effort */
      }
    }
  }

  private async spawn(): Promise<Host> {
    const { utilityProcess } = await import('electron')
    const proc = utilityProcess.fork(this.opts.entryPath, [], {
      env: hostEnv(),
      // 'inherit', not 'pipe': a piped stdio that nobody drains fills its buffer
      // and BLOCKS the host mid-stage, which looks exactly like the wedge this
      // pool exists to be able to kill.
      stdio: 'inherit',
      serviceName: 'corpus-stage-host'
    })
    const host: Host = { proc, pid: 0, busy: false, runFile: null }
    await new Promise<void>((resolve, reject) => {
      const onMessage = (e: unknown): void => {
        const msg = payloadOf(e)
        if (msg?.kind !== 'ready') return
        proc.off('message', onMessage as never)
        host.pid = msg.pid
        host.runFile = join(this.opts.runDir, `host-${msg.pid}.json`)
        try {
          writeFileSync(
            host.runFile,
            JSON.stringify({
              pid: msg.pid,
              startTicks: procStartTicks(msg.pid),
              parentPid: process.pid,
              parentStartTicks: procStartTicks(process.pid),
              instanceId: this.opts.instanceId
            })
          )
        } catch {
          // A missing run file only weakens the orphan sweep, which is itself
          // the backstop for the port-close exit. Not worth refusing to run.
          host.runFile = null
        }
        resolve()
      }
      proc.on('message', onMessage as never)
      proc.once('exit', () => reject(new Error('stage host exited before it was ready')))
      setTimeout(() => reject(new Error('stage host did not report ready within 15s')), 15_000)
    })

    proc.on('exit', () => {
      const deliberate = this.intentionalKills.delete(host)
      this.forget(host)
      if (!deliberate) this.noteExit()
    })
    this.hosts.push(host)
    return host
  }

  private forget(host: Host): void {
    const i = this.hosts.indexOf(host)
    if (i >= 0) this.hosts.splice(i, 1)
    if (host.runFile) {
      try {
        unlinkSync(host.runFile)
      } catch {
        /* the sweep will get it */
      }
    }
    for (const [token, h] of this.byToken) if (h === host) this.byToken.delete(token)
  }

  private noteExit(): void {
    if (this.stopped) return
    const now = Date.now()
    this.exitTimes.push(now)
    while (this.exitTimes.length > 0 && now - this.exitTimes[0] > BREAKER_WINDOW_MS) {
      this.exitTimes.shift()
    }
    if (this.exitTimes.length >= BREAKER_THRESHOLD) {
      this.breakerOpenUntil = now + BREAKER_OPEN_MS
      this.exitTimes.length = 0
      // eslint-disable-next-line no-console
      console.error(
        `[host-pool] ${BREAKER_THRESHOLD} host exits in ${BREAKER_WINDOW_MS / 1000}s — ` +
          `pausing host dispatch for ${BREAKER_OPEN_MS / 1000}s`
      )
    }
  }

  private async acquire(): Promise<Host> {
    const idle = this.hosts.find((h) => !h.busy)
    if (idle) return idle
    if (this.hosts.length < this.opts.size) return this.spawn()
    // The scheduler's own concurrency is the admission control; reaching here
    // means it dispatched more than the pool is sized for, which is a bug worth
    // hearing about rather than a queue to silently join.
    throw new Error('stage host pool is saturated')
  }

  async dispatch(req: DispatchRequest): Promise<DispatchResult> {
    if (this.stopped) throw new Error('stage host pool is shut down')
    const envelope: DispatchMessage = { kind: 'dispatch', token: this.nextToken++, ...req.message }
    const size = Buffer.byteLength(JSON.stringify(envelope.inputs))
    if (size > MAX_ENVELOPE_BYTES) {
      // Loud, not truncated. A stage whose inputs do not fit needs a streaming
      // shape, and silently sending less than it asked for would produce a
      // confidently wrong result.
      throw new Error(
        `stage '${envelope.stageId}' inputs are ${Math.round(size / 1e6)} MB, over the ` +
          `${Math.round(MAX_ENVELOPE_BYTES / 1e6)} MB dispatch ceiling`
      )
    }

    const host = await this.acquire()
    host.busy = true
    this.byToken.set(envelope.token, host)

    try {
      return await new Promise<DispatchResult>((resolve, reject) => {
        const post = (m: ToHostMessage): void => {
          try {
            host.proc.postMessage(m)
          } catch {
            /* the host is gone; its exit handler settles this promise */
          }
        }
        const onMessage = (e: unknown): void => {
          const msg = payloadOf(e)
          if (!msg) return
          // Every message is checked against the token, not the job id: a
          // killed host's last messages can still arrive after its replacement
          // has been dispatched for the same job.
          if (!('token' in msg) || msg.token !== envelope.token) return
          switch (msg.kind) {
            case 'progress':
              req.onProgress(msg.pct, msg.note)
              break
            case 'log':
              req.onLog(msg.message)
              break
            case 'llm-request':
              // The gate is held for the duration of the CALL in main, and
              // released the moment the text is known. It is deliberately not
              // held across the host's consumption of the result: that would
              // let a host killed mid-parse hold the single process-wide slot
              // until the 15-minute wall-clock cap, silently stopping every
              // LLM job in the app.
              void req
                .callLlm(msg.messages, msg.opts)
                .then((text) => post({ kind: 'llm-reply', token: envelope.token, callId: msg.callId, ok: true, text }))
                .catch((err: Error) =>
                  post({
                    kind: 'llm-reply',
                    token: envelope.token,
                    callId: msg.callId,
                    ok: false,
                    error: err.message
                  })
                )
              break
            case 'result':
              cleanup()
              resolve({ outcome: msg.outcome, emitted: msg.emitted, writes: msg.writes })
              break
          }
        }
        const onExit = (): void => {
          cleanup()
          // A host that dies mid-stage is transient by definition: nothing
          // about the WORK says it must fail permanently, and the attempts
          // ceiling is the backstop against a genuine crash loop.
          reject(new Error('stage host exited during execution'))
        }
        // The pending kill, so it can be CANCELLED. A stage that observes the
        // cooperative message and returns inside its grace period settles this
        // dispatch and hands the host back to the pool — and a timer still
        // armed would then kill a host that is already running somebody else's
        // job, reporting it as an exit during execution. Holding the handle is
        // the difference between a graceful cancel and a delayed grenade.
        let killTimer: NodeJS.Timeout | null = null
        const onAbort = (): void => {
          post({ kind: 'cancel', token: envelope.token })
          // The kill is what makes the cancel real. A stage blocked inside a
          // native call never sees the cooperative message, so the grace period
          // is an opportunity, not a wait: `cancelGraceMs: 0` stages skip it.
          const grace = Math.max(0, envelope.cancelGraceMs)
          const doKill = (): void => {
            killTimer = null
            // Marked INTENTIONAL before the kill, so the exit it causes is not
            // counted as a crash. Without this, five cancelled OCR jobs inside
            // a minute open the circuit breaker and stop ALL host dispatch for
            // thirty seconds — a user cancelling a batch would disable the
            // pipeline, which is the opposite of what cancelling means.
            this.intentionalKills.add(host)
            try {
              host.proc.kill()
            } catch {
              /* already dead */
            }
          }
          if (grace === 0) doKill()
          else killTimer = setTimeout(doKill, grace)
        }
        const cleanup = (): void => {
          if (killTimer) {
            clearTimeout(killTimer)
            killTimer = null
          }
          host.proc.off('message', onMessage as never)
          host.proc.off('exit', onExit as never)
          req.signal.removeEventListener('abort', onAbort)
        }
        host.proc.on('message', onMessage as never)
        host.proc.once('exit', onExit as never)
        if (req.signal.aborted) onAbort()
        else req.signal.addEventListener('abort', onAbort, { once: true })
        post(envelope)
      })
    } finally {
      this.byToken.delete(envelope.token)
      host.busy = false
    }
  }

  /** Kill every host. Called from quit; safe to call twice. */
  shutdown(): void {
    this.stopped = true
    for (const host of [...this.hosts]) {
      this.intentionalKills.add(host)
      try {
        host.proc.kill()
      } catch {
        /* already gone */
      }
      this.forget(host)
    }
    this.intentionalKills.clear()
  }

  hostCount(): number {
    return this.hosts.length
  }
}

/**
 * A process's start time, as an opaque comparable string, or null if it is gone.
 *
 * The whole point is PID REUSE: a recorded pid may belong to something else by
 * the time the sweep runs, and killing it would be worse than leaving an orphan.
 * On Linux field 22 of `/proc/<pid>/stat` is the start time in clock ticks; the
 * command field before it can contain spaces and parentheses, so the parse
 * starts after the LAST ')'. Elsewhere there is no cheap equivalent and the
 * function reports "cannot tell", which the sweep treats as "do not kill".
 */
function procStartTicks(pid: number): string | null {
  if (process.platform !== 'linux') {
    try {
      process.kill(pid, 0)
      return 'alive'
    } catch {
      return null
    }
  }
  const path = `/proc/${pid}/stat`
  if (!existsSync(path)) return null
  try {
    const stat = readFileSync(path, 'utf8')
    const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    return after[19] ?? null
  } catch {
    return null
  }
}
