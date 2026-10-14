/**
 * Upstream scientific markup: what to keep, what to render, what to ignore.
 *
 * SHARED, and in `src/shared` for the reason that directory exists: both sides
 * of the IPC boundary need these exact rules. Main uses `plainText` for the
 * dedup key and for the text it hands a model; the renderer uses the same
 * function for `aria-label`s and the tag table for `RichText`. Two copies would
 * drift, and the failure would be silent — the same paper keyed two ways.
 *
 * WHY MARKUP IS KEPT AT ALL. Crossref, PubMed and the preprint servers return
 * real JATS/HTML inside titles and abstracts: `A Saccharifying Pectate
 * <i>trans</i>-Eliminase of <i>Erwinia aroideae</i>` is a genuine record.
 * Stripping it at ingest was tried and reverted — italics distinguish a species
 * name and mark `trans` as stereochemistry, and a subscript is part of a
 * formula. `T<sub>m</sub>` flattened to `Tm` is a different string from the one
 * the paper prints, in an app whose claim is fidelity to the source. So the
 * stored value keeps it, the UI renders it, and only the plain-text consumers
 * strip it.
 *
 * No JSX here, deliberately: `scripts/verify-backend.ts` compiles under the
 * node tsconfig, which has no `--jsx`, and these rules are exactly what it
 * needs to assert.
 */

/**
 * Tags rendered as themselves. A CLOSED LIST, and the security boundary.
 *
 * The text comes from an academic index or a SEARCH PLUGIN — a folder a
 * stranger wrote — so a title is untrusted input rendered into the app's own
 * window. Anything not named here has its tags dropped and its text kept, which
 * is the safe direction: the reader loses emphasis, never the words.
 */
export const INLINE_TAGS: Record<string, string> = {
  i: 'i',
  em: 'em',
  italic: 'i',
  b: 'b',
  strong: 'strong',
  bold: 'b',
  sub: 'sub',
  sup: 'sup',
  u: 'u',
  small: 'small',
  // JATS spells them out, and Crossref returns JATS verbatim in abstracts.
  'jats:italic': 'i',
  'jats:bold': 'b',
  'jats:sub': 'sub',
  'jats:sup': 'sup',
  'jats:sc': 'span',
  'jats:p': 'span',
  'jats:title': 'span'
}

/**
 * A tag: `<name>`, `</name>`, `<ns:name/>`, or an XML processing instruction.
 *
 * The name must start with a LETTER, which is what keeps `p < 0.05`, `T < 4 K`
 * and `<10 µM` as prose. A greedy `<[^>]*>` deletes from the first `<` to the
 * next `>` and turns "p < 0.05, n > 30" into "p 30" — silent corruption of
 * exactly the values this app exists to preserve. That is asserted by a
 * negative control in `verify:backend`, so a later "simplification" back to the
 * obvious pattern fails a gate rather than a corpus.
 */
export const TAG_TOKEN =
  /<(\/?)([a-zA-Z][a-zA-Z0-9-]*(?::[a-zA-Z][a-zA-Z0-9-]*)?)(?:\s[^<>]*?)?(\/?)>/g

