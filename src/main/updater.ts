import { createHash } from 'node:crypto'
import { createReadStream, rmSync } from 'node:fs'
import type { UpdateStateDTO } from '../shared/contract'

/**
 * Whether the file on disk is the artifact the manifest described.
 *
 * STREAMED, never read whole: a release is ~200 MB and this runs in the main
 * process, so `readFileSync` would hold the entire installer in memory and stop
 * the UI for as long as it took.
 *
 * The digest is base64 sha512, which is what electron-builder writes into
 * `latest*.yml` and what electron-updater hands back on the event. Compared
 * case-sensitively after trimming: base64 is case-significant, so a
 * lower-cased comparison would accept a file that does not match.
 *
 * Resolves false for a mismatch and REJECTS if the file cannot be read — the
 * two need different sentences, because "wrong bytes" and "no bytes" are
 * different problems for whoever has to fix them.
 */
async function verifyDownload(file: string, expectedBase64: string): Promise<boolean> {
  const actual = await new Promise<string>((resolve, reject) => {
    const hash = createHash('sha512')
    const stream = createReadStream(file)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('base64')))
  })
  return actual.trim() === expectedBase64.trim()
}

/**
 * Decide the feed URL, refusing an unsafe one outright.
 *
 * The URL is baked into the artifact at build time, so the packaged app is the
 * LAST place able to notice that a release was pointed at plain http — and the
 * consequence of not noticing is that the app downloads and runs an installer
 * fetched over a link anyone on the path can rewrite. electron-updater does
 * verify the sha512 from the manifest, but the manifest came down the same
 * rewritable channel, so that check proves only self-consistency.
 *
 * Development is exempt because there is no TLS on the service yet and a
 * developer pointing at their own box is not the threat.
 */
export function resolveFeed(opts: { url: string | undefined; packaged: boolean }): string | null {
  if (!opts.url) return null
  let parsed: URL
  try {
    parsed = new URL(opts.url)
  } catch {
    throw new Error(`the update feed is not a URL: ${opts.url}`)
  }
  if (opts.packaged && parsed.protocol !== 'https:') {
    throw new Error(
      `refusing the update feed ${opts.url}: a released build must fetch updates over https`
    )
  }
  return opts.url
}

/**
 * Whether this build can replace itself.
 *
 * An unsigned macOS app cannot: Squirrel.Mac requires a valid signature to swap
 * the bundle, and it fails at the very end, after the whole download. Better to
 * know before offering the button than to spend the user's bandwidth on a
 * promise that cannot be kept.
 */
export function canInstallInPlace(opts: { platform: NodeJS.Platform | string; signed: boolean }): boolean {
  if (opts.platform === 'darwin') return opts.signed
  return true
}

/** Turn whatever electron-updater threw into a sentence, never a blank card. */
export function describeUpdateError(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|ECONNRESET/i.test(raw)) {
    return 'Could not reach the update server.'
  }
  if (/checksum|sha512|hash/i.test(raw)) {
    return 'The download did not match what the server said it should be, so it was discarded.'
  }
  if (/404|not found/i.test(raw)) {
    return 'The update server has no release for this platform.'
  }
  if (/certificate|self.signed|SSL|TLS/i.test(raw)) {
    return 'The update server’s certificate was not accepted.'
  }
  if (/did not load/i.test(raw)) {
    return 'This build could not start its updater, so it cannot check for new versions.'
  }
  if (/https/i.test(raw) && /refus/i.test(raw)) {
    return 'This build points at an update server it will not use, because the address is not secure. It cannot check for updates.'
  }
  return raw.trim() || 'The update check failed for an unknown reason.'
}

/** What a download can be interrupted with. */
export interface CancelTokenLike {
  cancel(): void
  readonly cancelled: boolean
}

/** The minimum of electron-updater this service uses, so the tests need no Electron. */
interface AutoUpdaterLike {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  /**
   * Whether to fetch the WHOLE artifact rather than patch the installed one.
   *
   * See `start()` for why this is always true here. Optional on the interface
   * only because the test doubles predate it; the real `autoUpdater` has it.
   */
  disableDifferentialDownload?: boolean
  setFeedURL(options: { provider: 'generic'; url: string; channel?: string | null }): void
  checkForUpdates(): Promise<unknown>
  downloadUpdate(token?: CancelTokenLike): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): boolean | void
  on(event: string, cb: (...args: never[]) => void): unknown
}

