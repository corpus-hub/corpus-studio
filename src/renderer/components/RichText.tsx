import { Fragment, type ReactNode } from 'react'
import { INLINE_TAGS, TAG_TOKEN, decodeEntities } from '@shared/markup'

export { plainText } from '@shared/markup'

/**
 * Upstream scientific markup, RENDERED rather than shown or thrown away.
 *
 * Crossref, PubMed and the preprint servers return real JATS/HTML inside titles
 * and abstracts: `A Saccharifying Pectate <i>trans</i>-Eliminase of <i>Erwinia
 * aroideae</i>`, `H<sub>2</sub>O<sub>2</sub>`, `T<sub>m</sub>`. React escapes
 * strings, so rendering the raw value shows the reader the angle brackets.
 *
 * THE OBVIOUS FIX — strip the tags at the boundary — IS WRONG, and it was tried
 * first. The markup is not noise: italics distinguish a species name from an
 * ordinary word and mark `trans`/`cis` as stereochemistry, and a subscript is
 * part of a formula. `T<sub>m</sub>` stripped is `Tm` and `x<sup>2</sup>` is
 * `x2` — different quantities. Deleting it destroys information the publisher
 * deliberately encoded, in a tool whose whole claim is fidelity to the source.
 *
 * NEVER `dangerouslySetInnerHTML`. This parses to REACT ELEMENTS through the
 * closed allowlist in `@shared/markup`, so an upstream index — or a search
 * plugin, which is a folder a stranger wrote — cannot inject an element, an
 * attribute or a handler by putting one in a title. Anything not on the list
 * has its tags dropped and its text kept: the reader loses emphasis, never the
 * words.
 *
 * PLAIN TEXT IS A SEPARATE QUESTION. Dedup keys, exports, model prompts and
 * `aria-label`s all want the words without the markup — that is `plainText`,
 * re-exported here so a caller needs one import.
 */
export function RichText({ text }: { text: string }): JSX.Element {
  // Nothing to parse: the overwhelmingly common case, and worth not walking.
  if (!text.includes('<') && !text.includes('&')) return <>{text}</>

  // A stack of open elements; children accumulate into the innermost.
  const root: ReactNode[] = []
  const stack: Array<{ tag: string | null; children: ReactNode[] }> = [
    { tag: null, children: root }
  ]
  const top = (): ReactNode[] => stack[stack.length - 1].children

  let last = 0
  let key = 0
  const pushText = (s: string): void => {
    if (s.length > 0) top().push(<Fragment key={key++}>{decodeEntities(s)}</Fragment>)
  }
  const closeFrame = (frame: { tag: string | null; children: ReactNode[] }): void => {
    // The tag name is one of `INLINE_TAGS`' values, which are all plain inline
    // elements — never a component, never anything from the input.
    const El = frame.tag as keyof JSX.IntrinsicElements
    top().push(<El key={key++}>{frame.children}</El>)
  }

  for (const m of text.matchAll(TAG_TOKEN)) {
    const [full, closing, nameRaw, selfClose] = m
    const at = m.index ?? 0
    pushText(text.slice(last, at))
    last = at + full.length

    const mapped = INLINE_TAGS[nameRaw.toLowerCase()]
    // NOT ON THE LIST: the tag vanishes and its text stays. An unknown element
    // is far likelier to be an index's stray markup than something the reader
    // needs, and rendering it would mean trusting a name nobody vetted.
    if (!mapped || selfClose === '/') continue

    if (closing === '/') {
      // Close the nearest matching open element. Scanning rather than assuming
      // the top matches is what makes crossed tags (`<i><sub></i></sub>`, which
      // real records contain) collapse sensibly instead of losing the tail.
      const idx = stack.map((f) => f.tag).lastIndexOf(mapped)
      if (idx > 0) {
        while (stack.length > idx) {
          const frame = stack.pop()
          if (!frame?.tag) break
          closeFrame(frame)
        }
      }
      continue
    }
    stack.push({ tag: mapped, children: [] })
  }
  pushText(text.slice(last))

  // Unbalanced markup is common in this data — a title truncated by an upstream
  // mid-tag, a `<sub>` never closed — so anything still open formats to here
  // rather than throwing or dropping the rest of the string.
  while (stack.length > 1) {
    const frame = stack.pop()
    if (!frame?.tag) break
    closeFrame(frame)
  }

  return <>{root}</>
}
