import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { RankingRowDTO, GraphDTO } from '@shared/contract'
import { DOSSIER_PAPER_LIMIT } from '@shared/contract'
import { useAsync } from '../lib/useAsync'
import { parseWhyRank } from '../lib/whyRank'
import { DataView, EmptyState } from '../components/States'
import { ScreenHeader, Popover, Modal, Select, DossierToggle, cardStyle } from '../components/ui'
import { SummaryButtons } from '../components/SummaryButtons'
import { useSummaryVersion } from '../lib/summaries'
import { expansionForDisplay, relevanceForDisplay, fmtYear } from '../lib/format'
import {
  ringCategory,
  ringCategoryColor,
  ringCategoryLabel,
  ringCategoryTip,
  ringDashArray,
  type RingCategory
} from '../lib/workType'
import { RichText, plainText } from '../components/RichText'

// Single source of truth for the sort keys: the union is derived from the list
// so a persisted preference can be validated against it at runtime.
const SORT_KEYS = ['relevance', 'expansion', 'year', 'citations'] as const
type SortBy = (typeof SORT_KEYS)[number]
const SORT_LABELS: Record<SortBy, string> = {
  relevance: 'relevance',
  expansion: 'expansion priority',
  year: 'year',
  citations: 'citations'
}
const PAGE_SIZE = 50

/**
 * The five inclusion states, with what each one MEANS.
 *
 * Two axes are deliberately collapsed into one control: whether you have READ
 * the paper, and whether it is IN the project's evidence base. They are stored
 * as one `inclusion_status` on `project_work`, so the list has to be read as a
 * single progression — which is exactly why each option needs its meaning
 * spelled out rather than a one-word label.
 */
const INCLUSION_TIPS: Record<string, string> = {
  unread: 'Not looked at yet. The default for every paper the corpus pulls in.',
  read: 'You have read it but have not decided whether it belongs in the evidence base.',
  included: 'Part of this project\u2019s evidence base — its facts and measurements count.',
  excluded:
    'Left out on purpose. The paper stays in your library, but its findings stop counting as ' +
    'evidence for this project and it drops off the map.',
  uncertain: 'Read, but the call needs more context or another opinion before it is settled.'
}
// The dossier filter is NOT an inclusion status — it reads a different column
// (`is_reference`) — but it belongs in the same row because it answers the same
// shape of question ("show me the subset that…"). `filtered` branches on this
// key rather than comparing it to inclusion_status, which would match nothing.
//
// It is called "In dossier" and not "References" for the user, because this app
// already uses "reference" for the papers a paper CITES — a whole screen, a
// tree, and every unresolved bibliography line. Two unrelated meanings under
// one word left the reader with no way to tell "papers I trust as background"
// from "papers this one cites". The stored column keeps its name; only what is
// read changes.
const REFERENCE_FILTER_KEY = 'references'
const STATUS_FILTERS = [
  { key: 'all', label: 'All', tip: 'Every paper in the project, whatever its status.' },
  {
    key: REFERENCE_FILTER_KEY,
    label: 'In project context',
    tip: 'The papers you marked as trusted background. These, and only these, go into the project context when it is generated.'
  },
  { key: 'unread', label: 'Unread', tip: INCLUSION_TIPS.unread },
  { key: 'read', label: 'Read', tip: INCLUSION_TIPS.read },
  { key: 'included', label: 'Included', tip: INCLUSION_TIPS.included },
  { key: 'excluded', label: 'Excluded', tip: INCLUSION_TIPS.excluded },
  { key: 'uncertain', label: 'Uncertain', tip: INCLUSION_TIPS.uncertain }
]
const INCLUSION_OPTIONS = ['read', 'unread', 'included', 'excluded', 'uncertain']

/**
 * What the row says when a change could not be written.
 *
 * A CLOSED set, chosen by which control failed rather than by what the
 * rejection said. Each sentence states the same two things: the change is not
 * stored, and the row has been put back to what is — because the reader's next
 * question after "it failed" is "so what is saved now?".
 */
const SAVE_FAILED = {
  status: 'That status was not saved — the row has been put back to what is stored. Try again.',
  dossier:
    'That project-context change was not saved — the button has been put back to what is stored. Try again.',
  override: 'That override was not saved — the scores shown are the stored ones. Try again.'
} as const

// 0..1 (or null) score → integer /10 for display (design uses REL 8 / EXP 10).
const toTen = (v: number | null | undefined): number | null =>
  v === null || v === undefined ? null : Math.round(Math.max(0, Math.min(1, v)) * 10)
/**
 * An UNSCORED paper renders NOTHING — not a dash, not a zero, not "pending".
 *
 * The columns are null until something computes them, and every stand-in for
 * that tried so far read as a verdict: `0.5` on insert showed every paper a
 * confident middle 5, and a dash is still a mark in a column of numbers, which
 * invites the reader to compare it with them. The bar is dropped with the label
 * for the same reason — an empty track at 0% is a score of zero drawn to scale.
 *
 * Scoring happens at import, so this is a brief state, not a resting one.
 */
const tenLabel = (v: number | null | undefined): string => {
  const t = toTen(v)
  return t === null ? '' : String(t)
}
/**
 * A score as a bar width, or NULL when there is no score.
 *
 * Null rather than `'0%'`, which was a loaded gun in the one file that argues
 * against it: an empty track is how this screen draws a score of zero, so
 * handing that string to an unscored paper would draw "judged, and found
 * irrelevant" over a paper nothing has looked at. Every caller already guards
 * with `isScored`; returning null makes the guard structural rather than a
 * convention the next caller has to know about.
 */
const pct = (v: number | null | undefined): string | null => {
  const t = toTen(v)
  return t === null ? null : `${t * 10}%`
}
const isScored = (v: number | null | undefined): boolean => toTen(v) !== null

// The frontier ring vocabulary is shared with the Connectome (lib/workType), so
// one paper cannot be a Review on one screen and a Primary on the other.

// ============================================================ reorder semantics
// A manual reorder is persisted by writing `relevance`, because the relevance
// ranking is served by `ORDER BY pw.relevance DESC, w.title ASC`. Two rules:
//
//  1. MINIMAL WRITE — the moved row gets a value strictly between its two new
//     neighbours (fractional indexing), so one drag costs ONE IPC round-trip and
//     no other row's score is touched.
//  2. WINDOWED REBALANCE — when the neighbours leave no usable gap (equal or
//     near-equal scores, nulls, exhausted precision) the smallest power-of-two
//     window around the insertion point that DOES have room is renormalized to
//     evenly-spaced, strictly-decreasing values. Only if even the whole list has
//     no room do we renormalize everything.
//
// Both branches are pure functions of the new order, so the persisted result is
// deterministic and reproduces the exact order after a reload. The order handed
// in is always the FULL project order (see `spliceIntoGlobal`), never just the
// visible slice, so a drag performed under a status filter or on page 1 of a
// paginated list can never scramble rows the user cannot see.
const REORDER_EPS = 1e-6

export type ReorderWrite = { workId: number; relevance: number }

const spread = (
  ids: number[],
  lo: number,
  hi: number,
  hiBound: number,
  loBound: number
): ReorderWrite[] => {
  const count = hi - lo + 1
  const step = (hiBound - loBound) / (count + 1)
  const out: ReorderWrite[] = []
  for (let i = 0; i < count; i++) out.push({ workId: ids[lo + i], relevance: hiBound - step * (i + 1) })
  return out
}

export function computeReorderWrites(
  newOrder: number[],
  movedId: number,
  relById: Map<number, number | null>
): ReorderWrite[] {
  const n = newOrder.length
  if (n === 0) return []
  const k = newOrder.indexOf(movedId)
  const rel = (i: number): number | null => {
    const v = relById.get(newOrder[i])
    return typeof v === 'number' && Number.isFinite(v) ? v : null
  }
  // Full renormalize: strictly decreasing over (0, 1].
  const renormalizeAll = (): ReorderWrite[] =>
    newOrder.map((id, i) => ({ workId: id, relevance: (n - i) / n }))
  if (k < 0) return renormalizeAll()

  // Grow a window around k until the surrounding bounds leave room for it.
  for (let span = 0; ; span = span === 0 ? 1 : span * 2) {
    const lo = Math.max(0, k - span)
    const hi = Math.min(n - 1, k + span)
    const hiBound = lo > 0 ? rel(lo - 1) : 1
    const loBound = hi < n - 1 ? rel(hi + 1) : 0
    const full = lo === 0 && hi === n - 1
    if (hiBound !== null && loBound !== null) {
      const count = hi - lo + 1
      if (hiBound - loBound > (count + 1) * REORDER_EPS && hiBound <= 1 && loBound >= 0) {
        return spread(newOrder, lo, hi, hiBound, loBound)
      }
    }
    if (full) return renormalizeAll()
  }
}