export interface UpdaterDeps {
  autoUpdater: AutoUpdaterLike
  currentVersion: string
  packaged: boolean
  platform: NodeJS.Platform | string
  signed: boolean
  feedUrl: string | undefined
  channel?: string
  /**
   * The build's update configuration is BROKEN, as opposed to absent.
   *
   * Kept apart from `feedUrl: undefined` because the two say opposite things.
   * No feed is a deliberate build choice and "no update server is configured"
   * describes it exactly. A file that exists and cannot be read is a fault, and
   * reported as the deliberate choice it left the user certain that updates
   * were switched off on purpose while the app quietly never checked again.
   */
  feedUnreadable?: boolean
  /** Where to push state. Absent in the verifier, which polls instead. */
  send?: (state: UpdateStateDTO) => void
  /** Delay before the one automatic check. Zero disables it. */
  autoCheckDelayMs?: number
  /** Whether to call setFeedURL. False when the build already carries the config. */
  applyFeedUrl?: boolean
  /** How long to wait for the app to quit before calling an install failed. */
  installGraceMs?: number
  /**
   * Whether a quit is already under way.
   *
   * Consulted before blaming an install for not starting: this app guards its
   * own `before-quit`, so a successful install can wait at that prompt far
   * longer than any deadline worth setting.
   */
  isQuitting?: () => boolean
  /** Makes the token that can interrupt a download. Absent in tests without one. */
  makeCancelToken?: () => CancelTokenLike
}

/**
 * The whole update lifecycle, as one observable state.
 *
 * The renderer never talks to electron-updater and never derives a phase of its
 * own: it renders exactly what this holds. A second copy of "are we downloading"
 * in the UI is how a cancelled download leaves a progress bar spinning forever.
 */
export class UpdaterService {
  private state: UpdateStateDTO
  private timer: NodeJS.Timeout | null = null
  /** Fires only if the app is still running after an install was asked for. */
  private installTimer: NodeJS.Timeout | null = null
  private cancelled = false
  /**
   * What this service is CURRENTLY waiting on, if anything.
   *
   * The error listener attributes a failure to this rather than inferring it,
   * because inference kept getting it wrong: a cancelled transfer's late
   * ECONNRESET was reported as a failed check (the cancel flag having been
   * reset by that check), and a retry could be errored by the attempt it
   * replaced. If nothing is in flight, a late failure belongs to something
   * abandoned and is not news.
   */
  private inFlight: 'check' | 'download' | null = null
  /**
   * An install that has been asked for and has not yet been accounted for.
   *
   * SEPARATE from `inFlight`, which holds one slot for the operation the user
   * is waiting on. An install outlives those: it stays pending across the quit
   * guard's prompt, and a check pressed in that window would otherwise
   * overwrite it -- reporting a later install failure as "Check failed", and
   * cancelling the install's own deadline on the way past.
   */
  private installPending = false
  private token: CancelTokenLike | null = null
  /**
   * Whether the differential path has already been tried for the update in hand.
   *
   * Set when a patched download fails its digest, and what makes the retry a
   * WHOLE-file fetch rather than the same patch again. Cleared whenever a new
   * download starts from scratch, so a later release still gets the cheap path
   * — one bad patch must not disable patching for good.
   */
  private differentialAttempted = false
  /**
   * Settles when the digest check for the download in hand has finished.
   *
   * `download()` AWAITS this before returning, so its promise means "there is a
   * verified installer, or an error explaining why there is not" — not merely
   * "the bytes arrived". Without it the method resolved while the file was
   * still unverified, and every caller that reads the state immediately
   * afterwards (the real-service verifier does exactly that) saw `downloading`
   * and a null error for a download that had in fact finished.
   */
  private verifying: Promise<void> | null = null

  constructor(private readonly deps: UpdaterDeps) {
    let configured = false
    let initialError: string | null = null
    if (deps.feedUnreadable) {
      // NOT `configured: false`, which the panel renders as "this build has no
      // update server configured" — a statement about how the app was built,
      // and a reassuring one. The truth is that the app cannot tell where to
      // look, which is a fault with a remedy. Phrased here, naming no path:
      // `resourcesPath` sits inside the install directory.
      initialError =
        'This app’s update settings could not be read, so it cannot check for new versions. '
        + 'Reinstalling Corpus Studio will restore them.'
    } else {
      try {
        configured = resolveFeed({ url: deps.feedUrl, packaged: deps.packaged }) !== null
      } catch (err) {
        initialError = describeUpdateError(err)
      }
    }
    this.state = {
      phase: initialError ? 'error' : 'idle',
      currentVersion: deps.currentVersion,
      newVersion: null,
      releaseNotes: null,
      releaseDate: null,
      percent: null,
      bytesPerSecond: null,
      file: null,
      error: initialError,
      failed: initialError ? 'load' : null,
      configured,
      checkedAt: null
    }
  }

