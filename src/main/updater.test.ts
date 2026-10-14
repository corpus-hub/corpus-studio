import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveFeed, canInstallInPlace, describeUpdateError, UpdaterService } from './updater'
import type { UpdaterDeps } from './updater'
import type { UpdateStateDTO } from '../shared/contract'

/** A stand-in for electron-updater whose events we fire by hand. */
function fakeUpdater() {
  const handlers = new Map<string, (arg?: unknown) => void>()
  return {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    feed: null as unknown,
    installed: false,
    setFeedURL(o: unknown) {
      this.feed = o
    },
    on(event: string, cb: (arg?: unknown) => void) {
      handlers.set(event, cb)
      return this
    },
    emit(event: string, arg?: unknown) {
      handlers.get(event)?.(arg)
    },
    async checkForUpdates() {
      // Mirrors the real AppUpdater: it announces the check first, and on
      // failure EMITS 'error' before rethrowing. A fake that only threw let a
      // guard reading `state.phase` in the catch look correct while the
      // listener had already overwritten it.
      this.emit('checking-for-update')
      if (this.checkError) {
        this.emit('error', this.checkError)
        throw this.checkError
      }
      return null
    },
    checkError: null as Error | null,
    downloadCancelled: false,
    async downloadUpdate(token?: { cancel(): void; readonly cancelled: boolean }) {
      this.lastToken = token ?? null
      return null
    },
    lastToken: null as { cancel(): void; readonly cancelled: boolean } | null,
    // Returns NOTHING, like the real one: BaseUpdater.quitAndInstall computes
    // whether the install started and then discards it. A fake that returned a
    // boolean let a check on the return value look correct while being dead
    // code in production.
    quitAndInstall() {
      this.installed = true
    }
  }
}

function service(over: Partial<UpdaterDeps> = {}) {
  const au = fakeUpdater()
  const seen: UpdateStateDTO[] = []
  const svc = new UpdaterService({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    autoUpdater: au as any,
    currentVersion: '0.1.0',
    packaged: false,
    platform: 'linux',
    signed: false,
    feedUrl: 'http://127.0.0.1:8088/stable',
    autoCheckDelayMs: 0,
    makeCancelToken: () => {
      let cancelled = false
      return {
        cancel() {
          cancelled = true
        },
        get cancelled() {
          return cancelled
        }
      }
    },
    send: (s) => seen.push(s),
    ...over
  })
  svc.start()
  return { au, svc, seen }
}

test('a packaged build refuses a plain-http feed', () => {
  assert.throws(() => resolveFeed({ url: 'http://host:8088/stable', packaged: true }), /https/i)
})

test('a dev build may use http', () => {
  assert.equal(
    resolveFeed({ url: 'http://host:8088/stable', packaged: false }),
    'http://host:8088/stable'
  )
})

test('https is accepted when packaged', () => {
  assert.equal(
    resolveFeed({ url: 'https://u.example/stable', packaged: true }),
    'https://u.example/stable'
  )
})

test('no configured feed resolves to null, not an error', () => {
  assert.equal(resolveFeed({ url: undefined, packaged: true }), null)
  assert.equal(resolveFeed({ url: '', packaged: false }), null)
})

test('a feed that is not a url at all is refused', () => {
  assert.throws(() => resolveFeed({ url: 'not a url', packaged: false }))
})

test('an unsigned mac build cannot install in place', () => {
  assert.equal(canInstallInPlace({ platform: 'darwin', signed: false }), false)
  assert.equal(canInstallInPlace({ platform: 'darwin', signed: true }), true)
  assert.equal(canInstallInPlace({ platform: 'linux', signed: false }), true)
  assert.equal(canInstallInPlace({ platform: 'win32', signed: false }), true)
})

test('errors are phrased for a reader, and never blank', () => {
  assert.match(describeUpdateError(new Error('getaddrinfo ENOTFOUND u.example')), /reach/i)
  assert.match(describeUpdateError(new Error('connect ECONNREFUSED 1.2.3.4:8088')), /reach/i)
  assert.match(describeUpdateError(new Error('sha512 checksum mismatch')), /download/i)
  assert.ok(describeUpdateError(new Error('')).length > 0)
  assert.ok(describeUpdateError(undefined).length > 0)
})

test('an unconfigured build never checks, and says so', async () => {
  const { svc, au } = service({ feedUrl: undefined })
  assert.equal(svc.getState().configured, false)
  await svc.check()
  assert.equal(svc.getState().phase, 'idle')
  assert.equal(au.feed, null)
})

