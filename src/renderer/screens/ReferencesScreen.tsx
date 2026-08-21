import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CitationEdgeDTO } from '@shared/types'
import * as d3 from 'd3'
import * as pdfjs from 'pdfjs-dist'
import type {
  GraphEdgeDTO,
  ReferenceRetrievalStatus,
  ReferenceTreeDTO,
  ReferenceTreeNodeDTO,
  UnresolvedReferenceNodeDTO
} from '@shared/contract'
import { referenceLabel } from '@shared/referenceLabel'
import { expansionForDisplay, relevanceForDisplay } from '../lib/format'
import { useAsync } from '../lib/useAsync'
import { isContentAbsence, pdfUnavailableLabel } from '../lib/pdfAvailability'
import { useVisibleWindowListener } from '../lib/visibility'
import { useJobsChanged } from '../lib/useJobsChanged'
import { DataView, EmptyState } from '../components/States'
import { Select, SwitchField, cardStyle } from '../components/ui'
import { ReadAbstractButton } from '../components/ReferenceAbstract'
import { EvidenceBody, occurrenceCount } from '../components/EvidenceCard'
import { PaperProfileCard } from '../components/PaperProfileCard'

// Worker asset resolved to a bundled local URL (offline, no CDN). Assigning it
// again when PdfDocView has already run is a no-op with the same value.
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString()

// How many in-project works the screen will lay out. The repository returns the
// project's TRUE total alongside, so a shortfall is disclosed, never hidden.
const TREE_LIMIT = 5000

// ---- geometry (world units) --------------------------------------------
const NODE_W = 168
const NODE_H = 96
/** Breadth (vertical) step between sibling rows, and depth (horizontal) step. */
/**
 * EVERY cited-but-absent reference is drawn — the tree shows what the papers
 * actually cite, not a sample of it.
 *
 * This used to be capped at six per citing work to keep the layout tidy, which
 * meant a paper with 34 printed references rendered 6 and said nothing about
 * the other 28. A view that silently omits data is worse than a crowded one:
 * the user cannot tell a short bibliography from a truncated drawing. The
 * The number is a safety valve for a pathological document, not a display
 * budget: the largest bibliography in this corpus is 213 references.
 */
const UNRESOLVED_PER_WORK = 5000

/**
 * How the paper list is ordered. `cited-here` counts citations FROM THIS
 * CORPUS (what the tree can actually draw); `citations` is the world-wide
 * figure the metadata carries. They answer different questions, so both exist.
 */
const SORTS = [
  { key: 'cited-here', label: 'cited here', tip: 'How many papers in THIS corpus cite it — what the tree can actually draw.' },
  { key: 'relevance', label: 'relevance', tip: "How closely the paper bears on this project's question." },
  { key: 'expansion', label: 'expansion', tip: 'How much new territory reading it would open up.' },
  { key: 'year', label: 'year', tip: 'Publication year, newest first.' },
  { key: 'citations', label: 'citations', tip: 'Citation count recorded in the corpus metadata (world-wide, not just this project).' }
] as const
type SortKey = (typeof SORTS)[number]['key']
const ROW_STEP = NODE_H + 26
const COL_STEP = NODE_W + 92
const THUMB_W = 52
const THUMB_H = 70
/** Device-pixel size the page-1 raster is baked at (2x for crispness). */
const THUMB_PX_W = THUMB_W * 2
const THUMB_PX_H = THUMB_H * 2

// ---- render policy ------------------------------------------------------
/** How long a citation highlight takes to fade in or out, in ms. */
const HIGHLIGHT_FADE_MS = 130
/**
 * How long a card's own hover/pick transition takes, in ms. Shorter than the
 * highlight fade: this one tracks the pointer, and a slow response to a direct
 * gesture reads as lag rather than as polish.
 */
const CARD_FADE_MS = 75
/**
 * Strength of the "related" emphasis, shared by the highlighted lines AND the
 * papers they reach. ONE constant for both is the point: the neighbourhood has
 * to read as a single set, and it must stay quieter than the hovered card so
 * the eye is never pulled off what the pointer is actually on.
 */
const RELATED_ALPHA = 0.55
/** Below this zoom a thumbnail is a few pixels tall: draw a cheap box instead. */
const THUMB_MIN_K = 0.45
/** Below this zoom text is unreadable: skip the (expensive) text pass. */
const TEXT_MIN_K = 0.34
/** Bounded raster cache. ~140 * 104*140*4B ≈ 8 MB worst case. */
const THUMB_CACHE_MAX = 140
/** Concurrent pdf.js loads. pdf.js is single-worker; more just queues. */
const MAX_INFLIGHT = 3
/** Per-frame slice for the thumbnail scheduler, mirroring PdfDocView. */
const BUDGET_MS = 6

const COL_INK = '#211a12'
const COL_MUTED = '#8a8073'
/** Lighter than COL_MUTED: the status line is context, not content. */
const COL_MUTED_2 = '#a89e91'
const COL_LINE = '#e0d9cf'
const COL_ACCENT = '#e2600f'
const COL_PANEL = '#ffffff'
const COL_BORDER = '#e6ded3'
const COL_PLACEHOLDER = '#f1ece5'
/**
 * Selection blue. Deliberately NOT the accent orange: the accent already means
 * "hovered / related", and a selection the user made by hand must not read as
 * something the pointer merely happens to be near.
 */
const COL_SELECT = '#2563eb'
/** The face wash of a picked card, and the softer border of a merely-hoverable one. */
const COL_SELECT_FILL = '#eff4ff'
const COL_SELECT_SOFT = '#93b4f5'
/** Failure red, and the wash the card face is tinted with. */
const COL_FAIL = '#b4402a'
const COL_FAIL_FILL = '#fdf3f1'

/**
 * Blend `hex` toward the accent by `t` (0..1).
 *
 * The card tint has to be an opaque COLOUR rather than a translucent overlay:
 * cards are drawn over links, so painting a semi-transparent wash on top would
 * let the lines beneath show through the card face and muddy it.
 */
/**
 * Blend two `#rrggbb` colours, returning `#rrggbb`.
 *
 * The result MUST stay in the input format: these calls are chained (a face is
 * washed by failure, then selection, then hover) and a function that accepted
 * hex but returned `rgb()` would parse its own previous output as garbage.
 */
function mix(hex: string, toHex: string, t: number): string {
  const p = (h: string): number[] => [
    parseInt(h.slice(1, 3), 16),
    parseInt(h.slice(3, 5), 16),
    parseInt(h.slice(5, 7), 16)
  ]
  const from = p(hex)
  const to = p(toHex)
  const k = Math.max(0, Math.min(1, t))
  const ch = (i: number): string =>
    Math.round(from[i] + (to[i] - from[i]) * k)
      .toString(16)
      .padStart(2, '0')
  return `#${ch(0)}${ch(1)}${ch(2)}`
}

function mixAccent(hex: string, t: number): string {
  return mix(hex, COL_ACCENT, t)
}

// ============================================================ layout model
interface PlacedNode {
  node: ReferenceTreeNodeDTO
  depth: number
  /** Centre of the card in world space. */
  cx: number
  cy: number
}
/**
 * A paper this corpus CITES but does not hold. It is real evidence — it was
 * printed in a bibliography — so it is drawn rather than dropped, but with a
 * "?" where the page preview would be, since there is no document to render.
 */
interface PlacedUnresolved {
  node: UnresolvedReferenceNodeDTO
  cx: number
  cy: number
}
interface LayoutLink {
  x1: number
  y1: number
  x2: number
  y2: number
  /** The two papers this link joins — cited (left) and citing (right). */
  citedId: number
  citingId: number
}
interface Layout {
  placed: PlacedNode[]
  /** Cited-but-absent papers, stacked left of the work that cites them. */
  unresolved: PlacedUnresolved[]
  /** Links joining each unresolved card to the work whose bibliography named it. */
  unresolvedLinks: LayoutLink[]
  byId: Map<number, PlacedNode>
  primary: LayoutLink[]
  /** Citation links whose target is not the node's layout parent (DAG extras). */
  secondary: LayoutLink[]
  maxDepth: number
  rootCount: number
  /** Citation edges dropped from the depth pass because they closed a cycle. */
  cycleEdges: number
  bounds: { x0: number; y0: number; x1: number; y1: number }
}

/**
 * Longest-path depth over the citation DAG.
 *
 * Layout direction is CITED -> CITING: a paper must sit to the right of
 * everything it cites, so a paper's depth is 1 + the max depth of the papers it
 * cites, and depth 0 is a work that cites nothing else inside the project.
 * "Longest" (not shortest) is what guarantees the invariant transitively.
 *
 * Kahn's algorithm gives the exact answer for the acyclic part. Anything left
 * with a non-zero in-degree sits on a cycle (dirty data: A cites B cites A).
 * Those are drained in a deterministic order — publication year, then work id —
 * and each takes 1 + the max depth among its ALREADY-resolved citations; its
 * unresolved back-edges are counted and reported, not silently applied. This
 * terminates and never recurses, so a cycle cannot hang or crash the screen.
 */
function computeDepths(
  nodes: ReferenceTreeNodeDTO[],
  edges: GraphEdgeDTO[]
): { depth: Map<number, number>; parents: Map<number, number[]>; cycleEdges: number } {
  const present = new Set(nodes.map((n) => n.id))
  // parents[citing] = the works it cites (its layout candidates on the left).
  const parents = new Map<number, number[]>()
  const children = new Map<number, number[]>()
  for (const n of nodes) {
    parents.set(n.id, [])
    children.set(n.id, [])
  }
  const seen = new Set<string>()
  for (const e of edges) {
    if (!present.has(e.source) || !present.has(e.target)) continue
    if (e.source === e.target) continue
    const key = `${e.target}>${e.source}`
    if (seen.has(key)) continue
    seen.add(key)
    parents.get(e.source)!.push(e.target)
    children.get(e.target)!.push(e.source)
  }

  const indeg = new Map<number, number>()
  for (const n of nodes) indeg.set(n.id, parents.get(n.id)!.length)

  const depth = new Map<number, number>()
  const resolved = new Set<number>()
  const queue: number[] = []
  for (const n of nodes) {
    if (indeg.get(n.id) === 0) {
      depth.set(n.id, 0)
      queue.push(n.id)
    }
  }
  let qi = 0
  while (qi < queue.length) {
    const u = queue[qi++]
    resolved.add(u)
    for (const v of children.get(u)!) {
      depth.set(v, Math.max(depth.get(v) ?? 0, (depth.get(u) ?? 0) + 1))
      const left = (indeg.get(v) ?? 0) - 1
      indeg.set(v, left)
      if (left === 0) queue.push(v)
    }
  }

  let cycleEdges = 0
  if (resolved.size < nodes.length) {
    const stuck = nodes
      .filter((n) => !resolved.has(n.id))
      .sort((a, b) => (a.year ?? Infinity) - (b.year ?? Infinity) || a.id - b.id)
    for (const n of stuck) {
      let d = 0
      for (const p of parents.get(n.id)!) {
        if (resolved.has(p)) d = Math.max(d, (depth.get(p) ?? 0) + 1)
        else cycleEdges++
      }
      depth.set(n.id, Math.max(depth.get(n.id) ?? 0, d))
      resolved.add(n.id)
      for (const v of children.get(n.id)!) {
        if (resolved.has(v)) continue
        depth.set(v, Math.max(depth.get(v) ?? 0, (depth.get(n.id) ?? 0) + 1))
      }
    }
  }

  for (const n of nodes) if (!depth.has(n.id)) depth.set(n.id, 0)
  return { depth, parents, cycleEdges }
}

/**
 * Depths -> screen coordinates via d3.tree.
 *
 * d3.hierarchy needs ONE root and a single parent per node, which a citation
 * DAG has neither of. Both gaps are closed here:
 *
 *  - FOREST: a synthetic virtual root (id -1) adopts every depth-0 work. It is
 *    purely a layout device — it is dropped before rendering, so it is never
 *    drawn, never hit-tested, never counted, and the links from it to the real
 *    roots are never emitted. The whole layout is translated left by one column
 *    so the real roots sit at x=0 and the phantom is off-canvas.
 *  - MULTI-PARENT: a work that cites several in-project works is placed under
 *    ONE primary parent — the cited work with the greatest depth (ties by id),
 *    which is exactly the predecessor on the longest path, so the tree depth
 *    d3 assigns equals the DAG depth computed above. Its remaining citations
 *    are still drawn, as thin secondary links. Nothing is duplicated, so the
 *    node count on screen equals the paper count.
 */