  /** Whether an installer has been downloaded and is waiting to be run. */
  private holdsDownloadedUpdate(): boolean {
    return this.state.phase === 'ready' || this.state.phase === 'ready-manual'
  }

  getState(): UpdateStateDTO {
    return { ...this.state }
  }

  private set(patch: Partial<UpdateStateDTO>): UpdateStateDTO {
    this.state = { ...this.state, ...patch }
    this.deps.send?.(this.getState())
    return this.getState()
  }

  /** Wire the events and schedule the single automatic check. */
  start(): void {
    if (!this.state.configured) return
    const au = this.deps.autoUpdater
    au.autoDownload = false
    au.autoInstallOnAppQuit = false
    // PATCHING IS ALLOWED; SHIPPING AN UNVERIFIED PATCH IS NOT.
    //
    // electron-updater defaults to a DIFFERENTIAL download: it reads the
    // blockmap, keeps the blocks the installed copy already has and fetches
    // only the rest. That is worth keeping — a release is ~200 MB and most of
    // it is unchanged — but when it goes wrong it does not go wrong loudly. It
    // produces a file of exactly the right LENGTH with the wrong CONTENT and
    // writes it over the working install.
    //
    // It went wrong here. An install updated to 0.2.2 ended up with an AppImage
    // of precisely the declared 205,681,053 bytes whose sha512 did not match
    // the manifest: the ELF header pointed at section headers 36 MB past the
    // end of the file. The main process still started — it is the renderer that
    // is read from the truncated region — so the app booted, opened the
    // database, loaded its plugins and then silently never showed a window.
    // Nothing said "corrupt"; it simply stopped starting.
    //
    // So the patch is attempted, its result is CHECKED against the manifest
    // digest, and a mismatch falls back to the whole artifact (see
    // `update-downloaded`). The saving is kept for the case that works and
    // abandoned for the case that does not. The flag itself is set per-download
    // in `download()`, because it has to differ between the first attempt and
    // the retry that replaces it.
    if (this.deps.applyFeedUrl !== false) {
      au.setFeedURL({
        provider: 'generic',
        url: this.deps.feedUrl as string,
        channel: this.deps.channel ?? null
      })
    }

    au.on('checking-for-update', () => {
      // A downloaded update is NOT replaced by "checking". The installer is on
      // disk and ready to run; moving to `checking` takes the Install button
      // away for the duration and loses it entirely if the check then fails.
      // The stale error is still cleared, because a new attempt is underway.
      if (this.holdsDownloadedUpdate()) {
        this.set({ error: null, failed: null })
        return
      }
      this.set({ phase: 'checking', error: null, failed: null })
    })
    au.on('update-available', (info: never) => {
      const i = info as unknown as { version: string; releaseNotes?: string; releaseDate?: string }
      // A downloaded update is not replaced by a SUCCESSFUL check either. The
      // installer on disk is the same release this check just re-confirmed, so
      // moving to `available` would offer to download a file already there and
      // take the Install button away to do it.
      if (this.holdsDownloadedUpdate() && i.version === this.state.newVersion) {
        this.set({ checkedAt: Date.now(), error: null, failed: null })
        return
      }
      this.set({
        phase: 'available',
        newVersion: i.version,
        releaseNotes: typeof i.releaseNotes === 'string' ? i.releaseNotes : null,
        releaseDate: i.releaseDate ?? null,
        checkedAt: Date.now(),
        error: null,
        failed: null
      })
    })
    au.on('update-not-available', () => {
      // Likewise: an installer already downloaded stays installable. Reporting
      // "up to date" here would be true of the running version and useless to
      // someone holding the next one.
      if (this.holdsDownloadedUpdate()) {
        this.set({ checkedAt: Date.now(), error: null, failed: null })
        return
      }
      this.set({
        phase: 'uptodate',
        newVersion: null,
        releaseNotes: null,
        releaseDate: null,
        checkedAt: Date.now(),
        error: null,
        failed: null
      })
    })
    au.on('download-progress', (p: never) => {
      if (this.cancelled) return
      const prog = p as unknown as { percent: number; bytesPerSecond: number }
      this.set({
        phase: 'downloading',
        // Clamped AND checked: `Math.min(100, NaN)` is NaN, which reaches the
        // progress bar as `width: NaN%` and renders nothing at all.
        percent: Number.isFinite(prog.percent)
          ? Math.max(0, Math.min(100, prog.percent))
          : 0,
        bytesPerSecond: prog.bytesPerSecond
      })
    })
    au.on('update-downloaded', (info: never) => {
      if (this.cancelled) return
      const i = info as unknown as {
        version: string
        downloadedFile?: string
        sha512?: string
        files?: { url?: string; sha512?: string }[]
      }
      const inPlace = canInstallInPlace({ platform: this.deps.platform, signed: this.deps.signed })
      const ready = (): void => {
        // Whatever produced this file was good enough, so the NEXT release may
        // use the cheap path again. One bad patch is a bad patch, not a reason
        // to download everything whole for ever.
        this.differentialAttempted = false
        this.set({
          phase: inPlace ? 'ready' : 'ready-manual',
          newVersion: i.version,
          percent: 100,
          bytesPerSecond: null,
          file: i.downloadedFile ?? null
        })
      }

      // WHAT IS ON DISK IS CHECKED BEFORE IT MAY BE INSTALLED.
      //
      // Differential downloads are off (see above), which removes the way this
      // app was actually corrupted. This is the second lock on the same door,
      // and it is here because the failure it guards against is silent: a bad
      // artifact does not announce itself, it just replaces a working install
      // with one that no longer starts. A digest is cheap; that outcome is not.
      //
      // The expected value comes from the MANIFEST, which was fetched
      // separately from the artifact — a digest carried by the same bytes it
      // is meant to authenticate proves only internal consistency.
      const expected = i.sha512 ?? i.files?.find((f) => f.sha512)?.sha512 ?? null
      const file = i.downloadedFile ?? null
      if (!expected || !file) {
        // NOT a refusal. An older manifest may carry no digest for this file,
        // and refusing to install what was asked for on the grounds that it
        // cannot be checked would break updating for a build that never
        // promised one. The primary defence does not depend on this.
        ready()
        return
      }
      // Held at 100% rather than given a phase of its own: the DTO's phases are
      // a frozen contract the renderer switches on, and "verifying" would be a
      // new one for a step that takes about a second. The Install button
      // appears when the file is trustworthy, which is the only claim the phase
      // is making.
      this.verifying = verifyDownload(file, expected)
        .then((ok) => {
          if (this.cancelled) return
          if (ok) {
            ready()
            return
          }
          // The file is DELETED, not merely rejected. Left behind, the next
          // attempt finds a cached artifact for this version and can offer it
          // again without re-downloading — handing over the same corrupt bytes
          // a second time.
          rmSync(file, { force: true })

          // A PATCHED download that fails the digest is retried WHOLE, once,
          // without asking. The patch is an optimisation the user never chose,
          // so its failure is not a decision to put in front of them — and the
          // fallback is the very thing that makes patching safe to leave on.
          if (!this.differentialAttempted) {
            this.differentialAttempted = true
            this.set({
              phase: 'available',
              percent: null,
              bytesPerSecond: null,
              file: null,
              error: null,
              failed: null
            })
            // CLEARED FIRST. The retry runs `download()`, which waits on
            // `verifying` — and `verifying` is this very promise, which cannot
            // settle until the handler returns. Leaving it set deadlocks the
            // retry against its own predecessor. The loop in `download()` picks
            // up whatever the retry stores in its place.
            this.verifying = null
            void this.download()
            return
          }

          // The whole file failed too, so the patch was not the problem: the
          // server, the link or the disk is at fault. Nothing further to try
          // automatically.
          this.set({
            phase: 'error',
            failed: 'download',
            percent: null,
            bytesPerSecond: null,
            file: null,
            error:
              'The downloaded update did not match what the update server published, '
              + 'so it was discarded rather than installed. Try again later.'
          })
        })
        .catch(() => {
          // The digest could not be computed — the file vanished, or the disk
          // failed. Unverifiable is not the same as wrong, but it is not a file
          // to overwrite the application with either.
          if (this.cancelled) return
          this.set({
            phase: 'error',
            failed: 'download',
            percent: null,
            bytesPerSecond: null,
            file: null,
            error: 'The downloaded update could not be checked, so it was not installed. Try again.'
          })
        })
    })
    au.on('error', (err: never) => {
      // An ABANDONED transfer's own failure is not news. electron-updater
      // suppresses only its CancellationError, so an aborted socket still
      // arrives here as ECONNRESET — and since `cancelDownload` clears the
      // token first, it would be attributed to the CHECK and rendered as
      // "Check failed" over network wording.
      //
      // Keyed on a marker the next operation does NOT reset, unlike
      // `cancelled`: cancel, then press Check, and the late ECONNRESET arrived
      // after that reset and was reported as a failed check for a transfer the
      // user themselves stopped.
      // Nothing is waiting on this, so it is the tail of something abandoned --
      // a cancelled transfer's aborted socket arriving as ECONNRESET, which
      // electron-updater does dispatch because it is not its CancellationError.
      // An install outlives the operation slot, so it is asked about first: a
      // failure arriving while one is pending belongs to it, whatever else the
      // user has since pressed.
      if (this.installPending) {
        this.installPending = false
        if (this.installTimer) clearTimeout(this.installTimer)
        this.installTimer = null
        this.set({
          phase: 'error',
          failed: 'install',
          error: describeUpdateError(err)
        })
        return
      }
      if (this.inFlight === null) return
      // A DOWNLOAD failure is not decided here. The library emits a bare error
      // with nothing tying it to a transfer, so this listener cannot tell an
      // abandoned one's late socket failure from the retry that replaced it --
      // and guessing errored the live download. `download()`'s catch knows its
      // own token and settles it there.
      if (this.inFlight === 'download') return

      // THIS is where a failed check is decided, not in `check()`'s catch.
      // `checkForUpdates` emits 'error' BEFORE it rethrows, so by the time that
      // catch runs the phase has already been overwritten and any guard there
      // reads the value this listener just wrote.
      const failed = this.inFlight

      // A downloaded update survives a failed check. The installer is on disk
      // and verified; a network hiccup while asking whether something newer
      // exists must not take the Install button with it and leave a file
      // nothing can reach.
      if (failed === 'check' && this.holdsDownloadedUpdate()) {
        this.set({ error: describeUpdateError(err), failed })
        return
      }

      this.set({
        phase: 'error',
        percent: null,
        bytesPerSecond: null,
        error: describeUpdateError(err),
        failed
      })
    })

    const delay = this.deps.autoCheckDelayMs ?? 10_000
    if (delay > 0) {
      // Not at ready: the first seconds of a launch belong to the window opening
      // and the database migrating, and a check that loses that race for the
      // network is a check the user watches fail.
      this.timer = setTimeout(() => {
        void this.check()
      }, delay)
      this.timer.unref?.()
    }
  }