test('a feed refused at construction surfaces as an error, not a crash', () => {
  const { svc } = service({ feedUrl: 'http://host/stable', packaged: true })
  assert.equal(svc.getState().phase, 'error')
  assert.equal(svc.getState().configured, false)
  // Phrased for a reader, not the internal refusal text.
  assert.match(svc.getState().error ?? '', /not secure/i)
})

test('start disarms electron-updater’s own automation', () => {
  const { au } = service()
  assert.equal(au.autoDownload, false)
  assert.equal(au.autoInstallOnAppQuit, false)
})

test('available then downloading then ready', async () => {
  const { au, svc } = service()
  au.emit('checking-for-update')
  assert.equal(svc.getState().phase, 'checking')

  au.emit('update-available', { version: '0.2.0', releaseNotes: 'nice', releaseDate: '2026-07-30' })
  assert.equal(svc.getState().phase, 'available')
  assert.equal(svc.getState().newVersion, '0.2.0')
  assert.equal(svc.getState().releaseNotes, 'nice')
  assert.ok(svc.getState().checkedAt)

  await svc.download()
  au.emit('download-progress', { percent: 42.5, bytesPerSecond: 1000 })
  assert.equal(svc.getState().phase, 'downloading')
  assert.equal(svc.getState().percent, 42.5)

  au.emit('update-downloaded', { version: '0.2.0', downloadedFile: '/tmp/x.AppImage' })
  assert.equal(svc.getState().phase, 'ready')
  assert.equal(svc.getState().percent, 100)
})

test('an unsigned mac build lands on ready-manual, not ready', () => {
  const { au, svc } = service({ platform: 'darwin', signed: false })
  au.emit('update-available', { version: '0.2.0' })
  au.emit('update-downloaded', { version: '0.2.0', downloadedFile: '/tmp/x.dmg' })
  assert.equal(svc.getState().phase, 'ready-manual')
  assert.equal(svc.getState().file, '/tmp/x.dmg')
})

test('install only fires from ready', () => {
  const { au, svc } = service()
  au.emit('update-available', { version: '0.2.0' })
  svc.install()
  assert.equal(au.installed, false)
  au.emit('update-downloaded', { version: '0.2.0' })
  svc.install()
  assert.equal(au.installed, true)
})

test('a cancelled download really stops, and returns to the offer', async () => {
  const { au, svc } = service()
  au.emit('update-available', { version: '0.2.0' })
  const started = svc.download()
  au.emit('download-progress', { percent: 10, bytesPerSecond: 1 })
  svc.cancelDownload()
  assert.equal(svc.getState().phase, 'available')
  assert.equal(svc.getState().percent, null)
  // The transfer is interrupted, not merely ignored: leaving it running means a
  // second Download resolves instantly against the finished file, emitting no
  // events, and the card sits at 0% forever.
  assert.equal(au.lastToken?.cancelled, true)

  // Late events from the abandoned transfer must not drag the card back.
  au.emit('download-progress', { percent: 90, bytesPerSecond: 1 })
  au.emit('update-downloaded', { version: '0.2.0' })
  assert.equal(svc.getState().phase, 'available')
  await started
})

test('download refuses when there is no version to fetch', async () => {
  const { au, svc } = service()
  au.checkError = new Error('connect ECONNREFUSED 1.2.3.4:8088')
  await svc.check()
  assert.equal(svc.getState().phase, 'error')
  await svc.download()
  // Offering a download after a failed CHECK would flip error → downloading →
  // error, since there is nothing named to download.
  assert.equal(svc.getState().phase, 'error')
})

test('a build carrying its own feed config is not re-pointed', () => {
  const { au } = service({ applyFeedUrl: false })
  assert.equal(au.feed, null)
})

test('up to date is a distinct phase from never having asked', () => {
  const { au, svc } = service()
  assert.equal(svc.getState().phase, 'idle')
  au.emit('update-not-available', { version: '0.1.0' })
  assert.equal(svc.getState().phase, 'uptodate')
  assert.ok(svc.getState().checkedAt)
})

test('every transition is pushed to the renderer', () => {
  const { au, seen } = service()
  au.emit('checking-for-update')
  au.emit('update-not-available', {})
  assert.deepEqual(
    seen.map((s) => s.phase),
    ['checking', 'uptodate']
  )
})

