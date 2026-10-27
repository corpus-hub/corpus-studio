import { app, BrowserWindow } from 'electron'
import type { QuitChoice, QuitStateDTO } from '@shared/contract'
import { getJobQueue } from './pipeline/scheduler'
import { busyCount, busyCountForWindow, forgetWindow, onBusyChange } from './busy'

/**
 * Don't let the user throw away a paper that is halfway through being read.
 *
 * A job has no intermediate save point: `resumePending` re-queues an
 * interrupted one FROM THE BEGINNING and spends one of its attempts doing so,
 * so quitting mid-analysis silently discards however long that paper had been
 * running. This intercepts the close, asks, and offers to wait it out.
 *
 * It intervenes ONLY while something is genuinely being read. Queued-but-not-
 * started papers are durable and lose nothing, so they do not prompt: a
 * confirmation the user sees every time is one they learn to click through,
 * which is worse than no confirmation at all.
 */

type Phase = 'idle' | 'asking' | 'finishing'

let phase: Phase = 'idle'
/**
 * The APP is going and the question has been settled — stop guarding.
 *
 * Without this, `app.quit()` from the decision handler re-enters the very
 * handler that prevented the quit, and the app either loops or asks twice.
 * Every exit path that quits sets it.
 *
 * Reset by `cancelQuit`, because a quit the user called off must leave the guard
 * armed for the next one. And set ONLY by paths that are genuinely quitting the
 * process: a single window going away — even to an OS session end — must not
 * disarm the guard for the windows that remain, or the one that started the
 * analysis could then be closed without a word.
 */
let decided = false
/** The window that was asked, so a second window cannot stack a second modal. */
let askingWindowId: number | null = null
/**
 * Windows whose own `session-end` fired.
 *
 * The OS is taking that window and will not wait for an answer, so it is not
 * asked — but the state is per WINDOW. A detached window ending its session is
 * not a statement about the app.
 */
const sessionEnded = new Set<number>()
/**
 * The OS is logging out or shutting down.
 *
 * Set as soon as ANY window reports `session-end`, and consulted by the app-level
 * quit as well as the per-window close. Per-window state alone is not enough: on
 * logoff the windows get `session-end` and then the APP is quit, and that quit
 * arrives with no window to attribute it to — so it would put up a question nobody
 * is going to answer and stall the whole logout. The abandoned row stays 'running'
 * and `resumePending` recovers it next launch.
 */
let osSessionEnding = false
/**
 * The window this prompt will CLOSE when answered, or null when answering it
 * quits the whole app.
 *
 * The two are genuinely different outcomes and the guard has to know which one it
 * is holding open. Closing one window of several while its own analysis runs is
 * worth asking about — that user is watching it — but committing to it must close
 * that window, not quit an app whose other windows are still in use.
 */
let closingWindowId: number | null = null
/** Whether the queue was claiming work before we paused it, to restore on cancel. */
let queueWasRunning = false
let finishingSince = 0
let elapsedTimer: ReturnType<typeof setInterval> | null = null
let unsubscribeBusy: (() => void) | null = null

/**
 * Headless harnesses (e2e, `npm run shot`, the acceptance scripts) close the
 * app programmatically and cannot answer a modal, so a guard would hang them
 * until their timeout and be reported as a launch failure rather than as this.
 */
const BYPASS = process.env.CORPUS_NO_CLOSE_GUARD === '1'

/**
 * Work main still owes the DB before the process may go away.
 *
 * `broadcastJobsChanged` defers a real write (`settleReferenceRetrievals`)
 * behind a coalescing timer, so quitting between the schedule and the timer
 * would drop it. Registered by main rather than imported to keep this module
 * free of the IPC layer.
 */
let flushPending: (() => void) | null = null
export function setQuitFlush(fn: () => void): void {
  flushPending = fn
}

