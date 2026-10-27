import type { CorpusApi } from '@shared/contract'

declare global {
  interface Window {
    api: CorpusApi
  }
}

export {}