test('an error carries a sentence, and clears the progress', async () => {
  const { au, svc } = service()
  au.emit('update-available', { version: '0.2.0' })
  // A download that fails while it is genuinely in flight, as the library
  // reports it: progress, then an error, before the promise settles.
  au.downloadUpdate = (() =>
    new Promise<null>((_res, rej) => {
      setTimeout(() => {
        au.emit('download-progress', { percent: 30, bytesPerSecond: 5 })
        const err = new Error('connect ECONNREFUSED 1.2.3.4:8088')
        au.emit('error', err)
        rej(err)
      }, 0)
    })) as never
  await svc.download()
  assert.equal(svc.getState().phase, 'error')
  assert.equal(svc.getState().percent, null)
  assert.match(svc.getState().error ?? '', /reach/i)
  assert.equal(svc.getState().failed, 'download')
})

test('a cancelled attempt cannot fail the download that replaced it', async () => {
  const { au, svc } = service()
  au.emit('update-available', { version: '0.2.0' })

  // First attempt: hold its rejection until after a retry has started.
  let rejectFirst: (e: Error) => void = () => undefined
  let call = 0
  au.downloadUpdate = function (this: typeof au, token?: never) {
    this.lastToken = (token as never) ?? null
    call++
    if (call === 1) return new Promise((_res, rej) => (rejectFirst = rej))
    return Promise.resolve(null)
  } as never

  const first = svc.download()
  svc.cancelDownload()
  const second = svc.download()
  assert.equal(svc.getState().phase, 'downloading')

  // The abandoned attempt now fails. It must not touch the live one.
  rejectFirst(new Error('connect ECONNREFUSED 1.2.3.4:8088'))
  await Promise.allSettled([first, second])
  assert.notEqual(svc.getState().phase, 'error')
})

test('a progress report with no percentage does not blank the bar', () => {
  const { au, svc } = service()
  au.emit('update-available', { version: '0.2.0' })
  au.emit('download-progress', { percent: undefined, bytesPerSecond: 1 })
  // NaN reaches the DOM as `width: NaN%`, which renders nothing at all.
  assert.equal(Number.isFinite(svc.getState().percent), true)
})

test('a failed check is not reported as a failed download', async () => {
  const { au, svc } = service()
  // An earlier check found a version...
  au.emit('update-available', { version: '0.2.0' })
  assert.equal(svc.getState().newVersion, '0.2.0')

  // ...and a LATER check fails on the network. No download was ever attempted,
  // so nothing here may say one failed.
  au.checkError = new Error('connect ECONNREFUSED 1.2.3.4:8088')
  await svc.check()
  assert.equal(svc.getState().failed, 'check')
  assert.equal(svc.getState().phase, 'error')
})

test('a failed download says so', async () => {
  const { au, svc } = service()
  au.emit('update-available', { version: '0.2.0' })
  au.downloadUpdate = async () => {
    throw new Error('connect ECONNREFUSED 1.2.3.4:8088')
  }
  await svc.download()
  assert.equal(svc.getState().failed, 'download')
  assert.equal(svc.getState().newVersion, '0.2.0')
})

test('a refused feed is reported as a load failure, not a missing one', () => {
  const { svc } = service({ feedUrl: 'http://host/stable', packaged: true })
  assert.equal(svc.getState().failed, 'load')
  assert.equal(svc.getState().configured, false)
})

test('a failed check does not throw away a downloaded update', async () => {
  const { au, svc } = service()
  au.emit('update-available', { version: '0.2.0' })
  await svc.download()
  au.emit('update-downloaded', { version: '0.2.0', downloadedFile: '/tmp/x.AppImage' })
  assert.equal(svc.getState().phase, 'ready')

  // The user presses Check while the network is down. The installer is already
  // on disk and verified; losing `ready` would take the Install button with it
  // and leave the file unreachable.
  au.checkError = new Error('connect ECONNREFUSED 1.2.3.4:8088')
  await svc.check()
  assert.equal(svc.getState().phase, 'ready')
  assert.equal(svc.getState().newVersion, '0.2.0')
  assert.equal(svc.getState().failed, 'check')
  assert.equal(svc.install(), true)
})

test('a cancelled transfer’s own failure is not reported', async () => {
  const { au, svc } = service()
  au.emit('update-available', { version: '0.2.0' })
  const started = svc.download()
  svc.cancelDownload()
  // Aborting the socket surfaces here as ECONNRESET; electron-updater only
  // suppresses its own CancellationError.
  au.emit('error', new Error('socket hang up ECONNRESET'))
  assert.equal(svc.getState().phase, 'available')
  assert.equal(svc.getState().failed, null)
  await started
})

