/*
 * Put the whole suite on a virtual display AND a throwaway user profile before a
 * single test runs.
 *
 * Playwright forks its workers after this returns, so what is published here
 * (`CORPUS_E2E_DISPLAY`, see e2e/display.ts; the profile redirect, see
 * e2e/profile.ts) reaches every worker and every `launchApp`, whatever command
 * started the run.
 *
 * The Xvfb server we spawn and the temp profile are torn down in
 * global-teardown, and again from signal/exit handlers so an interrupted or
 * crashed run does not leave either behind.
 */
import { provisionDisplay, stopXvfb } from './display'
import { provisionProfile, removeProfile } from './profile'

export default async function globalSetup(): Promise<void> {
  // Before the display: a launch that somehow happens early must already be
  // pointed away from the developer's real gateway credential.
  const profile = provisionProfile()
  console.log(`[e2e] throwaway user profile ${profile}`)

  const display = await provisionDisplay()

  // Overwrite DISPLAY itself, not just the private variable. `launchApp` passes
  // the display explicitly, but a spec that reaches for `_electron.launch`
  // directly (smoke-real-launch does, deliberately, to exercise the real
  // default-DB path) spreads `process.env` and would inherit the user's screen.
  // Setting it here means the inherited value is ALSO the virtual one, so the
  // protection does not depend on every spec remembering to opt in.
  process.env.DISPLAY = display
  // Electron prefers Wayland when the socket is present, which would put the
  // window back on the user's compositor despite DISPLAY pointing at Xvfb.
  if (process.env.CORPUS_E2E_HEADED !== '1') delete process.env.WAYLAND_DISPLAY

  if (process.env.CORPUS_E2E_HEADED === '1') {
    console.log(`[e2e] HEADED: driving the app on your display ${display}`)
  } else {
    console.log(`[e2e] virtual display ${display}`)
  }

  let cleaned = false
  const cleanup = (): void => {
    if (cleaned) return
    cleaned = true
    stopXvfb()
    removeProfile()
  }
  process.on('exit', cleanup)
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => {
      cleanup()
      process.exit(130)
    })
  }
  process.on('uncaughtException', (err) => {
    cleanup()
    throw err
  })
}