  /**
   * A quit that was asked for and then abandoned.
   *
   * The install is over: the app is still here, so it never started, and
   * nothing else is going to say so. Without this the pending flag stayed set
   * for the session -- the button stuck on "Restarting…" with no push coming to
   * release it, and the next unrelated failure reported as an install failure,
   * taking the Install button away from an installer still on disk.
   */
  quitCancelled(): void {
    if (!this.installPending) return
    this.installPending = false
    if (this.installTimer) clearTimeout(this.installTimer)
    this.installTimer = null
    if (!this.holdsDownloadedUpdate()) return
    // The PHASE is kept, so Install stays offered. Nothing failed here -- the
    // user declined to close the app -- and the installer is still on disk and
    // still runnable. Dropping to `error` would have stranded it behind a
    // re-download, which is the rule this file already keeps for a failed
    // check, for exactly the same reason.
    this.set({
      error: 'The app was not closed, so the update is still waiting to install.'
    })
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    // The install grace timer too: a service told to stop must leave nothing
    // scheduled that could later accuse a successful install of failing.
    if (this.installTimer) clearTimeout(this.installTimer)
    this.installTimer = null
    this.installPending = false
  }

  async check(): Promise<UpdateStateDTO> {
    if (!this.state.configured) return this.getState()
    // Never while bytes are arriving. `checking-for-update` would replace the
    // `downloading` phase and drop the progress bar mid-transfer, and a failure
    // would then be attributed to the download. The UI hides the button here,
    // but a second window or an IPC caller must not be able to do it either.
    if (this.state.phase === 'downloading') return this.getState()
    this.cancelled = false
    this.inFlight = 'check'
    try {
      await this.deps.autoUpdater.checkForUpdates()
    } catch (err) {
      // The 'error' LISTENER has already recorded this: electron-updater emits
      // it before rethrowing, so anything decided here would be a second, later
      // opinion about the same failure — and would read a phase that listener
      // just wrote. Only fill in what it cannot know.
      this.set({
        error: this.state.error ?? describeUpdateError(err),
        failed: this.state.failed ?? 'check'
      })
    } finally {
      this.inFlight = null
      // `checkedAt` is deliberately NOT stamped: it drives "checked N minutes
      // ago", which asserts a check that succeeded. Stamping it here made a
      // failed attempt read as a fresh, successful one.
    }
    return this.getState()
  }