test('cancelling then checking does not report the abandoned transfer', async () => {
  const { au, svc } = service()
  au.emit('update-available', { version: '0.2.0' })
  const started = svc.download()
  svc.cancelDownload()
  // `check()` resets `cancelled`, so a marker the next operation clears is not
  // enough: the abandoned socket's ECONNRESET arrives after that reset.
  await svc.check()
  au.emit('error', new Error('socket hang up ECONNRESET'))
  assert.notEqual(svc.getState().failed, 'check')
  assert.equal(svc.getState().error, null)
  await started
})

test('a failed check does not claim to have checked', async () => {
  const { au, svc } = service()
  au.emit('update-not-available', { version: '0.1.0' })
  const stamped = svc.getState().checkedAt
  assert.ok(stamped)
  await new Promise((r) => setTimeout(r, 5))
  au.checkError = new Error('connect ECONNREFUSED 1.2.3.4:8088')
  await svc.check()
  // "checked N minutes ago" asserts a check that SUCCEEDED.
  assert.equal(svc.getState().checkedAt, stamped)
})

test('a check is refused while a download is running', async () => {
  const { au, svc } = service()
  au.emit('update-available', { version: '0.2.0' })
  // A download that stays in flight, so `check()` really does overlap it.
  let finish: () => void = () => undefined
  au.downloadUpdate = (() =>
    new Promise<null>((res) => {
      finish = () => res(null)
    })) as never
  const started = svc.download()
  au.emit('download-progress', { percent: 40, bytesPerSecond: 1 })

  await svc.check()
  // Without the guard, `checking-for-update` replaces the phase and the bar
  // vanishes while the bytes keep arriving.
  assert.equal(svc.getState().phase, 'downloading')
  assert.equal(svc.getState().percent, 40)
  finish()
  await started
})

test('a successful check does not throw away a downloaded update', async () => {
  const { au, svc } = service()
  au.emit('update-available', { version: '0.2.0' })
  await svc.download()
  au.emit('update-downloaded', { version: '0.2.0', downloadedFile: '/tmp/x.AppImage' })
  assert.equal(svc.getState().phase, 'ready')

  // The check succeeds and re-confirms the SAME release. Moving to `available`
  // would offer to download a file already on disk, and take Install away.
  await svc.check()
  au.emit('update-available', { version: '0.2.0' })
  assert.equal(svc.getState().phase, 'ready')
  assert.equal(svc.install(), true)
})

test('a check reporting no update leaves a downloaded one installable', async () => {
  const { au, svc } = service()
  au.emit('update-available', { version: '0.2.0' })
  await svc.download()
  au.emit('update-downloaded', { version: '0.2.0', downloadedFile: '/tmp/x.AppImage' })
  await svc.check()
  au.emit('update-not-available', { version: '0.1.0' })
  // "Up to date" would be true of the RUNNING version and useless to someone
  // holding the next one.
  assert.equal(svc.getState().phase, 'ready')
})

test('an abandoned transfer cannot error the download that replaced it', async () => {
  const { au, svc } = service()
  au.emit('update-available', { version: '0.2.0' })

  let failFirst: (e: Error) => void = () => undefined
  let call = 0
  au.downloadUpdate = ((token?: never) => {
    au.lastToken = (token as never) ?? null
    call++
    if (call === 1) {
      return new Promise<null>((_res, rej) => {
        failFirst = (e) => {
          au.emit('error', e)
          rej(e)
        }
      })
    }
    return new Promise<null>(() => undefined)
  }) as never

  const first = svc.download()
  svc.cancelDownload()
  const second = svc.download()
  assert.equal(svc.getState().phase, 'downloading')

  // The abandoned transfer's socket finally gives up. It must not touch the
  // download now running.
  failFirst(new Error('socket hang up ECONNRESET'))
  await Promise.allSettled([first])
  assert.equal(svc.getState().phase, 'downloading')
  assert.equal(svc.getState().failed, null)
  void second
})

