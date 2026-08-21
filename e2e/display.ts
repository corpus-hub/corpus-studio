/*
 * Display provisioning for the E2E suite.
 *
 * Every test launches a REAL Electron window. On a desktop those windows appear
 * on top of whatever the user is doing and STEAL KEYBOARD FOCUS — and the suite
 * types into them, so a long run makes the machine unusable and can deliver
 * keystrokes to the wrong window.
 *
 * So the suite provisions its OWN virtual display and hands it to every launch
 * explicitly. The guarantee lives in `globalSetup` + `launchApp`, which every
 * entry point traverses (`npx playwright test`, a single spec from an IDE, a
 * debugger), rather than in a shell wrapper that only protects the one command
 * somebody remembered to type.
 *
 * Watching the suite drive the app is still possible, but must be ASKED for:
 * `CORPUS_E2E_HEADED=1` (what `npm run test:e2e:headed` sets).
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'

/** Env var carrying the provisioned display to the workers and to `launchApp`. */
export const DISPLAY_ENV = 'CORPUS_E2E_DISPLAY'

const PID_ENV = 'CORPUS_E2E_XVFB_PID'
const WATCHDOG_PID_ENV = 'CORPUS_E2E_XVFB_WATCHDOG_PID'

/**
 * Is this display a virtual framebuffer rather than somebody's monitor?
 *
 * Determined by ASKING X, not by guessing from the display number (`:0` is
 * conventional for a real seat but nothing enforces it) and not from
 * `$XVFB_DISPLAY` (xvfb-run does not export it). The vendor string is no help
 * either — Xvfb reports "The X.Org Foundation" exactly like a real server.
 *
 * The reliable signal is HARDWARE extensions. A physical display advertises
 * `XFree86-VidModeExtension` (mode setting) and `DPMS` (monitor power control);
 * Xvfb drives no hardware, so it offers neither.
 *
 * If the display cannot be inspected it counts as REAL: provisioning another
 * server is cheap, hijacking someone's desktop is not.
 */
export function isVirtualDisplay(display: string): boolean {
  try {
    const out = execFileSync('xdpyinfo', ['-display', display], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000
    })
    return !out.includes('XFree86-VidModeExtension') && !out.includes('DPMS')
  } catch {
    return false
  }
}

let child: ChildProcess | null = null

/**
 * Stop the server we spawned. Safe to call repeatedly and from a signal handler.
 *
 * Kills XVFB BY ITS OWN PID, and the watchdog shell separately, rather than
 * signalling the shared process group: a group signal reaches the shell too, and
 * a shell that dies first never runs the `kill $xpid` it was holding, so whether
 * the server actually died came down to delivery order. Naming it removes that.
 *
 * SIGTERM, not SIGKILL: Xvfb removes its own /tmp/.X<n>-lock on the way out, so
 * the display number becomes reusable. SIGKILL would strand the lock.
 */
export function stopXvfb(): void {
  const watchdog = child?.pid ?? Number(process.env[WATCHDOG_PID_ENV] ?? '')
  const server = Number(process.env[PID_ENV] ?? '')
  child = null
  delete process.env[PID_ENV]
  delete process.env[WATCHDOG_PID_ENV]
  // Server first: the watchdog is only a fallback for the case where this call
  // never happens, and killing it first would forfeit that fallback if the
  // second kill then failed.
  for (const pid of [server, watchdog]) {
    if (!pid || !Number.isFinite(pid)) continue
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      /* already gone */
    }
  }
}

/**
 * Spawn an Xvfb server and return its display string.
 *
 * Two details are load-bearing:
 *
 * `-displayfd` makes XVFB PICK the display number and report it back, so two
 * concurrent runs cannot race for the same number the way "scan for a free :N
 * then claim it" does.
 *
 * The shell wrapper is a WATCHDOG that POLLS the runner's pid. Explicit teardown
 * handles the ordinary exits, but the runner can also be SIGKILLed, or shut down
 * by Playwright's own Ctrl-C path before our handlers get a turn — and an Xvfb
 * left behind then survives for days (this box was already carrying eleven of
 * them). `kill -0` needs nothing from the dying process, so no exit path can
 * skip it.
 *
 * Polling beats watching an inherited pipe for EOF here: Playwright forks
 * workers that inherit every open descriptor, so a pipe stays open as long as
 * ANY worker lives and the EOF may never arrive.
 *
 * The wrapper reports the server's PID on fd 4 so teardown can kill Xvfb by
 * name. `detached` keeps the wrapper out of this process's group, so a signal
 * sent to the runner's group (Ctrl-C in a shell) cannot take the watchdog down
 * before it has done its job.
 */