function buildLayout(tree: ReferenceTreeDTO): Layout {
  const { nodes, edges } = tree
  const { depth, parents, cycleEdges } = computeDepths(nodes, edges)

  const primaryParent = new Map<number, number>()
  for (const n of nodes) {
    let best: number | null = null
    let bestDepth = -1
    for (const p of parents.get(n.id) ?? []) {
      const pd = depth.get(p) ?? 0
      // A back-edge from a broken cycle cannot be a layout parent: it would
      // place the child left of its own citation.
      if (pd >= (depth.get(n.id) ?? 0)) continue
      if (pd > bestDepth || (pd === bestDepth && best !== null && p < best)) {
        best = p
        bestDepth = pd
      }
    }
    if (best !== null) primaryParent.set(n.id, best)
  }

  const kids = new Map<number, ReferenceTreeNodeDTO[]>()
  for (const n of nodes) kids.set(n.id, [])
  const roots: ReferenceTreeNodeDTO[] = []
  for (const n of nodes) {
    const p = primaryParent.get(n.id)
    if (p === undefined) roots.push(n)
    else kids.get(p)!.push(n)
  }

  type HNode = { id: number; node: ReferenceTreeNodeDTO | null; children: HNode[] }
  const wrap = (n: ReferenceTreeNodeDTO): HNode => ({
    id: n.id,
    node: n,
    children: kids.get(n.id)!.map(wrap)
  })
  const virtualRoot: HNode = { id: -1, node: null, children: roots.map(wrap) }

  // The layout call is what assigns x/y; take its return value, which is typed
  // as HierarchyPointNode (x/y non-optional) rather than the bare hierarchy.
  const root = d3
    .tree<HNode>()
    .nodeSize([ROW_STEP, COL_STEP])(d3.hierarchy<HNode>(virtualRoot, (d) => d.children))

  const placed: PlacedNode[] = []
  const byId = new Map<number, PlacedNode>()
  root.each((d) => {
    if (d.data.node === null) return
    const p: PlacedNode = {
      node: d.data.node,
      depth: depth.get(d.data.node.id) ?? 0,
      // d3 lays out top-down: `y` is the depth axis, `x` the breadth axis. The
      // tree is horizontal here, so they swap. The -COL_STEP puts the real
      // roots at x=0 and the virtual root one column off-canvas to the left.
      cx: d.y - COL_STEP,
      cy: d.x
    }
    placed.push(p)
    byId.set(p.node.id, p)
  })

  const primary: LayoutLink[] = []
  const secondary: LayoutLink[] = []
  const seenLink = new Set<string>()
  for (const e of edges) {
    const from = byId.get(e.target) // cited — left endpoint
    const to = byId.get(e.source) // citing — right endpoint
    if (!from || !to || from === to) continue
    const key = `${e.target}>${e.source}`
    if (seenLink.has(key)) continue
    seenLink.add(key)
    const link: LayoutLink = {
      x1: from.cx,
      y1: from.cy,
      x2: to.cx,
      y2: to.cy,
      citedId: e.target,
      citingId: e.source
    }
    if (primaryParent.get(e.source) === e.target) primary.push(link)
    else secondary.push(link)
  }

  // Cited-but-absent papers sit ONE COLUMN LEFT of the paper citing them —
  // left because they are cited BY it, which is the direction the whole tree
  // reads. They are stacked vertically around their citer so a paper with many
  // missing references does not overlap its neighbours' rows.
  //
  // A paper cited by SEVERAL works is one card with several links, matching how
  // a known paper is drawn. It is anchored to the LEFTMOST of its citers, so it
  // still precedes every paper that cites it.
  const unresolved: PlacedUnresolved[] = []
  const unresolvedLinks: LayoutLink[] = []
  const perCiter = new Map<number, UnresolvedReferenceNodeDTO[]>()
  for (const u of tree.unresolved ?? []) {
    const citers = u.citing_work_ids.filter((id) => byId.has(id))
    if (citers.length === 0) continue
    const anchorId = citers.reduce((best, id) =>
      (byId.get(id)!.cx < byId.get(best)!.cx ? id : best)
    )
    const a = perCiter.get(anchorId)
    if (a) a.push(u)
    else perCiter.set(anchorId, [u])
  }
  // Rows already taken by REAL cards in each column, so an unresolved card is
  // never dropped on top of a paper the corpus actually holds.
  const takenByColumn = new Map<number, number[]>()
  for (const p of placed) {
    const col = Math.round(p.cx / COL_STEP)
    const a = takenByColumn.get(col)
    if (a) a.push(p.cy)
    else takenByColumn.set(col, [p.cy])
  }
  const free = (col: number, wanted: number): number => {
    const rows = takenByColumn.get(col) ?? []
    let y = wanted
    // Walk outward until the slot clears every card already in this column.
    for (let guard = 0; guard < 400; guard++) {
      if (!rows.some((r) => Math.abs(r - y) < ROW_STEP * 0.9)) break
      y += ROW_STEP
    }
    rows.push(y)
    takenByColumn.set(col, rows)
    return y
  }

  for (const [anchorId, list] of perCiter) {
    const anchor = byId.get(anchorId)
    if (!anchor) continue
    list.sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0))
    // Wrap a long bibliography into a BLOCK of columns rather than one tall
    // stack. A review here cites 213 papers; in a single column that is a
    // 20,000-pixel ribbon, so fitting it put the whole tree at 3% zoom and
    // nothing was legible. Columns grow leftwards (away from the citing paper),
    // which keeps the reference-precedes-citer reading direction intact.
    const perColumn = Math.max(1, Math.ceil(Math.sqrt(list.length * 1.6)))
    const columns = Math.ceil(list.length / perColumn)
    list.forEach((u, i) => {
      const colIndex = Math.floor(i / perColumn)
      const rowIndex = i % perColumn
      // The first column sits nearest its citer; later columns step further left.
      const cx = anchor.cx - COL_STEP * (columns - colIndex)
      const col = Math.round(cx / COL_STEP)
      const rows = Math.min(perColumn, list.length - colIndex * perColumn)
      const span = (rows - 1) * ROW_STEP
      const cy = free(col, anchor.cy - span / 2 + rowIndex * ROW_STEP)
      unresolved.push({ node: u, cx, cy })
      // The links are the whole point: an unresolved card floating with no line
      // to its citers is not "in the tree", it is a box next to one. One line
      // per citing paper, so the card's several citations are all visible.
      for (const citingId of u.citing_work_ids) {
        const citer = byId.get(citingId)
        if (!citer) continue
        unresolvedLinks.push({
          x1: cx,
          y1: cy,
          x2: citer.cx,
          y2: citer.cy,
          citedId: -u.id,
          citingId
        })
      }
    })
  }

  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const p of placed) {
    x0 = Math.min(x0, p.cx - NODE_W / 2)
    x1 = Math.max(x1, p.cx + NODE_W / 2)
    y0 = Math.min(y0, p.cy - NODE_H / 2)
    y1 = Math.max(y1, p.cy + NODE_H / 2)
  }
  for (const u of unresolved) {
    x0 = Math.min(x0, u.cx - NODE_W / 2)
    x1 = Math.max(x1, u.cx + NODE_W / 2)
    y0 = Math.min(y0, u.cy - NODE_H / 2)
    y1 = Math.max(y1, u.cy + NODE_H / 2)
  }
  if (!placed.length) {
    x0 = 0
    y0 = 0
    x1 = 1
    y1 = 1
  }

  return {
    placed,
    unresolved,
    unresolvedLinks,
    byId,
    primary,
    secondary,
    maxDepth: placed.reduce((m, p) => Math.max(m, p.depth), 0),
    rootCount: roots.length,
    cycleEdges,
    bounds: { x0, y0, x1, y1 }
  }
}

// ==================================================== thumbnail rasteriser
/**
 * What became of a card's cover.
 *
 * `none` carried two different facts — "this paper has no PDF" and "the PDF is
 * on record and could not be opened" — and the initials drawn for it asserted
 * the first, so a card whose file sits on a disconnected drive was
 * indistinguishable from one that never had a document. `failed` is now its own
 * answer, and the card draws a warning tile instead of initials.
 */
type ThumbState =
  | { kind: 'pending' }
  | { kind: 'ready' }
  | { kind: 'absent' }
  | { kind: 'failed'; label: string }

/**
 * Bounded LRU of page-1 rasters plus the in-flight bookkeeping needed to cancel
 * work for nodes that scroll out of view.
 *
 * Each job loads the PDF, renders page 1 onto an offscreen canvas and then
 * DESTROYS the pdf.js document immediately: only the small raster is retained,
 * so neither the source ArrayBuffer nor a worker-side document lingers. On
 * eviction the canvas is shrunk to 0x0, which is what actually releases the
 * backing store in Chromium.
 */
class ThumbCache {
  private lru = new Map<number, HTMLCanvasElement>()
  private status = new Map<number, ThumbState>()
  private inflight = new Map<number, { cancel: () => void }>()
  constructor(private onReady: () => void) {}

  get(workId: number): HTMLCanvasElement | null {
    const c = this.lru.get(workId)
    if (!c) return null
    this.lru.delete(workId)
    this.lru.set(workId, c)
    return c
  }

  stateOf(workId: number): ThumbState | undefined {
    return this.status.get(workId)
  }

  get inflightCount(): number {
    return this.inflight.size
  }

  /** Drop the render for a node that left the viewport. */
  cancel(workId: number): void {
    const job = this.inflight.get(workId)
    if (!job) return
    job.cancel()
    this.inflight.delete(workId)
    this.status.delete(workId)
  }

  cancelAllExcept(keep: Set<number>): void {
    for (const id of [...this.inflight.keys()]) if (!keep.has(id)) this.cancel(id)
  }

  request(workId: number, documentId: number): void {
    if (this.status.has(workId) || this.lru.has(workId)) return
    this.status.set(workId, { kind: 'pending' })

    let cancelled = false
    let renderTask: { cancel: () => void } | null = null
    let loadingTask: { destroy: () => Promise<void> } | null = null
    this.inflight.set(workId, {
      cancel: () => {
        cancelled = true
        renderTask?.cancel()
        void loadingTask?.destroy()
      }
    })

    void (async () => {
      try {
        const read = await window.api.readPdf(documentId)
        if (cancelled) return
        if (!read.ok) {
          this.finish(
            workId,
            isContentAbsence(read.reason)
              ? { kind: 'absent' }
              : { kind: 'failed', label: pdfUnavailableLabel(read.reason) }
          )
          return
        }
        const bytes = read.bytes
        const data = bytes instanceof Uint8Array ? bytes.slice() : new Uint8Array(bytes)
        const task = pdfjs.getDocument({ data })
        loadingTask = task as unknown as { destroy: () => Promise<void> }
        const doc = await task.promise
        if (cancelled) {
          void doc.destroy()
          return
        }
        const page = await doc.getPage(1)
        const base = page.getViewport({ scale: 1 })
        const scale = Math.min(THUMB_PX_W / base.width, THUMB_PX_H / base.height)
        const viewport = page.getViewport({ scale })
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(viewport.width))
        canvas.height = Math.max(1, Math.round(viewport.height))
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          void doc.destroy()
          this.finish(workId, { kind: 'failed', label: 'PDF unavailable' })
          return
        }
        const rt = page.render({ canvasContext: ctx, viewport })
        renderTask = rt
        await rt.promise
        // The raster is all we keep; the document and its bytes go now.
        void doc.destroy()
        if (cancelled) return
        this.put(workId, canvas)
        this.finish(workId, { kind: 'ready' })
      } catch {
        // The bytes WERE had; pdf.js would not turn them into a page. That is a
        // broken or unsupported file, not a paper without one.
        if (!cancelled) this.finish(workId, { kind: 'failed', label: 'PDF unreadable' })
      }
    })()
  }

  private finish(workId: number, state: ThumbState): void {
    this.inflight.delete(workId)
    this.status.set(workId, state)
    this.onReady()
  }

  private put(workId: number, canvas: HTMLCanvasElement): void {
    this.lru.set(workId, canvas)
    while (this.lru.size > THUMB_CACHE_MAX) {
      const oldest = this.lru.keys().next().value as number | undefined
      if (oldest === undefined) break
      const dead = this.lru.get(oldest)
      this.lru.delete(oldest)
      this.status.delete(oldest)
      if (dead) {
        dead.width = 0
        dead.height = 0
      }
    }
  }

  dispose(): void {
    for (const id of [...this.inflight.keys()]) this.cancel(id)
    for (const c of this.lru.values()) {
      c.width = 0
      c.height = 0
    }
    this.lru.clear()
    this.status.clear()
  }
}

