/**
 * Drive the update state machine against a REAL version service.
 *
 * The unit tests fake electron-updater, which proves the transitions but not
 * that the two halves agree: the manifest format, the download URL the client
 * builds, the hash the server published. Those only meet here.
 *
 * The service is started in-process on a free port, so this needs no network
 * and no container. It cleans up after itself.
 *
 *   npm run verify:updater
 */
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { UpdaterService } from '../src/main/updater'
import type { UpdateStateDTO } from '../src/shared/contract'

const VERSIONER = '/media/varingait/Lobotomite/corpus-studio-versioner'
const CURRENT = '0.1.0'
const NEXT = '9.9.9'

/**
 * Abort the check.
 *
 * THROWS rather than exiting, so the `finally` that closes the listener and
 * removes the temp directories still runs. Exiting here left a stale socket and
 * a directory behind on every failure — which is the run where cleanup matters
 * most, since it is the one you repeat.
 */
class VerifyFailure extends Error {}
function fail(message: string): never {
  throw new VerifyFailure(message)
}

async function main(): Promise<void> {
  let buildApp: (o: { root: string; token: string }) => Promise<{
    inject(o: unknown): Promise<{ statusCode: number; body: string }>
    listen(o: { host: string; port: number }): Promise<unknown>
    close(): Promise<unknown>
    server: { address(): { port: number } | string | null }
  }>
  try {
    ;({ buildApp } = await import(`${VERSIONER}/src/app.ts`))
  } catch {
    fail(`the version service is not checked out at ${VERSIONER}`)
  }

  const root = await mkdtemp(join(tmpdir(), 'verify-updater-'))
  // Hoisted so the `finally` can remove it however the run ends.
  const cacheRoot = await mkdtemp(join(tmpdir(), 'verify-updater-cache-'))
  const app = await buildApp({ root, token: 'verify' })
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const base = `http://127.0.0.1:${port}`

  try {
    // A release the client has never seen, published the way CI would.
    const installer = Buffer.from(`corpus-studio ${NEXT} payload`)
    const sha512 = createHash('sha512').update(installer).digest('base64')
    const manifest = [
      `version: ${NEXT}`,
      'files:',
      `  - url: App-${NEXT}.AppImage`,
      `    sha512: ${sha512}`,
      `    size: ${installer.length}`,
      `path: App-${NEXT}.AppImage`,
      `sha512: ${sha512}`,
      `releaseDate: '${new Date().toISOString()}'`
    ].join('\n')

    const auth = { authorization: 'Bearer verify', 'content-type': 'application/octet-stream' }
    const put = async (name: string, payload: Buffer | string): Promise<void> => {
      const r = await app.inject({
        method: 'PUT',
        url: `/api/release/stable/${NEXT}/${name}`,
        headers: auth,
        payload
      })
      if (r.statusCode !== 201) fail(`uploading ${name} answered ${r.statusCode}: ${r.body}`)
    }
    await put('latest-linux.yml', manifest)
    await put(`App-${NEXT}.AppImage`, installer)

    // BEFORE publishing, nothing is visible. This is the invariant the whole
    // design rests on, so it is asserted end to end rather than trusted.
    const early = await app.inject({ url: '/stable/latest-linux.yml' })
    if (early.statusCode !== 404) fail(`an unpublished release was served (${early.statusCode})`)

    const published = await app.inject({
      method: 'POST',
      url: `/api/release/stable/${NEXT}/publish`,
      headers: { authorization: 'Bearer verify', 'content-type': 'application/json' },
      payload: { notes: 'verified by scripts/verify-updater.ts' }
    })
    if (published.statusCode !== 200) fail(`publish answered ${published.statusCode}`)

    // --- now the client -----------------------------------------------------
    //
    // The updater is constructed against a STAND-IN for Electron's `app`. There
    // is no Electron app in this process — the point of the exercise is to run
    // the real client logic against the real server without launching a window.
    const { AppImageUpdater } = await import('electron-updater')
    const { CancellationToken } = await import('builder-util-runtime')
    const cacheDir = cacheRoot
    const devConfig = join(cacheDir, 'app-update.yml')
    await writeFile(devConfig, `provider: generic\nurl: ${base}/stable\n`)

    const appAdapter = {
      version: CURRENT,
      name: 'corpus-studio',
      isPackaged: true,
      appUpdateConfigPath: devConfig,
      userDataPath: cacheDir,
      baseCachePath: cacheDir,
      whenReady: async () => undefined,
      relaunch: () => undefined,
      quit: () => undefined,
      onQuit: () => undefined
    }
    // AppImageUpdater refuses to act unless it is running FROM an AppImage,
    // which it decides by this variable. Pointing it at a scratch file is what
    // lets the real client run here at all.
    process.env.APPIMAGE = join(cacheDir, 'Corpus Studio.AppImage')
    await writeFile(process.env.APPIMAGE, 'placeholder')
    const autoUpdater = new AppImageUpdater(null, appAdapter as never)
    // Passing an app adapter makes electron-updater skip building its own HTTP
    // executor, because it assumes only its Electron-backed constructor path
    // needs one. Node's plain https client answers the same interface and is
    // what a scripted run has available.
    const { NodeHttpExecutor } = await import('./lib/nodeHttpExecutor')
    ;(autoUpdater as unknown as { httpExecutor: unknown }).httpExecutor = new NodeHttpExecutor()

    const phases: string[] = []
    const service = new UpdaterService({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      autoUpdater: autoUpdater as any,
      currentVersion: CURRENT,
      packaged: false,
      platform: 'linux',
      signed: false,
      feedUrl: `${base}/stable`,
      autoCheckDelayMs: 0,
      makeCancelToken: () => new CancellationToken() as never,
      send: (s: UpdateStateDTO) => {
        if (phases[phases.length - 1] !== s.phase) phases.push(s.phase)
      }
    })
    service.start()

    await service.check()
    const found = service.getState()
    if (found.phase !== 'available') {
      fail(`expected the client to find ${NEXT}, got phase="${found.phase}" error="${found.error}"`)
    }
    if (found.newVersion !== NEXT) fail(`offered "${found.newVersion}", expected ${NEXT}`)

    await service.download()
    const ready = service.getState()
    if (ready.phase !== 'ready') {
      fail(`expected the download to complete, got phase="${ready.phase}" error="${ready.error}"`)
    }

    console.log(`  phases: ${phases.join(' → ')}`)
    console.log(`  ✓ ${CURRENT} found ${NEXT}, downloaded it, and is ready to install`)

    // --- and the negative case ---------------------------------------------
    //
    // A download that merely SUCCEEDS proves nothing about verification: if the
    // digest check were skipped entirely, everything above would still pass. So
    // a release is published whose manifest states a hash the file does not
    // have, and the client must refuse it.
    const BAD = '9.9.10'
    const wrongHash = createHash('sha512').update('not this').digest('base64')
    const tampered = [
      `version: ${BAD}`,
      'files:',
      `  - url: App-${BAD}.AppImage`,
      `    sha512: ${wrongHash}`,
      `    size: ${installer.length}`,
      `path: App-${BAD}.AppImage`,
      `sha512: ${wrongHash}`,
      `releaseDate: '${new Date().toISOString()}'`
    ].join('\n')
    for (const [name, payload] of [
      ['latest-linux.yml', tampered],
      [`App-${BAD}.AppImage`, installer]
    ] as const) {
      const r = await app.inject({
        method: 'PUT',
        url: `/api/release/stable/${BAD}/${name}`,
        headers: auth,
        payload
      })
      if (r.statusCode !== 201) fail(`uploading the tampered ${name} answered ${r.statusCode}`)
    }
    const badPublish = await app.inject({
      method: 'POST',
      url: `/api/release/stable/${BAD}/publish`,
      headers: { authorization: 'Bearer verify', 'content-type': 'application/json' },
      payload: {}
    })
    if (badPublish.statusCode !== 200) fail(`publishing ${BAD} answered ${badPublish.statusCode}`)

    await service.check()
    if (service.getState().newVersion !== BAD) {
      fail(`expected the client to be offered ${BAD}, got "${service.getState().newVersion}"`)
    }
    await service.download()
    const refused = service.getState()
    if (refused.phase !== 'error') {
      fail(`a file that does not match its published hash was ACCEPTED (phase="${refused.phase}")`)
    }
    // The REASON, not just the failure. Every fault lands in `error` — a 404, a
    // refused connection — so asserting the phase alone would read a broken URL
    // as proof that the hash was checked, which is the one thing this exists to
    // establish.
    // Matched loosely, so a copy-edit to the sentence the user reads cannot
    // fail a check about whether the hash was verified.
    if (!/did not match|checksum|sha512/i.test(refused.error ?? '')) {
      fail(`the download failed, but not because of the hash: "${refused.error}"`)
    }
    console.log(`  ✓ a build whose bytes do not match its manifest is refused: "${refused.error}"`)
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true })
    await rm(cacheRoot, { recursive: true, force: true })
  }
}

main().catch((err) => {
  if (err instanceof VerifyFailure) {
    console.error(`\n  ✗ ${err.message}\n`)
  } else {
    console.error(err)
  }
  process.exit(1)
})