async function startXvfb(): Promise<string> {
  const proc = spawn(
    'sh',
    [
      '-c',
      'Xvfb -displayfd 3 -screen 0 1920x1080x24 -nolisten tcp -noreset & ' +
        'xpid=$!; echo $xpid >&4; ' +
        `while kill -0 ${process.pid} 2>/dev/null; do sleep 1; done; ` +
        'kill $xpid 2>/dev/null'
    ],
    { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], detached: true }
  )

  const serverPid = new Promise<string>((resolve) => {
    const fd = proc.stdio[4] as NodeJS.ReadableStream | undefined
    if (!fd) {
      resolve('')
      return
    }
    let buf = ''
    fd.on('data', (b: Buffer) => {
      buf += b.toString()
      if (buf.includes('\n')) resolve(buf.trim())
    })
  })
  child = proc

  let stderr = ''
  proc.stderr?.on('data', (b: Buffer) => {
    stderr += b.toString()
  })

  const num = await new Promise<string>((resolve, reject) => {
    let out = ''
    const fd = proc.stdio[3] as NodeJS.ReadableStream | undefined
    if (!fd) {
      reject(new Error('Xvfb: no -displayfd pipe'))
      return
    }
    const timer = setTimeout(
      () => reject(new Error(`Xvfb did not report a display within 15s. ${stderr}`)),
      15_000
    )
    const done = (err: Error | null, value?: string): void => {
      clearTimeout(timer)
      err ? reject(err) : resolve(value as string)
    }
    fd.on('data', (b: Buffer) => {
      out += b.toString()
      if (out.includes('\n')) done(null, out.trim())
    })
    proc.on('error', (e) =>
      done(
        new Error(
          `could not start Xvfb (${e.message}). Install it: sudo apt-get install xvfb`
        )
      )
    )
    proc.on('exit', (code) => done(new Error(`Xvfb exited with code ${code}. ${stderr}`)))
  })

  // The exit listener above must not outlive the handshake, or a later crash
  // rejects a settled promise; but we DO want the pids recorded for teardown.
  proc.removeAllListeners('exit')
  process.env[PID_ENV] = await serverPid
  process.env[WATCHDOG_PID_ENV] = String(proc.pid)
  proc.unref()
  return `:${num}`
}

/**
 * Resolve the display the suite will run on, spawning a server when needed, and
 * publish it as `CORPUS_E2E_DISPLAY`. Playwright forks its workers AFTER global
 * setup, so they inherit the variable; `launchApp` then passes it to Electron
 * explicitly instead of inheriting whatever `DISPLAY` happened to be set.
 *
 * Throws rather than falling back to the user's screen if no virtual display
 * can be obtained — a silent fallback is exactly the bug this replaces.
 */
export async function provisionDisplay(): Promise<string> {
  if (process.env.CORPUS_E2E_HEADED === '1') {
    const display = process.env.DISPLAY
    if (!display) {
      throw new Error(
        'CORPUS_E2E_HEADED=1 was set but DISPLAY is empty, so there is no screen to watch.'
      )
    }
    process.env[DISPLAY_ENV] = display
    return display
  }

  // Already inside xvfb-run (or any other virtual server): reuse it. Spawning a
  // second one would waste a server and split the run across two screens.
  const inherited = process.env.DISPLAY
  if (inherited && isVirtualDisplay(inherited)) {
    process.env[DISPLAY_ENV] = inherited
    return inherited
  }

  const display = await startXvfb()
  if (!isVirtualDisplay(display)) {
    stopXvfb()
    throw new Error(`Xvfb reported ${display} but it does not look virtual; refusing to run.`)
  }
  process.env[DISPLAY_ENV] = display
  return display
}
