// Spawning the Python sidecar. This is the PACKAGING mechanism for the one
// Python stage in the pipeline design (tmp/pipeline-design.md §14.1.2) — it
// proves the payload can be located and executed identically from source and
// from an installer, which is the part that had to be paid for before that
// design could stop treating Python as permanently optional.
//
// What it deliberately does NOT do: own a stage, touch the database, or open a
// socket. The sidecar is bytes in, JSON out. Ownership is per Node host, not a
// process-wide singleton, so a kill has a blast radius of one job.

import { spawn, type ChildProcess } from 'node:child_process'
import { hostEnv } from './pipeline/host/protocol'
import { resourceExists, resourcePath } from './resources'

/** Where the interpreter lands inside the platform's sidecar payload. */
function interpreterSegments(): string[] {
  return process.platform === 'win32'
    ? ['sidecar', 'win32', 'python', 'python.exe']
    : ['sidecar', process.platform, 'python', 'bin', 'python3']
}

/** Absolute path to the shipped interpreter for this platform. */
export function sidecarInterpreterPath(): string {
  return resourcePath(...interpreterSegments())
}

/** Absolute path to the sidecar entry module. */
export function sidecarEntryPath(): string {
  return resourcePath('sidecar', process.platform, 'corpus_sidecar', 'main.py')
}

/**
 * Whether a sidecar was packaged for this platform.
 *
 * "Absent" is a legitimate, cacheable outcome — a stage reports `skipped` and
 * carries the tool identity in its fingerprint, so a later build that ships the
 * payload changes the fingerprint and the skip re-runs. It is NOT the same as a
 * crash loop, which is session state and must never enter a fingerprint.
 */
export function sidecarAvailable(): boolean {
  return (
    resourceExists(...interpreterSegments()) &&
    resourceExists('sidecar', process.platform, 'corpus_sidecar', 'main.py')
  )
}

export interface SidecarHandle {
  child: ChildProcess
  /** Tree-kill. POSIX kills the process GROUP; Windows needs taskkill /T /F. */
  kill(): void
}

/**
 * Spawn the sidecar with the framed-JSON stdio contract.
 *
 * The fourth stdio pipe is a dedicated LIVENESS channel (fd 3 in the child).
 * It cannot be stdin: stdin carries request frames, so a watchdog reading it
 * would steal them, and the request loop cannot notice EOF while blocked inside
 * a long-running op. The child's watchdog thread blocks on fd 3 and exits on
 * EOF, which the kernel delivers when this process dies for ANY reason,
 * including SIGKILL.
 */
export function spawnSidecar(): SidecarHandle {
  if (!sidecarAvailable()) {
    throw new Error(
      `No Python sidecar packaged for ${process.platform}. ` +
        `Expected ${sidecarInterpreterPath()} — run scripts/build-sidecar.sh.`
    )
  }

  const child = spawn(sidecarInterpreterPath(), [sidecarEntryPath()], {
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    // POSIX: lead our own process group so a kill reaps grandchildren too.
    // "We kill the process we know about" is exactly how orphans happen.
    detached: process.platform !== 'win32',
    // The child gets an ALLOW-LIST, and it is the SAME one the Node hosts get:
    // the sidecar must be unable to construct a gateway request, and one shared
    // list cannot drift out of agreement with itself the way two would.
    // `verify:sidecar` asserts the credential's absence from inside the child.
    env: {
      ...hostEnv(),
      PYTHONUNBUFFERED: '1',
      // stdout IS the protocol channel, so its encoding cannot be left to the
      // user's locale: `LC_ALL` is forwarded, and a latin-1 stdout would emit
      // bytes Node decodes as utf8 the moment a table contains a µ or a ±.
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
      // The sidecar is pure-Python plus vendored wheels; keep the user's own
      // site-packages and PYTHONPATH out of it so a machine-local install
      // cannot change what the app computes.
      PYTHONNOUSERSITE: '1',
      PYTHONPATH: resourcePath('sidecar', process.platform, 'site-packages')
    }
  })

  const kill = (): void => {
    // `child.killed` stays false after `process.kill(-pid)`, which bypasses
    // `child.kill`. Ask whether the process has actually gone instead, so a
    // second kill cannot signal a process group the OS has since recycled.
    if (child.pid == null || child.exitCode != null || child.signalCode != null) return
    if (process.platform === 'win32') {
      // Windows has no process groups and emulates SIGKILL as TerminateProcess
      // on one handle, leaving grandchildren alive. taskkill ships with the OS.
      const tk = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      // Without this listener a missing taskkill raises an unhandled 'error'
      // and takes main down during the very cleanup meant to be reaping.
      tk.on('error', () => {})
    } else {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }
  }

  return { child, kill }
}