/** Move the item at `from` to index `to` in a copy of `ids`. */
export function moveItem(ids: number[], from: number, to: number): number[] {
  const next = ids.slice()
  const [moved] = next.splice(from, 1)
  next.splice(Math.max(0, Math.min(next.length, to)), 0, moved)
  return next
}

/**
 * Re-seat a reordered VISIBLE subsequence back into the full project order:
 * rows hidden by the status filter or by pagination keep their absolute slots
 * and only the visible slots are refilled, in the new visible order.
 */
export function spliceIntoGlobal(
  globalIds: number[],
  visibleIds: number[],
  newVisibleIds: number[]
): number[] {
  const slots = new Set(visibleIds)
  let j = 0
  return globalIds.map((id) => (slots.has(id) ? (newVisibleIds[j++] ?? id) : id))
}

type OverrideJson = {
  relevance?: unknown
  expansion_priority?: unknown
  reason?: unknown
} | null

const parseOverrides = (raw: string | null): OverrideJson => {
  if (!raw) return null
  try {
    return JSON.parse(raw) as OverrideJson
  } catch {
    return null
  }
}
const hasOverride = (ov: OverrideJson): boolean =>
  !!ov && (ov.relevance !== undefined || ov.expansion_priority !== undefined)
const overrideReasonOf = (ov: OverrideJson): string | null => {
  if (!ov) return null
  const nodes = [ov.relevance, ov.expansion_priority]
  for (const n of nodes) {
    if (n && typeof n === 'object' && 'reason' in n) {
      const r = (n as { reason?: unknown }).reason
      if (typeof r === 'string' && r) return r
    }
  }
  return typeof ov.reason === 'string' ? ov.reason : null
}

// Pencil glyph for the per-score override affordance (audit §4C). Purely
// decorative: every call site supplies title + aria-label.
function PencilIcon(): JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <path d="M13.2 3.6l3.2 3.2L7.4 15.8 3.6 16.4l.6-3.8z" />
    </svg>
  )
}

// ---- Frontier map (SVG scatter). Mirrors the design's rankingPlot() geometry.
function FrontierMap({
  rows,
  citeById,
  selectedId,
  liveId,
  onHover
}: {
  rows: RankingRowDTO[]
  citeById: Map<number, number>
  selectedId: number | null
  liveId: number | null
  onHover: (h: { row: RankingRowDTO; x: number; y: number } | null) => void
}): JSX.Element {
  const W = 560
  const H = 460
  const pad = 44
  // BOTH axes are ranks in 0..1, drawn on a 0..10 field like the design. They
  // have to be the same kind of quantity: a raw relevance on Y against a ranked
  // expansion on X put two different scales under one pair of 0..10 ticks, and
  // since the raw scores have a median near 0.0004 it crushed every bubble onto
  // the bottom edge of a chart whose X spread them properly.
  const px = (v01: number): number => pad + Math.max(0, Math.min(1, v01)) * (W - pad - 16)
  const py = (v01: number): number => H - pad - Math.max(0, Math.min(1, v01)) * (H - pad - 16)

  // BOTH RANKS, not the raw scores. A geometric plot is arithmetic: a row that
  // still carries only a raw relevance (0.0004) would sit on the same axis as a
  // ranked one (0.5) and the picture would be meaningless for every point on
  // it. A row awaiting its first rank is therefore left OUT of the scatter
  // rather than misplaced in it — it is still in the list beside it, which is
  // where its number can be read honestly.
  // EXCLUDED PAPERS ARE NOT DRAWN. The map answers "what should I read next",
  // and a paper the user has personally thrown out is not a candidate — it took
  // a slot, a colour and a legend entry to say so. It stays in the list beside
  // the chart, where the verdict can be seen and undone.
  const plotted = rows.filter(
    (r) =>
      r.relevance_rank !== null && r.expansion_rank !== null && r.inclusion_status !== 'excluded'
  )
  const maxCite = Math.max(1, ...plotted.map((r) => citeById.get(r.work_id) ?? 0))

  // Wrap the FULL title — never truncate. A paper's title is how the reader
  // identifies it, and an ellipsis on the one label the chart shows defeats the
  // point of selecting the bubble. Only the LINE WIDTH is bounded (the chart is
  // 560px wide); the number of lines grows with the title.
  const LABEL_CHARS = 34
  const wrapTitle = (title: string): string[] => {
    const lines: string[] = []
    let line = ''
    for (const word of title.split(/\s+/)) {
      if (!line) line = word
      else if (line.length + 1 + word.length <= LABEL_CHARS) line = `${line} ${word}`
      else {
        lines.push(line)
        line = word
      }
      // A single token longer than a line (a DOI, a hyphen-free compound) is
      // broken rather than allowed to overflow the plate.
      while (line.length > LABEL_CHARS) {
        lines.push(line.slice(0, LABEL_CHARS))
        line = line.slice(LABEL_CHARS)
      }
    }
    if (line) lines.push(line)
    return lines
  }

  const grid: JSX.Element[] = []
  for (let i = 0; i <= 10; i += 2) {
    const f = i / 10
    grid.push(
      <line key={`gx${i}`} x1={px(f)} y1={py(0)} x2={px(f)} y2={py(1)} stroke="#f1ece5" strokeWidth={1} />
    )
    grid.push(
      <line key={`gy${i}`} x1={px(0)} y1={py(f)} x2={px(1)} y2={py(f)} stroke="#f1ece5" strokeWidth={1} />
    )
  }
  // THE MIDDLE, because both axes are now ranks. 0.65 came from a mockup drawn
  // when the axes were raw scores, where a bias upward and right put the
  // crosshair somewhere near the interesting papers. A rank spreads its
  // population evenly over 0..1, so half the papers fall either side of 0.5 by
  // construction and any other split names quadrants that do not divide
  // anything — while looking, correctly, like a cross drawn off-centre.
  const mid = 0.5
  // Quadrant labels sit at the CENTRE of their quadrant and are anchored
  // `middle`. Previously they had no textAnchor, so SVG's default `start` made
  // every label run rightward from its x, and the x fractions had been
  // hand-tuned per label LENGTH to compensate — which can never truly centre
  // them (the offset depends on rendered text width). Deriving the centres from
  // the crosshair keeps all four aligned regardless of how long the text is.
  const leftMid = mid / 2
  const rightMid = mid + (1 - mid) / 2
  // A long caption centred in its quadrant can still run past the plot edge, so
  // every one is clamped into the drawable box using its own rendered
  // half-width, derived from the SAME geometry as the axes so the captions
  // cannot drift when the chart's proportions change.
  const CAPTION_CHAR_W = 6.2 // 9.5px Geist Mono + .12em tracking
  const clampX = (frac: number, text: string): number => {
    const half = (text.length * CAPTION_CHAR_W) / 2
    const left = px(0) + half
    const right = px(1) - half
    // A caption wider than the whole plot centres rather than jittering.
    return left > right ? (px(0) + px(1)) / 2 : Math.min(Math.max(px(frac), left), right)
  }
  // TOP AND BOTTOM EDGES, not inside the quadrant. A caption at 0.94 sat in the
  // band where the best papers plot, and centring the crosshair moved the
  // right-hand quadrant under the densest part of the cloud — "EXPAND FRONTIER"
  // came out struck through by a bubble. These name the corners of the map, so
  // they belong at its margins where nothing is ever drawn.
  const qLabels = [
    { x: clampX(leftMid, 'READ NOW'), y: py(1) - 6, t: 'READ NOW' },
    { x: clampX(rightMid, 'EXPAND FRONTIER'), y: py(1) - 6, t: 'EXPAND FRONTIER' },
    { x: clampX(leftMid, 'SKIM / SKIP'), y: py(0) + 16, t: 'SKIM / SKIP' },
    { x: clampX(rightMid, 'EXPLORE NEIGHBORHOOD'), y: py(0) + 16, t: 'EXPLORE NEIGHBORHOOD' }
  ]

  return (
    <svg
      className="frontier-svg"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="Frontier map: topic relevance versus expansion priority"
    >
      {grid}
      <line x1={px(mid)} y1={py(0)} x2={px(mid)} y2={py(1)} stroke="#e6ddd2" strokeDasharray="4 5" />
      <line x1={px(0)} y1={py(mid)} x2={px(1)} y2={py(mid)} stroke="#e6ddd2" strokeDasharray="4 5" />
      {qLabels.map((l, i) => (
        <text
          key={`ql${i}`}
          x={l.x}
          y={l.y}
          textAnchor="middle"
          fill="#c4b9aa"
          fontSize={9.5}
          fontFamily="'Geist Mono', monospace"
          letterSpacing=".12em"
        >
          {l.t}
        </text>
      ))}
      {plotted.map((r) => {
        const cite = citeById.get(r.work_id) ?? 0
        const rad = 6 + Math.min(12, (cite / maxCite) * 12)
        const live = liveId === r.work_id
        const sel = selectedId === r.work_id || live
        const excluded = r.inclusion_status === 'excluded'
        const cat = ringCategory(r.work_type, cite, excluded)
        return (
          <g
            key={r.work_id}
            className={`frontier-node${sel ? ' is-selected' : ''}${live ? ' is-live' : ''}`}
            data-testid={`frontier-node-${r.work_id}`}
            onMouseEnter={(e) => onHover({ row: r, x: e.clientX, y: e.clientY })}
            onMouseMove={(e) => onHover({ row: r, x: e.clientX, y: e.clientY })}
            onMouseLeave={() => onHover(null)}
          >
            <circle
              cx={px(r.expansion_rank as number)}
              cy={py(r.relevance_rank as number)}
              r={sel ? rad + 3 : rad}
              fill="#fff"
              // SELECTION KEEPS THE CATEGORY'S COLOUR. Painting it '#e2600f'
              // was painting it the exact hue the legend beside it gives
              // "review", so a selected primary bubble claimed to be a review
              // and an unselected review looked selected. Selection is carried
              // by the ring instead — a separate channel that collides with
              // nothing, since no category uses one.
              stroke={ringCategoryColor(cat)}
              strokeWidth={sel ? 3 : 2}
              strokeDasharray={ringDashArray(cat)}
            />
          </g>
        )
      })}
      {/* Selected label LAST: SVG paints in document order, so a label emitted
          inside its node group was overpainted by every bubble drawn after it.
          Rendering it here puts it above the whole plot. */}
      {(() => {
        const r = plotted.find((x) => x.work_id === (liveId ?? selectedId))
        if (!r) return null
        const lines = wrapTitle(r.title)
        const halfWide = (Math.max(...lines.map((l) => l.length)) * 6) / 2
        const cx = Math.min(
          Math.max(px(r.expansion_rank as number), halfWide + 4),
          W - halfWide - 4
        )
        const cite = citeById.get(r.work_id) ?? 0
        const rad = 6 + Math.min(12, (cite / maxCite) * 12)
        const cy = py(relevanceForDisplay(r) as number)
        // Prefer growing upward so the label never covers its own bubble; when
        // the node sits too near the top for the block to fit, flip it below
        // rather than clamping it back down over the bubble.
        const above = cy - rad - 8 - (lines.length - 1) * 13
        const top = above < 12 ? cy + rad + 16 : above
        return (
          <g className="frontier-label" pointerEvents="none">
            {/* Plate: the title can land on the quadrant captions, and unbacked
                text over text is unreadable. */}
            <rect
              x={cx - halfWide - 5}
              y={top - 11}
              width={halfWide * 2 + 10}
              height={lines.length * 13 + 6}
              rx={5}
              fill="#fffaf5"
              fillOpacity={0.94}
            />
            <text x={cx} y={top} textAnchor="middle" fontSize={11} fontWeight={600} fill="#211a12">
              {lines.map((line, li) => (
                <tspan key={li} x={cx} dy={li === 0 ? 0 : 13}>
                  {line}
                </tspan>
              ))}
            </text>
          </g>
        )
      })()}
      <text
        x={px(0.5)}
        y={H - 8}
        textAnchor="middle"
        fontSize={11}
        fill="#8a8073"
        fontFamily="'Geist Mono', monospace"
      >
        EXPANSION PRIORITY →
      </text>
      <text
        x={12}
        y={py(0.5)}
        textAnchor="middle"
        fontSize={11}
        fill="#8a8073"
        fontFamily="'Geist Mono', monospace"
        transform={`rotate(-90 12 ${py(0.5)})`}
      >
        TOPIC RELEVANCE →
      </text>
    </svg>
  )
}

