// Renderer typechecks independently: declare window.api using the frozen
// contract. Guarded so it doesn't clash with the preload d.ts if that is also
// on the include path (identical shape → structurally compatible).
import type { CorpusApi } from '@shared/contract'

declare global {
  interface Window {
    api: CorpusApi
  }
}

export {}