// ============================================================== canvas view
/**
 * The tree is drawn to ONE canvas rather than one SVG/DOM element per paper.
 * At a few thousand works the DOM approach costs thousands of elements plus a
 * style/layout pass on every pan frame; a single canvas costs one clear and a
 * culled draw of only what intersects the viewport, which keeps panning at
 * frame rate and makes the node budget a drawing cost rather than a DOM cost.
 */
function TreeCanvas({
  layout,
  projectId,
  onOpenWork,
  onOpenQuote,
  selectionWorkId,
  selectedRefs,
  statusOf,
  hiddenUnknowns,
  onStartSelection,
  onToggleRef
}: {
  layout: Layout
  /** Identifies the tree, so the view is fitted once per project and not per reload. */
  projectId: number
  onOpenWork: (workId: number) => void
  /** Open a paper scrolled to the passage carrying this citation text. */
  onOpenQuote?: (workId: number, quote: string) => void
  /**
   * Cited-but-absent papers the reader has switched OFF, so the count line can
   * say they exist. 0 when they are being drawn — they are then in the count.
   */
  hiddenUnknowns: number
  /** The work whose cited unknowns are being picked, or null when not picking. */
  selectionWorkId: number | null
  selectedRefs: Set<number>
  /** Live retrieval state of one unresolved reference (DB-backed, polled). */
  statusOf: (u: UnresolvedReferenceNodeDTO) => ReferenceRetrievalStatus
  onStartSelection: (workId: number) => void
  onToggleRef: (unresolvedId: number) => void
}): JSX.Element {
  /**
   * Can this cited-but-absent paper be chosen for retrieval?
   *
   * No while a fetch is in flight (it is not a choice to make twice), and no
   * once one has FAILED: re-picking it would queue the same attempt against the
   * same unreachable source. A failed card stays on the tree — the citation is
   * still real — but it is inert, not a normal candidate.
   */
  const isPickable = (u: UnresolvedReferenceNodeDTO): boolean => {
    const s = statusOf(u)
    return s !== 'retrieving' && s !== 'failed'
  }

  const hostRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const transformRef = useRef<d3.ZoomTransform>(d3.zoomIdentity)
  const zoomRef = useRef<d3.ZoomBehavior<HTMLCanvasElement, unknown> | null>(null)
  const hoverLinkRef = useRef<LayoutLink | null>(null)

  /**
   * The citation card opened by clicking a line, with the pointer position it
   * was opened at.
   *
   * The tree draws its links on a CANVAS, so there is no element to hang a
   * popover off — the card is placed from the click coordinates, exactly as the
   * connectome places its pinned card.
   */
  const [edgeCard, setEdgeCard] = useState<{
    edge: CitationEdgeDTO
    x: number
    y: number
  } | null>(null)
  const [edgeCardLoading, setEdgeCardLoading] = useState(false)
  /** Where the click landed, so the busy card and any refusal appear there. */
  const [edgeCardAt, setEdgeCardAt] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  /** Set when a clicked line turns out to have no citation_edge behind it. */
  const [edgeCardNone, setEdgeCardNone] = useState(false)

  /**
   * Resolve the clicked line to the citation edge behind it.
   *
   * The layout knows only the two work ids it joins; the evidence — roles,
   * passages, the printed reference line — hangs off `citation_edge`, which is
   * fetched per work. Asking for the CITING side and matching on the cited id
   * is one call and gets the edge with its contexts attached.
   */
  const openEdgeCard = useCallback(async (link: LayoutLink, x: number, y: number): Promise<void> => {
    setEdgeCardAt({ x, y })
    setEdgeCardNone(false)
    setEdgeCardLoading(true)
    try {
      const edges = await window.api.getCitations(link.citingId)
      const hit = edges.find(
        (e) => e.citing_work_id === link.citingId && e.cited_work_id === link.citedId
      )
      if (hit) setEdgeCard({ edge: hit, x, y })
      // No `citation_edge` behind the line — it was drawn from something else.
      // SAID, not swallowed: a click that silently does nothing reads as a
      // broken control, and the reader cannot tell it from a missed click.
      else setEdgeCardNone(true)
    } finally {
      setEdgeCardLoading(false)
    }
  }, [])
  /**
   * The citations currently emphasised, and how far the emphasis has faded in.
   * `alpha` is eased toward `target` by the ticker below; keeping the LINKS
   * alongside it means a fade-out finishes drawing the set it started on rather
   * than vanishing the instant the pointer leaves.
   */
  const highlightRef = useRef<{
    links: LayoutLink[]
    /** The papers at the far end of those citations — NOT the hovered card. */
    nodes: Set<number>
    alpha: number
    target: number
  }>({
    links: [],
    nodes: new Set(),
    alpha: 0,
    target: 0
  })
  const fadeRef = useRef(0)
  const hoverRef = useRef<number | null>(null)
  /** The unresolved card under the pointer, tracked so it can paint a hover state. */
  const hoverRefRef = useRef<number | null>(null)
  /**
   * Per-unresolved-card animation progress: `hover` and `pick` each ease 0→1.
   *
   * Held in a REF and ticked by rAF rather than derived from React state: these
   * are paint-only values that change every frame during a fade, and routing
   * them through a re-render would rebuild the layout 60 times a second.
   * Entries are dropped once both channels settle at 0, so the map stays the
   * size of what is actually animating rather than of the whole corpus.
   */
  const uAnimRef = useRef<Map<number, { hover: number; pick: number }>>(new Map())
  /**
   * Where each animating card is headed. Separate from the progress map and read
   * by the ticker EVERY frame, so a new gesture retargets a fade already in
   * flight instead of waiting for it (or being dropped).
   */
  const uTargetsRef = useRef<Map<number, { hover: number; pick: number }>>(new Map())
  const uAnimFrameRef = useRef(0)
  /** The project the view was fitted for, so a reload does not re-fit it. */
  const fittedForRef = useRef<number | null>(null)
  const frameRef = useRef(0)
  const [zoomPct, setZoomPct] = useState(100)
  const [visibleCount, setVisibleCount] = useState(0)
  /**
   * The card menu, in CLIENT-RELATIVE screen pixels.
   *
   * The tree is a canvas, so a card is paint, not an element a popup could be
   * anchored to. The menu is therefore a DOM overlay positioned by projecting
   * the card's world coordinates through the current zoom transform — the exact
   * inverse of `toWorld`. It is closed (never re-projected) on any pan or zoom:
   * a menu that chased its card during a drag would be a moving target, and one
   * that stayed put would point at the wrong paper.
   */
  const [menu, setMenu] = useState<{
    workId: number
    title: string
    x: number
    y: number
  } | null>(null)

  // Escape closes the menu from ANYWHERE, not only while a menu item holds
  // focus — a user who opened it by mistake should not have to find it again to
  // get rid of it.
  // An open menu SURVIVES this tab being hidden, so an ungated listener would
  // have a References tab the user cannot see eat the Escape they meant for the
  // tab they are looking at.
  useVisibleWindowListener('keydown', (e) => {
    if (menu && e.key === 'Escape') setMenu(null)
  })

  const requestDraw = useCallback(() => {
    if (frameRef.current) return
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0
      drawRef.current?.()
    })
  }, [])

  /**
   * Ease the highlight toward its target and keep redrawing until it arrives.
   *
   * The ticker STOPS once settled — an always-on rAF loop would burn a frame's
   * work forever on a screen that is usually still. Easing is the derivative of
   * cubic in-out, applied per frame, so the fade accelerates then decelerates
   * rather than moving linearly.
   */
  const runFade = useCallback(() => {
    if (fadeRef.current) return
    let prev = performance.now()
    const tick = (now: number): void => {
      const dt = Math.min(64, now - prev)
      prev = now
      const h = highlightRef.current
      const step = dt / HIGHLIGHT_FADE_MS
      // Ease-in-out via a velocity that is smallest at both ends.
      //
      // Both the velocity input and the result are clamped to [0,1]. This is
      // belt-and-braces, NOT a fix for an observed fault: `target` is only ever
      // 0 or 1 and each branch clamps against it, so alpha cannot leave the
      // range as the code stands — verified exhaustively over the reachable
      // states. The guard is here because the velocity `a*(1-a)` is a parabola
      // that goes NEGATIVE outside [0,1], which would push alpha further out
      // and diverge rather than settle; a future `target` that is not 0 or 1
      // would open that door silently, and a runaway alpha reaches the card
      // tint, where `mix` pins it at a solid accent face.
      const eased = Math.max(0, Math.min(1, h.alpha))
      const speed = 0.35 + 2.6 * eased * (1 - eased)
      const next =
        h.target > h.alpha ? Math.min(h.target, h.alpha + step * speed) : Math.max(h.target, h.alpha - step * speed)
      h.alpha = Math.max(0, Math.min(1, next))
      drawRef.current?.()
      if (Math.abs(h.target - h.alpha) > 0.005) {
        fadeRef.current = requestAnimationFrame(tick)
      } else {
        h.alpha = h.target
        // A finished fade-out has nothing left to draw; drop the set so it
        // cannot linger invisibly and be re-shown by an unrelated redraw.
        if (h.target === 0) {
          h.links = []
          h.nodes = new Set()
        }
        fadeRef.current = 0
        drawRef.current?.()
      }
    }
    fadeRef.current = requestAnimationFrame(tick)
  }, [])

  /**
   * Ease every unresolved card's `hover`/`pick` channel toward its target.
   *
   * Same shape as `runFade`: a self-stopping rAF ticker, with a velocity that is
   * smallest at both ends so the transition accelerates then decelerates instead
   * of moving at a constant rate. It stops the moment nothing is in motion.
   */
  const runCardFade = useCallback((): void => {
      // The ticker reads targets from a REF each frame instead of closing over
      // the map it was started with. Capturing them meant a call made while a
      // fade was already running was dropped on the floor — so hovering a second
      // card before the first finished simply did nothing.
      if (uAnimFrameRef.current) return
      let prev = performance.now()
      const tick = (now: number): void => {
        const dt = Math.min(64, now - prev)
        prev = now
        const step = dt / CARD_FADE_MS
        let moving = false
        const targets = uTargetsRef.current
        for (const [id, want] of targets) {
          const cur = uAnimRef.current.get(id) ?? { hover: 0, pick: 0 }
          for (const ch of ['hover', 'pick'] as const) {
            const to = want[ch]
            const at = cur[ch]
            if (Math.abs(to - at) <= 0.004) {
              cur[ch] = to
              continue
            }
            const speed = 0.4 + 2.6 * at * (1 - at)
            cur[ch] = to > at ? Math.min(to, at + step * speed) : Math.max(to, at - step * speed)
            moving = true
          }
          if (cur.hover === 0 && cur.pick === 0) {
            uAnimRef.current.delete(id)
            // Settled at rest AND wanted at rest: it has nothing left to say, so
            // drop it from the targets too. Leaving it in made the map grow by
            // one entry per card ever touched, and every later frame re-walked
            // all of them.
            if (want.hover === 0 && want.pick === 0) targets.delete(id)
          } else uAnimRef.current.set(id, cur)
        }
        drawRef.current?.()
        uAnimFrameRef.current = moving ? requestAnimationFrame(tick) : 0
      }
      uAnimFrameRef.current = requestAnimationFrame(tick)
  }, [])

  /**
   * Point the fade at a new set of citations (empty = fade out).
   *
   * `focusId` is the paper being hovered, if any: it is EXCLUDED from the
   * related-node set so it keeps its own full-strength hover treatment rather
   * than being repainted as one of its own neighbours.
   */
  const setHighlight = useCallback(
    (links: LayoutLink[], focusId?: number): void => {
      const h = highlightRef.current
      if (links.length > 0) {
        h.links = links
        const nodes = new Set<number>()
        for (const l of links) {
          if (l.citingId !== focusId) nodes.add(l.citingId)
          if (l.citedId !== focusId) nodes.add(l.citedId)
        }
        h.nodes = nodes
        h.target = 1
      } else {
        h.target = 0
      }
      runFade()
    },
    [runFade]
  )

  /**
   * work id -> every citation it takes part in, as citer OR as cited. Built
   * once per layout so a hover is a map lookup rather than a scan of every
   * edge; on a 10k-edge corpus that difference is the whole frame budget.
   */
  const linksByNode = useMemo(() => {
    const m = new Map<number, LayoutLink[]>()
    const add = (id: number, l: LayoutLink): void => {
      const a = m.get(id)
      if (a) a.push(l)
      else m.set(id, [l])
    }
    for (const l of [...layout.primary, ...layout.secondary]) {
      add(l.citingId, l)
      add(l.citedId, l)
    }
    return m
  }, [layout])

  const thumbsRef = useRef<ThumbCache | null>(null)
  if (thumbsRef.current === null) thumbsRef.current = new ThumbCache(() => requestDraw())
  useEffect(() => {
    const cache = thumbsRef.current
    return () => cache?.dispose()
  }, [])

  const drawRef = useRef<(() => void) | null>(null)

  // Painter. Kept in a ref (not a useCallback dependency chain) so the zoom
  // handler can trigger it without re-subscribing on every transform tick.
  drawRef.current = () => {
    const canvas = canvasRef.current
    const host = hostRef.current
    const thumbs = thumbsRef.current
    if (!canvas || !host || !thumbs) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    const w = host.clientWidth
    const h = host.clientHeight
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
    }

    const t = transformRef.current
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    ctx.save()
    ctx.translate(t.x, t.y)
    ctx.scale(t.k, t.k)

    // World-space viewport, padded by one card so partially visible cards draw.
    const vx0 = -t.x / t.k - NODE_W
    const vy0 = -t.y / t.k - NODE_H
    const vx1 = (w - t.x) / t.k + NODE_W
    const vy1 = (h - t.y) / t.k + NODE_H

    const linkVisible = (l: LayoutLink): boolean =>
      Math.max(l.x1, l.x2) >= vx0 &&
      Math.min(l.x1, l.x2) <= vx1 &&
      Math.max(l.y1, l.y2) >= vy0 &&
      Math.min(l.y1, l.y2) <= vy1

    const curve = (l: LayoutLink): void => {
      const x1 = l.x1 + NODE_W / 2
      const x2 = l.x2 - NODE_W / 2
      const mx = (x1 + x2) / 2
      ctx.moveTo(x1, l.y1)
      ctx.bezierCurveTo(mx, l.y1, mx, l.y2, x2, l.y2)
    }

    // EVERY link is one thing: "this paper cites that one". Which of them the
    // layout happened to hang the card from is an implementation detail of the
    // tree, not a property of the citation, so it gets no visual distinction —
    // drawing some solid and some dashed asserted a difference in MEANING that
    // does not exist.
    ctx.lineWidth = 1.2 / t.k
    ctx.strokeStyle = COL_LINE
    ctx.beginPath()
    for (const l of layout.primary) if (linkVisible(l)) curve(l)
    for (const l of layout.secondary) if (linkVisible(l)) curve(l)
    ctx.stroke()

    // Links to cited-but-absent papers, dashed to match their dashed cards —
    // the citation is real, the paper is simply not held here.
    ctx.save()
    ctx.setLineDash([5 / t.k, 4 / t.k])
    ctx.strokeStyle = COL_LINE
    ctx.lineWidth = 1.2 / t.k
    ctx.beginPath()
    for (const l of layout.unresolvedLinks) if (linkVisible(l)) curve(l)
    ctx.stroke()
    ctx.restore()

    // Highlighted citations, redrawn on top — either the one link under the
    // pointer, or every citation of the card under it. Fading in rather than
    // snapping keeps the eye on the paper the user is reading instead of
    // yanking it to a hard colour change.
    const hi = highlightRef.current
    if (hi.links.length > 0 && hi.alpha > 0.01) {
      ctx.save()
      // Muted, not full accent: these are the CONTEXT around the hovered paper,
      // so they read as related without competing with it. The related cards
      // below use the same hue at the same strength, so the lines and the
      // papers they reach are visibly ONE set.
      ctx.globalAlpha = hi.alpha * RELATED_ALPHA
      ctx.lineWidth = 2.4 / t.k
      ctx.strokeStyle = COL_ACCENT
      ctx.beginPath()
      for (const l of hi.links) if (linkVisible(l)) curve(l)
      ctx.stroke()
      ctx.restore()
    }

    const wantThumbs = t.k >= THUMB_MIN_K
    const wantText = t.k >= TEXT_MIN_K

    // ---- cited-but-absent papers, drawn UNDER the real cards ----------------
    // Dashed border and a "?" where the page preview goes: the paper is real
    // (it was printed in a bibliography) but the corpus does not hold it, so
    // there is no document to show. Drawn first so a real card always wins the
    // overlap.
    let visibleUnresolved = 0
    for (const u of layout.unresolved) {
      if (u.cx + NODE_W / 2 < vx0 || u.cx - NODE_W / 2 > vx1) continue
      if (u.cy + NODE_H / 2 < vy0 || u.cy - NODE_H / 2 > vy1) continue
      visibleUnresolved++
      const ux = u.cx - NODE_W / 2
      const uy = u.cy - NODE_H / 2
      const status = statusOf(u.node)
      const failed = status === 'failed'
      // Picking a paper's cited unknowns outlines EVERY one of them, and the
      // ones actually picked are outlined harder — the user can see what they
      // are choosing FROM, not only what they have chosen. A card standing for a
      // paper cited by several works is in scope when ANY of them is the target:
      // it IS one of that paper's references.
      const inScope =
        selectionWorkId !== null &&
        u.node.citing_work_ids.includes(selectionWorkId) &&
        isPickable(u.node)
      // Animated 0..1 channels, but the TRUTH is the pointer and the selection —
      // the animation only says how far the paint has caught up. Reading the
      // animation alone let a settled entry mask the real state: a card whose
      // entry was still alive (kept by `pick`) painted hover=0 while the pointer
      // was on it, so some cards silently stopped responding to hover while
      // still selecting on click.
      const wantHover = hoverRefRef.current === u.node.id ? 1 : 0
      const wantPick = selectedRefs.has(u.node.id) ? 1 : 0
      const anim = uAnimRef.current.get(u.node.id)
      // Snap to the target when there is no entry, or when the entry disagrees
      // with reality and no fade is running to reconcile it.
      const settled = uAnimFrameRef.current === 0
      const hoverT = anim && !(settled && anim.hover !== wantHover) ? anim.hover : wantHover
      const pickT = anim && !(settled && anim.pick !== wantPick) ? anim.pick : wantPick
      // Retrieval in flight is a state the card is BUSY in, not one the user can
      // act on, so it reads as neither hovered nor picked however it is drawn.
      const busy = status === 'retrieving'

      // Base face, then the two washes layered on it in order of authority:
      // failure (what happened) < selection (what the user chose). Hover tints
      // the face only faintly — the border carries the hover, so a hovered card
      // and a picked one never look alike.
      let face = failed ? COL_FAIL_FILL : COL_PANEL
      if (busy) face = mix(face, COL_ACCENT, 0.05)
      // A picked card keeps a trace of WHY it is notable: blending the selection
      // wash only part-way over a failed face leaves the red readable, so
      // "picked" never erases "this one already failed".
      face = mix(face, COL_SELECT_FILL, pickT * (failed ? 0.55 : 1))
      face = mix(face, COL_SELECT_FILL, hoverT * 0.45)

      // Border: picked is the strongest and fully saturated; hover is the same
      // hue but softer, so hovering PREVIEWS the pick it would produce; in-scope
      // is quieter still; otherwise the card's own resting colour.
      const resting = busy ? COL_ACCENT : failed ? COL_FAIL : COL_BORDER
      let border = inScope ? mix(resting, COL_SELECT_SOFT, 0.75) : resting
      border = mix(border, COL_SELECT_SOFT, hoverT)
      border = mix(border, COL_SELECT, pickT)
      // Hovering an ALREADY-picked card still has to answer: it brightens the
      // border rather than changing hue, so the card reads as "picked, and you
      // are on it" instead of going inert under the pointer.
      if (pickT > 0.01 && hoverT > 0.01) border = mix(border, COL_INK, hoverT * 0.3)

      ctx.save()
      ctx.setLineDash([5 / t.k, 4 / t.k])
      ctx.fillStyle = face
      ctx.strokeStyle = border
      // An in-scope card is dimmed to sit behind the ones the user is acting on,
      // and hover/pick lift it back to full — so the card under the pointer is
      // never the faint one.
      const dim = inScope ? 0.62 + 0.38 * Math.max(hoverT, pickT) : 1
      ctx.globalAlpha = dim
      ctx.lineWidth = strokeWidth(1 + 0.8 * (inScope ? 1 : 0) + 1.4 * Math.max(hoverT, pickT), t.k)
      roundRect(ctx, ux, uy, NODE_W, NODE_H, 10)
      ctx.fill()
      ctx.stroke()

      // A picked card also gets a solid ring OUTSIDE its dashed edge: the dash
      // says "not in the corpus" and the ring says "you chose this", so the two
      // facts stay separately legible instead of one overwriting the other.
      //
      // A reference that names nothing to look up gets a BROKEN, muted ring
      // instead. It is still chosen — it can be read — but it is not one of the
      // fetches the button is about to make, and a ring identical to the
      // retrievable one made four picked cards stand behind a button offering
      // two, which reads as a miscount rather than as a shortfall.
      if (pickT > 0.01) {
        const lookupable = u.node.retrieval_kind !== null
        if (lookupable) ctx.setLineDash([])
        else ctx.setLineDash([2 / t.k, 3 / t.k])
        ctx.globalAlpha = dim * pickT * (lookupable ? 1 : 0.7)
        ctx.strokeStyle = lookupable ? COL_SELECT : mix(COL_SELECT, COL_MUTED, 0.65)
        ctx.lineWidth = strokeWidth((lookupable ? 1.5 : 1.1) + 0.9 * hoverT, t.k)
        // The ring steps outward under the pointer, so hovering a picked card
        // reads as a change even where colour alone would not.
        const pad = (3 + 1.5 * hoverT) / t.k
        roundRect(ctx, ux - pad, uy - pad, NODE_W + pad * 2, NODE_H + pad * 2, 10 + pad)
        ctx.stroke()
      }
      ctx.restore()

      const utx = ux + 10
      const uty = uy + (NODE_H - THUMB_H) / 2
      ctx.fillStyle = COL_PLACEHOLDER
      roundRect(ctx, utx, uty, THUMB_W, THUMB_H, 3)
      ctx.fill()
      if (wantThumbs && wantText) {
        ctx.fillStyle = COL_MUTED
        ctx.font = '600 22px "Instrument Sans", system-ui, sans-serif'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText('?', utx + THUMB_W / 2, uty + THUMB_H / 2)
        ctx.textAlign = 'left'
        ctx.textBaseline = 'alphabetic'
      }
      if (!wantText) continue
      const utextX = utx + THUMB_W + 10
      const utextW = NODE_W - (utextX - ux) - 10
      // "not in corpus" leads on its OWN line, with the year beneath it: joined
      // as `1996 · not in corpus` the pair overran the 96px text column, and
      // the status is what distinguishes this card from a real one.
      ctx.font = '500 9px "Geist Mono", ui-monospace, monospace'
      // A retrieval in flight REPLACES the status line rather than adding to it:
      // "not in corpus" and "Retrieving…" are the same slot answering the same
      // question, and the second is the newer answer.
      if (status === 'retrieving') {
        ctx.fillStyle = COL_ACCENT
        ctx.fillText(ellipsize(ctx, 'Retrieving…', utextW), utextX, uy + 16)
        ctx.fillStyle = COL_MUTED
        ctx.fillText(String(u.node.year ?? '—'), utextX, uy + 28)
      } else if (failed) {
        // The failure gets its OWN line beneath the status: it qualifies "not in
        // corpus" (we tried, and it did not work), so collapsing the two would
        // lose the fact that an attempt was made at all.
        ctx.fillStyle = COL_MUTED_2
        ctx.fillText(ellipsize(ctx, 'not in corpus', utextW), utextX, uy + 14)
        ctx.fillStyle = COL_FAIL
        ctx.fillText(ellipsize(ctx, '(failed)', utextW), utextX, uy + 25)
      } else {
        ctx.fillStyle = COL_MUTED_2
        ctx.fillText(ellipsize(ctx, 'not in corpus', utextW), utextX, uy + 16)
        ctx.fillStyle = COL_MUTED
        ctx.fillText(String(u.node.year ?? '—'), utextX, uy + 28)
      }
      ctx.fillStyle = COL_MUTED
      ctx.font = '600 11px "Instrument Sans", system-ui, sans-serif'
      // `withYear: false` — the year already has its own line above this slot.
      wrapText(ctx, referenceLabel(u.node, { withYear: false }), utextX, uy + 42, utextW, 13, 3)
    }

    const visible: PlacedNode[] = []
    for (const p of layout.placed) {
      if (p.cx + NODE_W / 2 < vx0 || p.cx - NODE_W / 2 > vx1) continue
      if (p.cy + NODE_H / 2 < vy0 || p.cy - NODE_H / 2 > vy1) continue
      visible.push(p)
    }

    const x = (p: PlacedNode): number => p.cx - NODE_W / 2
    const y = (p: PlacedNode): number => p.cy - NODE_H / 2

    for (const p of visible) {
      const hovered = hoverRef.current === p.node.id
      // A paper at the far end of a highlighted citation. Tinted at the SAME
      // strength as those lines so the whole neighbourhood reads as one set,
      // and always weaker than the hovered card itself.
      const related = hi.alpha > 0.01 && hi.nodes.has(p.node.id)
      const relTint = related ? hi.alpha * RELATED_ALPHA : 0
      ctx.fillStyle = related ? mixAccent(COL_PANEL, relTint * 0.16) : COL_PANEL
      ctx.strokeStyle = hovered
        ? COL_ACCENT
        : related
          ? mixAccent(COL_BORDER, relTint)
          : COL_BORDER
      ctx.lineWidth = strokeWidth(hovered ? 2 : related ? 1.8 : 1, t.k)
      roundRect(ctx, x(p), y(p), NODE_W, NODE_H, 10)
      ctx.fill()
      ctx.stroke()

      const tx = x(p) + 10
      const ty = y(p) + (NODE_H - THUMB_H) / 2
      const raster = wantThumbs ? thumbs.get(p.node.id) : null
      if (raster && raster.width > 0) {
        ctx.drawImage(raster, tx, ty, THUMB_W, THUMB_H)
        ctx.strokeStyle = COL_BORDER
        ctx.lineWidth = 1 / t.k
        ctx.strokeRect(tx, ty, THUMB_W, THUMB_H)
      } else {
        // A cover that could not be HAD is a different tile from one the paper
        // never has. Initials say "this is the paper, it just has no PDF"; a
        // file on a disconnected drive would be telling the reader a falsehood
        // they have no way to notice, so it gets a tinted tile and a warning
        // mark instead — shape as well as colour, so it survives at any zoom.
        const cover = wantThumbs ? thumbs.stateOf(p.node.id) : undefined
        const coverFailed = cover?.kind === 'failed'
        ctx.fillStyle = coverFailed ? COL_FAIL_FILL : COL_PLACEHOLDER
        roundRect(ctx, tx, ty, THUMB_W, THUMB_H, 3)
        ctx.fill()
        if (coverFailed) {
          ctx.strokeStyle = COL_FAIL
          ctx.lineWidth = 1 / t.k
          ctx.stroke()
        }
        if (wantThumbs && wantText) {
          if (coverFailed) {
            const cx = tx + THUMB_W / 2
            const cy = ty + THUMB_H / 2
            ctx.strokeStyle = COL_FAIL
            ctx.lineWidth = 1.6 / t.k
            ctx.lineCap = 'round'
            ctx.lineJoin = 'round'
            ctx.beginPath()
            ctx.moveTo(cx, cy - 9)
            ctx.lineTo(cx + 9, cy + 7)
            ctx.lineTo(cx - 9, cy + 7)
            ctx.closePath()
            ctx.stroke()
            ctx.beginPath()
            ctx.moveTo(cx, cy - 3)
            ctx.lineTo(cx, cy + 1)
            ctx.stroke()
            ctx.beginPath()
            ctx.moveTo(cx, cy + 4)
            ctx.lineTo(cx, cy + 4.4)
            ctx.stroke()
          } else {
            // The paper's initials stand in, so the card is still identifiable
            // instead of an empty grey box.
            ctx.fillStyle = COL_MUTED
            ctx.font = '600 15px "Instrument Sans", system-ui, sans-serif'
            ctx.textAlign = 'center'
            ctx.textBaseline = 'middle'
            ctx.fillText(initials(p.node.title), tx + THUMB_W / 2, ty + THUMB_H / 2)
            ctx.textAlign = 'left'
            ctx.textBaseline = 'alphabetic'
          }
        }
      }

      if (!wantText) continue
      const textX = tx + THUMB_W + 10
      const textW = NODE_W - (textX - x(p)) - 10
      ctx.fillStyle = COL_MUTED
      ctx.font = '500 9px "Geist Mono", ui-monospace, monospace'
      // Depth is already conveyed by the column the card sits in; printing it
      // as "D3" only adds jargon to every card.
      ctx.fillText(`${p.node.year ?? '—'}`, textX, y(p) + 22)
      ctx.fillStyle = COL_INK
      ctx.font = '600 11px "Instrument Sans", system-ui, sans-serif'
      wrapText(ctx, p.node.title, textX, y(p) + 38, textW, 13, 3)
    }

    ctx.restore()

    // ---- thumbnail scheduling, budgeted so panning never stalls ----
    if (wantThumbs) {
      const keep = new Set(visible.map((p) => p.node.id))
      thumbs.cancelAllExcept(keep)
      const start = performance.now()
      for (const p of visible) {
        if (thumbs.inflightCount >= MAX_INFLIGHT) break
        if (performance.now() - start >= BUDGET_MS) break
        if (p.node.document_id === null) continue
        if (thumbs.stateOf(p.node.id) !== undefined) continue
        thumbs.request(p.node.id, p.node.document_id)
      }
      // More cards want rasters than the budget allowed: come back next frame.
      if (
        thumbs.inflightCount > 0 ||
        visible.some((p) => p.node.document_id !== null && thumbs.stateOf(p.node.id) === undefined)
      ) {
        requestDraw()
      }
    }

    // BOTH populations, because the canvas draws both. Counting only
    // `layout.placed` reported "4 of 4 cards in view" over a canvas holding
    // ~50 — cited-but-absent cards are the overwhelming majority on this
    // corpus, and a reader who can SEE them being told they are not there has
    // no way to know which of the two numbers to distrust.
    const shown = visible.length + visibleUnresolved
    if (shown !== visibleCount) setVisibleCount(shown)
    const pct = Math.round(t.k * 100)
    if (pct !== zoomPct) setZoomPct(pct)
  }

  // Zoom / pan + initial fit.
  useEffect(() => {
    const canvas = canvasRef.current
    const host = hostRef.current
    if (!canvas || !host) return
    const sel = d3.select<HTMLCanvasElement, unknown>(canvas)
    const zoom = d3
      .zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([0.04, 3])
      .on('zoom', (ev: d3.D3ZoomEvent<HTMLCanvasElement, unknown>) => {
        transformRef.current = ev.transform
        // The menu is anchored to a screen position derived from the OLD
        // transform, so any pan or zoom invalidates it. Closing is the honest
        // response; re-projecting would have it slide around under the cursor.
        setMenu(null)
        requestDraw()
      })
    sel.call(zoom)
    zoomRef.current = zoom

    // Opening view: fit the whole forest when it fits, but never below
    // MIN_OPEN_K — a project with a thousand roots is tens of thousands of
    // world-pixels tall, and fitting that literally would open on an unreadable
    // 2% smear. Beyond that scale the tree is anchored at its top-left (the
    // OLDEST roots, which is where reading starts) and the user pans.
    // No floor on the opening zoom.
    //
    // A 0.5 floor was fine while the tree drew six references per paper, and
    // wrong once it draws all of them: the content is then far wider than the
    // pane, so clamping the fit scale left every card outside the viewport and
    // the canvas looked empty ("0 of 24 cards in view"). The fit must be
    // whatever actually fits; the user zooms in from there.
    const PAD = 40
    const { x0, y0, x1, y1 } = layout.bounds
    const w = host.clientWidth || 800
    const h = host.clientHeight || 600
    const fit = Math.min(w / (x1 - x0 + PAD * 2), h / (y1 - y0 + PAD * 2))
    const k = Math.min(1, fit)
    const axis = (span: number, extent: number, lo: number): number =>
      span * k <= extent ? (extent - span * k) / 2 - lo * k : PAD - lo * k
    // Fit ONCE per project. Re-fitting on every layout would throw the user's
    // pan and zoom away each time the tree is re-read — and retrieving a
    // reference re-reads it, so the view jumped the moment a card updated.
    // Later reloads re-attach the zoom behaviour but keep where the user is.
    if (fittedForRef.current !== projectId) {
      fittedForRef.current = projectId
      sel.call(
        zoom.transform,
        d3.zoomIdentity.translate(axis(x1 - x0, w, x0), axis(y1 - y0, h, y0)).scale(k)
      )
    } else {
      // d3 stores the current transform on the node; a fresh zoom behaviour
      // starts at identity and would silently teleport the view on the next
      // gesture unless it is told where the user actually is.
      sel.call(zoom.transform, transformRef.current)
    }

    const ro = new ResizeObserver(() => requestDraw())
    ro.observe(host)
    return () => {
      ro.disconnect()
      sel.on('.zoom', null)
      // The fade ticker outlives this effect if left running, and would keep
      // calling draw against a canvas that is gone.
      if (fadeRef.current) {
        cancelAnimationFrame(fadeRef.current)
        fadeRef.current = 0
      }
      if (uAnimFrameRef.current) {
        cancelAnimationFrame(uAnimFrameRef.current)
        uAnimFrameRef.current = 0
      }
      uAnimRef.current.clear()
      uTargetsRef.current.clear()
      highlightRef.current = { links: [], nodes: new Set(), alpha: 0, target: 0 }
    }
  }, [layout, requestDraw])

  /**
   * Aim every animating card at where its state says it should be.
   *
   * Targets are computed from the union of what is CURRENTLY animating and what
   * is now hovered/picked: a card that just lost both still needs a target of 0
   * to ease back down, so dropping it here would make it snap instead.
   */
  const retargetCards = useCallback(() => {
    const ids = new Set<number>(uAnimRef.current.keys())
    for (const id of selectedRefs) ids.add(id)
    if (hoverRefRef.current !== null) ids.add(hoverRefRef.current)
    // Written in place: the ticker holds this same map, so an update reaches a
    // fade that is already running.
    const targets = uTargetsRef.current
    targets.clear()
    for (const id of ids) {
      targets.set(id, {
        hover: hoverRefRef.current === id ? 1 : 0,
        pick: selectedRefs.has(id) ? 1 : 0
      })
      if (!uAnimRef.current.has(id)) uAnimRef.current.set(id, { hover: 0, pick: 0 })
    }
    runCardFade()
  }, [selectedRefs, runCardFade])

  // Selection and retrieval state affect only the PAINT, so a change repaints
  // rather than re-laying-out: rebuilding the layout would re-run d3.tree on
  // every single toggle, and the cards would be in the same places afterwards.
  useEffect(() => {
    retargetCards()
    requestDraw()
  }, [selectionWorkId, selectedRefs, statusOf, requestDraw, retargetCards])

  /** client coords -> world coords, or null when the canvas is not mounted. */
  const toWorld = (clientX: number, clientY: number): { wx: number; wy: number } | null => {
    const canvas = canvasRef.current
    if (!canvas) return null
    const r = canvas.getBoundingClientRect()
    const t = transformRef.current
    return { wx: (clientX - r.left - t.x) / t.k, wy: (clientY - r.top - t.y) / t.k }
  }

  /**
   * world coords -> client coords. The exact inverse of `toWorld`, and the only
   * way a DOM overlay can be put on top of something the canvas painted.
   */
  const toClient = (wx: number, wy: number): { x: number; y: number } | null => {
    const canvas = canvasRef.current
    if (!canvas) return null
    const t = transformRef.current
    return { x: wx * t.k + t.x, y: wy * t.k + t.y }
  }

  const hitTest = (clientX: number, clientY: number): PlacedNode | null => {
    const p0 = toWorld(clientX, clientY)
    if (!p0) return null
    for (const p of layout.placed) {
      if (Math.abs(p0.wx - p.cx) <= NODE_W / 2 && Math.abs(p0.wy - p.cy) <= NODE_H / 2) return p
    }
    return null
  }

  /** The cited-but-absent card under the pointer, if any. */
  const hitTestUnresolved = (clientX: number, clientY: number): PlacedUnresolved | null => {
    const p0 = toWorld(clientX, clientY)
    if (!p0) return null
    for (const u of layout.unresolved) {
      if (Math.abs(p0.wx - u.cx) <= NODE_W / 2 && Math.abs(p0.wy - u.cy) <= NODE_H / 2) return u
    }
    return null
  }

  /**
   * The link under the pointer, by sampling the SAME cubic the draw pass uses —
   * an analytic distance-to-bezier is not worth it for a hover test, and
   * sampling cannot drift from the rendered curve the way a straight-line
   * approximation would.
   *
   * Tolerance is in SCREEN pixels converted back to world units, so a link stays
   * equally easy to hit at every zoom level. Cards are hit-tested first and win
   * ties: a link passing behind a card must not steal its click.
   */
  const hitTestLink = (clientX: number, clientY: number): LayoutLink | null => {
    const p0 = toWorld(clientX, clientY)
    if (!p0) return null
    const t = transformRef.current
    const tol = 6 / t.k
    const SAMPLES = 18
    let best: LayoutLink | null = null
    let bestD = tol
    for (const l of [...layout.primary, ...layout.secondary]) {
      const x1 = l.x1 + NODE_W / 2
      const x2 = l.x2 - NODE_W / 2
      // Cheap reject before sampling: the curve never leaves this box.
      if (
        p0.wx < Math.min(x1, x2) - tol ||
        p0.wx > Math.max(x1, x2) + tol ||
        p0.wy < Math.min(l.y1, l.y2) - tol ||
        p0.wy > Math.max(l.y1, l.y2) + tol
      ) {
        continue
      }
      const mx = (x1 + x2) / 2
      for (let i = 0; i <= SAMPLES; i++) {
        const s = i / SAMPLES
        const u = 1 - s
        const bx = u * u * u * x1 + 3 * u * u * s * mx + 3 * u * s * s * mx + s * s * s * x2
        const by = u * u * u * l.y1 + 3 * u * u * s * l.y1 + 3 * u * s * s * l.y2 + s * s * s * l.y2
        const d = Math.hypot(p0.wx - bx, p0.wy - by)
        if (d < bestD) {
          bestD = d
          best = l
        }
      }
    }
    return best
  }

  return (
    <div className="rt-canvas-host" ref={hostRef}>
      <canvas
        ref={canvasRef}
        className="rt-canvas"
        data-testid="references-canvas"
        onMouseMove={(e) => {
          // Cards win over links: a link passing behind a card must not steal
          // the pointer from it.
          const hit = hitTest(e.clientX, e.clientY)
          const id = hit?.node.id ?? null
          const u = hit ? null : hitTestUnresolved(e.clientX, e.clientY)
          // An unresolved card is selectable on its own — picking one IS the
          // gesture, so it must not require entering a mode from a paper first.
          const refId = u && isPickable(u.node) ? u.node.id : null
          const link = hit || u ? null : hitTestLink(e.clientX, e.clientY)
          if (
            id !== hoverRef.current ||
            refId !== hoverRefRef.current ||
            link !== hoverLinkRef.current
          ) {
            hoverRef.current = id
            hoverRefRef.current = refId
            hoverLinkRef.current = link
            if (canvasRef.current) {
              // `pointer` ONLY over something that actually responds to a click;
              // bare canvas keeps `grab`, which is what it really does.
              canvasRef.current.style.cursor =
                id !== null || refId !== null || link !== null ? 'pointer' : 'grab'
            }
            // A card lights up EVERY citation it takes part in — the same
            // emphasis one link gets, applied to the whole set, so hovering a
            // paper answers "what does this connect to?" in one move.
            if (id !== null) setHighlight(linksByNode.get(id) ?? [], id)
            else if (link) setHighlight([link])
            else setHighlight([])
            retargetCards()
            requestDraw()
          }
        }}
        onMouseLeave={() => {
          hoverRef.current = null
          hoverRefRef.current = null
          hoverLinkRef.current = null
          setHighlight([])
          retargetCards()
          if (canvasRef.current) canvasRef.current.style.cursor = 'grab'
          requestDraw()
        }}
        onClick={(e) => {
          const hit = hitTest(e.clientX, e.clientY)
          if (hit) {
            // A click on a paper opens its profile: what the paper IS, and
            // what can be done with it.
            //
            // VIEWPORT coords, not canvas-relative. `toClient` answers relative
            // to the canvas, which is right for something drawn inside it — but
            // this card is portalled to <body> and fixed-positioned to escape
            // `.rt-canvas-host`'s `overflow: hidden`, so it needs the canvas's
            // own offset added back.
            const at = toClient(hit.cx + NODE_W / 2, hit.cy - NODE_H / 2)
            const r = canvasRef.current?.getBoundingClientRect()
            if (at && r) {
              setMenu({
                workId: hit.node.id,
                title: hit.node.title,
                x: at.x + r.left,
                y: at.y + r.top
              })
            }
            return
          }
          const u = hitTestUnresolved(e.clientX, e.clientY)
          if (u) {
            if (isPickable(u.node)) onToggleRef(u.node.id)
            return
          }
          const link = hitTestLink(e.clientX, e.clientY)
          if (link) {
            // The card is what the click is FOR: the zoom moved the view and
            // said nothing about why one paper cites the other.
            void openEdgeCard(link, e.clientX, e.clientY)
          }
        }}
      />
      {/* The citation evidence card, opened by clicking a line. Same component
          and classes as the connectome's pinned card: the same citation must
          read the same wherever it is met. Portalled and positioned from the
          pointer because the tree is a canvas — there is no element to anchor
          a popover to — and `.cg-edgecard` is `position: fixed`, which would
          otherwise resolve against `.screen`'s animated transform. */}
      {(edgeCard || edgeCardLoading || edgeCardNone) &&
        createPortal(
          <>
            <div
              className="rt-menu-scrim"
              data-testid="references-edgecard-scrim"
              onClick={() => {
                setEdgeCard(null)
                setEdgeCardNone(false)
              }}
            />
            {/* The click has to answer immediately. Fetching the edge takes a
                round trip, and rendering only the scrim meanwhile left a
                dismissable nothing on screen — the next click looked like it
                had done something when it had only closed an invisible sheet. */}
            {!edgeCard && edgeCardLoading && (
              <div
                className="cg-edgecard cg-edgecard-pinned rt-edgecard-busy mono"
                data-testid="references-edgecard-loading"
                style={cardStyle(edgeCardAt.x, edgeCardAt.y, 200, 44)}
              >
                Reading the citation…
              </div>
            )}
            {!edgeCard && !edgeCardLoading && edgeCardNone && (
              <div
                className="cg-edgecard cg-edgecard-pinned rt-edgecard-busy mono"
                data-testid="references-edgecard-none"
                style={cardStyle(edgeCardAt.x, edgeCardAt.y, 240, 44)}
              >
                No citation record behind that line.
              </div>
            )}
            {edgeCard ? (
            <div
              className="cg-edgecard cg-edgecard-pinned"
              data-testid="references-edgecard"
              style={cardStyle(edgeCard.x, edgeCard.y, 460, 420)}
            >
              <div className="cg-edgecard-head cg-edgecard-bar mono">
                <span className="cg-edgecard-type">{edgeCard.edge.edge_type}</span>
                <span className="cg-edgecard-n">{occurrenceCount(edgeCard.edge)}</span>
                <button
                  type="button"
                  className="cg-edgecard-close"
                  data-testid="references-edgecard-close"
                  aria-label="Close citation evidence"
                  data-tip="Close"
                  onClick={() => setEdgeCard(null)}
                >
                  <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden="true">
                    <path d="M3 3l6 6M9 3l-6 6" />
                  </svg>
                </button>
              </div>
              <div className="cg-edgecard-scroll">
                <EvidenceBody
                  edge={edgeCard.edge}
                  interactive
                  onOpenWork={onOpenWork}
                  onOpenQuote={onOpenQuote}
                />
              </div>
            </div>
            ) : null}
          </>,
          document.body
        )}
      {/* PORTALLED to <body>, like the evidence card above it. `.rt-canvas-host`
          is `overflow: hidden`, which CLIPS an absolutely-positioned child at
          the panel edge whatever its z-index — clipping is not a stacking
          problem. Clicking a node in the right half of the canvas sliced the
          card's whole right column off, buttons included. `cardStyle` also
          flips it back over the cursor near a window edge. */}
      {menu &&
        createPortal(
          <>
            {/*
              Full-frame backdrop, so ANY click outside the card dismisses it —
              including one on the canvas, which would otherwise open a second
              card behind the first.
            */}
            <div
              className="rt-menu-scrim"
              data-testid="references-profile-scrim"
              onClick={() => setMenu(null)}
              onContextMenu={(e) => {
                e.preventDefault()
                setMenu(null)
              }}
            />
            <div
              className="rt-profile-wrap"
              data-testid="references-profile-wrap"
              style={cardStyle(menu.x, menu.y, 560, 480)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setMenu(null)
              }}
            >
            <PaperProfileCard
              workId={menu.workId}
              projectId={projectId}
              title={menu.title}
              hiddenUnknowns={hiddenUnknowns}
              onRead={() => {
                const id = menu.workId
                setMenu(null)
                onOpenWork(id)
              }}
              onSelectUnknowns={() => {
                const id = menu.workId
                setMenu(null)
                // Picking cards that are not drawn would be a selection the
                // user cannot see or correct, so asking for it turns them back
                // on. A disabled item would answer a question the user has
                // already answered by choosing it.
                onStartSelection(id)
              }}
            />
            </div>
          </>,
          document.body
        )}
      {/* The denominator is every card the canvas DRAWS — papers in the corpus
          plus the cited-but-absent ones — because that is what the reader is
          counting when they disagree with it. The zoom note names what is
          actually withheld at this scale: below TEXT_MIN_K no title is drawn at
          all, so "zoom in for page previews" described the lesser of two
          omissions while the cards were unreadable rectangles. */}
      <div className="rt-hud mono" data-testid="references-hud">
        {visibleCount} of {layout.placed.length + layout.unresolved.length} cards in view ·{' '}
        {zoomPct}%
        {zoomPct / 100 < TEXT_MIN_K
          ? ' · too far out to draw titles — zoom in'
          : zoomPct / 100 < THUMB_MIN_K
            ? ' · zoom in for page previews'
            : ''}
        {/* Hiding the unknowns must not make them UNKNOWABLE. The denominator
            above silently shrinks when they go, so without this the tree would
            read as a complete bibliography — the exact overstatement drawing
            them exists to prevent. */}
        {hiddenUnknowns > 0 && ` · ${hiddenUnknowns} cited unknown${hiddenUnknowns === 1 ? '' : 's'} hidden`}
      </div>
    </div>
  )
}