// Live drag bookkeeping. `base` is the DOM order FROZEN at drag start (React
// never reorders the DOM mid-drag); `order` is the live logical order. Cards are
// moved purely with CSS transforms computed from the measured base layout, so a
// pointermove costs one transform patch per shifted card and no list re-mount.
type DragMeasure = {
  base: number[]
  tops: number[]
  heights: number[]
  gap: number
  /** Slot tops of the base layout with the dragged row removed. */
  removedTops: number[]
  removedIds: number[]
  fromIndex: number
}
type DragState = { id: number; order: number[] }

const AUTOSCROLL_EDGE = 46
const AUTOSCROLL_MAX = 16

export function RankingScreen({
  projectId,
  onOpenWork,
  onAddPapers
}: {
  projectId: number
  onOpenWork: (id: number) => void
  /** Leave for the Papers screen. This screen is a view OF the papers, so with
   *  none it must carry the action rather than name it in prose. */
  onAddPapers: () => void
}): JSX.Element {
  // Sort + filter PERSIST (per project). Everything else the user does here —
  // marking read/included/excluded, overriding a score, reordering — already
  // writes to SQLite immediately, so the screen you come back to is the screen
  // you left. These two were the exception that made the app feel like it had
  // unsaved state; there is no save step, and nothing to restore by hand.
  const [sortBy, setSortBy] = useState<SortBy>('relevance')
  const [statusFilter, setStatusFilter] = useState('all')
  // Guard: the first render writes nothing, so loading the stored value cannot
  // race the effect below and immediately re-save the default over it.
  const prefsLoaded = useRef(false)

  useEffect(() => {
    let alive = true
    prefsLoaded.current = false
    void Promise.all([
      window.api.getViewPref(`ranking.sort.${projectId}`),
      window.api.getViewPref(`ranking.status.${projectId}`)
    ])
      .then(([sort, status]) => {
        if (!alive) return
        // Validate against the SortBy union: a stored value from an older build
        // (or a hand-edited DB) must not put the screen in an unsortable state.
        if (sort && (SORT_KEYS as readonly string[]).includes(sort)) setSortBy(sort as SortBy)
        if (status) setStatusFilter(status)
      })
      .catch(() => {
        /* a missing preference is not an error — keep the defaults */
      })
      .finally(() => {
        if (alive) prefsLoaded.current = true
      })
    return () => {
      alive = false
    }
  }, [projectId])

  useEffect(() => {
    if (!prefsLoaded.current) return
    void window.api.setViewPref(`ranking.sort.${projectId}`, sortBy).catch(() => {})
    void window.api.setViewPref(`ranking.status.${projectId}`, statusFilter).catch(() => {})
  }, [projectId, sortBy, statusFilter])
  const [shown, setShown] = useState(PAGE_SIZE)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [hover, setHover] = useState<{ row: RankingRowDTO; x: number; y: number } | null>(null)
  const state = useAsync<RankingRowDTO[]>(
    () => window.api.getRanking(projectId, sortBy),
    [projectId, sortBy]
  )
  /**
   * Which papers already have each kind of summary, so a row's buttons can be
   * dimmed when there is nothing behind them yet.
   *
   * ONE call for the whole page. `getWorkSummary` would answer per row, but it
   * assembles the prose, its provenance and its freshness — fifty of those to
   * decide fifty button tints is fifty analyses read and thrown away.
   */
  // Re-read whenever a summary is written anywhere — including from a paper's
  // own screen or a reference-tree card, neither of which knows this list
  // exists. That is the point of the store: the row un-dims without this screen
  // having been told by the writer.
  const summaryVersion = useSummaryVersion()
  const summaries = useAsync<{ general: number[]; project: number[] }>(
    () => window.api.getWorksWithSummaries(projectId),
    [projectId, summaryVersion]
  )
  const haveSummaries = useMemo(
    () => ({
      general: new Set(summaries.data?.general ?? []),
      project: new Set(summaries.data?.project ?? [])
    }),
    [summaries.data]
  )

  // Citations for bubble size come from the graph (RankingRowDTO has none).
  const graph = useAsync<GraphDTO>(() => window.api.getGraph(projectId), [projectId])
  const citeById = useMemo(() => {
    const m = new Map<number, number>()
    for (const n of graph.data?.nodes ?? []) m.set(n.id, n.citation_count)
    return m
  }, [graph.data])

  const [excludeTarget, setExcludeTarget] = useState<number | null>(null)
  const [overrideTarget, setOverrideTarget] = useState<{
    workId: number
    field: 'relevance' | 'expansion_priority'
  } | null>(null)
  const [overrideValue, setOverrideValue] = useState('')
  const [overrideReason, setOverrideReason] = useState('')
  /**
   * The row whose last change did NOT reach the database, and what it was.
   *
   * A control here writes and then reloads, so the row it sits in redraws from
   * what is STORED. When the write threw, the reload used to be skipped and the
   * row went on showing the user's choice — the one arrangement in which the
   * screen states something false and offers no way to notice. Naming the row
   * lets it carry the warning next to the control that failed, and the reload
   * runs on the failing path too so the row snaps back to the stored value.
   */
  const [saveFailure, setSaveFailure] = useState<{ workId: number; sentence: string } | null>(null)

  // ---- reorder state -------------------------------------------------------
  // Reordering maps onto the relevance axis, so it is enabled only while the
  // list is sorted by relevance.
  const canReorder = sortBy === 'relevance'
  /** Optimistic FULL-project order held while a persist round-trip is in flight. */
  const [manualOrder, setManualOrder] = useState<number[] | null>(null)
  /**
   * True from the moment a reorder starts persisting until the refetch it
   * triggers has LANDED. Clearing it merely when the IPC resolves would be
   * wrong: `state.reload()` only bumps a nonce, so `rows` (and therefore the
   * relevance values the next reorder computes against) stay stale for another
   * round-trip. A second drag started in that window would compute its
   * fractional index from superseded scores and degenerate into a full-list
   * renormalization.
   */
  const [reordering, setReordering] = useState(false)
  const [drag, setDrag] = useState<DragState | null>(null)

  const listRef = useRef<HTMLDivElement | null>(null)
  /** The dashed "it will land here" band drawn in the vacated slot. */
  const dropRef = useRef<HTMLDivElement | null>(null)
  const cardRefs = useRef(new Map<number, HTMLElement>())
  const measureRef = useRef<DragMeasure | null>(null)
  const dragRef = useRef<DragState | null>(null)
  dragRef.current = drag
  const pointerRef = useRef({ startY: 0, y: 0, startScroll: 0 })
  const rafRef = useRef<number | null>(null)

  const rows = useMemo(() => state.data ?? [], [state.data])

  const setCardRef = useCallback((id: number, el: HTMLElement | null): void => {
    if (el) cardRefs.current.set(id, el)
    else cardRefs.current.delete(id)
  }, [])

  const stopAutoscroll = useCallback((): void => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
  }, [])

  /** Wipe every transform applied during a drag. */
  const clearTransforms = useCallback((): void => {
    for (const el of cardRefs.current.values()) {
      el.style.transform = ''
      el.style.transition = ''
    }
  }, [])

  const endDrag = useCallback((): void => {
    stopAutoscroll()
    measureRef.current = null
    dragRef.current = null
    clearTransforms()
    setDrag(null)
  }, [clearTransforms, stopAutoscroll])

  // Any refetch invalidates the optimistic order — and aborts a drag in flight,
  // because the frozen DOM measurements no longer describe the rendered list.
  // This MUST be a layout effect: React has already committed the new (real)
  // DOM order by the time it runs, and clearing the stale drag transforms
  // before the browser paints avoids a one-frame "new order + old offsets"
  // flash.
  useLayoutEffect(() => {
    if (dragRef.current) endDrag()
    setManualOrder(null)
    setReordering(false)
  }, [state.data, state.error, endDrag])

  useEffect(() => stopAutoscroll, [stopAutoscroll])

  /**
   * Run a write, then reload the list — WHETHER OR NOT it succeeded.
   *
   * The reload on the failing path is the point: it is what pulls the row back
   * to the value that is actually stored, so a change that did not land cannot
   * keep sitting on screen looking saved. The sentence is chosen here, from a
   * fixed set, and never taken from the rejection — an IPC rejection carries the
   * channel name and a stack, and neither belongs in front of a reader.
   */
  const persist = async (workId: number, sentence: string, write: () => Promise<unknown>): Promise<void> => {
    setSaveFailure((f) => (f?.workId === workId ? null : f))
    try {
      await write()
    } catch (e) {
      // THE REASON, when main gave one. The generic sentence ends "Try again",
      // which is advice for a write that failed by accident — a refusal
      // because the project context is full is not something retrying can fix,
      // and telling someone to retry it is telling them to press a button that
      // will refuse again for the same reason.
      const reason = e instanceof Error ? e.message.trim() : ''
      setSaveFailure({ workId, sentence: reason.length > 0 ? reason : sentence })
    } finally {
      state.reload()
    }
  }

  const setStatus = async (workId: number, status: string): Promise<void> => {
    if (status === 'excluded') {
      setExcludeTarget(workId)
      return
    }
    await persist(workId, SAVE_FAILED.status, () =>
      window.api.setInclusionStatus(projectId, workId, status)
    )
  }

  const confirmExclude = async (): Promise<void> => {
    if (excludeTarget === null) return
    const workId = excludeTarget
    setExcludeTarget(null)
    await persist(workId, SAVE_FAILED.status, () =>
      window.api.setInclusionStatus(projectId, workId, 'excluded')
    )
  }

  /**
   * Mark/unmark a paper as a project REFERENCE — the trusted sources the topic
   * dossier is compiled from (§8). This is the ONLY control that writes
   * project_work.is_reference; without it the dossier can never be anything but
   * a top-relevance fallback.
   */
  const toggleReference = async (workId: number, next: boolean): Promise<void> => {
    await persist(workId, SAVE_FAILED.dossier, () =>
      window.api.markReference(projectId, workId, next)
    )
  }

  const openOverride = (workId: number, field: 'relevance' | 'expansion_priority'): void => {
    setOverrideTarget({ workId, field })
    setOverrideValue('')
    setOverrideReason('')
  }

  const saveOverride = async (): Promise<void> => {
    if (!overrideTarget) return
    const raw = Number(overrideValue)
    if (Number.isNaN(raw)) return
    const value = Math.min(1, Math.max(0, raw))
    const { workId, field } = overrideTarget
    const reason = overrideReason.trim() || undefined
    setOverrideTarget(null)
    await persist(workId, SAVE_FAILED.override, () =>
      window.api.overrideScore(projectId, workId, field, value, reason)
    )
  }

  // ---- data shaping --------------------------------------------------------
  const globalOrdered = useMemo(() => {
    if (!manualOrder || !canReorder) return rows
    const byId = new Map(rows.map((r) => [r.work_id, r]))
    const seq: RankingRowDTO[] = []
    for (const id of manualOrder) {
      const r = byId.get(id)
      if (r) {
        seq.push(r)
        byId.delete(id)
      }
    }
    for (const r of rows) if (byId.has(r.work_id)) seq.push(r)
    return seq
  }, [rows, manualOrder, canReorder])

  // `rows` is the WHOLE project — the 50-per-page cap is applied to `visible`
  // below, not to what was fetched — so this count is exact rather than a count
  // of the page the reader happens to be on.
  const atLimit = useMemo(
    () => rows.filter((r) => r.is_reference).length >= DOSSIER_PAPER_LIMIT,
    [rows]
  )

  const filtered = useMemo(() => {
    if (statusFilter === 'all') return globalOrdered
    if (statusFilter === REFERENCE_FILTER_KEY) return globalOrdered.filter((r) => r.is_reference)
    return globalOrdered.filter((r) => r.inclusion_status === statusFilter)
  }, [globalOrdered, statusFilter])
  const visible = useMemo(() => filtered.slice(0, shown), [filtered, shown])

  const relById = useMemo(() => {
    const m = new Map<number, number | null>()
    for (const r of rows) m.set(r.work_id, r.relevance)
    return m
  }, [rows])

  /**
   * The rows fed to the frontier map + the score bars. While a drag is in
   * flight these carry the relevance values the drop is ABOUT to persist, so
   * the chart moves in real time and lands exactly where it previewed.
   */
  const previewOrder = useMemo(() => {
    if (!drag) return null
    return spliceIntoGlobal(
      globalOrdered.map((r) => r.work_id),
      measureRef.current?.base ?? [],
      drag.order
    )
  }, [drag, globalOrdered])

  const previewWrites = useMemo(() => {
    if (!previewOrder || !drag) return null
    return computeReorderWrites(previewOrder, drag.id, relById)
  }, [previewOrder, drag, relById])

  const previewRelById = useMemo(() => {
    if (!previewWrites) return null
    const m = new Map<number, number>()
    for (const w of previewWrites) m.set(w.workId, w.relevance)
    return m
  }, [previewWrites])

  /**
   * The RANK each row would hold once the drop is persisted.
   *
   * Derived from the previewed ORDER rather than from the previewed relevance
   * values, because those are fractional-index writes: a minimal drag lands one
   * paper a hair below its new neighbour, and drawn raw the bar would not move
   * at all while every bar around it stayed where it was. Ranking the preview
   * reproduces exactly what `recordScores` will store, so the bar the user
   * releases is the bar they get back.
   *
   * Only rows carrying a score take a position — an unscored paper is not in
   * the order and must not be given one.
   */
  const previewRankById = useMemo(() => {
    if (!previewOrder || !previewRelById) return null
    const scored = previewOrder.filter(
      (id) => (previewRelById.get(id) ?? relById.get(id) ?? null) !== null
    )
    const m = new Map<number, number>()
    const span = scored.length - 1
    // TIES SHARE A POSITION, exactly as `rankByValue` in `rerank/store.ts`
    // does. Without this the preview hands every row a distinct position and
    // the drop hands tied rows a shared one, so releasing the pointer made
    // bars jump — breaking the promise this preview exists to keep, that the
    // bar you release is the bar you get back.
    scored.forEach((id, i) => {
      const value = previewRelById.get(id) ?? relById.get(id) ?? null
      const prev = i > 0 ? scored[i - 1] : null
      const prevValue = prev === null ? null : (previewRelById.get(prev) ?? relById.get(prev) ?? null)
      const tied = prev !== null && value === prevValue
      m.set(id, tied ? (m.get(prev as number) as number) : span === 0 ? 1 : 1 - i / span)
    })
    return m
  }, [previewOrder, previewRelById, relById])

  const relOf = useCallback(
    (r: RankingRowDTO): number | null => previewRelById?.get(r.work_id) ?? r.relevance,
    [previewRelById]
  )

  /**
   * What to DRAW for one row's relevance — the stored rank, or the rank the
   * drag in flight is about to give it.
   *
   * The raw score is never drawn here: it is an ordinal sigmoid whose median on
   * a real corpus is 0.0004, so a x/10 label reads 0 for almost every paper in
   * the list. Sorting, overriding and the "why this rank" text all still read
   * the raw value.
   */
  const relDisplayOf = useCallback(
    (r: RankingRowDTO): number | null =>
      previewRankById?.get(r.work_id) ?? relevanceForDisplay(r),
    [previewRankById]
  )

  // Plot the FILTERED set: the chart and the list are two views of one
  // selection, so a status filter that hides works from the list must hide them
  // from the map too. (Sort is deliberately NOT applied — the axes are
  // relevance x expansion, so ordering rows cannot move a bubble.)
  const plotRows = useMemo(
    () => (previewRelById ? filtered.map((r) => ({ ...r, relevance: relOf(r) })) : filtered),
    [filtered, previewRelById, relOf]
  )

  // The legend names exactly the rings the map is currently drawing: an entry
  // for a category nothing on the canvas has sends the reader hunting for a
  // bubble that is not there.
  const legendCats = useMemo<RingCategory[]>(() => {
    const present = new Set<RingCategory>()
    // The SAME population `FrontierMap` plots, so the legend cannot name a
    // category the canvas has nothing for — an excluded paper is filtered out
    // of the chart, and reading `plotRows` here kept its entry in the key.
    for (const r of plotRows) {
      if (r.relevance_rank === null || r.expansion_rank === null) continue
      if (r.inclusion_status === 'excluded') continue
      present.add(ringCategory(r.work_type, citeById.get(r.work_id) ?? 0, false))
    }
    const order: RingCategory[] = ['primary', 'review', 'method', 'highly-cited']
    return order.filter((c) => present.has(c))
  }, [plotRows, citeById])

  // ---- persistence ---------------------------------------------------------
  /**
   * Persist a new FULL-project order. Writes are minimal (usually a single
   * `overrideScore` for the moved row); the optimistic order is held until the
   * refetch lands so the list never flickers back.
   */
  const persistOrder = useCallback(
    async (newGlobal: number[], movedId: number): Promise<void> => {
      const writes = computeReorderWrites(newGlobal, movedId, relById)
      if (writes.length === 0) return
      setReordering(true)
      try {
        for (const w of writes) {
          await window.api.overrideScore(
            projectId,
            w.workId,
            'relevance',
            w.relevance,
            'manual drag reorder'
          )
        }
        // `reordering` is cleared by the layout effect once the refetch lands,
        // NOT here — see its declaration.
        state.reload()
      } catch {
        setManualOrder(null)
        setReordering(false)
      }
    },
    [projectId, relById, state]
  )

  /** Commit a new VISIBLE order: optimistic render + persist. */
  const commitVisibleOrder = useCallback(
    (newVisible: number[], movedId: number): void => {
      const newGlobal = spliceIntoGlobal(
        globalOrdered.map((r) => r.work_id),
        visible.map((r) => r.work_id),
        newVisible
      )
      setManualOrder(newGlobal)
      void persistOrder(newGlobal, movedId)
    },
    [globalOrdered, visible, persistOrder]
  )

  // ---- pointer drag engine -------------------------------------------------
  /** Recompute the live order from the pointer position and re-layout. */
  const updateDrag = useCallback((): void => {
    const m = measureRef.current
    const d = dragRef.current
    const list = listRef.current
    if (!m || !d || !list) return
    const delta =
      pointerRef.current.y - pointerRef.current.startY + (list.scrollTop - pointerRef.current.startScroll)
    // Follow the pointer immediately (no React round-trip → no dropped frames).
    const el = cardRefs.current.get(d.id)
    // The tiny scale is the "picked up" affordance. It is applied HERE (not in
    // CSS) because the transform property is owned imperatively by the drag —
    // a CSS rule would be clobbered by this very assignment.
    if (el) el.style.transform = `translateY(${delta}px) scale(1.015)`

    // Insertion index = how many of the OTHER slots have their midpoint above
    // the dragged card's centre, in the base layout minus the dragged row.
    const centre = m.tops[m.fromIndex] + delta + m.heights[m.fromIndex] / 2
    let idx = 0
    for (let i = 0; i < m.removedIds.length; i++) {
      const h = m.heights[m.base.indexOf(m.removedIds[i])]
      if (m.removedTops[i] + h / 2 < centre) idx = i + 1
    }
    const next = m.removedIds.slice()
    next.splice(idx, 0, d.id)
    if (next.length !== d.order.length || next.some((id, i) => id !== d.order[i])) {
      dragRef.current = { id: d.id, order: next }
      setDrag(dragRef.current)
    }
  }, [])

  // Shift the non-dragged cards into their live slots after every order change.
  // LAYOUT effect: on the first pass this also seats the freshly-mounted drop
  // indicator, which would otherwise paint one frame at top:0/height:0.
  useLayoutEffect(() => {
    const m = measureRef.current
    if (!drag || !m) return
    const gap = m.gap
    let y = m.tops[0]
    for (const id of drag.order) {
      const baseIdx = m.base.indexOf(id)
      if (baseIdx < 0) continue
      const el = cardRefs.current.get(id)
      if (el && id !== drag.id) {
        el.style.transition = 'transform .18s cubic-bezier(.2,.8,.3,1)'
        el.style.transform = `translateY(${y - m.tops[baseIdx]}px)`
      } else if (id === drag.id) {
        // Park the drop indicator in the slot the row would land in.
        const drop = dropRef.current
        if (drop) {
          drop.style.top = `${y}px`
          drop.style.height = `${m.heights[baseIdx]}px`
        }
      }
      y += m.heights[baseIdx] + gap
    }
  }, [drag])

  const autoscrollTick = useCallback((): void => {
    const list = listRef.current
    if (!list || !dragRef.current) return
    const rect = list.getBoundingClientRect()
    const y = pointerRef.current.y
    let dv = 0
    if (y < rect.top + AUTOSCROLL_EDGE) {
      dv = -Math.min(AUTOSCROLL_MAX, (rect.top + AUTOSCROLL_EDGE - y) / 3)
    } else if (y > rect.bottom - AUTOSCROLL_EDGE) {
      dv = Math.min(AUTOSCROLL_MAX, (y - (rect.bottom - AUTOSCROLL_EDGE)) / 3)
    }
    if (dv !== 0) {
      const before = list.scrollTop
      list.scrollTop = before + dv
      if (list.scrollTop !== before) updateDrag()
    }
    rafRef.current = requestAnimationFrame(autoscrollTick)
  }, [updateDrag])

  const finishDrag = useCallback(
    (commit: boolean): void => {
      const m = measureRef.current
      const d = dragRef.current
      // `finally` is load-bearing: if commitVisibleOrder throws synchronously we
      // must STILL tear the drag down, or `drag` stays non-null with no live
      // gesture and the document-wide grabbing cursor gets stuck on.
      try {
        if (m && d && commit) {
          const changed = d.order.some((id, i) => id !== m.base[i])
          if (changed) commitVisibleOrder(d.order, d.id)
        }
      } finally {
        endDrag()
      }
    },
    [commitVisibleOrder, endDrag]
  )

  const beginDrag = useCallback(
    (workId: number, clientY: number): void => {
      if (!canReorder || reordering || dragRef.current) return
      const list = listRef.current
      if (!list) return
      const ids = visible.map((r) => r.work_id)
      const fromIndex = ids.indexOf(workId)
      if (fromIndex < 0) return
      const tops: number[] = []
      const heights: number[] = []
      for (const id of ids) {
        const el = cardRefs.current.get(id)
        tops.push(el ? el.offsetTop : 0)
        heights.push(el ? el.offsetHeight : 0)
      }
      const gap = ids.length > 1 ? Math.max(0, tops[1] - tops[0] - heights[0]) : 0
      const removedIds = ids.filter((id) => id !== workId)
      const removedTops: number[] = []
      let y = tops[0]
      for (const id of removedIds) {
        removedTops.push(y)
        y += heights[ids.indexOf(id)] + gap
      }
      measureRef.current = { base: ids, tops, heights, gap, removedTops, removedIds, fromIndex }
      pointerRef.current = { startY: clientY, y: clientY, startScroll: list.scrollTop }
      dragRef.current = { id: workId, order: ids }
      // Seed the lift immediately so the card reads as "picked up" on
      // pointerdown, not only after the first pointermove.
      const dragged = cardRefs.current.get(workId)
      if (dragged) dragged.style.transform = 'translateY(0px) scale(1.015)'
      setDrag(dragRef.current)
      stopAutoscroll()
      rafRef.current = requestAnimationFrame(autoscrollTick)
    },
    [canReorder, reordering, visible, autoscrollTick, stopAutoscroll]
  )

  /**
   * DOCUMENT-WIDE grabbing cursor.
   *
   * The drag is driven by window-level pointer listeners, so the pointer spends
   * most of the gesture over elements that are NOT the handle (other cards,
   * their titles, the status dropdowns, the SVG chart) — each of which wins the cursor
   * with its own rule. A `cursor` declaration scoped to `.ranked-list` cannot
   * fix that. So while a drag is live we mark the ROOT element and CSS forces
   * `grabbing` on everything under it (see ranking.css).
   *
   * Cleanup is the effect's own teardown keyed on `drag`, which is the only
   * thing that can put the class on. React runs it on EVERY exit path — normal
   * drop, pointercancel, Escape, the refetch layout-effect that aborts a drag,
   * a re-render that clears `drag`, and unmount (route change / reload). There
   * is no imperative add/remove pair that could drift, so the whole app can
   * never get stuck showing `grabbing`.
   */
  // Keyed on the BOOLEAN, not on `drag`: the drag object's identity changes on
  // every insertion-index change, which would pointlessly remove+re-add the
  // class dozens of times per gesture.
  const dragging = drag !== null
  useEffect(() => {
    if (!dragging) return
    const root = document.documentElement
    root.classList.add('is-dragging-row')
    return () => {
      root.classList.remove('is-dragging-row')
    }
  }, [dragging])

  // Window-level listeners so the drag survives the pointer leaving the list.
  useEffect(() => {
    if (!drag) return
    const onMove = (e: PointerEvent): void => {
      e.preventDefault()
      pointerRef.current.y = e.clientY
      updateDrag()
    }
    const onUp = (): void => finishDrag(true)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') finishDrag(false)
    }
    window.addEventListener('pointermove', onMove, { passive: false })
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      window.removeEventListener('keydown', onKey)
    }
  }, [drag, updateDrag, finishDrag])

  /** Keyboard alternative to dragging: ArrowUp / ArrowDown move a row a slot. */
  const moveByKeyboard = useCallback(
    (workId: number, dir: -1 | 1): void => {
      if (!canReorder || reordering || dragRef.current) return
      const ids = visible.map((r) => r.work_id)
      const from = ids.indexOf(workId)
      const to = from + dir
      if (from < 0 || to < 0 || to >= ids.length) return
      commitVisibleOrder(moveItem(ids, from, to), workId)
      // Keep the moved row's handle focused across the re-render.
      requestAnimationFrame(() => {
        const el = cardRefs.current.get(workId)?.querySelector<HTMLButtonElement>('.drag-handle')
        el?.focus()
      })
    },
    [canReorder, reordering, visible, commitVisibleOrder]
  )

  const liveOrder = drag?.order ?? null

  return (
    <div className="screen screen-ranking" data-testid="screen-ranking">
      <ScreenHeader
        actions={
          // Filters and a sort order are ways of looking at a list, and there
          // is no list yet. Seven chips over an empty page invite a click that
          // changes nothing.
          state.data && state.data.length === 0 ? null : (
          <div className="ranking-actions">
            <div className="chip-row" data-testid="ranking-status-filters">
              {STATUS_FILTERS.map((o) => (
                <button
                  key={o.key}
                  className={`chip ${o.key === statusFilter ? 'chip-active' : ''}`}
                  data-testid={`chip-${o.key}`}
                  data-tip={o.tip}
                  onClick={() => {
                    setStatusFilter(o.key)
                    setShown(PAGE_SIZE)
                  }}
                >
                  {o.label}
                </button>
              ))}
            </div>
            <Select<SortBy>
              testid="ranking-sort"
              ariaLabel="Sort ranked works"
              className="input-sm"
              value={sortBy}
              format={(l) => `Sort: ${l}`}
              options={[
                {
                  value: 'relevance',
                  label: 'relevance',
                  tip: 'How closely the paper bears on this project\u2019s question.'
                },
                {
                  value: 'expansion',
                  label: 'expansion priority',
                  tip: 'How much NEW territory reading it would open up — a distinct axis from relevance, never fused with it.'
                },
                { value: 'year', label: 'year', tip: 'Publication year, newest first.' },
                {
                  value: 'citations',
                  label: 'citations',
                  tip: 'Citation count as recorded in the corpus.'
                }
              ]}
              onChange={(v) => {
                setSortBy(v)
                setShown(PAGE_SIZE)
              }}
            />
          </div>
          )
        }
      />

      <DataView
        state={state}
        isEmpty={(d) => d.length === 0}
        empty={
          <EmptyState
            title="No papers to rank yet."
            hint="This screen orders your papers two ways at once — how relevant each is to the project, and how much new ground it opens up."
          >
            <div className="empty-state-actions">
              <button
                type="button"
                className="btn btn-primary"
                data-testid="ranking-empty-add-papers"
                onClick={onAddPapers}
              >
                Add papers
              </button>
            </div>
          </EmptyState>
        }
      >
        {() => (
          <div className="ranking-grid">
            {/* LEFT — frontier map */}
            <section className="frontier-card" data-testid="frontier-map">
              <div className="frontier-head">
                <span className="mono eyebrow-mono">Frontier map · size = citations</span>
                <div className="frontier-legend mono">
                  {legendCats.map((c) => (
                    <span key={c} data-tip={ringCategoryTip(c)}>
                      <i
                        className="dot-ring"
                        style={{
                          borderColor: ringCategoryColor(c),
                          borderStyle: c === 'excluded' ? 'dashed' : 'solid'
                        }}
                      />
                      {ringCategoryLabel(c)}
                    </span>
                  ))}
                </div>
              </div>
              <div className="frontier-plot">
                {rows.length === 0 ? (
                  <div className="empty mono">No works to plot.</div>
                ) : (
                  <FrontierMap
                    rows={plotRows}
                    citeById={citeById}
                    selectedId={selectedId}
                    liveId={drag?.id ?? null}
                    // Viewport coords, passed straight through. They used to be
                    // rebased onto .frontier-plot for an absolutely-positioned
                    // card, but `.cg-hovercard` is `position: fixed` (it has to
                    // be — the connectome's canvas is inside three
                    // `overflow: hidden` boxes that would clip it). Fixed
                    // positioning then read those plot-relative numbers as
                    // viewport ones, so the card appeared offset from the
                    // pointer by however far the plot sits from the window
                    // corner — about 280px right and 190px down at this layout.
                    onHover={(h) => setHover(h)}
                  />
                )}
                {/* Same hovercard as the connectome, and now placed the same
                    way: PORTALLED to <body> and positioned from raw viewport
                    coords.

                    Both halves are load-bearing. `.cg-hovercard` is
                    `position: fixed`, which resolves against the nearest
                    ancestor carrying a transform — and `.screen` runs the
                    `screenIn` keyframes, which set one. So the card was being
                    re-based against the screen's origin rather than the
                    viewport, and its coords were ALSO pre-rebased onto the plot
                    box for a container that never applied: two offsets, both
                    pushing it down and right of the pointer. The portal removes
                    it from that subtree; `cardStyle` adds the 14px gap and
                    flips the card near a window edge so it is never half
                    off-screen. */}
                {hover &&
                  createPortal(
                    <div
                      className="cg-hovercard"
                      data-testid="frontier-hovercard"
                      style={cardStyle(hover.x, hover.y, 240, 70)}
                    >
                      <div className="cg-hovercard-title">{hover.row.title}</div>
                      <div className="cg-hovercard-stats mono">
                        {isScored(hover.row.relevance) && (
                          <span>REL {tenLabel(relevanceForDisplay(hover.row))}</span>
                        )}
                        {isScored(hover.row.expansion_priority) && (
                          <span>EXP {tenLabel(expansionForDisplay(hover.row))}</span>
                        )}
                      </div>
                    </div>,
                    document.body
                  )}
              </div>
            </section>

            {/* RIGHT — ranked list (the only scroller on this screen) */}
            <section className="ranked-col">
              <div className="ranked-col-head mono">
                <span className="eyebrow-mono">Ranked works</span>
                {/* Manual order is persisted AS relevance overrides, so dragging
                    under another sort would write meaningless values. State the
                    REASON, not just the remedy — a bare "sort by relevance"
                    reads like an arbitrary restriction. */}
                {!canReorder && (
                  <span className="ranked-reorder-note">
                    <span className="ranked-reorder-why">
                      drag sets relevance — disabled while sorted by{' '}
                      {SORT_LABELS[sortBy] ?? sortBy}
                    </span>
                    <button
                      type="button"
                      className="btn-link ranked-reorder-hint"
                      data-testid="ranking-enable-reorder"
                      onClick={() => setSortBy('relevance')}
                    >
                      sort by relevance
                    </button>
                  </span>
                )}
              </div>

              {filtered.length === 0 && <div className="empty">No works match this filter.</div>}

              <div
                className={`ranked-list${drag ? ' is-reordering' : ''}`}
                data-testid="ranked-list"
                ref={listRef}
              >
                {/* Drop indicator: an absolutely-positioned ghost slot showing
                    where the dragged row will land. Rendered only during a
                    drag; positioned by the layout effect above. */}
                {drag && <div className="drop-indicator" data-testid="drop-indicator" ref={dropRef} />}
                {visible.map((r, idx) => {
                  const ov = parseOverrides(r.user_overrides)
                  const overridden = hasOverride(ov)
                  const ovReason = overrideReasonOf(ov)
                  const excluded = r.inclusion_status === 'excluded'
                  const ringCat = ringCategory(
                    r.work_type,
                    citeById.get(r.work_id) ?? 0,
                    excluded
                  )
                  const selected = selectedId === r.work_id
                  // While dragging, the rank badge reflects the LIVE slot even
                  // though the DOM order is frozen.
                  const rankNum = String(
                    (liveOrder ? liveOrder.indexOf(r.work_id) : idx) + 1
                  )
                  // The handle stays ENABLED while a persist round-trip is in
                  // flight (disabling it would steal keyboard focus mid-
                  // sequence); `beginDrag`/`moveByKeyboard` guard on
                  // `reordering` instead. It is only truly disabled when the
                  // list is sorted on an axis that reordering cannot express.
                  const draggable = canReorder
                  const isDragging = drag?.id === r.work_id
                  const relevance = relOf(r)
                  // Two quantities, deliberately both in scope: `relevance` is
                  // the score — it decides whether anything is drawn at all and
                  // is what an override edits — and this is only where that
                  // score sits in the project's order, which is the one of the
                  // two a x/10 label can render without reading 0.
                  const relDisplay = relDisplayOf(r)
                  return (
                    <article
                      className={`rank-card${selected ? ' is-selected' : ''}${excluded ? ' is-excluded' : ''}${draggable ? ' is-draggable' : ''}${isDragging ? ' is-dragging' : ''}`}
                      data-testid={`ranking-row-${r.work_id}`}
                      data-rank={rankNum}
                      key={r.work_id}
                      ref={(el) => setCardRef(r.work_id, el)}
                      onClick={() => setSelectedId(r.work_id)}
                    >
                      <div className="rank-card-top">
                        <button
                          className="drag-handle"
                          type="button"
                          data-testid={`drag-handle-${r.work_id}`}
                          data-tip={draggable ? 'Drag to reorder (or arrow up / down)' : 'Sort by relevance to reorder'}
                          aria-label={
                            draggable
                              ? `Reorder ${r.title}: drag to reorder, or use arrow up and arrow down`
                              : 'Sort by relevance to reorder'
                          }
                          disabled={!draggable}
                          onClick={(e) => e.stopPropagation()}
                          onPointerDown={(e) => {
                            if (!draggable || e.button !== 0) return
                            e.preventDefault()
                            e.stopPropagation()
                            try {
                              ;(e.target as Element).releasePointerCapture?.(e.pointerId)
                            } catch {
                              /* not captured */
                            }
                            beginDrag(r.work_id, e.clientY)
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'ArrowUp') {
                              e.preventDefault()
                              moveByKeyboard(r.work_id, -1)
                            } else if (e.key === 'ArrowDown') {
                              e.preventDefault()
                              moveByKeyboard(r.work_id, 1)
                            }
                          }}
                        >
                          <i />
                          <i />
                          <i />
                        </button>
                        <span className="rank-badge">{rankNum}</span>
                        <span
                          className="dot-ring rank-type-dot"
                          style={{
                            borderColor: ringCategoryColor(ringCat),
                            borderStyle: ringCat === 'excluded' ? 'dashed' : 'solid'
                          }}
                          data-tip={ringCategoryTip(ringCat) ?? ringCategoryLabel(ringCat)}
                        />
                        <button
                          className="rank-title"
                          onClick={(e) => {
                            e.stopPropagation()
                            onOpenWork(r.work_id)
                          }}
                        >
                          <RichText text={r.title} />
                        </button>
                        {overridden && (
                          <span className="override-badge" data-testid={`override-badge-${r.work_id}`}>
                            overridden
                          </span>
                        )}
                        <span className="rank-year mono">{fmtYear(r.year)}</span>
                      </div>

                      {/* AN UNSCORED AXIS IS ABSENT, LABEL AND ALL. A bare "REL"
                          over an empty row is still an announcement that a
                          number is missing, which is the reader's cue to wonder
                          what happened to it; the honest rendering of "nothing
                          has scored this yet" is nothing. The card keeps its
                          title, year, status and actions, so the row is still
                          usable while its scores are being computed.
                          With neither axis scored the container goes too, rather
                          than holding open a gap the width of two bars. */}
                      {(isScored(relevance) || isScored(r.expansion_priority)) && (
                        <div className="rank-card-bars">
                          {isScored(relevance) && (
                            <div className="scorebar" data-testid={`relevance-${r.work_id}`}>
                              <div className="scorebar-label mono">
                                <span>
                                  REL {tenLabel(relDisplay)}
                                  {/* ONLY the shortfall speaks (HARD RULE 0.6).
                                      A paper with no abstract was scored on a
                                      fraction of the text the others offered,
                                      so a low number here is about the corpus
                                      rather than about the paper. Badging the
                                      full scores too would bury this one. */}
                                  {r.scored_on === 'title' && (
                                    <span
                                      className="badge badge-warn scored-on-badge"
                                      tabIndex={0}
                                      data-testid={`scored-on-title-${r.work_id}`}
                                      data-tip="No abstract is held here, so only the title was compared against this project — a shorter read scores lower whatever the paper is worth."
                                    >
                                      title only
                                    </span>
                                  )}
                                </span>
                                <button
                                  className="btn-mini btn-mini-icon"
                                  data-tip="Override relevance score"
                                  aria-label={`Override relevance score for ${plainText(r.title)}`}
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    openOverride(r.work_id, 'relevance')
                                  }}
                                >
                                  <PencilIcon />
                                </button>
                              </div>
                              <div className="scorebar-track">
                                <div
                                  className="scorebar-fill rel"
                                  style={{ width: pct(relDisplay) }}
                                />
                              </div>
                            </div>
                          )}
                          {isScored(r.expansion_priority) && (
                            <div className="scorebar" data-testid={`expansion-${r.work_id}`}>
                              <div className="scorebar-label mono">
                                <span>EXP {tenLabel(expansionForDisplay(r))}</span>
                                <button
                                  className="btn-mini btn-mini-icon"
                                  data-tip="Override expansion priority score"
                                  aria-label={`Override expansion priority score for ${plainText(r.title)}`}
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    openOverride(r.work_id, 'expansion_priority')
                                  }}
                                >
                                  <PencilIcon />
                                </button>
                              </div>
                              <div className="scorebar-track">
                                <div
                                  className="scorebar-fill exp"
                                  style={{ width: pct(expansionForDisplay(r)) }}
                                />
                              </div>
                            </div>
                          )}
                        </div>
                      )}

                      <div className="rank-card-foot">
                        <Select
                          className="status-select"
                          testid={`inclusion-select-${r.work_id}`}
                          ariaLabel={`Inclusion status for ${r.title}`}
                          value={r.inclusion_status}
                          options={INCLUSION_OPTIONS.map((s) => ({
                            value: s,
                            label: s,
                            tip: INCLUSION_TIPS[s]
                          }))}
                          onChange={(v) => void setStatus(r.work_id, v)}
                        />
                        {/* A TOGGLE, not a status: orthogonal to inclusion (a
                            paper can be included without feeding the dossier,
                            and vice versa) and the only input the dossier has. */}
                        <DossierToggle
                          atLimit={atLimit}
                          on={r.is_reference}
                          title={plainText(r.title)}
                          testid={`reference-toggle-${r.work_id}`}
                          size="sm"
                          onToggle={(next) => void toggleReference(r.work_id, next)}
                        />
                        {/* READING actions, after the two that CHANGE something.
                            A summary is how the user decides what the controls
                            to its left should be set to. */}
                        <SummaryButtons
                          workId={r.work_id}
                          projectId={projectId}
                          title={plainText(r.title)}
                          written={{
                            general: haveSummaries.general.has(r.work_id),
                            project: haveSummaries.project.has(r.work_id)
                          }}
                          size="sm"
                        />
                        {r.ranking_explanation && (
                          <Popover
                            testid={`explanation-${r.work_id}`}
                            trigger={(open) => (
                              <button
                                className="btn-link why-link why-link-icon"
                                data-tip="Why this rank"
                                aria-label={`Why this rank: ${plainText(r.title)}`}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  open()
                                }}
                              >
                                <svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                                  <circle cx="10" cy="10" r="7" />
                                  <path d="M8 8a2 2 0 1 1 2.6 1.9c-.4.15-.6.5-.6.95v.4" />
                                  <circle cx="10" cy="14" r="0.5" fill="currentColor" />
                                </svg>
                              </button>
                            )}
                          >
                            <div className="pop-title mono">Why this rank</div>
                            {/* THE SAME STRUCTURE THE CONNECTOME DRAWS, from the
                                same parser. This printed the stored sentence as
                                one paragraph while the inspector split it into
                                two labelled axes, so one row read two ways
                                depending on which screen you opened. Null still
                                falls back to the raw text: a row written by an
                                older scorer must be shown as it stands rather
                                than given headings this parser did not earn. */}
                            {(() => {
                              const parts = r.ranking_explanation
                                ? parseWhyRank(r.ranking_explanation)
                                : null
                              if (!parts) {
                                return (
                                  <div className="why-rank">
                                    <div className="why-rank-row">
                                      {isScored(relevance) && (
                                        <span className="why-rank-score">
                                          REL {tenLabel(relDisplay)}
                                        </span>
                                      )}
                                      {isScored(r.expansion_priority) && (
                                        <span className="why-rank-score">
                                          EXP {tenLabel(expansionForDisplay(r))}
                                        </span>
                                      )}
                                    </div>
                                    {r.ranking_explanation && (
                                      <div className="why-rank-reason">{r.ranking_explanation}</div>
                                    )}
                                    {ovReason && (
                                      <div className="why-rank-reason why-rank-override">
                                        Override: {ovReason}
                                      </div>
                                    )}
                                  </div>
                                )
                              }
                              return (
                                <div className="why-rank">
                                  {(
                                    [
                                      ['Relevance', 'rel', parts.relevance],
                                      ['Expansion priority', 'exp', parts.expansion]
                                    ] as const
                                  ).map(([name, tone, side]) => (
                                    <div className="why-rank-row" key={tone}>
                                      <div className="why-rank-head">
                                        <span className="why-rank-name mono">{name}</span>
                                        {side.score !== null && (
                                          <span className={`why-rank-score why-rank-score-${tone} mono`}>
                                            {side.score}
                                          </span>
                                        )}
                                      </div>
                                      <div className="why-rank-reason">{side.reason}</div>
                                      {/* Only under RELEVANCE, which is the score
                                          a thin read lowers. */}
                                      {tone === 'rel' && r.scored_on === 'title' && (
                                        <span className="badge badge-warn scored-on-badge">
                                          title only
                                        </span>
                                      )}
                                    </div>
                                  ))}
                                  {parts.notes.map((n, i) => (
                                    <div className="why-rank-note" key={i}>
                                      {n}
                                    </div>
                                  ))}
                                  {ovReason && (
                                    <div className="why-rank-reason why-rank-override">
                                      Override: {ovReason}
                                    </div>
                                  )}
                                </div>
                              )
                            })()}
                          </Popover>
                        )}
                        {saveFailure?.workId === r.work_id && (
                          <span
                            className="rank-save-failed"
                            data-testid={`rank-save-failed-${r.work_id}`}
                            role="alert"
                          >
                            <svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <path d="M10 2.6L18 16.6H2z" />
                              <path d="M10 8v3.6" />
                              <path d="M10 14.1v.1" />
                            </svg>
                            {saveFailure.sentence}
                          </span>
                        )}
                      </div>
                    </article>
                  )
                })}
              </div>

              {shown < filtered.length && (
                <button
                  className="btn btn-secondary show-more"
                  data-testid="ranking-show-more"
                  onClick={() => setShown((s) => s + PAGE_SIZE)}
                >
                  Show more ({filtered.length - shown} remaining)
                </button>
              )}
            </section>
          </div>
        )}
      </DataView>

      {overrideTarget && (
        <Modal
          title={`Override ${overrideTarget.field === 'relevance' ? 'relevance' : 'expansion priority'}`}
          onClose={() => setOverrideTarget(null)}
          testid="override-modal"
        >
          <div className="modal-body">
            <label className="field-label">Value (0.0–1.0)</label>
            <input
              className="input"
              type="number"
              min={0}
              max={1}
              step={0.01}
              data-testid="override-input"
              value={overrideValue}
              onChange={(e) => setOverrideValue(e.target.value)}
            />
            <label className="field-label" style={{ marginTop: 10 }}>
              Reason (optional)
            </label>
            <input
              className="input"
              data-testid="override-reason"
              value={overrideReason}
              onChange={(e) => setOverrideReason(e.target.value)}
            />
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setOverrideTarget(null)}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                data-testid="override-save"
                onClick={() => void saveOverride()}
              >
                Save
              </button>
            </div>
          </div>
        </Modal>
      )}

      {excludeTarget !== null && (
        <Modal
          title="Leave this paper out of the project"
          onClose={() => setExcludeTarget(null)}
          testid="exclude-modal"
        >
          {/* WHAT IT DOES, not a restatement of the button. "Exclude this work
              from the project?" told a reader only what they had already
              clicked, and the word suggests deletion — which is the one thing
              this does not do. The three lines below are the three real
              effects, in the order someone worries about them: the paper is
              kept, its findings stop counting, and it can be undone. */}
          <div className="modal-body">
            <p>
              The paper stays in your library and in the citation graph. You can read it, and
              it still shows in lists and searches.
            </p>
            <p>
              What changes is that its findings no longer count as evidence for this
              project: they are left out of summaries and exports, it drops off the
              Relevance × Expansion map, and it sinks slightly in the ranking so it stops
              sitting among the papers you still mean to read.
            </p>
            <p className="muted">
              Nothing is deleted, and this is only about this project. Set the paper back to
              any other status whenever you like.
            </p>
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setExcludeTarget(null)}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                data-testid="exclude-confirm"
                onClick={() => void confirmExclude()}
              >
                Leave it out
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