  /**
   * Fetch the installer.
   *
   * Only from a phase that HAS something to fetch — `available`, or an `error`
   * that still names the version a previous check found, which is a retry. A
   * failed CHECK leaves no version, and offering a download there could only
   * fail again.
   */
  async download(): Promise<UpdateStateDTO> {
    const offered = this.state.phase === 'available' || this.state.phase === 'error'
    if (!offered || !this.state.newVersion) return this.getState()
    this.cancelled = false
    this.inFlight = 'download'
    const token = this.deps.makeCancelToken?.() ?? null
    this.token = token
    // PATCH FIRST, WHOLE FILE ON THE RETRY. Set per attempt rather than once at
    // `start()`, because the two attempts differ: the retry after a digest
    // mismatch must not repeat the patch that produced it. `retryWhole()` is
    // what sets the flag, and it is cleared as soon as a download settles
    // successfully so the next release is cheap again.
    this.deps.autoUpdater.disableDifferentialDownload = this.differentialAttempted
    this.set({ phase: 'downloading', percent: 0, bytesPerSecond: null, error: null, failed: null })
    try {
      await this.deps.autoUpdater.downloadUpdate(token ?? undefined)
    } catch (err) {
      // Only if this attempt is still the current one. `cancelled` is a single
      // flag that the NEXT download resets, so a cancel followed immediately by
      // a retry let the first attempt's rejection — arriving after the reset —
      // write an error over the second, still-running download.
      if (this.token === token && !this.cancelled) {
        this.set({ phase: 'error', percent: null, error: describeUpdateError(err), failed: 'download' })
      }
    } finally {
      // Only if it is still OURS. A cancel followed by an immediate retry means
      // this `finally` unwinds after the SECOND download has stored its token,
      // and clearing unconditionally would leave that one uncancellable — the
      // stop button would silently do nothing.
      if (this.token === token) {
        this.token = null
        if (this.inFlight === 'download') this.inFlight = null
      }
    }
    // The digest runs on the 'update-downloaded' event, which fires DURING the
    // await above, so by here it is already in flight. Waiting for it is what
    // makes this promise mean "settled" rather than "bytes arrived" — and it
    // covers the retry too, since the fallback download is started from inside
    // that same chain.
    while (this.verifying) {
      const pending = this.verifying
      await pending
      if (this.verifying === pending) this.verifying = null
    }
    return this.getState()
  }

