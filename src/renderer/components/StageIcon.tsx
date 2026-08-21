// The pipeline states, drawn.
//
// WHY SVG AND NOT CHARACTERS. These were Unicode symbols — `⤼`, `⛒`, `∅`, `‖` —
// and every one of them was a bet that the user's machine had a font carrying
// that codepoint. Twice the bet lost: `⤼` (U+293C) exists only in FreeSerif and
// DejaVu Serif here, so it rendered as a serif glyph inside a sans interface and
// read as a rendering fault; `⏸` (U+23F8) is present in three faces and drawn as
// a colour emoji by most of them. A symbol that falls back is not a quieter
// icon, it is a wrong one — and at 11px inside a 22px ring, tofu and a state are
// indistinguishable.
//
// Drawn paths remove the bet entirely. They also let each state be a genuinely
// different SHAPE at this size, which is what carries the meaning for a reader
// who cannot rely on the colour: a tick, a cross, a pause bar, a slashed circle.
//
// `currentColor` throughout, so the ring's own colour rule keeps owning the
// state's hue and this file never repeats a palette decision.

import type { JSX } from 'react'
import type { StageState } from '../lib/stageState'

/**
 * One state, at the size the caller asks for.
 *
 * `strokeWidth` is set per-icon rather than globally: a tick and a pause bar
 * need different weights to read as the same density at 11px, and a single
 * value made the filled shapes look heavy beside the linear ones.
 */
export function StageIcon({ state, size = 11 }: { state: StageState; size?: number }): JSX.Element {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 20 20',
    fill: 'none' as const,
    stroke: 'currentColor',
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true
  }

  switch (state) {
    // Not scheduled: three dots, the flattest mark in the set. Deliberately not
    // a ring — half these shapes are circles, and a circle inside the 22px ring
    // resolves to a hairline that looks like an artifact.
    case 'pending':
      return (
        <svg {...common} strokeWidth={2.6}>
          <path d="M5 10h.01M10 10h.01M15 10h.01" />
        </svg>
      )
    // Scheduled and holding: a pause bar. Real work that has not started.
    case 'queued':
      return (
        <svg {...common} strokeWidth={2.4}>
          <path d="M7.5 5v10M12.5 5v10" />
        </svg>
      )
    // Waiting on something upstream: a link with a break in it.
    case 'blocked':
      return (
        <svg {...common} strokeWidth={1.9}>
          <path d="M8.2 6.5h-1.7a3.5 3.5 0 0 0 0 7h1.7" />
          <path d="M11.8 6.5h1.7a3.5 3.5 0 0 1 0 7h-1.7" />
          <path d="M7.5 3.2l5 13.6" />
        </svg>
      )
    // Working now: a play triangle, filled so it reads as motion rather than an
    // outline someone might mistake for "next".
    case 'running':
      return (
        <svg {...common} strokeWidth={1.6} fill="currentColor">
          <path d="M7 4.8l8 5.2-8 5.2z" />
        </svg>
      )
    case 'succeeded':
      return (
        <svg {...common} strokeWidth={2.6}>
          <path d="M4.5 10.5l4 4 7-9" />
        </svg>
      )
    // Ran, found nothing: the empty-set slash. An answer, not a fault.
    case 'empty':
      return (
        <svg {...common} strokeWidth={1.9}>
          <circle cx="10" cy="10" r="6" />
          <path d="M5.5 15l9-10" />
        </svg>
      )
    // Stopped on purpose: a hand, not a failure. Distinct from `empty`'s slash
    // by being solid-barred rather than diagonal.
    case 'refused':
      return (
        <svg {...common} strokeWidth={1.9}>
          <circle cx="10" cy="10" r="6" />
          <path d="M6.5 10h7" />
        </svg>
      )
    case 'cancelled':
      return (
        <svg {...common} strokeWidth={2.2}>
          <path d="M5.5 5.5l9 9M14.5 5.5l-9 9" strokeOpacity="0.55" />
        </svg>
      )
    case 'failed':
      return (
        <svg {...common} strokeWidth={2.6}>
          <path d="M5.5 5.5l9 9M14.5 5.5l-9 9" />
        </svg>
      )
    // Out of date: a refresh arrow — its result stands but has been overtaken.
    case 'superseded':
      return (
        <svg {...common} strokeWidth={1.9}>
          <path d="M15.5 8A6 6 0 1 0 16 11" />
          <path d="M16.2 4.6v3.6h-3.6" />
        </svg>
      )
    // Stopped part-way: a half-filled circle, the only shape here that is
    // partly solid, so "incomplete" is legible without reading a label.
    case 'stalled':
      return (
        <svg {...common} strokeWidth={1.8}>
          <circle cx="10" cy="10" r="6" />
          <path d="M10 4a6 6 0 0 1 0 12z" fill="currentColor" stroke="none" />
        </svg>
      )
  }
}
