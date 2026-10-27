import { useMemo, useRef, useState } from 'react'
import * as d3 from 'd3'
import type { TokenUsageBucketDTO } from '@shared/contract'
import { useAsync } from '../../lib/useAsync'
import { Select } from '../ui'

/**
 * What the model work has cost, per day.
 *
 * ONE chart, deliberately. The ledger behind it can answer per-paper and
 * per-stage questions too, but nobody has asked them yet and a settings pane
 * that grows a panel per available column becomes a place people stop reading.
 *
 * The stack is INPUT under OUTPUT rather than a band per model, so the height of
 * the stack is the day's total however many models the corpus touched. Stacking
 * by model would make the chart's legibility depend on a number the user does
 * not control.
 */
export function TokenUsageChart(): JSX.Element {
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [model, setModel] = useState('')

  const { data, loading, error } = useAsync(
    () =>
      window.api.getTokenUsage({
        from: from || null,
        to: to || null,
        model: model || null
      }),
    [from, to, model]
  )

  return (
    <div className="settings-section">
      <div className="settings-eyebrow mono">Token usage</div>

      <div className="tok-controls">
        <label className="tok-field">
          <span className="set-label mono">From</span>
          <input
            type="date"
            className="input tok-date"
            data-testid="tok-from"
            value={from}
            max={to || undefined}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label className="tok-field">
          <span className="set-label mono">To</span>
          <input
            type="date"
            className="input tok-date"
            data-testid="tok-to"
            value={to}
            min={from || undefined}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
        <div className="tok-field tok-field-model">
          <span className="set-label mono">Model</span>
          <Select
            className="tok-select"
            testid="tok-model"
            // The VISIBLE word, not a fuller sentence: a `<label>` cannot name a
            // button, so the name is supplied here — and a voice-control user
            // says what they can see, which is "Model".
            ariaLabel="Model"
            value={model}
            // Inert before anything has been recorded, because a selector
            // offering only "All models" is a control that cannot do anything —
            // and one that says why rather than just not responding.
            disabled={!data?.models.length}
            disabledTip="No calls have been recorded yet"
            options={[
              { value: '', label: 'All models' },
              ...(data?.models ?? []).map((m) => ({ value: m, label: m }))
            ]}
            onChange={setModel}
          />
        </div>
      </div>

      {error && (
        <p className="tok-note tok-note-bad" data-testid="tok-error">
          {error}
        </p>
      )}

      {loading && !data && <p className="tok-note">Reading…</p>}

      {data && !error && <Body data={data} onClearFilters={() => {
        setFrom('')
        setTo('')
        setModel('')
      }} />}
    </div>
  )
}

/**
 * The three nothings, told apart.
 *
 * "Not collecting", "collecting but nothing has run" and "filtered to nothing"
 * have three different remedies, and rendering one "no data" for all of them
 * sends the reader to fix the wrong thing — most likely to conclude the feature
 * is broken when it is working and merely idle.
 */
function Body({
  data,
  onClearFilters
}: {
  data: {
    buckets: TokenUsageBucketDTO[]
    collecting: boolean
    totalRows: number
  }
  onClearFilters: () => void
}): JSX.Element {
  if (!data.collecting && data.totalRows === 0) {
    return (
      <p className="tok-note" data-testid="tok-empty-off">
        Nothing is being recorded. Token usage is collected only while the diagnostic log is
        on — turn on <strong>Record a diagnostic log</strong> under About to start.
      </p>
    )
  }
  if (data.totalRows === 0) {
    return (
      <p className="tok-note" data-testid="tok-empty-fresh">
        Recording is on, and no model calls have been made yet. This fills in as papers are
        processed.
      </p>
    )
  }
  if (data.buckets.length === 0) {
    return (
      <p className="tok-note" data-testid="tok-empty-filtered">
        No calls match these filters, though {data.totalRows.toLocaleString()} are recorded.{' '}
        <button type="button" className="btn-link" onClick={onClearFilters}>
          clear filters
        </button>
      </p>
    )
  }
  return (
    <>
      <Chart buckets={data.buckets} />
      {/* An EXCEPTION, not a status line: while the log is off the chart is
          showing history that has stopped growing, and a reader looking at a
          flat right-hand end would otherwise read it as "no work happened". */}
      {!data.collecting && (
        <p className="tok-note tok-note-warn" data-testid="tok-paused">
          Recording is off — nothing new is being added.
        </p>
      )}
    </>
  )
}

