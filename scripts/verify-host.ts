// Prove the stage host pool's LIFECYCLE guarantees, against real processes.
//
//   npm run verify:host
//
// The pool exists for one reason: a stage that blocks inside a synchronous
// native call must not freeze main's synchronous SQLite, and must remain
// killable. Both of those are claims about PROCESSES, and neither can be
// checked by anything that stubs one out — so this script spawns real
// utilityProcess hosts and, for the central case, wedges one in a genuine
// unyielding busy loop that no AbortSignal can ever interrupt.
//
// It runs under Electron proper (not ELECTRON_RUN_AS_NODE), because
// `utilityProcess` only exists there.

import { app, utilityProcess } from 'electron'
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { HostPool } from '../src/main/pipeline/host/pool'
import { hostEnv, HOST_ENV_ALLOW } from '../src/main/pipeline/host/protocol'

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function main(): Promise<void> {
  const scratch = mkdtempSync(join(tmpdir(), 'corpus-host-check-'))
  const runDir = join(scratch, 'run')

  // ---------------------------------------------------------------- env
  console.log('\n── the host env is an allow-list ─────────────────────────────')
  const env = hostEnv({
    PATH: '/usr/bin',
    HOME: '/home/someone',
    SOME_OTHER_SECRET: 'also secret'
  })
  // The allow-list is a POSITIVE filter, so a secret under any name is dropped.
  // It is checked with an arbitrary name on purpose: the app no longer reads a
  // gateway credential from the environment at all, and a check naming the
  // retired `CORPUS_LLM_*` variables would pass by describing something that
  // cannot happen rather than by testing the filter.
  check('an unrelated variable is not forwarded', !('SOME_OTHER_SECRET' in env))
  // `utilityProcess.fork`'s `env` REPLACES the environment. Dropping these does
  // not harden anything — it breaks spawn('qpdf'), every temp file, and every
  // library that resolves a cache directory.
  check('PATH and HOME ARE forwarded', env.PATH === '/usr/bin' && env.HOME === '/home/someone')
  check(
    'the allow-list covers all three platforms',
    ['APPDATA', 'LOCALAPPDATA', 'TMPDIR', 'USERPROFILE'].every((k) =>
      (HOST_ENV_ALLOW as readonly string[]).includes(k)
    )
  )

  // ---------------------------------------------------------------- wedge
  console.log('\n── a WEDGED host is killed, not asked politely ───────────────')
  // A host whose body is an unyielding synchronous loop. This is the case the
  // whole design turns on: `worker.terminate()` cannot interrupt it, which is
  // why the pool uses `utilityProcess.kill()`. Nothing cooperative can help —
  // the loop never returns to the event loop, so the AbortSignal is never
  // delivered, and any implementation that only aborts would hang forever.
  const wedgeEntry = join(scratch, 'wedge.js')
  writeFileSync(
    wedgeEntry,
    `process.parentPort.postMessage({ kind: 'ready', pid: process.pid })
     process.parentPort.on('message', () => {
       // Deliberately unyielding: no await, no timer, no signal check.
       for (;;) { Math.sqrt(Math.random()) }
     })`
  )
  const wedged = utilityProcess.fork(wedgeEntry, [], { env: hostEnv(), stdio: 'inherit' })
  const wedgedPid = await new Promise<number>((resolve) => {
    wedged.on('message', (m: { kind: string; pid: number }) => {
      if (m.kind === 'ready') resolve(m.pid)
    })
  })
  check('the wedge host started', alive(wedgedPid), `pid ${wedgedPid}`)
  wedged.postMessage({ kind: 'dispatch' })
  await sleep(300)
  check('it is still alive and spinning', alive(wedgedPid))
  const killedAt = Date.now()
  wedged.kill()
  let died = false
  for (let i = 0; i < 100 && !died; i++) {
    await sleep(20)
    died = !alive(wedgedPid)
  }
  // The headline guarantee. If this fails, cancel is a lie for every native
  // stage in the app: OCR at ~12.5 s/page cannot be interrupted any other way.
  check(
    'kill() interrupted a synchronous loop no signal could reach',
    died,
    died ? `${Date.now() - killedAt}ms` : 'STILL RUNNING'
  )

  // ---------------------------------------------------------------- orphans
  console.log('\n── no host outlives its parent ───────────────────────────────')
  const orphanEntry = join(scratch, 'orphan.js')
  writeFileSync(
    orphanEntry,
    `process.parentPort.postMessage({ kind: 'ready', pid: process.pid })
     process.parentPort.on('close', () => process.exit(0))
     setInterval(() => {}, 1000)`
  )
  const orphan = utilityProcess.fork(orphanEntry, [], { env: hostEnv(), stdio: 'inherit' })
  const orphanPid = await new Promise<number>((resolve) => {
    orphan.on('message', (m: { kind: string; pid: number }) => {
      if (m.kind === 'ready') resolve(m.pid)
    })
  })
  check('an idle host stays alive while its parent lives', alive(orphanPid))
  orphan.kill()
  let orphanDied = false
  for (let i = 0; i < 100 && !orphanDied; i++) {
    await sleep(20)
    orphanDied = !alive(orphanPid)
  }
  check('and dies when killed', orphanDied)

  // ---------------------------------------------------------------- sweep
  console.log('\n── the orphan sweep kills only OUR dead-parent hosts ─────────')
  // A run file naming a live process whose parent is ALSO live: a second
  // running instance of the app. Killing that would be worse than leaving an
  // orphan, and this repo has a documented history of two instances contending.
  const otherInstance = new HostPool({
    entryPath: join(scratch, 'noop.js'),
    runDir,
    instanceId: randomUUID()
  })
  writeFileSync(
    join(runDir, 'host-999999.json'),
    JSON.stringify({
      pid: 999999,
      startTicks: 'nonsense',
      parentPid: 999998,
      instanceId: randomUUID()
    })
  )
  // A record for THIS process, whose parent (also this process) is alive.
  writeFileSync(
    join(runDir, `host-${process.pid}.json`),
    JSON.stringify({
      pid: process.pid,
      startTicks: startTicksOf(process.pid),
      parentPid: process.pid,
      instanceId: randomUUID()
    })
  )
  // Constructing a pool runs the sweep.
  new HostPool({ entryPath: join(scratch, 'noop.js'), runDir, instanceId: randomUUID() })
  check('this process was NOT killed by the sweep', alive(process.pid))
  check(
    'a stale record for a dead pid was cleaned up',
    !existsSync(join(runDir, 'host-999999.json'))
  )
  check(
    'a record whose parent is still alive was left alone',
    existsSync(join(runDir, `host-${process.pid}.json`)),
    readdirSync(runDir).join(' ')
  )
  otherInstance.shutdown()

  // ---------------------------------------------------------------- shutdown
  console.log('\n── shutdown is idempotent ────────────────────────────────────')
  const pool = new HostPool({
    entryPath: join(scratch, 'noop.js'),
    runDir,
    instanceId: randomUUID()
  })
  pool.shutdown()
  pool.shutdown()
  check('shutting a pool down twice does not throw', true)
  check('a shut-down pool holds no hosts', pool.hostCount() === 0)

  rmSync(scratch, { recursive: true, force: true })
  console.log(failures === 0 ? '\nALL HOST CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
  app.exit(failures === 0 ? 0 : 1)
}

/** Mirrors the pool's own pid-reuse defence, so the fixture matches reality. */
function startTicksOf(pid: number): string | null {
  if (process.platform !== 'linux') return 'alive'
  try {
    const { readFileSync } = require('node:fs') as typeof import('node:fs')
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null
  } catch {
    return null
  }
}

app.whenReady().then(main).catch((err) => {
  console.error('verify-host crashed:', err)
  app.exit(1)
})