/**
 * "The user has asked to close, and we are holding it open" — with BOTH edges.
 *
 * The MCP server stops accepting writes once a quit is under way, so that an
 * agent hammering the app cannot hold the `finishing` phase open forever. But a
 * one-way latch set from `before-quit` would be wrong in the other direction:
 * `guard()` fires on every quit attempt including ones the user then CANCELS,
 * and a latch would leave writes refused for the rest of a session they chose
 * to keep — exactly the failure `vectorSearch` is rebuilt in `index.ts` to
 * avoid. So the intent falls back to false on `cancelQuit`.
 *
 * Registered rather than imported, to keep this module free of the MCP layer.
 */
let quitIntent = false
const quitIntentListeners = new Set<(intent: boolean) => void>()

export function onQuitIntentChange(cb: (intent: boolean) => void): () => void {
  quitIntentListeners.add(cb)
  cb(quitIntent)
  return () => quitIntentListeners.delete(cb)
}

function setQuitIntent(next: boolean): void {
  if (quitIntent === next) return
  quitIntent = next
  for (const l of quitIntentListeners) {
    try {
      l(next)
    } catch {
      /* a listener failure must never affect the quit itself */
    }
  }
}

function queueInFlight(): number {
  try {
    return getJobQueue().inFlightCount()
  } catch {
    // Queue not initialised (a failure before startup finished) — nothing can
    // be in flight, so nothing is at risk.
    return 0
  }
}

/** Papers being read right now, from BOTH the queue and the direct IPC runs. */
function busy(): number {
  return queueInFlight() + busyCount()
}

/**
 * What the prompt currently open is actually waiting for.
 *
 * Scoped to the closing window when only that window is going: waiting for the
 * whole app to fall idle there would hold one window open until every other
 * window's work finished, which is not what its user asked and not what the
 * prompt says.
 */
function atRiskNow(): number {
  return closingWindowId === null ? busy() : busyCountForWindow(closingWindowId)
}

/**
 * The guard state AS SEEN BY one window.
 *
 * Scoped, not global: only the window that was asked should render the prompt.
 * A second window pulling a global 'asking' on mount would put up a duplicate
 * modal that is equally able to decide the app's fate.
 */
export function quitState(forWindowId: number | null): QuitStateDTO {
  // REQUIRED, and an unresolvable sender is answered 'idle' rather than with the
  // global phase. Returning the global phase to a caller who could not be
  // identified is how a second window renders a duplicate modal — one that is
  // equally able to decide the fate of work it was never shown.
  if (forWindowId === null || forWindowId !== askingWindowId) {
    return { phase: 'idle', busy: 0, elapsedMs: 0 }
  }
  return {
    phase,
    busy: atRiskNow(),
    elapsedMs: phase === 'finishing' && finishingSince > 0 ? Date.now() - finishingSince : 0
  }
}

/** Push the guard state to the window that was asked (and only that one). */
function pushQuitState(): void {
  if (askingWindowId === null) return
  const win = BrowserWindow.fromId(askingWindowId)
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  win.webContents.send('window:quitState', quitState(win.id))
}

function stopTimers(): void {
  if (elapsedTimer) {
    clearInterval(elapsedTimer)
    elapsedTimer = null
  }
  if (unsubscribeBusy) {
    unsubscribeBusy()
    unsubscribeBusy = null
  }
}

/**
 * Commit to quitting.
 *
 * `setImmediate` so the pending `ipcMain.handle` reply is delivered before the
 * teardown begins — otherwise the renderer's `invoke` never settles and the
 * button it came from is left looking stuck for the instant before the window
 * disappears.
 */