  /**
   * Interrupt a download in flight.
   *
   * The token really does stop the transfer — abandoning it and letting the
   * bytes keep arriving would leave a second press of "Download update"
   * resolving instantly against the already-finished file, with no further
   * events, so the card would sit at 0% forever.
   */
  cancelDownload(): UpdateStateDTO {
    if (this.state.phase !== 'downloading') return this.getState()
    this.cancelled = true
    this.inFlight = null
    this.token?.cancel()
    this.token = null
    return this.set({ phase: 'available', percent: null, bytesPerSecond: null })
  }

  /**
   * Quit and relaunch into the new version.
   *
   * Reports whether it could even try. Returning nothing meant the IPC call
   * resolved either way, so a refusal left the button reading "Restarting…"
   * forever with nothing said.
   */
  install(): boolean {
    if (this.state.phase !== 'ready') return false
    // INSTALL is a third operation, and the state machine has to know about it:
    // `quitAndInstall` dispatches its failures as ERRORS, and the listener drops
    // anything arriving while nothing is in flight.
    //
    // It stays in flight until the outcome is known, because the failures are
    // not all synchronous -- the Windows and macOS installers dispatch theirs
    // from a promise that settles after `quitAndInstall` has already returned.
    // Clearing it in a `finally` threw those away and left the reader with a
    // generic sentence instead of the actual reason.
    this.installPending = true
    // The previous attempt's complaint goes: a sentence about why the app was
    // not closed last time has no business sitting under the attempt running
    // now. Every other actor clears this; the install path was the exception.
    this.set({ error: null, failed: null })
    try {
      this.deps.autoUpdater.quitAndInstall(false, true)
    } catch (err) {
      // Normally a throw is converted into an `error` event; if it ever is not,
      // the flag would be left set with no deadline scheduled to resolve it.
      this.installPending = false
      this.set({ phase: 'error', failed: 'install', error: describeUpdateError(err) })
      return false
    }

    // THE APP SHOULD BE GOING. Confirm it by watching the quit, not the clock.
    //
    // The return value cannot be used: `quitAndInstall` computes whether the
    // install started and then discards it, so it is typed `void` and returns
    // nothing either way. And a plain timer is wrong too: this app guards its
    // own `before-quit` to protect work in progress, so a SUCCESSFUL install --
    // where the new binary is already in place -- can sit at that prompt for
    // minutes. Accusing it of never starting would be both wrong and
    // unrecoverable, since the updater refuses to try twice.
    //
    // So the deadline only runs while nothing has begun quitting. Once a quit
    // is under way the outcome belongs to the quit, not to us.
    const deadline = this.deps.installGraceMs ?? 5_000
    if (this.installTimer) clearTimeout(this.installTimer)
    this.installTimer = setTimeout(() => {
      this.installTimer = null
      if (this.state.phase !== 'ready') return
      // A quit is under way, so the outcome belongs to it. The install stays
      // PENDING: the close guard may hold it for minutes and NSIS reports a
      // declined elevation from a promise that settles long after this, and
      // clearing the flag here would drop that error on the floor.
      if (this.deps.isQuitting?.() === true) return
      this.installPending = false
      this.set({
        phase: 'error',
        failed: 'install',
        error: 'The update did not start installing. The download may need repeating.'
      })
    }, deadline)
    this.installTimer.unref?.()
    return true
  }


}