test('a genuine check failure after a cancel is still reported', async () => {
  const { au, svc } = service()
  au.emit('update-available', { version: '0.2.0' })
  const started = svc.download()
  svc.cancelDownload()
  // The abandoned marker must not swallow a LATER failure that belongs to the
  // check the user then ran.
  au.checkError = new Error('connect ECONNREFUSED 1.2.3.4:8088')
  await svc.check()
  assert.equal(svc.getState().failed, 'check')
  assert.equal(svc.getState().phase, 'error')
  await Promise.allSettled([started])
})

test('an install that silently fails to start is reported', async () => {
  const { au, svc } = service({ installGraceMs: 20 })
  au.emit('update-available', { version: '0.2.0' })
  await svc.download()
  au.emit('update-downloaded', { version: '0.2.0', downloadedFile: '/tmp/x.AppImage' })
  assert.equal(svc.getState().phase, 'ready')

  // The silent shape: a second press takes an early branch that logs a warning,
  // dispatches NOTHING and returns. The return value is unusable -- the real
  // quitAndInstall is typed void and returns nothing either way -- so the only
  // signal is that the app is still here.
  au.quitAndInstall = (() => undefined) as never
  assert.equal(svc.install(), true)
  assert.equal(svc.getState().phase, 'ready')

  await new Promise((r) => setTimeout(r, 60))
  assert.equal(svc.getState().phase, 'error')
  assert.equal(svc.getState().failed, 'install')
  assert.ok(svc.getState().error)
})

test('an install that dispatches an error is reported at once', async () => {
  const { au, svc } = service({ installGraceMs: 10_000 })
  au.emit('update-available', { version: '0.2.0' })
  await svc.download()
  au.emit('update-downloaded', { version: '0.2.0', downloadedFile: '/tmp/x.AppImage' })

  // The common shape: the cache cleared between download and press.
  au.quitAndInstall = function (this: typeof au) {
    this.emit('error', new Error("No update filepath provided, can't quit and install"))
  } as never
  svc.install()
  // Without waiting for the grace period: the listener records it, which it can
  // only do if `install` is in flight when the error is dispatched.
  assert.equal(svc.getState().phase, 'error')
  assert.equal(svc.getState().failed, 'install')
  assert.match(svc.getState().error ?? '', /filepath/i)
})

test('an install that starts is not reported as a failure', async () => {
  const { au, svc } = service({ installGraceMs: 20 })
  au.emit('update-available', { version: '0.2.0' })
  await svc.download()
  au.emit('update-downloaded', { version: '0.2.0', downloadedFile: '/tmp/x.AppImage' })
  // Older versions return nothing at all; treating that as a refusal would
  // report every successful install as broken in the moment before the app goes.
  // On a real install the process is quitting before the grace period is up, so
  // the timer never fires. `stop()` stands in for that: whatever the service
  // has scheduled must not outlive it and accuse a successful install.
  assert.equal(svc.install(), true)
  svc.stop()
  await new Promise((r) => setTimeout(r, 60))
  assert.notEqual(svc.getState().failed, 'install')
})

test('a successful install waiting at the quit guard is not accused', async () => {
  let quitting = false
  const { au, svc } = service({ installGraceMs: 20, isQuitting: () => quitting })
  au.emit('update-available', { version: '0.2.0' })
  await svc.download()
  au.emit('update-downloaded', { version: '0.2.0', downloadedFile: '/tmp/x.AppImage' })

  // The install SUCCEEDED -- on AppImage the new binary is already in place --
  // and the app is now sitting at this app's own "work in progress" prompt,
  // which is unbounded. Blaming it would be both wrong and unrecoverable, since
  // electron-updater refuses to install twice.
  au.quitAndInstall = (() => {
    quitting = true
  }) as never
  svc.install()

  await new Promise((r) => setTimeout(r, 60))
  assert.equal(svc.getState().phase, 'ready')
  assert.notEqual(svc.getState().failed, 'install')
})

test('an install failure dispatched asynchronously is still reported', async () => {
  const { au, svc } = service({ installGraceMs: 200 })
  au.emit('update-available', { version: '0.2.0' })
  await svc.download()
  au.emit('update-downloaded', { version: '0.2.0', downloadedFile: '/tmp/x.AppImage' })

  // Windows and macOS dispatch theirs from a promise that settles AFTER
  // quitAndInstall has returned, so clearing the in-flight marker synchronously
  // threw the real reason away and left a generic sentence in its place.
  au.quitAndInstall = function (this: typeof au) {
    setTimeout(() => this.emit('error', new Error('spawn failed: EACCES')), 10)
  } as never
  svc.install()

  await new Promise((r) => setTimeout(r, 60))
  assert.equal(svc.getState().failed, 'install')
  assert.ok(svc.getState().error)
})