function quitNow(scope: number | null = closingWindowId): void {
  // Committing to close ONE window of several is not a quit. Tearing the queue
  // down and calling `app.quit()` here would take the user's other windows — and
  // the analyses running behind them — with it.
  //
  // `scope` is a PARAMETER, defaulting to the open prompt's own scope, because the
  // caller is not always the prompt: a second window closing, or an app-level
  // Cmd-Q, arrives while a window-scoped prompt is up and takes the "asked twice,
  // stop arguing" branch. Reading the prompt's scope there destroyed the wrong
  // window and left the app unquittable — the caller has to say what IT is
  // committing to.
  if (scope !== null) {
    const target = BrowserWindow.fromId(scope)
    phase = 'idle'
    finishingSince = 0
    askingWindowId = null
    closingWindowId = null
    // The intent was raised for a prompt about the whole app; a window-scoped
    // commit does not fulfil it, and leaving it up would keep MCP refusing writes
    // for the rest of a session the user chose to keep.
    setQuitIntent(false)
    stopTimers()
    if (target && !target.isDestroyed()) {
      // `destroy()` rather than `close()`: `close()` re-enters this guard, which
      // would see the same still-running analysis and ask the same question again.
      setImmediate(() => {
        if (!target.isDestroyed()) target.destroy()
      })
    }
    return
  }
  decided = true
  closingWindowId = null
  phase = 'idle'
  setQuitIntent(true)
  stopTimers()
  try {
    getJobQueue().stop()
  } catch {
    /* queue may not be initialised */
  }
  try {
    flushPending?.()
  } catch {
    /* a flush failure must not prevent the quit the user asked for */
  }
  setImmediate(() => app.quit())
}

/**
 * Nothing is being read any more — so honour the close the user already asked
 * for, in either phase.
 *
 * While `finishing` this is the whole point. While `asking` it matters just as
 * much: the last paper can land as the user reads the prompt, and a question
 * that then sits there announcing "0 papers" while refusing to close is both
 * false and stuck.
 */
function checkDrained(): void {
  if (phase === 'idle') return
  if (atRiskNow() > 0) {
    pushQuitState()
    return
  }
  quitNow()
}

function beginFinishing(): void {
  phase = 'finishing'
  finishingSince = Date.now()
  // Only when the APP is going. Pausing the shared queue because one window of
  // several is waiting for its own analysis would stall the papers the user's
  // other windows are working through, for a reason that has nothing to do with
  // them.
  if (closingWindowId === null) {
    try {
      // Claim nothing NEW; what is already running is left to land, which is the
      // whole point of this choice.
      getJobQueue().stop()
    } catch {
      /* queue may not be initialised */
    }
  }
  stopTimers()
  unsubscribeBusy = onBusyChange(checkDrained)
  // The elapsed readout has to advance on its own — nothing else ticks while a
  // single paper is being read — and it doubles as a safety net in case a
  // settle notification is ever missed.
  elapsedTimer = setInterval(() => {
    pushQuitState()
    checkDrained()
  }, 1000)
  pushQuitState()
  checkDrained()
}

/**
 * Undo everything the prompt changed and stay in the app.
 *
 * The queue is only restarted if WE paused it. A user who paused it from the
 * Queue screen while the prompt was open must not find it running again.
 */
function cancelQuit(): void {
  phase = 'idle'
  finishingSince = 0
  // Re-armed. A quit the user called off must not leave the guard permanently
  // disarmed for every later close of the session they chose to keep.
  decided = false
  setQuitIntent(false)
  stopTimers()
  // Only the app-level prompt stops the queue, so only it may restart one. A
  // window-scoped cancel restarting a queue it never touched would resume work the
  // user had paused from the Queue screen.
  if (closingWindowId === null) {
    try {
      if (queueWasRunning && !getJobQueue().isRunning()) getJobQueue().start()
    } catch {
      /* queue may not be initialised */
    }
  }
  // Tell the window the prompt is over BEFORE forgetting which window it was,
  // or it would keep the modal up with nothing left to dismiss it.
  pushQuitState()
  askingWindowId = null
  closingWindowId = null
}

/**
 * The user paused or resumed the queue themselves while the prompt was open.
 *
 * Called from the pause/resume IPC handlers so the state we would restore on
 * cancel is their latest intent, not the one captured when the prompt opened.
 */