/**
 * A stroke width in WORLD units that never outgrows the card it outlines.
 *
 * Every stroke here is divided by the zoom so it stays a constant thickness on
 * SCREEN — which is right, and is why a 1px hairline stays a hairline. But
 * nothing bounded it, so as the view zooms out the card shrinks while the
 * stroke does not: at the default 9% a card is 9px tall and its 3.2px border is
 * 37% of that from EACH side, leaving a sliver of face. The card reads as a
 * solid accent rectangle with the text knocked out — which is exactly the
 * "card went bright orange" fault, and why it only happened sometimes: it needs
 * a hover at a zoom far enough out.
 *
 * Capped at a fraction of the card's short side, so a border is always a
 * border. `NODE_H` because it is the smaller dimension and therefore the one
 * that runs out first.
 */
const strokeWidth = (world: number, k: number, cap = 0.12): number =>
  Math.min(world / k, NODE_H * cap)

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

/**
 * Cut `s` to the longest prefix that fits `maxW`, appending the ellipsis.
 *
 * Binary search over `measureText`, so the result is the TRUE rendered width in
 * the current font rather than an estimate from an average character width —
 * proportional faces make "WWW" and "iii" differ by a factor of three, so any
 * per-character guess is wrong for real titles.
 *
 * Deterministic: same string, same font, same box → same cut, every frame.
 */