const ENTITY = /&(?:(amp|lt|gt|quot|apos|nbsp)|#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6}));/g

/**
 * Decode the XML entities, ONCE.
 *
 * `&amp;lt;` must become the literal text `&lt;`, not `<`. Decoding repeatedly
 * would let a double-escaped string turn back into markup after the parse has
 * already decided what is markup.
 */
export function decodeEntities(s: string): string {
  return s.replace(ENTITY, (m, name: string | undefined, dec: string | undefined, hex: string | undefined) => {
    if (name) {
      return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' }[name] ?? m
    }
    const code = dec ? Number.parseInt(dec, 10) : Number.parseInt(hex ?? '', 16)
    // Control characters are dropped rather than materialised: the same class
    // of value the ingest boundary strips, and decoding must not smuggle one
    // back in behind it.
    if (!Number.isFinite(code) || code < 32 || code === 127 || code > 0x10ffff) return ' '
    return String.fromCodePoint(code)
  })
}

/**
 * A field whose markup arrived ESCAPED, restored to markup.
 *
 * Some indexes — Europe PMC among them — HTML-encode the JATS inside a title, so
 * the field carries `&lt;i&gt;Caecomyces churrovis&lt;/i&gt;` rather than
 * `<i>…</i>`. Every markup-aware consumer then fails in the same way:
 * `TAG_TOKEN` finds no tag, the entities decode as ordinary text, and the reader
 * is shown the angle brackets — `H<sub>2</sub>` printed verbatim in a result
 * row, which is what this was reported as.
 *
 * WHY THE DECISION IS ABOUT THE WHOLE FIELD, NOT EACH ENTITY. Unescaping `&lt;`
 * wherever it appears would corrupt exactly the values this app exists to
 * preserve: a title reading `p &lt; 0.05` means the CHARACTER, and promoting it
 * to markup would leave `TAG_TOKEN`'s "a tag starts with a letter" rule as the
 * only thing between a statistic and a deleted clause. So this fires only when
 * the field contains an escaped sequence that is unmistakably a tag from the
 * allowlist, and contains no raw `<` that might already be markup. Anything
 * ambiguous is left exactly as it arrived.
 *
 * ONCE, and only at the ingest boundary. `decodeEntities` deliberately decodes a
 * single level so `&amp;lt;` stays the literal text `&lt;`; a double-escaped
 * field therefore still renders as text after this, which is correct.
 */
const ESCAPED_TAG = /&lt;\/?([a-zA-Z][a-zA-Z0-9-]*(?::[a-zA-Z][a-zA-Z0-9-]*)?)\s*\/?&gt;/g

export function unescapeMarkup(s: string): string {
  if (s.includes('<')) return s
  let sawKnownTag = false
  for (const m of s.matchAll(ESCAPED_TAG)) {
    if (INLINE_TAGS[m[1].toLowerCase()]) {
      sawKnownTag = true
      break
    }
  }
  if (!sawKnownTag) return s
  // Only the bracket entities, and only inside a matched tag. `&amp;` is left
  // alone: decoding it here would put a live `&` in front of whatever follows
  // and let `decodeEntities` read a second entity out of text that never had
  // one — the double-decode this module is careful to avoid.
  return s.replace(ESCAPED_TAG, (full) => full.replace(/&lt;/g, '<').replace(/&gt;/g, '>'))
}

/**
 * The words of a stored field, without its markup.
 *
 * For every consumer that is NOT a rendered element: the dedup key, an export,
 * the text handed to a model, an `aria-label`, a window title, a search query
 * built from a title.
 *
 * Escaped markup is resolved FIRST, so a title from an index that encodes its
 * tags produces the same key and the same words as the identical title from one
 * that does not. Without it the two spell the same paper differently and dedup
 * keeps both.
 */
export function plainText(s: string): string {
  return decodeEntities(unescapeMarkup(s).replace(TAG_TOKEN, ''))
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * What `RichText` would render, as an HTML string.
 *
 * Exists so the parse can be ASSERTED without a DOM — `verify:backend` checks
 * that `<script>`, `<img onerror>`, an `<iframe>` and a handler attribute all
 * come back inert, and that `p < 0.05` survives. Those are security and
 * data-integrity properties and they belong in a gate.
 *
 * The component builds React elements from the same rules rather than calling
 * this: turning a string into elements would mean `dangerouslySetInnerHTML`,
 * which is the one thing that file refuses to do.
 */
export function renderToHtml(text: string): string {
  if (!text.includes('<') && !text.includes('&')) return text
  const root: string[] = []
  const stack: Array<{ tag: string | null; children: string[] }> = [{ tag: null, children: root }]
  const top = (): string[] => stack[stack.length - 1].children
  const close = (f: { tag: string | null; children: string[] }): string =>
    `<${f.tag}>${f.children.join('')}</${f.tag}>`
  let last = 0
  const pushText = (s: string): void => {
    if (s.length > 0) top().push(decodeEntities(s))
  }
  for (const m of text.matchAll(TAG_TOKEN)) {
    const [full, closing, nameRaw, selfClose] = m
    const at = m.index ?? 0
    pushText(text.slice(last, at))
    last = at + full.length
    const mapped = INLINE_TAGS[nameRaw.toLowerCase()]
    if (!mapped || selfClose === '/') continue
    if (closing === '/') {
      const idx = stack.map((f) => f.tag).lastIndexOf(mapped)
      if (idx > 0) {
        while (stack.length > idx) {
          const f = stack.pop()
          if (!f?.tag) break
          top().push(close(f))
        }
      }
      continue
    }
    stack.push({ tag: mapped, children: [] })
  }
  pushText(text.slice(last))
  while (stack.length > 1) {
    const f = stack.pop()
    if (!f?.tag) break
    top().push(close(f))
  }
  return root.join('')
}