export function noteQueueRunStateChanged(running: boolean): void {
  if (phase === 'asking') queueWasRunning = running
}

/** Re-push the live count while the prompt is open (wired to the queue's onChange). */
export function refreshQuitState(): void {
  if (phase === 'idle') return
  checkDrained()
}

export function decideQuit(choice: QuitChoice, fromWindowId: number | null): void {
  if (phase === 'idle') return
  // Only the window that was asked may answer, so a stale renderer elsewhere
  // cannot decide the fate of work it was never shown. An UNIDENTIFIABLE caller is
  // refused rather than trusted: a renderer main cannot place is one whose claim to
  // be the asked window cannot be checked at all.
  if (fromWindowId === null || fromWindowId !== askingWindowId) return
  if (choice === 'cancel') {
    cancelQuit()
    return
  }
  if (choice === 'now') {
    quitNow()
    return
  }
  // 'finish' with nothing left to finish — the paper landed in the same tick
  // the user clicked. Waiting for a drain that already happened would hang.
  if (atRiskNow() === 0) {
    quitNow()
    return
  }
  beginFinishing()
}

/**
 * Hold the close open and ask, if there is anything to lose.
 *
 * `win` is the window whose `close` fired, or null for an app-level quit.
 */
function guard(e: Electron.Event, win: BrowserWindow | null): void {
  const live = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
  // Closing one window of SEVERAL does not end the app, so the queue and any
  // other window's analyses are not at risk and must not prompt — a confirmation
  // the user sees on every window close is one they learn to click through.
  //
  // But the work THIS window started is at risk in the only sense that matters
  // to its user: they are watching it, and its surface is about to disappear. So
  // the question is not "are there other windows" but "does the closing window
  // own work nobody else is watching".
  const closingOneOfSeveral = win !== null && live.length > 1
  if (closingOneOfSeveral && busyCountForWindow(win.id) === 0) return
  // The OS is taking this window, or the whole session, and will not wait for an
  // answer. Holding the close stalls the entire logout.
  if (osSessionEnding || (win && sessionEnded.has(win.id))) return

  // Raised HERE, before every remaining early return: those returns are the
  // ordinary paths to closing (`busy()===0`, `BYPASS`, already-`decided`), not
  // exceptions to it, so a quit that will simply proceed must still be announced.
  // Only `cancelQuit` walks this back. NOT raised for a single window closing
  // among several — that is not a quit at all, and telling MCP to stop accepting
  // writes because one of three windows went away would be simply wrong.
  if (!closingOneOfSeveral) setQuitIntent(true)
  if (BYPASS || decided) return
  const atRisk = closingOneOfSeveral ? busyCountForWindow(win.id) : busy()
  if (atRisk === 0) return

  // Asked to close AGAIN while we are already holding one close open. The user
  // has now said close twice, so stop arguing and go.
  //
  // This is also the only way out of a renderer that is alive but wedged: it
  // never paints the prompt, so there is no button to press, and without this a
  // repeated Alt-F4 would be prevented forever and the app could only be killed.
  if (phase !== 'idle') {
    e.preventDefault()
    // Scoped to what THIS close is, not to what the open prompt was about. An
    // app-level quit arriving during a window-scoped prompt must quit the app;
    // reading the prompt's scope here destroyed that one window instead and left
    // the app unquittable until the state happened to clear.
    quitNow(closingOneOfSeveral ? win.id : null)
    return
  }

  const target = win ?? BrowserWindow.getFocusedWindow() ?? live[0] ?? null
  // No window, or one whose renderer is gone, cannot show the prompt. Blocking
  // there would produce an app that simply refuses to close, which is a worse
  // failure than the one being prevented.
  if (!target || target.isDestroyed() || target.webContents.isDestroyed() || target.webContents.isCrashed()) {
    return
  }

  e.preventDefault()

  if (phase === 'idle') {
    phase = 'asking'
    try {
      queueWasRunning = getJobQueue().isRunning()
    } catch {
      queueWasRunning = false
    }
  }
  askingWindowId = target.id
  // Which outcome answering this prompt commits to. Recorded WITH the question,
  // so a window opened or closed while the prompt is up cannot change what the
  // answer means.
  closingWindowId = closingOneOfSeveral ? win.id : null

  // A minimized window would show the prompt where nobody can see it, and the
  // close would look ignored.
  if (target.isMinimized()) target.restore()
  target.show()
  target.focus()
  pushQuitState()
}