function ellipsize(ctx: CanvasRenderingContext2D, s: string, maxW: number): string {
  if (ctx.measureText(s).width <= maxW) return s
  const ell = '…'
  const ellW = ctx.measureText(ell).width
  // Not even one character plus the ellipsis fits: the ellipsis alone is the
  // honest answer, and it still must not overflow.
  if (ellW > maxW) return ''
  let lo = 0
  let hi = s.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (ctx.measureText(s.slice(0, mid)).width + ellW <= maxW) lo = mid
    else hi = mid - 1
  }
  // Do not leave a dangling space before the ellipsis.
  return `${s.slice(0, lo).trimEnd()}${ell}`
}

/**
 * Word-wrap into at most `maxLines`, and NEVER exceed `maxW`.
 *
 * Three separate ways the old version overflowed, all fixed here:
 *  1. a single word wider than the box was emitted whole (the KE70 title's
 *     "In-Silico-Designed" is 18 chars) — it is now cut mid-word by measurement;
 *  2. `line + '…'` was drawn without re-measuring, so appending the ellipsis
 *     could push a line that just fitted over the edge;
 *  3. the last line was drawn unmeasured when the text ran out.
 */
function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxW: number,
  lineH: number,
  maxLines: number
): void {
  if (maxW <= 0 || maxLines <= 0) return
  const words = text.split(/\s+/).filter(Boolean)
  const draw = (s: string, i: number): void => ctx.fillText(s, x, y + i * lineH)

  let line = ''
  let row = 0
  for (let i = 0; i < words.length; i++) {
    const word = words[i]
    const trial = line ? `${line} ${word}` : word
    if (ctx.measureText(trial).width <= maxW) {
      line = trial
      continue
    }
    // `trial` does not fit. On the LAST row everything remaining has to be
    // squeezed into what is left, so cut by letter rather than dropping words
    // silently.
    if (row === maxLines - 1) {
      draw(ellipsize(ctx, line ? `${line} ${words.slice(i).join(' ')}` : words.slice(i).join(' '), maxW), row)
      return
    }
    if (line) {
      draw(line, row)
      row++
      line = ''
      i-- // retry this word on the fresh row
      continue
    }
    // A single word wider than the whole box: break it by measurement instead
    // of letting it run past the card edge.
    draw(ellipsize(ctx, word, maxW), row)
    row++
    if (row >= maxLines) return
  }
  if (line) draw(ellipsize(ctx, line, maxW), row)
}