/**
 * The feed URL a PACKAGED build will actually use.
 *
 * electron-updater reads `app-update.yml` out of `resourcesPath` on its own,
 * which is what electron-builder's `publish:` block wrote at build time. Reading
 * the same file here is the only way to know what the app is about to talk to —
 * and therefore the only place the https rule can be applied to a real release.
 *
 * Taking it from the environment instead, as this first did, was worse than
 * useless: a packaged app has no such variable, so updates would never work at
 * all, while anyone able to set one could have pointed the app at a feed of
 * their choosing.
 */
export function readPackagedFeed(resourcesPath: string): {
  url?: string
  channel?: string
  /**
   * The file is there and could not be read or holds no url.
   *
   * Distinct from ABSENT, which is a build that deliberately ships no updater —
   * a legitimate configuration, and the one "no update server is configured"
   * describes. Both used to answer `{}`, so a corrupt or unreadable
   * `app-update.yml` presented itself as a deliberate choice: the panel said
   * updates were not configured for this build, the user had no reason to doubt
   * it, and the app never checked for a new version again.
   */
  unreadable?: boolean
} {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readFileSync } = require('node:fs') as typeof import('node:fs')
  let raw: string
  try {
    raw = readFileSync(`${resourcesPath}/app-update.yml`, 'utf8')
  } catch (err) {
    // ENOENT is a build that ships no feed at all — nothing is wrong. Anything
    // else is a file that exists and would not be read.
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT' || code === 'ENOTDIR') return {}
    return { unreadable: true }
  }
  const scalar = (key: string): string | undefined => {
    const line = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(raw)?.[1]
    if (!line) return undefined
    const quoted = /^(['"])(.*?)\1/.exec(line.trim())
    // Quoted values are taken whole; an unquoted one ends at a comment.
    const value = quoted ? quoted[2] : line.split('#')[0].trim()
    return value || undefined
  }
  const url = scalar('url')
  // The file is present and names no feed. Whatever wrote it meant to configure
  // one, so this is a broken file rather than a build without updates.
  if (url === undefined) return { unreadable: true }
  return { url, channel: scalar('channel') }
}

/**
 * Build the service against the real electron-updater.
 *
 * Takes a BROADCAST rather than a window: bound to the one window alive at
 * startup, a second window received the state once and then never heard about
 * a transition again — and when the first window closed, every push was
 * dropped for good.
 */
/**
 * Repair electron-updater's own shell quoting on the linux package path.
 *
 * `LinuxUpdater.runCommandWithSudoIfNeeded` builds, for pkexec:
 *
 *     pkexec --disable-internal-agent /bin/bash -c 'dpkg -i /path/to.deb'
 *
 * and those quotes are LITERAL CHARACTERS in the argument, not shell syntax:
 * pkexec execs directly, so nothing ever strips them. bash is handed a command
 * whose name begins with an apostrophe, cannot find it, and exits 127 — which
 * reaches the user as "Command pkexec exited with code 127", naming the one
 * part of the line that was fine.
 *
 * The whole `-c` argument is one string, so it needs no quoting at all. This
 * rewrites the argv immediately before the spawn and touches nothing else: the
 * command, the elevation and the package manager choice are all still theirs.
 *
 * Applies to `.deb`, `.rpm` and pacman installs. An AppImage never reaches here
 * — it replaces a file the user already owns — and neither does a root session,
 * which electron-updater spawns without a wrapper.
 *
 * Remove when upstream fixes it: the marker is a `-c` argument that both starts
 * and ends with an apostrophe, so this becomes a no-op the day the extra quotes
 * stop being added.
 */
function repairSudoQuoting(autoUpdater: unknown): void {
  const u = autoUpdater as { spawnSyncLog?: (cmd: string, args?: string[], env?: unknown) => string }
  const original = u.spawnSyncLog
  if (typeof original !== 'function') return
  u.spawnSyncLog = function patched(cmd: string, args: string[] = [], env?: unknown): string {
    const i = args.indexOf('-c')
    const script = i === -1 ? undefined : args[i + 1]
    if (script !== undefined && script.length > 1 && script.startsWith("'") && script.endsWith("'")) {
      const fixed = args.slice()
      fixed[i + 1] = script.slice(1, -1)
      return original.call(this, cmd, fixed, env)
    }
    return original.call(this, cmd, args, env)
  }
}

export async function createUpdaterService(
  broadcast: (state: UpdateStateDTO) => void,
  opts: {
    currentVersion: string
    packaged: boolean
    signed: boolean
    resourcesPath: string
    isQuitting?: () => boolean
  }
): Promise<UpdaterService> {
  // electron-updater and builder-util-runtime are CommonJS. Destructuring the
  // dynamic import works in dev, where Vite interops it, but in the PACKAGED
  // build the named export lands on `.default` and `autoUpdater` comes back
  // undefined — so updates died on the first property access in exactly the
  // build that ships, and only there. Read both shapes.
  const updaterModule = await import('electron-updater')
  const runtimeModule = await import('builder-util-runtime')
  const autoUpdater =
    updaterModule.autoUpdater ??
    (updaterModule as unknown as { default: { autoUpdater: unknown } }).default?.autoUpdater
  const CancellationToken =
    runtimeModule.CancellationToken ??
    (runtimeModule as unknown as { default: { CancellationToken: unknown } }).default
      ?.CancellationToken
  if (!autoUpdater || !CancellationToken) {
    throw new Error('electron-updater did not load; this build cannot check for updates')
  }
  repairSudoQuoting(autoUpdater)
  // A release uses what was baked in; only a development run may be pointed
  // somewhere by the environment, which is how the local verifier drives it.
  const baked = opts.packaged ? readPackagedFeed(opts.resourcesPath) : {}
  const service = new UpdaterService({
    autoUpdater: autoUpdater as unknown as AutoUpdaterLike,
    currentVersion: opts.currentVersion,
    packaged: opts.packaged,
    platform: process.platform,
    signed: opts.signed,
    feedUrl: opts.packaged ? baked.url : process.env.CORPUS_UPDATE_URL,
    channel: opts.packaged ? baked.channel : process.env.CORPUS_UPDATE_CHANNEL,
    feedUnreadable: opts.packaged ? baked.unreadable === true : false,
    // Packaged: electron-updater already has the baked config, and calling
    // setFeedURL would only re-state it. Dev: it has none, so it must be told.
    applyFeedUrl: !opts.packaged,
    isQuitting: opts.isQuitting,
    makeCancelToken: () => new (CancellationToken as new () => CancelTokenLike)(),
    send: broadcast
  })
  service.start()
  return service
}
