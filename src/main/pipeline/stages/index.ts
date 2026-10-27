// The entire registration surface. Adding a stage is one new file next to this
// one plus one line in the array below — no migration, no contract change, no
// edit to a neighbouring stage. Ordering is derived from the capability tokens
// each stage declares, so a stage inserted in the middle needs no one's
// permission.

//
// The ARRAY ORDER MEANS NOTHING. The registry topologically sorts by capability
// token and breaks ties on `rank`, so moving a line here changes no behaviour.
// Anyone editing this file to reorder execution is in the wrong file: change
// the tokens.

import type { StageDefinition } from '../types'
import citationContexts from './citation-contexts'
import download from './download'
import embed from './embed'
import extractText from './extract-text'
import ocr from './ocr'
import optimize from './optimize'
import referenceAbstracts from './reference-abstracts'
import references from './references'
import rerank from './rerank'
import resolveReferences from './resolve-references'
import retrieve from './retrieve'
import reviewRecords from './review-records'
import schemaExtract from './schema-extract'
import segment from './segment'
import summarise from './summarise'
import verifyCitations from './verify-citations'
import zoteroPush from './zotero-push'

export const STAGES: readonly StageDefinition[] = [
  retrieve,
  download,
  optimize,
  extractText,
  ocr,
  segment,
  embed,
  summarise,
  references,
  referenceAbstracts,
  citationContexts,
  schemaExtract,
  reviewRecords,
  resolveReferences,
  rerank,
  verifyCitations,
  zoteroPush
]