function initials(title: string): string {
  return title
    .split(/\s+/)
    .filter((w) => /[A-Za-z0-9]/.test(w))
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('')
}

// ================================================================= screen
export function ReferencesScreen({
  projectId,
  onOpenWork,
  onOpenQuote,
  onAddPapers
}: {
  projectId: number
  onOpenWork: (workId: number) => void
  /** Open a paper scrolled to the passage carrying this citation text. */
  onOpenQuote?: (workId: number, quote: string) => void
  /** Leave for the Papers screen — the tree is drawn from the papers, so with
   *  none this screen owns the action that fills it. */
  onAddPapers: () => void
}): JSX.Element {
  const state = useAsync<ReferenceTreeDTO>(
    () => window.api.getReferenceTree(projectId, { limit: TREE_LIMIT, unresolvedPerWork: UNRESOLVED_PER_WORK }),
    [projectId]
  )

  return (
    <div className="screen-refs" data-testid="references-screen">
      <DataView
        state={state}
        isEmpty={(t) => t.nodes.length === 0}
        empty={
          <EmptyState
            title="No papers in this project yet."
            hint="This screen walks the citation tree of each paper you collect — what it cites, and which of those you already hold."
            testid="references-empty"
          >
            <div className="empty-state-actions">
              <button
                type="button"
                className="btn btn-primary"
                data-testid="references-empty-add-papers"
                onClick={onAddPapers}
              >
                Add papers
              </button>
            </div>
          </EmptyState>
        }
      >
        {(tree) => (
          <ReferenceTreeBody
            tree={tree}
            projectId={projectId}
            onOpenWork={onOpenWork}
            onOpenQuote={onOpenQuote}
            onRetrieved={state.reload}
          />
        )}
      </DataView>
    </div>
  )
}