/**
 * The window that was asked can no longer answer.
 *
 * Its renderer is gone — crashed, or the window was destroyed from underneath the
 * prompt. Without this, `pushQuitState` quietly no-ops against destroyed contents,
 * `phase` stays `asking` forever, and the NEXT close takes the
 * "asked twice, stop arguing" branch and quits immediately without asking. That is
 * silent data loss, not a hang, which is why it has to be handled rather than
 * waited out.
 *
 * Re-targeted to another live window where there is one, because the question is
 * still worth asking; otherwise the quit is simply called off, leaving the guard
 * armed for whoever asks next.
 */
function askingWindowLost(): void {
  if (phase === 'idle' || askingWindowId === null) return
  const lostId = askingWindowId
  // The prompt was about closing THAT window, and that window has now gone. There
  // is nothing left to commit to: `atRiskNow()` would read zero (its attribution
  // was dropped on `closed`), so a re-targeted prompt would announce 0 papers and
  // then `quitNow` would find nothing to close and silently drop the close the user
  // asked for. Calling it off leaves the guard armed for whoever asks next.
  if (closingWindowId === lostId) {
    cancelQuit()
    return
  }
  const other = BrowserWindow.getAllWindows().find(
    (w) =>
      w.id !== lostId &&
      !w.isDestroyed() &&
      !w.webContents.isDestroyed() &&
      !w.webContents.isCrashed()
  )
  if (!other) {
    cancelQuit()
    return
  }
  // The question — about the whole app — is still worth asking; only the surface
  // showing it has to change.
  askingWindowId = other.id
  pushQuitState()
}

/** Attach the guard to a window's close. Call for every window created. */
export function guardWindow(win: BrowserWindow): void {
  const id = win.id
  win.on('close', (e) => guard(e, win))

  // Windows only, and emitted on the WINDOW rather than on `app`: the OS is
  // shutting down or logging off. It will not wait for an answer, and holding
  // the close stalls the whole session — so stand down and let the work go. The
  // abandoned row stays 'running' and `resumePending` recovers it next launch.
  //
  // Recorded PER WINDOW. A blanket `decided = true` would disarm the guard for
  // the whole process, so one window's session ending would let every other
  // window be closed over a running analysis without a word.
  win.on('session-end', () => {
    sessionEnded.add(id)
    // Also app-level: the quit that follows a logoff has no window to attribute it
    // to, so a per-window flag alone would let it put up a question nobody is there
    // to answer.
    osSessionEnding = true
  })

  // `closed`, not `close`: the guard can and does veto a close, and tearing this
  // window's bookkeeping down on `close` would forget a window that then stays
  // open.
  win.on('closed', () => {
    sessionEnded.delete(id)
    forgetWindow(id)
    if (askingWindowId === id) askingWindowLost()
  })

  // A crashed renderer never paints the prompt and never answers it, but the
  // window object is still alive, so `closed` will not fire.
  win.webContents.on('render-process-gone', () => {
    if (askingWindowId === id) askingWindowLost()
  })
}

/** Attach the app-level hooks. Call once, before the first window exists. */
export function installCloseGuard(): void {
  // Covers app.quit() from any source: macOS Cmd-Q, the dock's Quit, and the
  // window-all-closed handler.
  app.on('before-quit', (e) => guard(e, null))
}
