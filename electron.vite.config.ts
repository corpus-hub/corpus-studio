import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': resolve('src/shared') }
    },
    build: {
      rollupOptions: {
        // THREE entries, and the two extras exist for the same reason: both are
        // started by ABSOLUTE PATH at runtime rather than imported, so without
        // its own input rollup would never emit the file and the thing starting
        // it would point at nothing.
        //
        // `stageHost` is the body of a `utilityProcess` that runs long CPU
        // stages off the main thread. `vectorWorker` is a `worker_threads`
        // worker that answers semantic searches against a read-only connection
        // — a thread rather than a process precisely because it needs a
        // database, which a utilityProcess deliberately does not have.
        input: {
          index: resolve('src/main/index.ts'),
          stageHost: resolve('src/main/pipeline/host/hostEntry.ts'),
          vectorWorker: resolve('src/main/search/vectorWorker.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': resolve('src/shared') }
    },
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    resolve: {
      alias: { '@shared': resolve('src/shared') }
    },
    plugins: [react()],
    css: {
      // Source maps for the DEV server's injected styles, so a rule inspected
      // there points at the file it was written in rather than at a <style> tag.
      devSourcemap: true
    },
    build: {
      // SOURCE MAPS IN THE BUILT APP, which is not the usual reason to ship
      // them. The window is what a user actually runs — `npm run dev` is a
      // different build under a different CSP — so a bug seen in the app can
      // only be inspected in the app, and without maps DevTools points at a
      // bundled line nobody can find in the tree.
      //
      // CSS gets no map from this and needs none: the stylesheet is emitted
      // unminified with its comments, so the Styles pane already shows the rule
      // as it was written and an edit there is legible. The map matters for the
      // JS, where the bundle is not readable.
      //
      // They carry no secrets — this is a local-first UI whose sources ship
      // anyway — and nothing fetches them until DevTools is opened.
      sourcemap: true,
      // Emit ALL font files as real assets served via file: — never inline them
      // as `data:font/...;base64` URIs. The strict CSP uses `font-src 'self'`
      // (NOT `data:`), so any inlined font is REFUSED and the app silently falls
      // back to system fonts, breaking design fidelity. Returning false for font
      // extensions forces file emission regardless of size; other assets keep
      // Vite's default heuristic.
      assetsInlineLimit: (filePath: string): boolean | undefined => {
        if (/\.(woff2?|ttf|otf|eot)(\?.*)?$/i.test(filePath)) return false
        return undefined
      },
      rollupOptions: {
        input: { index: resolve('src/renderer/index.html') }
      }
    }
  }
})