const W = 720
const H = 240
const M = { top: 12, right: 12, bottom: 28, left: 60 }

function Chart({ buckets }: { buckets: TokenUsageBucketDTO[] }): JSX.Element {
  const [hover, setHover] = useState<number | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)

  // WHAT THE MODEL WORKED ON, and what it merely re-read, are separate bands.
  //
  // Input, output and the cache used to be one figure. They are disjoint counts,
  // and summing them made a cache-heavy run unreadable: twenty turns over one
  // cached document measured 40 tokens of fresh input against 301,746 re-read,
  // and the chart drew 300k of apparent work. Cache tokens are stacked last and
  // drawn faintest, so a tall band of them says "the same prefix, reused" rather
  // than "a great deal happened".
  const cacheOf = (b: TokenUsageBucketDTO): number => b.cacheWriteTokens + b.cacheReadTokens
  const { areaIn, areaOut, areaCache, x, y, days, maxTotal } = useMemo(() => {
    const days = buckets.map((b) => new Date(`${b.day}T00:00:00`))
    const maxTotal =
      d3.max(buckets, (b) => b.promptTokens + b.completionTokens + cacheOf(b)) ?? 0

    // The domain runs to the day AFTER the last, because a bucket occupies the
    // whole day rather than a point on its boundary. Ending at the last day
    // would give it zero width and drop the most recent figure off the chart —
    // the one the reader came to see.
    const end = new Date(days[days.length - 1])
    end.setDate(end.getDate() + 1)
    const x = d3
      .scaleTime()
      .domain([days[0], end])
      .range([M.left, W - M.right])
    const y = d3
      .scaleLinear()
      .domain([0, maxTotal || 1])
      .nice()
      .range([H - M.bottom, M.top])

    // STEPPED, not smoothed. A day is a discrete bucket, and a monotone curve
    // draws confident values between two days that were never measured —
    // reading a peak off the slope would be reading an interpolation. The step
    // says "this figure held for this day" instead.
    //
    // A single day has no horizontal extent, so an area path over it is
    // invisible; the dot layer below is what makes that case readable.
    const curve = d3.curveStepAfter

    // The final bucket is repeated at `end` so the step has somewhere to run
    // to. Without it the last day is drawn as a vertical line at its own left
    // edge and reads as a crash to zero.
    const edges = [...days, end]
    const pts = [...buckets, buckets[buckets.length - 1]]

    const areaIn = d3
      .area<TokenUsageBucketDTO>()
      .x((_, i) => x(edges[i]))
      .y0(y(0))
      .y1((b) => y(b.promptTokens))
      .curve(curve)(pts)
    const areaOut = d3
      .area<TokenUsageBucketDTO>()
      .x((_, i) => x(edges[i]))
      .y0((b) => y(b.promptTokens))
      .y1((b) => y(b.promptTokens + b.completionTokens))
      .curve(curve)(pts)
    const areaCache = d3
      .area<TokenUsageBucketDTO>()
      .x((_, i) => x(edges[i]))
      .y0((b) => y(b.promptTokens + b.completionTokens))
      .y1((b) => y(b.promptTokens + b.completionTokens + cacheOf(b)))
      .curve(curve)(pts)

    return { areaIn, areaOut, areaCache, x, y, days, maxTotal }
  }, [buckets])

  const ticks = y.ticks(4)
  const single = buckets.length === 1

  // At most six, and never more than there are days — a label per day turns
  // into overlapping mush at three weeks, and fractional dates are not dates.
  //
  // Then thinned by PIXEL distance, because d3's tick generator knows nothing
  // about how wide the rendered text is: the domain runs a day past the last
  // bucket, so its final tick lands beside the previous one and the two labels
  // overprint ("31 J01 Aug" shipped in a screenshot).
  const MIN_LABEL_GAP = 62
  const dayTicks = x.ticks(Math.min(6, days.length)).reduce<Date[]>((keep, d) => {
    if (!keep.length || x(d) - x(keep[keep.length - 1]) >= MIN_LABEL_GAP) keep.push(d)
    return keep
  }, [])

  const onMove = (e: React.MouseEvent<SVGSVGElement>): void => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return
    // The SVG scales to its container, so client pixels must be mapped back
    // through the viewBox before they mean anything to the scale.
    const px = ((e.clientX - rect.left) / rect.width) * W
    // The BAND the pointer is over, not the nearest left edge: the bands are
    // stepped, so the day drawn under the cursor is the one starting at or
    // before it. Nearest-edge picks the following day across the right half of
    // every band, which reads as the readout lagging the pointer.
    let best = 0
    days.forEach((d, i) => {
      if (x(d) <= px) best = i
    })
    setHover(best)
  }

  const hb = hover === null ? null : buckets[hover]

  return (
    <div className="tok-chart-wrap">
      <svg
        ref={svgRef}
        className="tok-chart"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Token usage per day. Peak ${maxTotal.toLocaleString()} tokens.`}
        data-testid="tok-chart"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line className="tok-grid" x1={M.left} x2={W - M.right} y1={y(t)} y2={y(t)} />
            <text className="tok-axis mono" x={M.left - 8} y={y(t)} dy="0.32em" textAnchor="end">
              {fmtCompact(t)}
            </text>
          </g>
        ))}

        {/* Output sits ON TOP of input and cache on top of both, so the stack's
            height is everything the day moved while its lower bands are what was
            actually worked on. The three differ in fill AND in stroke, never in
            hue alone — a colourblind reader still reads the boundaries. */}
        {areaCache && <path className="tok-band tok-band-cache" d={areaCache} />}
        {areaOut && <path className="tok-band tok-band-out" d={areaOut} />}
        {areaIn && <path className="tok-band tok-band-in" d={areaIn} />}

        {single &&
          buckets.map((b, i) => (
            <g key={b.day}>
              <circle className="tok-dot tok-dot-out" cx={x(days[i])} cy={y(b.promptTokens + b.completionTokens)} r={3.5} />
              <circle className="tok-dot tok-dot-in" cx={x(days[i])} cy={y(b.promptTokens)} r={3.5} />
            </g>
          ))}

        {hover !== null && (
          <line
            className="tok-cursor"
            x1={x(days[hover])}
            x2={x(days[hover])}
            y1={M.top}
            y2={H - M.bottom}
          />
        )}

        <line className="tok-axis-line" x1={M.left} x2={W - M.right} y1={y(0)} y2={y(0)} />

        {dayTicks.map((d) => (
          <text
            key={d.getTime()}
            className="tok-axis mono"
            // Clamped into the plot so the first and last labels are not
            // clipped by the viewBox, while every label still sits centred on
            // its own tick — anchoring the ends inward instead moves them
            // toward their neighbours, which is what made them collide.
            x={Math.min(Math.max(x(d), M.left + 18), W - M.right - 18)}
            y={H - 8}
            textAnchor="middle"
          >
            {fmtDay(d)}
          </text>
        ))}
      </svg>

      <div className="tok-legend">
        <span className="tok-key">
          <span className="tok-swatch tok-swatch-in" aria-hidden="true" />
          Input
        </span>
        <span className="tok-key">
          <span className="tok-swatch tok-swatch-out" aria-hidden="true" />
          Output
        </span>
        <span className="tok-key" data-tip="Input written to or served from the cache. Reused, never reprocessed.">
          <span className="tok-swatch tok-swatch-cache" aria-hidden="true" />
          Cache
        </span>
      </div>

      {/* A fixed-height readout, so hovering does not reflow the pane under the
          pointer — a layout that jumps as you move across it is unusable. */}
      <div className="tok-readout mono" data-testid="tok-readout">
        {hb ? (
          <>
            <span className="tok-readout-day">{hb.day}</span>
            <span>in {hb.promptTokens.toLocaleString()}</span>
            <span>out {hb.completionTokens.toLocaleString()}</span>
            {/* HARD RULE 0.6: the cache figure appears only where there is one.
                A run with no reuse should not carry a zero explaining itself. */}
            {cacheOf(hb) > 0 && <span>cache {cacheOf(hb).toLocaleString()}</span>}
            {/* The total is what the model WORKED ON. Cache is excluded on
                purpose: it is counted beside these, and adding it back is the
                sum that made one re-read document read as 300k of work. */}
            <span className="tok-readout-total">
              {(hb.promptTokens + hb.completionTokens).toLocaleString()} processed
            </span>
          </>
        ) : (
          <span className="tok-readout-idle">Hover the chart for a day&rsquo;s figures</span>
        )}
      </div>
    </div>
  )
}

function fmtCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k`
  return String(n)
}

function fmtDay(d: Date): string {
  return d3.timeFormat('%d %b')(d)
}