test('a late install failure during the quit prompt is still reported', async () => {
  let quitting = false
  const { au, svc } = service({ installGraceMs: 20, isQuitting: () => quitting })
  au.emit('update-available', { version: '0.2.0' })
  await svc.download()
  au.emit('update-downloaded', { version: '0.2.0', downloadedFile: '/tmp/x.AppImage' })

  // The quit begins, so the deadline stands down -- and THEN the install fails,
  // the way a declined elevation does, from a promise settling much later.
  au.quitAndInstall = (() => {
    quitting = true
  }) as never
  svc.install()
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(svc.getState().phase, 'ready')

  au.emit('error', new Error('spawn failed: EACCES'))
  assert.equal(svc.getState().failed, 'install')
  assert.equal(svc.getState().phase, 'error')
})

test('a check pressed while an install is pending does not steal its failure', async () => {
  let quitting = false
  const { au, svc } = service({ installGraceMs: 20, isQuitting: () => quitting })
  au.emit('update-available', { version: '0.2.0' })
  await svc.download()
  au.emit('update-downloaded', { version: '0.2.0', downloadedFile: '/tmp/x.AppImage' })
  au.quitAndInstall = (() => {
    quitting = true
  }) as never
  svc.install()

  // The Check button is rendered in `ready`, so this is reachable while the
  // quit prompt is up. Sharing one slot reported the install's own failure as
  // "Check failed" and left the phase at ready.
  await svc.check()
  au.emit('error', new Error('spawn failed: EACCES'))
  assert.equal(svc.getState().failed, 'install')
})

test('cancelling the quit ends the install, and frees the card', async () => {
  let quitting = false
  const { au, svc, seen } = service({ installGraceMs: 20, isQuitting: () => quitting })
  au.emit('update-available', { version: '0.2.0' })
  await svc.download()
  au.emit('update-downloaded', { version: '0.2.0', downloadedFile: '/tmp/x.AppImage' })

  au.quitAndInstall = (() => {
    quitting = true
  }) as never
  svc.install()
  await new Promise((r) => setTimeout(r, 60))
  // The deadline stood down for the quit, so nothing has been decided yet.
  assert.equal(svc.getState().phase, 'ready')

  // The user cancels at the "work in progress" prompt. No error will ever
  // arrive, so without this the flag stayed set for the session: the button
  // stuck on "Restarting…" with no push coming to release it.
  const before = seen.length
  quitting = false
  svc.quitCancelled()
  // The PHASE is kept: nothing failed, the user declined to close, and the
  // installer is still on disk. Dropping to `error` would strand it behind a
  // re-download, which is the rule this service keeps for a failed check too.
  assert.equal(svc.getState().phase, 'ready')
  assert.ok(svc.getState().error, 'the reader was told nothing')
  assert.ok(seen.length > before, 'the renderer was never told')
  // And the installer is still offered -- pressing Install clears the sentence
  // about the previous attempt rather than leaving it under the new one.
  assert.equal(svc.install(), true, 'the installer was stranded')
  assert.equal(svc.getState().error, null)
})

test('a cancelled quit does not leave the next failure mis-attributed', async () => {
  let quitting = false
  const { au, svc } = service({ installGraceMs: 20, isQuitting: () => quitting })
  au.emit('update-available', { version: '0.2.0' })
  await svc.download()
  au.emit('update-downloaded', { version: '0.2.0', downloadedFile: '/tmp/x.AppImage' })
  au.quitAndInstall = (() => {
    quitting = true
  }) as never
  svc.install()
  await new Promise((r) => setTimeout(r, 60))
  quitting = false
  svc.quitCancelled()

  // A later, unrelated check failure belongs to the CHECK. Left pending, the
  // install branch stole it and rendered network wording as "Install failed".
  au.checkError = new Error('connect ECONNREFUSED 1.2.3.4:8088')
  await svc.check()
  assert.equal(svc.getState().failed, 'check')
})