function ReferenceTreeBody({
  tree,
  projectId,
  onOpenWork,
  onOpenQuote,
  onRetrieved
}: {
  tree: ReferenceTreeDTO
  projectId: number
  onOpenWork: (workId: number) => void
  /** Open a paper scrolled to the passage carrying this citation text. */
  onOpenQuote?: (workId: number, quote: string) => void
  /**
   * Re-read the tree: when a retrieval batch is queued, and again once any of
   * them settles — a retrieval that succeeded added a real paper, which only a
   * fresh read can move out of the unresolved list.
   */
  onRetrieved: () => void
}): JSX.Element {
  /**
   * How many papers IN THIS CORPUS cite each work — the "who is built on"
   * ranking. Counted from the tree's own edges rather than `citation_count`
   * (which is the world-wide figure the metadata carries): the list exists to
   * choose what to draw, so it must rank by what is actually drawable.
   */
  const citedByCount = useMemo(() => {
    const m = new Map<number, number>()
    for (const n of tree.nodes) m.set(n.id, 0)
    const seen = new Set<string>()
    for (const e of tree.edges) {
      const key = `${e.source}>${e.target}`
      if (seen.has(key) || e.source === e.target) continue
      seen.add(key)
      if (m.has(e.target)) m.set(e.target, (m.get(e.target) ?? 0) + 1)
    }
    return m
  }, [tree])

  const [sortBy, setSortBy] = useState<SortKey>('cited-here')
  const [listQuery, setListQuery] = useState('')
  const ranked = useMemo(() => {
    // Missing values sort LAST in every mode rather than as zero — an unscored
    // paper is unknown, not worst.
    const val = (n: ReferenceTreeNodeDTO): number | null => {
      switch (sortBy) {
        case 'relevance':
          return n.relevance
        case 'expansion':
          return n.expansion_priority
        case 'year':
          return n.year
        case 'citations':
          return n.citation_count
        default:
          return citedByCount.get(n.id) ?? 0
      }
    }
    // Filter FIRST, then sort: the query narrows which papers exist in the list,
    // it does not reorder them. Matching on title only — the row shows the title,
    // so a hit the user cannot see would look like a bug.
    const q = listQuery.trim().toLowerCase()
    const pool = q ? tree.nodes.filter((n) => n.title.toLowerCase().includes(q)) : tree.nodes
    return [...pool].sort((a, b) => {
      const av = val(a)
      const bv = val(b)
      if (av === null && bv === null) return a.id - b.id
      if (av === null) return 1
      if (bv === null) return -1
      return bv - av || a.title.localeCompare(b.title)
    })
  }, [tree.nodes, citedByCount, sortBy, listQuery])

  /**
   * What the right-hand number shows. It follows the SORT: a list ordered by
   * relevance that still printed citation counts would be sorted by a number
   * the reader cannot see.
   */
  const metric = useMemo(() => {
    // THE RANK, never the raw score. Both of these are ordinal and heavily
    // right-skewed — relevances on this corpus have a median near 0.0004 —
    // so `Math.round(raw * 10)` printed "0" beside nearly every paper here
    // while the Ranking screen, which already ranked them, showed the same
    // paper a 7. The SORT above still reads the raw value: it is the
    // measurement, and this column is only where it lands in the order.
    const outOfTen = (v: number | null): string => (v === null ? '—' : `${Math.round(v * 10)}`)
    switch (sortBy) {
      case 'relevance':
        return {
          value: (n: ReferenceTreeNodeDTO): string => outOfTen(relevanceForDisplay(n)),
          tip: (n: ReferenceTreeNodeDTO): string =>
            n.relevance === null
              ? 'Not scored yet.'
              : `Relevance ${Math.round((relevanceForDisplay(n) as number) * 10)}/10 — where this paper sits among the papers scored beside it, not a measurement of its own.`
        }
      case 'expansion':
        return {
          value: (n: ReferenceTreeNodeDTO): string => outOfTen(expansionForDisplay(n)),
          tip: (n: ReferenceTreeNodeDTO): string =>
            n.expansion_priority === null
              ? 'Not scored yet.'
              : `Expansion priority ${Math.round((expansionForDisplay(n) as number) * 10)}/10 — where this paper sits among the papers scored beside it, not a measurement of its own.`
        }
      case 'year':
        return {
          value: (n: ReferenceTreeNodeDTO): string => (n.year === null ? '—' : String(n.year)),
          tip: (n: ReferenceTreeNodeDTO): string =>
            n.year === null ? 'No publication year recorded.' : `Published ${n.year}`
        }
      case 'citations':
        return {
          value: (n: ReferenceTreeNodeDTO): string => String(n.citation_count),
          tip: (n: ReferenceTreeNodeDTO): string =>
            `${n.citation_count} citation${n.citation_count === 1 ? '' : 's'} recorded in the corpus metadata`
        }
      default:
        return {
          value: (_n: ReferenceTreeNodeDTO, c: number): string => String(c),
          tip: (_n: ReferenceTreeNodeDTO, c: number): string =>
            `Cited by ${c} paper${c === 1 ? '' : 's'} in this corpus`
        }
    }
  }, [sortBy])

  // Default: the single most-cited paper. Showing the whole forest at once was
  // the old behaviour and it is unreadable past a few dozen works; starting
  // from the most-built-upon paper is the one choice that needs no explanation.
  const [selected, setSelected] = useState<Set<number>>(() => new Set())
  useEffect(() => {
    setSelected((cur) => {
      const live = new Set([...cur].filter((id) => citedByCount.has(id)))
      if (live.size > 0) return live
      return ranked.length > 0 ? new Set([ranked[0].id]) : live
    })
  }, [ranked, citedByCount])

  /**
   * Whether cited-but-absent papers are drawn.
   *
   * ON by default, because they are real citations and hiding them by default
   * would quietly present a bibliography as complete when it is not. But this
   * corpus parses ~840 of them over 20 papers, and at that density they crowd
   * out the works the tree exists to show — so the reader can put them away.
   *
   * Not persisted: it is a way of looking at the tree in the moment, like the
   * find box beside it, and a stored value would silently hide citations in a
   * later session for a reason the reader had long forgotten.
   */
  const [showUnknowns, setShowUnknowns] = useState(true)

  /** How many there are to hide — the number the switch's tooltip quotes. */
  const unknownCount = tree.unresolved?.length ?? 0

  /**
   * The subtree reachable from the chosen papers: each selected paper, plus
   * everything it (transitively) cites. Selecting a paper asks "what is this
   * built on?", so the ancestry is what has to come with it.
   */
  const shown = useMemo(() => {
    // Hiding drops the unresolved nodes HERE, before the layout is built, so
    // the columns close up instead of leaving the gaps their cards occupied.
    // `buildLayout` also derives the links from this list, so they go with it.
    const withUnknowns = <T extends { unresolved?: UnresolvedReferenceNodeDTO[] }>(t: T): T =>
      showUnknowns ? t : { ...t, unresolved: [] }

    if (selected.size === 0) return withUnknowns(tree)
    const cites = new Map<number, number[]>()
    for (const e of tree.edges) {
      const a = cites.get(e.source)
      if (a) a.push(e.target)
      else cites.set(e.source, [e.target])
    }
    const keep = new Set<number>()
    const stack = [...selected]
    while (stack.length) {
      const id = stack.pop()!
      if (keep.has(id)) continue
      keep.add(id)
      for (const t of cites.get(id) ?? []) stack.push(t)
    }
    return withUnknowns({
      ...tree,
      nodes: tree.nodes.filter((n) => keep.has(n.id)),
      edges: tree.edges.filter((e) => keep.has(e.source) && keep.has(e.target)),
      unresolved: (tree.unresolved ?? [])
        .filter((u) => u.citing_work_ids.some((id) => keep.has(id)))
        // A citer outside the shown subtree has no card to draw a link to, so
        // the node must not claim it.
        .map((u) => ({ ...u, citing_work_ids: u.citing_work_ids.filter((id) => keep.has(id)) }))
    })
  }, [tree, selected, showUnknowns])

  const layout = useMemo(() => buildLayout(shown), [shown])
  const truncated = tree.total_works - tree.shown_works

  const toggle = (id: number): void =>
    setSelected((cur) => {
      const next = new Set(cur)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  // ---- retrieving cited-but-absent papers --------------------------------
  /** The work whose missing citations are being picked; null = not picking. */
  const [selectionWorkId, setSelectionWorkId] = useState<number | null>(null)
  const [selectedRefs, setSelectedRefs] = useState<Set<number>>(() => new Set())
  const [retrieveError, setRetrieveError] = useState<string | null>(null)
  const [retrieving, setRetrieving] = useState(false)
  /**
   * unresolved id -> live retrieval status, read from the DB.
   *
   * The DB is the source of truth (a retrieval must survive a navigation and a
   * restart), and the tree DTO carries a snapshot of it. This overlay holds
   * what has been learned SINCE that snapshot, so a card can flip to
   * "Retrieving…" and later to "(failed)" without re-fetching the whole tree.
   */
  const [live, setLive] = useState<Map<number, ReferenceRetrievalStatus>>(() => new Map())

  const unresolvedById = useMemo(() => {
    const m = new Map<number, UnresolvedReferenceNodeDTO>()
    for (const u of tree.unresolved ?? []) m.set(u.id, u)
    return m
  }, [tree.unresolved])

  const statusOf = useCallback(
    (u: UnresolvedReferenceNodeDTO): ReferenceRetrievalStatus =>
      live.get(u.id) ?? u.retrieval_status,
    [live]
  )

  /**
   * Track the retrievals that are in flight until they settle.
   *
   * The retrieval work runs in main's job queue, entirely off this screen, so
   * the tree is TOLD when something changed rather than asking on a timer. That
   * replaced a 1200ms poll: the push reflects a transition immediately instead
   * of up to a poll-interval late, and costs nothing while the tree is idle —
   * which is its normal state.
   */
  const inFlightIds = useMemo(
    () => (tree.unresolved ?? []).filter((u) => statusOf(u) === 'retrieving').map((u) => u.id),
    [tree.unresolved, statusOf]
  )
  const inFlightKey = inFlightIds.join(',')
  // `inFlightKey` is a total function of `inFlightIds`, so it is a complete
  // dependency; the array itself changes identity every render and would
  // re-create this callback (and re-run the effects below) continuously.
  // Guards against out-of-order responses: two signals can arrive close
  // together, and the SLOWER reply is the older truth. Applying it would flip a
  // card that has already settled back to "retrieving".
  const refreshSeqRef = useRef(0)
  const refreshRetrievals = useCallback(async (): Promise<void> => {
    if (inFlightIds.length === 0) return
    const seq = ++refreshSeqRef.current
    const rows = await window.api.getReferenceRetrievals(inFlightIds)
    if (seq !== refreshSeqRef.current) return
    // Read from `rows`, NOT from inside the updater below: React may defer a
    // functional update to the next render, so a flag set in there is still
    // false when execution reaches the check — and the reload silently never
    // happens. The updater also has to stay pure.
    const settledOne = rows.some((r) => r.retrieval_status !== 'retrieving')
    setLive((cur) => {
      const next = new Map(cur)
      for (const r of rows) next.set(r.unresolved_id, r.retrieval_status)
      return next
    })
    // A retrieval that SUCCEEDED added a real paper to the corpus, which the
    // tree only learns by re-reading. Without this the retrieved paper stayed
    // on screen as an unresolved card until the user navigated away and back.
    if (settledOne) onRetrieved()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inFlightKey])

  // Read once for whatever was already running when the screen opened: the
  // signal only reports FUTURE transitions, so a retrieval that started before
  // this mounted would otherwise sit at "retrieving" until the next one moved.
  useEffect(() => {
    void refreshRetrievals()
  }, [refreshRetrievals])

  useJobsChanged(() => {
    if (inFlightIds.length > 0) {
      // Something this tree is watching may have moved: update those cards in
      // place, which avoids re-laying-out the whole graph on every transition.
      void refreshRetrievals()
      return
    }
    // Nothing of ours is in flight, but a job still finished — an ingest parses
    // citations and inserts NEW unresolved references, which only a fresh read
    // can show. Without this branch the tree quietly stayed as it was while the
    // corpus grew underneath it.
    onRetrieved()
  })

  /**
   * "Select cited unknowns" SELECTS them.
   *
   * It used to only set `selectionWorkId`, which outlines a paper's unknowns as
   * in-scope but leaves them unpicked — so the menu item said "Select" and
   * nothing came out selected, and the cards looked different from the same
   * cards clicked by hand. Everything retrievable is picked up front; the ones
   * already retrieving or failed are skipped, since they are not choices.
   */
  const startSelection = useCallback(
    (workId: number) => {
      // Picking them requires seeing them. Asking to select unknowns while they
      // are switched off is an unambiguous request for them, so it is granted
      // rather than refused — the switch then shows the state it is now in.
      setShowUnknowns(true)
      setSelectionWorkId(workId)
      setSelectedRefs(
        new Set(
          (tree.unresolved ?? [])
            .filter((u) => {
              if (!u.citing_work_ids.includes(workId)) return false
              const s = statusOf(u)
              return s !== 'retrieving' && s !== 'failed'
            })
            .map((u) => u.id)
        )
      )
      setRetrieveError(null)
    },
    [tree.unresolved, statusOf]
  )

  const toggleRef = useCallback((unresolvedId: number) => {
    setSelectedRefs((cur) => {
      const next = new Set(cur)
      if (next.has(unresolvedId)) next.delete(unresolvedId)
      else next.add(unresolvedId)
      return next
    })
  }, [])

  /**
   * The selected references that could ACTUALLY be fetched. A reference with no
   * DOI, no title and no venue names nothing to look up (`retrieval_kind` is
   * null); one already in flight is not a fresh choice; and one that has already
   * FAILED would only re-run the same attempt against the same unreachable
   * source. All three are excluded here, matching the filter the enqueue
   * applies, so the count on the button is the number of jobs really created.
   */
  const retrievable = useMemo(
    () =>
      [...selectedRefs].filter((id) => {
        const u = unresolvedById.get(id)
        if (!u) return false
        const s = statusOf(u)
        return u.retrieval_kind !== null && s !== 'retrieving' && s !== 'failed'
      }),
    [selectedRefs, unresolvedById, statusOf]
  )

  /**
   * The ONE unknown paper picked, or null when the selection is not one paper.
   *
   * "Read abstract" opens the abstract of A PAPER. With nine cards picked there
   * is no such paper, and acting on whichever happened to be first would put
   * one reference's text on screen while the bar reports nine selected.
   */
  const soleSelected = useMemo(
    () => (selectedRefs.size === 1 ? unresolvedById.get([...selectedRefs][0]) ?? null : null),
    [selectedRefs, unresolvedById]
  )

  const runRetrieve = async (): Promise<void> => {
    if (retrievable.length === 0) return
    setRetrieving(true)
    setRetrieveError(null)
    try {
      const res = await window.api.retrieveUnresolvedReferences({
        projectId,
        unresolvedIds: retrievable
      })
      // Paint the queued cards immediately from the WRITE'S OWN RESULT rather
      // than from what was asked for: only the ids main actually queued get to
      // claim they are being retrieved.
      setLive((cur) => {
        const next = new Map(cur)
        for (const q of res.queued) next.set(q.unresolved_id, 'retrieving')
        return next
      })
      setSelectedRefs(new Set())
      setSelectionWorkId(null)
      onRetrieved()
    } catch (e) {
      setRetrieveError(e instanceof Error ? e.message : String(e))
    } finally {
      setRetrieving(false)
    }
  }

  return (
    <div className="rt-layout">
      <aside className="rt-list" data-testid="references-list">
        <div className="rt-list-head">
          <span className="eyebrow">Papers</span>
          <button
            type="button"
            className="btn-link rt-list-all"
            data-testid="references-select-all"
            onClick={() =>
              setSelected(
                selected.size === ranked.length
                  ? new Set(ranked.length ? [ranked[0].id] : [])
                  : new Set(ranked.map((n) => n.id))
              )
            }
          >
            {selected.size === ranked.length ? 'show top only' : 'show all'}
          </button>
        </div>
        <div className="rt-list-sorts">
          <input
            className="input input-sm rt-list-find"
            data-testid="references-find"
            placeholder="Find a paper"
            value={listQuery}
            onChange={(e) => setListQuery(e.target.value)}
          />
          <Select<SortKey>
            testid="references-sort"
            ariaLabel="Sort papers by"
            className="input-sm"
            value={sortBy}
            format={(l) => `Sort: ${l}`}
            options={SORTS.map((o) => ({ value: o.key, label: o.label, tip: o.tip }))}
            onChange={setSortBy}
          />
          <SwitchField
            label="Unknown papers"
            on={showUnknowns}
            onWord="Shown"
            offWord="Hidden"
            tip={
              unknownCount === 0
                ? 'Papers cited by this corpus that are not in it. None were parsed out of these bibliographies.'
                : `The ${unknownCount} papers cited here that are not in the corpus. They are real citations — hiding them clears the tree, it does not resolve them.`
            }
            testid="references-show-unknowns"
            onToggle={setShowUnknowns}
          />
        </div>
        <div className="rt-list-rows">
          {ranked.length === 0 && (
            <div className="rt-list-none">No paper matches that.</div>
          )}
          {ranked.map((n) => {
            const on = selected.has(n.id)
            const c = citedByCount.get(n.id) ?? 0
            return (
              <button
                key={n.id}
                type="button"
                className={`rt-list-row${on ? ' is-on' : ''}`}
                data-testid={`references-list-row-${n.id}`}
                aria-pressed={on}
                data-tip={n.title}
                onClick={() => toggle(n.id)}
              >
                <span className="rt-list-check" aria-hidden="true">
                  {on ? '✓' : ''}
                </span>
                <span className="rt-list-title">{n.title}</span>
                <span className="rt-list-count mono" data-tip={metric.tip(n, c)}>
                  {metric.value(n, c)}
                </span>
              </button>
            )
          })}
        </div>
      </aside>
      <div className="rt-shell">
      {(selectionWorkId !== null || selectedRefs.size > 0) && (
        <div className="rt-selectbar" data-testid="references-selectbar">
          <span className="rt-selectbar-label">
            Pick the cited papers this corpus does not hold, then retrieve them.
          </span>
          <button
            type="button"
            className="btn btn-primary rt-retrieve"
            data-testid="references-retrieve"
            disabled={retrievable.length === 0 || retrieving}
            // The count is of what WILL be queued, so a selection of purely
            // un-retrievable references reads "Retrieve 0 of N selected" and is
            // disabled — rather than promising work it cannot do.
            //
            // It names the SELECTION SIZE too whenever the two disagree. With
            // four cards outlined on the tree, "Retrieve selected (2)" reads as
            // a miscount: the number the user can see and the number on the
            // button are both true and neither says what the other is. Carrying
            // both makes the shortfall part of the sentence rather than a note
            // at the other end of the bar.
            data-tip={
              retrievable.length === 0
                ? 'None of the selected references carry an identifier that could be looked up.'
                : undefined
            }
            onClick={() => void runRetrieve()}
          >
            {retrieving
              ? 'Retrieving…'
              : retrievable.length === selectedRefs.size
                ? `Retrieve selected (${retrievable.length})`
                : `Retrieve ${retrievable.length} of ${selectedRefs.size} selected`}
          </button>
          {/* BESIDE the retrieve, and only with ONE card picked. An abstract
              belongs to a paper, so there is no honest thing for this to open
              when nine are selected — and a button that silently acted on the
              first of them would show one paper's text under a selection of
              nine. With several picked it is simply not offered: the retrieve
              beside it is the action a multi-selection is for. */}
          {soleSelected !== null && (
            <ReadAbstractButton
              state={soleSelected.abstract_state}
              printedTitle={referenceLabel(soleSelected)}
              className="rt-read-abstract"
              testid="references-read-abstract"
            />
          )}
          <button
            type="button"
            className="btn btn-secondary rt-selectbar-cancel"
            data-testid="references-selection-cancel"
            disabled={selectedRefs.size === 0}
            onClick={() => {
              setSelectionWorkId(null)
              setSelectedRefs(new Set())
              setRetrieveError(null)
            }}
          >
            Deselect all
          </button>
          {selectedRefs.size > retrievable.length && (
            <span className="rt-selectbar-note mono" data-testid="references-selection-note">
              {selectedRefs.size - retrievable.length} of the selected cannot be retrieved
            </span>
          )}
        </div>
      )}
      {retrieveError && (
        <div className="rt-selectbar is-error mono" data-testid="references-retrieve-error">
          {retrieveError}
        </div>
      )}
      {/* No bar: with the legend gone there is nothing standing above the tree
          except a disclosure that is usually absent, and an empty bar would
          reserve space for nothing. What survives is the disclosure itself — a
          dropped edge or a truncated corpus is something the picture cannot
          admit to on its own, and silence would present the tree as complete. */}
      {(layout.cycleEdges > 0 || truncated > 0) && (
        <div className="rt-stats mono" data-testid="references-stats">
          {[
            layout.cycleEdges > 0
              ? `${layout.cycleEdges} cyclic edge(s) not used for depth`
              : null,
            truncated > 0 ? `showing the first ${tree.shown_works} of ${tree.total_works}` : null
          ]
            .filter(Boolean)
            .join(' · ')}
        </div>
      )}
        <TreeCanvas
          layout={layout}
          projectId={projectId}
          onOpenWork={onOpenWork}
          onOpenQuote={onOpenQuote}
          selectionWorkId={selectionWorkId}
          selectedRefs={selectedRefs}
          statusOf={statusOf}
          hiddenUnknowns={showUnknowns ? 0 : unknownCount}
          onStartSelection={startSelection}
          onToggleRef={toggleRef}
        />
      </div>
    </div>
  )
}
