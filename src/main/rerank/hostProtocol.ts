// The wire between main and the reranker host.
//
// Its own file so BOTH sides can import the types without either importing the
// other's body — the host must not drag main's database in, and main must not
// load `rerank/model`, which is the very thing being kept out of this process.

import type { PairScore } from './model'

export type RerankHostRequest =
  | { kind: 'score'; id: number; query: string; passages: string[] }
  | { kind: 'cancel'; id: number }

export type RerankHostResponse =
  | { kind: 'ready'; pid: number }
  | { kind: 'scored'; id: number; pairs: PairScore[] }
  /**
   * `name` is the original error's class name, carried as data.
   *
   * A thrown `RerankerError` cannot survive structured clone — it arrives as a
   * plain object with its prototype gone — so a caller that wanted to tell "no
   * model packaged" from "a pair could not be measured" would be left comparing
   * message text. The name travels explicitly instead.
   */
  | { kind: 'failed'; id: number; name: string; message: string }
