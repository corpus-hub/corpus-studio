// Segmentation — TS reimplementation of ai-detector's segment.py (razdel-based),
// per port-map §2/§5 Phase B. Produces paragraphs with the EXACT-SLICE offset
// contract: text.slice(charStart, charEnd) === paragraph.text ALWAYS. Sentence
// splitting uses Intl.Segmenter (offline, built-in). This underpins evidence-span
// anchoring.

export interface Sentence {
  text: string
  start: number
  end: number
}

export type ParagraphKind = 'prose' | 'heading' | 'list'

export interface Paragraph {
  id: string
  index: number
  text: string
  charStart: number
  charEnd: number
  sentences: Sentence[]
  kind: ParagraphKind
}

// A sentence segmenter that preserves absolute offsets into the paragraph text.
function splitSentences(text: string, baseOffset: number): Sentence[] {
  const out: Sentence[] = []
  // Intl.Segmenter is available in Node/Electron. Fall back to a regex if absent.
  const Seg = (Intl as unknown as { Segmenter?: typeof Intl.Segmenter }).Segmenter
  if (Seg) {
    const seg = new Seg('en', { granularity: 'sentence' })
    for (const part of seg.segment(text)) {
      const raw = part.segment
      const trimmed = raw.trim()
      if (!trimmed) continue
      // Recover absolute offsets of the trimmed slice inside `raw`.
      const lead = raw.length - raw.trimStart().length
      const start = baseOffset + part.index + lead
      const end = start + trimmed.length
      out.push({ text: trimmed, start, end })
    }
    if (out.length) return out
  }
  // Fallback: split on sentence-final punctuation followed by whitespace.
  const re = /[^.!?]+[.!?]*\s*/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const raw = m[0]
    const trimmed = raw.trim()
    if (!trimmed) continue
    const lead = raw.length - raw.trimStart().length
    const start = baseOffset + m.index + lead
    out.push({ text: trimmed, start, end: start + trimmed.length })
  }
  return out
}

function classify(text: string): ParagraphKind {
  const t = text.trim()
  // Heading: short, no terminal punctuation, few words.
  if (t.length <= 80 && !/[.!?;:]$/.test(t) && t.split(/\s+/).length <= 12) {
    if (/^(\d+(\.\d+)*\s+)?[A-Z]/.test(t)) return 'heading'
  }
  // List: leads with a bullet / number-dot / dash marker.
  if (/^\s*([-*•]|\d+[.)])\s+/.test(text)) return 'list'
  return 'prose'
}

/**
 * segment(text) -> Paragraph[]. Paragraphs are separated by one or more blank
 * lines. Soft-wrapped single newlines are kept inside a paragraph. Junk
 * (whitespace-only / lone punctuation / pure page-number lines) is dropped.
 * The exact-slice contract is guaranteed because charStart/charEnd index the
 * ORIGINAL text and paragraph.text is that exact slice.
 */
export function segment(text: string): Paragraph[] {
  const paras: Paragraph[] = []
  // Split on blank-line boundaries but keep offsets via a regex over the source.
  const re = /[^\n]*(?:\n(?!\s*\n)[^\n]*)*/g
  let index = 0
  let m: RegExpExecArray | null
  const seen = new Set<number>()
  while ((m = re.exec(text)) !== null) {
    if (m.index === re.lastIndex) {
      re.lastIndex++ // zero-length guard
    }
    const raw = m[0]
    if (raw === '') continue
    if (seen.has(m.index)) continue
    seen.add(m.index)

    // Trim leading/trailing whitespace but adjust offsets to keep exact-slice.
    const lead = raw.length - raw.trimStart().length
    const trailing = raw.length - raw.trimEnd().length
    const start = m.index + lead
    const end = m.index + raw.length - trailing
    if (end <= start) continue
    const body = text.slice(start, end)

    // Drop junk: lone punctuation, dot-leaders, bare page numbers.
    if (/^[\s.\u2026·•\-–—]+$/.test(body)) continue
    if (/^\d{1,4}$/.test(body.trim())) continue

    const kind = classify(body)
    paras.push({
      id: `p${index}`,
      index,
      text: body,
      charStart: start,
      charEnd: end,
      sentences: splitSentences(body, start),
      kind
    })
    index++
  }
  return paras
}
