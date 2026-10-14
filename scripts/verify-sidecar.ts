// Prove the Python sidecar packaging mechanism end to end: locate the shipped
// payload through `resourcePath()`, spawn it, exchange a framed-JSON request,
// and confirm the liveness watchdog reaps it when the parent's pipe closes.
//
//   npm run verify:sidecar
//   CORPUS_RESOURCES_DIR=release/linux-unpacked/resources/app-resources \
//     npm run verify:sidecar        # against a packaged tree
//
// This is the de-risking step for tmp/pipeline-design.md's one Python stage:
// if this passes from a packaged tree, "Python is packageable" stops being an
// assumption.

import { sidecarAvailable, sidecarInterpreterPath, spawnSidecar } from '../src/main/sidecar'
import { resourcesRoot } from '../src/main/resources'

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

async function main(): Promise<void> {
  console.log(`resources root: ${resourcesRoot()}`)
  console.log(`interpreter:    ${sidecarInterpreterPath()}`)

  if (!sidecarAvailable()) {
    console.log(
      '\nNo sidecar payload present — run `scripts/build-sidecar.sh` first.\n' +
        'Absence is a legitimate state (a stage reports `skipped`), so this is ' +
        'reported, not failed.'
    )
    process.exit(0)
  }

  const { child, kill } = spawnSidecar()
  const responses: string[] = []
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => responses.push(chunk))
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => process.stderr.write(`[sidecar] ${chunk}`))

  child.stdin?.write(JSON.stringify({ id: 1, op: 'ping', args: { echo: 'hello' } }) + '\n')

  const reply = await new Promise<string>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error('sidecar did not answer in 10s')), 10_000)
    const poll = setInterval(() => {
      const joined = responses.join('')
      if (joined.includes('\n')) {
        clearTimeout(timer)
        clearInterval(poll)
        resolvePromise(joined.split('\n')[0])
      }
    }, 50)
  })

  const parsed = JSON.parse(reply) as {
    id: number
    ok: boolean
    result?: { pong?: boolean; python?: string; echo?: string }
  }
  check('sidecar answered the framed request', parsed.ok === true && parsed.id === 1)
  check('op result is correct', parsed.result?.pong === true && parsed.result?.echo === 'hello')
  console.log(`      interpreter reports python ${parsed.result?.python}`)

  // The child must not have been handed the LLM gateway credential. This is
  // asked of the child rather than asserted of the spawn options, because the
  // bug it guards against — a `...process.env` spread — looks correct at the
  // call site and is only visible from inside the process that received it.
  child.stdin?.write(JSON.stringify({ id: 2, op: 'envkeys', args: {} }) + '\n')
  const envReply = await new Promise<string>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error('no envkeys reply in 10s')), 10_000)
    const poll = setInterval(() => {
      // Match on the request id, and only consider lines a newline has closed:
      // a reply split across two 'data' events would otherwise be parsed as a
      // truncated frame, which fails intermittently and looks like a flake.
      const chunks = responses.join('').split('\n')
      const complete = chunks.slice(0, -1)
      const hit = complete.find((line) => {
        try {
          return (JSON.parse(line) as { id?: number }).id === 2
        } catch {
          return false
        }
      })
      if (hit != null) {
        clearTimeout(timer)
        clearInterval(poll)
        resolvePromise(hit)
      }
    }, 50)
  })
  const envKeys = (JSON.parse(envReply) as { result?: { keys?: string[] } }).result?.keys ?? []
  const leaked = envKeys.filter((k) => k.startsWith('CORPUS_LLM'))
  check(
    'no gateway credential in the sidecar environment',
    leaked.length === 0,
    leaked.length ? `LEAKED: ${leaked.join(', ')}` : `${envKeys.length} vars, none CORPUS_LLM*`
  )

  // Closing the liveness pipe (fd 3) must reap the child even though stdin is
  // still open — this is the property that stops orphaned interpreters when the
  // app is SIGKILLed.
  const liveness = child.stdio[3] as NodeJS.WritableStream | null
  check('a dedicated liveness pipe exists on fd 3', liveness != null)
  liveness?.end()

  const exited = await new Promise<boolean>((resolvePromise) => {
    const timer = setTimeout(() => resolvePromise(false), 5000)
    child.on('exit', () => {
      clearTimeout(timer)
      resolvePromise(true)
    })
  })
  check('sidecar exits when the liveness pipe closes (no orphans)', exited)
  if (!exited) kill()

  console.log(failures === 0 ? '\nSIDECAR CHECKS PASSED' : `\n${failures} SIDECAR CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

void main().catch((err) => {
  console.error(err)
  process.exit(1)
})