test('an install that throws synchronously does not orphan the pending flag', async () => {
  const { au, svc } = service({ installGraceMs: 20 })
  au.emit('update-available', { version: '0.2.0' })
  await svc.download()
  au.emit('update-downloaded', { version: '0.2.0', downloadedFile: '/tmp/x.AppImage' })

  au.quitAndInstall = (() => {
    throw new Error('spawn ENOENT')
  }) as never
  assert.equal(svc.install(), false)
  assert.equal(svc.getState().failed, 'install')

  // The flag must not be left set with no deadline to resolve it: a later,
  // unrelated failure would otherwise be reported as an install failure.
  au.checkError = new Error('connect ECONNREFUSED 1.2.3.4:8088')
  await svc.check()
  assert.equal(svc.getState().failed, 'check')
})

/**
 * A download whose bytes are checked, and the fallback that makes patching
 * safe to leave switched on.
 *
 * These exist because the app was actually corrupted this way: a differential
 * download produced an AppImage of exactly the right LENGTH with the wrong
 * CONTENT, and it was written over the working install. The library's own
 * sha512 check happens BEFORE the patch is applied, so it did not catch it.
 */
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

/**
 * A fake whose downloads land REAL bytes on disk, so the digest is computed
 * over a real file rather than mocked away — the check is the thing under test.
 *
 * `attempts` records whether each attempt was a patch or a whole download,
 * which is the assertion the fallback turns on.
 */
function downloadingService(opts: { patchIsBad: boolean; wholeIsBad: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), 'updater-dl-'))
  const good = Buffer.from('the artifact the server published')
  const sha512 = createHash('sha512').update(good).digest('base64')
  const attempts: ('patch' | 'whole')[] = []
  const au = fakeUpdater() as ReturnType<typeof fakeUpdater> & {
    disableDifferentialDownload?: boolean
  }
  au.downloadUpdate = async function () {
    const differential = this.disableDifferentialDownload !== true
    attempts.push(differential ? 'patch' : 'whole')
    const corrupt = differential ? opts.patchIsBad : opts.wholeIsBad
    const file = join(dir, `App-${attempts.length}.AppImage`)
    writeFileSync(file, corrupt ? Buffer.from('not the artifact') : good)
    this.emit('update-downloaded', { version: '9.9.9', downloadedFile: file, sha512 })
    return null
  } as never
  const svc = new UpdaterService({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    autoUpdater: au as any,
    currentVersion: '0.1.0',
    packaged: false,
    platform: 'linux',
    signed: false,
    feedUrl: 'http://127.0.0.1:8088/stable',
    autoCheckDelayMs: 0,
    send: () => {}
  })
  svc.start()
  return { au, svc, attempts, dir }
}

test('a patched download that fails its digest is retried WHOLE, and installs', async () => {
  const { au, svc, attempts } = downloadingService({ patchIsBad: true, wholeIsBad: false })
  au.emit('update-available', { version: '9.9.9' })
  await svc.download()

  // The saving is kept for the attempt that works and abandoned for the one
  // that does not — the patch is an optimisation nobody asked for, so its
  // failure is not a decision to put in front of the user.
  assert.deepEqual(attempts, ['patch', 'whole'])
  assert.equal(svc.getState().phase, 'ready')
  assert.equal(svc.getState().error, null)
})

test('a whole download that also fails the digest stops, rather than looping', async () => {
  const { au, svc, attempts, dir } = downloadingService({ patchIsBad: true, wholeIsBad: true })
  au.emit('update-available', { version: '9.9.9' })
  await svc.download()

  assert.deepEqual(attempts, ['patch', 'whole'])
  assert.equal(svc.getState().phase, 'error')
  assert.equal(svc.getState().failed, 'download')
  // DELETED, not merely rejected: a cached artifact for this version would be
  // offered again without re-downloading, handing over the same bad bytes.
  assert.equal(existsSync(join(dir, 'App-2.AppImage')), false)
})

test('a good patch is installed as it is, with no second download', async () => {
  const { au, svc, attempts } = downloadingService({ patchIsBad: false, wholeIsBad: false })
  au.emit('update-available', { version: '9.9.9' })
  await svc.download()

  assert.deepEqual(attempts, ['patch'])
  assert.equal(svc.getState().phase, 'ready')
})

test('a manifest carrying no digest still installs', async () => {
  // An older manifest may not name a hash for this file. Refusing to install
  // what was asked for, on the grounds that it cannot be checked, would break
  // updating for a build that never promised one.
  const { au, svc } = service()
  au.emit('update-available', { version: '0.2.0' })
  await svc.download()
  au.emit('update-downloaded', { version: '0.2.0', downloadedFile: '/tmp/x.AppImage' })
  assert.equal(svc.getState().phase, 'ready')
})
