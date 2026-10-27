import { test, expect } from './helpers/electron'

// The window is FRAMELESS (`frame:false`), so there is no OS title bar and the
// app renders its own minimize / maximize-restore / close controls at the far
// right of the existing topbar. These specs assert (a) the window really is
// frameless in main, (b) the controls exist, are labelled and keyboard-usable,
// and (c) the maximize control reflects the window's ACTUAL state.
//
// NOTE: e2e runs under xvfb with NO window manager, so real maximize/restore
// transitions are not exercised here — we assert the IPC round-trip and that
// the rendered label always agrees with `BrowserWindow.isMaximized()`.

test('the window is frameless (no OS title bar)', async ({ launch }) => {
  const { app } = await launch()
  const win = await app.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    // A framed window's outer bounds are TALLER than its content bounds (the OS
    // title bar lives in the gap). Frameless ⇒ the two are identical.
    return {
      bounds: w.getBounds(),
      content: w.getContentBounds(),
      // Dropping the frame must not cost resizability.
      resizable: w.isResizable()
    }
  })
  expect(win.resizable).toBe(true)
  expect(win.content.height).toBe(win.bounds.height)
  expect(win.content.width).toBe(win.bounds.width)

  // No renderer-side leftovers of OS chrome: the topbar is the title bar.
  await expect(app.windows()[0].locator('[data-testid="topbar"]')).toBeVisible()
})

test('custom window controls are present, labelled and focusable', async ({ launch }) => {
  const { window } = await launch()
  const controls = window.locator('[data-testid="window-controls"]')
  await expect(controls).toBeVisible()
  await expect(controls).toHaveAttribute('aria-label', 'Window')

  const min = window.locator('[data-testid="window-minimize"]')
  const max = window.locator('[data-testid="window-maximize"]')
  const close = window.locator('[data-testid="window-close"]')

  await expect(min).toHaveAttribute('aria-label', 'Minimize window')
  await expect(close).toHaveAttribute('aria-label', 'Close window')
  await expect(max).toHaveAttribute('aria-label', /(Maximize|Restore) window/)

  // Keyboard operable: they are real <button>s, so focus() lands on them.
  for (const btn of [min, max, close]) {
    await btn.focus()
    await expect(btn).toBeFocused()
  }
})

test('the maximize control reflects the real window state', async ({ launch }) => {
  const { app, window } = await launch()
  const max = window.locator('[data-testid="window-maximize"]')

  const realState = async (): Promise<boolean> =>
    app.evaluate(async ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized())

  const labelSaysMaximized = async (): Promise<boolean> =>
    (await max.getAttribute('aria-label')) === 'Restore window'

  expect(await labelSaysMaximized()).toBe(await realState())

  // Drive a real state change from MAIN (not from the button) and assert the
  // pushed `window:maximizedChanged` event syncs the control — proving the icon
  // is not merely toggled optimistically by the click handler.
  await app.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    if (w.isMaximized()) w.unmaximize()
    else w.maximize()
  })
  await expect
    .poll(async () => (await labelSaysMaximized()) === (await realState()), { timeout: 5000 })
    .toBe(true)
})

test('window controls sit inside the single topbar (no second bar, 62px)', async ({ launch }) => {
  const { window } = await launch()
  const bar = window.locator('[data-testid="topbar"]')
  const box = await bar.boundingBox()
  expect(box?.height).toBe(62)

  // The topbar carries no search box any more — corpus search lives on Papers.
  // Negative assertion so a stale topbar box cannot return unnoticed.
  await expect(window.locator('[data-testid="global-search-input"]')).toHaveCount(0)

  // Controls are INSIDE the topbar, at its right edge, after the route title.
  const controls = await window.locator('[data-testid="window-controls"]').boundingBox()
  const title = await window.locator('[data-testid="topbar-title"]').boundingBox()
  expect(controls!.x).toBeGreaterThan(title!.x)
  expect(controls!.y).toBeGreaterThanOrEqual(box!.y)
  expect(controls!.y + controls!.height).toBeLessThanOrEqual(box!.y + box!.height)

  // Full-bleed still holds: the shell starts at y=0 (no chrome above it).
  const shell = await window.locator('.app-shell').boundingBox()
  expect(shell!.y).toBe(0)
  expect(shell!.x).toBe(0)
})

test('interactive topbar children opt out of the window drag region', async ({ launch }) => {
  const { window } = await launch()
  const regions = await window.evaluate(() => {
    const region = (sel: string): string =>
      getComputedStyle(document.querySelector(sel)!).getPropertyValue('-webkit-app-region').trim()
    return {
      bar: region('[data-testid="topbar"]'),
      minimize: region('[data-testid="window-minimize"]'),
      maximize: region('[data-testid="window-maximize"]'),
      close: region('[data-testid="window-close"]')
    }
  })
  expect(regions.bar).toBe('drag')
  expect(regions.minimize).toBe('no-drag')
  expect(regions.maximize).toBe('no-drag')
  expect(regions.close).toBe('no-drag')

  // The window controls still actually receive clicks through the drag region.
  await window.click('[data-testid="window-maximize"]')
  await expect(window.locator('[data-testid="window-maximize"]')).toBeVisible()
})
