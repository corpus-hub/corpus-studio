// Turning LaTeX source into readable Unicode prose.
//
// Why this exists: arXiv stores abstracts as the author's LaTeX, and publisher
// feeds carry JATS/HTML. Printed verbatim the reader gets
// "An $\alpha,\beta$-Kempe swap" and "$k$-colorings" — which looks like data
// corruption rather than mathematics.
//
// The goal is READABILITY, not typesetting. A results list shows two lines of
// abstract to help someone decide whether to open a paper; rendering real math
// there would mean shipping a TeX engine (and, under our CSP, one that does not
// eval). So each construct is mapped to the closest honest plain-text form:
// \alpha becomes α, \frac{a}{b} becomes a/b, x^2 becomes x², and anything
// unrecognised degrades to its own name rather than staying as a backslash.
//
// The one rule that matters: NEVER leave a stray backslash or dollar sign in the
// output. Those are the marks that read as corruption, and an unknown command is
// far better shown as its bare name than as "\varphi".

/** Greek, including the variant forms authors use interchangeably. */
const GREEK: Record<string, string> = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε',
  zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ',
  lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', omicron: 'ο', pi: 'π', varpi: 'ϖ',
  rho: 'ρ', varrho: 'ϱ', sigma: 'σ', varsigma: 'ς', tau: 'τ', upsilon: 'υ',
  phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Alpha: 'Α', Beta: 'Β', Gamma: 'Γ', Delta: 'Δ', Epsilon: 'Ε', Zeta: 'Ζ',
  Eta: 'Η', Theta: 'Θ', Iota: 'Ι', Kappa: 'Κ', Lambda: 'Λ', Mu: 'Μ', Nu: 'Ν',
  Xi: 'Ξ', Omicron: 'Ο', Pi: 'Π', Rho: 'Ρ', Sigma: 'Σ', Tau: 'Τ',
  Upsilon: 'Υ', Phi: 'Φ', Chi: 'Χ', Psi: 'Ψ', Omega: 'Ω'
}

/** Operators, relations, arrows and the punctuation authors reach for. */
const SYMBOLS: Record<string, string> = {
  // relations
  leq: '≤', le: '≤', geq: '≥', ge: '≥', neq: '≠', ne: '≠', equiv: '≡',
  approx: '≈', simeq: '≃', cong: '≅', sim: '∼', propto: '∝', asymp: '≍',
  ll: '≪', gg: '≫', leqslant: '≤', geqslant: '≥', doteq: '≐',
  prec: '≺', succ: '≻', preceq: '⪯', succeq: '⪰',
  // set theory / logic
  in: '∈', notin: '∉', ni: '∋', subset: '⊂', supset: '⊃',
  subseteq: '⊆', supseteq: '⊇', subsetneq: '⊊', supsetneq: '⊋',
  cup: '∪', cap: '∩', setminus: '∖', emptyset: '∅', varnothing: '∅',
  forall: '∀', exists: '∃', nexists: '∄', neg: '¬', lnot: '¬',
  land: '∧', wedge: '∧', lor: '∨', vee: '∨', oplus: '⊕', otimes: '⊗',
  // operators
  times: '×', div: '÷', pm: '±', mp: '∓', cdot: '·', ast: '∗', star: '⋆',
  circ: '∘', bullet: '•', sum: '∑', prod: '∏', coprod: '∐', int: '∫',
  iint: '∬', iiint: '∭', oint: '∮', partial: '∂', nabla: '∇',
  infty: '∞', surd: '√', angle: '∠', perp: '⊥', parallel: '∥',
  // arrows
  to: '→', rightarrow: '→', longrightarrow: '⟶', Rightarrow: '⇒',
  leftarrow: '←', longleftarrow: '⟵', Leftarrow: '⇐',
  leftrightarrow: '↔', Leftrightarrow: '⇔', mapsto: '↦', longmapsto: '⟼',
  uparrow: '↑', downarrow: '↓', nearrow: '↗', searrow: '↘',
  hookrightarrow: '↪', rightsquigarrow: '⇝',
  // dots and spacing-ish
  ldots: '…', dots: '…', cdots: '⋯', vdots: '⋮', ddots: '⋱',
  // misc
  deg: '°', prime: '′', dagger: '†', ddagger: '‡', S: '§', P: '¶',
  copyright: '©', pounds: '£', euro: '€', textdegree: '°',
  ell: 'ℓ', hbar: 'ℏ', Re: 'ℜ', Im: 'ℑ', aleph: 'ℵ',
  top: '⊤', bot: '⊥', models: '⊨', vdash: '⊢', therefore: '∴', because: '∵',
  // named functions read fine as their own name
  log: 'log', ln: 'ln', exp: 'exp', sin: 'sin', cos: 'cos', tan: 'tan',
  min: 'min', max: 'max', inf: 'inf', sup: 'sup', lim: 'lim', det: 'det',
  dim: 'dim', ker: 'ker', deg_: 'deg', gcd: 'gcd', mod: 'mod', bmod: 'mod'
}

/** Accents: \'e → é. Keyed by the accent command, then by the base letter. */
const ACCENTS: Record<string, Record<string, string>> = {
  "'": { a: 'á', e: 'é', i: 'í', o: 'ó', u: 'ú', y: 'ý', c: 'ć', n: 'ń', s: 'ś', z: 'ź',
         A: 'Á', E: 'É', I: 'Í', O: 'Ó', U: 'Ú', Y: 'Ý', C: 'Ć', N: 'Ń', S: 'Ś', Z: 'Ź' },
  '`': { a: 'à', e: 'è', i: 'ì', o: 'ò', u: 'ù', A: 'À', E: 'È', I: 'Ì', O: 'Ò', U: 'Ù' },
  '^': { a: 'â', e: 'ê', i: 'î', o: 'ô', u: 'û', A: 'Â', E: 'Ê', I: 'Î', O: 'Ô', U: 'Û' },
  '"': { a: 'ä', e: 'ë', i: 'ï', o: 'ö', u: 'ü', y: 'ÿ', A: 'Ä', E: 'Ë', I: 'Ï', O: 'Ö', U: 'Ü' },
  '~': { a: 'ã', n: 'ñ', o: 'õ', A: 'Ã', N: 'Ñ', O: 'Õ' },
  '=': { a: 'ā', e: 'ē', i: 'ī', o: 'ō', u: 'ū' },
  '.': { a: 'ȧ', e: 'ė', z: 'ż', Z: 'Ż' },
  c: { c: 'ç', s: 'ş', C: 'Ç', S: 'Ş' },
  v: { c: 'č', s: 'š', z: 'ž', r: 'ř', e: 'ě', C: 'Č', S: 'Š', Z: 'Ž', R: 'Ř' },
  u: { a: 'ă', g: 'ğ', G: 'Ğ' },
  H: { o: 'ő', u: 'ű' },
  k: { a: 'ą', e: 'ę' }
}

/** Superscript/subscript forms, used only when EVERY character maps. */
const SUPERSCRIPT: Record<string, string> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶',
  '7': '⁷', '8': '⁸', '9': '⁹', '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽',
  ')': '⁾', n: 'ⁿ', i: 'ⁱ'
}
const SUBSCRIPT: Record<string, string> = {
  '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆',
  '7': '₇', '8': '₈', '9': '₉', '+': '₊', '-': '₋', '=': '₌', '(': '₍',
  ')': '₎', a: 'ₐ', e: 'ₑ', i: 'ᵢ', j: 'ⱼ', o: 'ₒ', r: 'ᵣ', u: 'ᵤ', v: 'ᵥ', x: 'ₓ'
}

/** Blackboard-bold letters, so \mathbb{R} reads as ℝ rather than a bare R. */
const BLACKBOARD: Record<string, string> = {
  A: '𝔸', B: '𝔹', C: 'ℂ', D: '𝔻', E: '𝔼', F: '𝔽', G: '𝔾', H: 'ℍ', I: '𝕀',
  J: '𝕁', K: '𝕂', L: '𝕃', M: '𝕄', N: 'ℕ', O: '𝕆', P: 'ℙ', Q: 'ℚ', R: 'ℝ',
  S: '𝕊', T: '𝕋', U: '𝕌', V: '𝕍', W: '𝕎', X: '𝕏', Y: '𝕐', Z: 'ℤ'
}

/** Commands whose braced argument is ordinary text to be kept as-is. */
const TEXT_WRAPPERS = new Set([
  'emph', 'textit', 'textbf', 'texttt', 'textrm', 'textsf', 'textsc', 'textmd',
  'textup', 'textnormal', 'text', 'mbox', 'hbox', 'mathrm', 'mathbf', 'mathit',
  'mathsf', 'mathtt', 'mathnormal', 'operatorname', 'boldsymbol', 'bm',
  'underline', 'overline', 'textsuperscript', 'textsubscript', 'mathcal',
  'mathfrak', 'mathscr', 'uppercase', 'lowercase', 'ensuremath', 'label',
  'footnotesize', 'em', 'mathbb'
])

/** Commands to delete along with their braced argument (they render nothing). */
const DROP_WITH_ARG = new Set(['label', 'ref', 'cite', 'citep', 'citet', 'footnote', 'index'])

/** Bare commands that are pure layout and should simply vanish. */
const DROP_BARE = new Set([
  'em', 'rm', 'it', 'bf', 'sf', 'tt', 'sl', 'sc', 'normalfont', 'itshape',
  'bfseries', 'rmfamily', 'sffamily', 'ttfamily', 'noindent', 'par',
  'centering', 'displaystyle', 'textstyle', 'scriptstyle', 'left', 'right',
  'big', 'Big', 'bigg', 'Bigg', 'quad', 'qquad', 'medskip', 'smallskip',
  'bigskip', 'newline', 'linebreak', 'protect', 'limits', 'nolimits'
])

/**
 * Read a braced group starting at `open` (which must index a `{`).
 * Returns the group's contents and the index just past its closing brace.
 *
 * Brace counting rather than a regex: arguments nest (`\frac{\sqrt{x}}{2}`),
 * and a non-greedy regex stops at the FIRST `}`, which silently truncates the
 * argument and strands the remainder as loose text.
 */
function readGroup(src: string, open: number): { body: string; end: number } | null {
  if (src[open] !== '{') return null
  let depth = 0
  for (let i = open; i < src.length; i++) {
    const c = src[i]
    if (c === '\\') {
      i++
      continue
    }
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return { body: src.slice(open + 1, i), end: i + 1 }
    }
  }
  // Unbalanced source: treat the rest as the argument rather than giving up.
  return { body: src.slice(open + 1), end: src.length }
}

/** Map a whole run to super/subscript, or null if any character has no form. */
function toScript(text: string, table: Record<string, string>): string | null {
  let out = ''
  for (const ch of text) {
    const mapped = table[ch]
    if (mapped === undefined) return null
    out += mapped
  }
  return out
}

/**
 * Convert LaTeX to plain readable Unicode.
 *
 * Runs as a single left-to-right pass so that nested constructs resolve
 * inside-out, and so a command can consume the arguments that follow it.
 */
export function latexToText(input: string): string {
  let src = input

  // Comments first: an unescaped % hides the rest of its line in TeX, so
  // leaving it in would show text the author never meant to publish.
  src = src.replace(/(^|[^\\])%.*$/gm, '$1')

  const out: string[] = []
  let i = 0

  while (i < src.length) {
    const c = src[i]

    // Math delimiters carry no meaning once the contents are plain text.
    if (c === '$') {
      i += src.startsWith('$$', i) ? 2 : 1
      continue
    }
    if (c === '{' || c === '}') {
      i++
      continue
    }

    // Super/subscripts: x^2 → x², a_i → aᵢ. Falls back to the caret/underscore
    // form when the run has no Unicode equivalent, which still reads correctly.
    if (c === '^' || c === '_') {
      const table = c === '^' ? SUPERSCRIPT : SUBSCRIPT
      let body: string
      let next: number
      if (src[i + 1] === '{') {
        const g = readGroup(src, i + 1)
        if (!g) {
          i++
          continue
        }
        body = latexToText(g.body)
        next = g.end
      } else {
        body = src[i + 1] ?? ''
        next = i + 2
      }
      const scripted = toScript(body, table)
      out.push(scripted ?? `${c}${body}`)
      i = next
      continue
    }

    if (c !== '\\') {
      out.push(c)
      i++
      continue
    }

    // ---- a control sequence ----
    const rest = src.slice(i + 1)

    // Escaped literals: \%, \$, \&, \_, \#, \{, \}
    const literal = rest.match(/^([%$&_#{}])/)
    if (literal) {
      out.push(literal[1])
      i += 2
      continue
    }
    // Explicit spacing commands.
    if (/^[,;:!> ]/.test(rest)) {
      out.push(' ')
      i += 2
      continue
    }
    // Line break.
    if (rest.startsWith('\\')) {
      out.push(' ')
      i += 2
      continue
    }

    // Accents with a braced or bare argument: \'{e}, \'e, \c{c}
    const accentChar = rest[0]
    if (accentChar !== undefined && ACCENTS[accentChar] && !/[a-zA-Z]/.test(accentChar)) {
      const after = i + 2
      if (src[after] === '{') {
        const g = readGroup(src, after)
        if (g) {
          const base = g.body
          out.push(ACCENTS[accentChar][base] ?? base)
          i = g.end
          continue
        }
      }
      const base = src[after] ?? ''
      out.push(ACCENTS[accentChar][base] ?? base)
      i = after + 1
      continue
    }

    const nameMatch = rest.match(/^([a-zA-Z]+)\*?/)
    if (!nameMatch) {
      // A lone backslash before something unexpected — drop it rather than
      // print it, since a stray backslash is exactly what looks like corruption.
      i++
      continue
    }
    const name = nameMatch[1]
    let j = i + 1 + nameMatch[0].length
    // TeX swallows the whitespace after a control word, but that space is a real
    // word separator in the rendered text: dropping it turned "\geqslant 5" into
    // "≥5" and "\to \mathbb{C}" into "→ℂ". Remember it and re-emit it unless the
    // command turns out to take a braced argument.
    const hadSpace = src[j] === ' '
    while (src[j] === ' ') j++

    // Letter accents (\c{c}, \v{s}, \u{a}, \H{o}, \k{a}) — only when followed
    // by an argument, so \cup is not mistaken for a cedilla.
    if (ACCENTS[name] && src[j] === '{') {
      const g = readGroup(src, j)
      if (g) {
        out.push(ACCENTS[name][g.body] ?? g.body)
        i = g.end
        continue
      }
    }

    // \begin{env} / \end{env} — the environment NAME is machinery, not prose.
    // Left alone it printed as "beginequation" inside the sentence.
    if ((name === 'begin' || name === 'end') && src[j] === '{') {
      const g = readGroup(src, j)
      if (g) {
        let k = g.end
        // Column specs like {tabular}{ll} are layout too.
        if (src[k] === '{') {
          const spec = readGroup(src, k)
          if (spec) k = spec.end
        }
        out.push(' ')
        i = k
        continue
      }
    }

    if (DROP_WITH_ARG.has(name)) {
      if (src[j] === '{') {
        const g = readGroup(src, j)
        i = g ? g.end : j
      } else {
        i = j
      }
      continue
    }

    if (name === 'frac' || name === 'dfrac' || name === 'tfrac') {
      const a = src[j] === '{' ? readGroup(src, j) : null
      const b = a && src[a.end] === '{' ? readGroup(src, a.end) : null
      if (a && b) {
        const num = latexToText(a.body)
        const den = latexToText(b.body)
        // Parenthesise compound parts so "a+b/c" cannot be misread.
        const wrap = (s: string): string => (/[\s+\-−]/.test(s.trim()) ? `(${s})` : s)
        out.push(`${wrap(num)}/${wrap(den)}`)
        i = b.end
        continue
      }
    }

    if (name === 'sqrt') {
      let idx = ''
      let k = j
      if (src[k] === '[') {
        const close = src.indexOf(']', k)
        if (close !== -1) {
          idx = latexToText(src.slice(k + 1, close))
          k = close + 1
        }
      }
      if (src[k] === '{') {
        const g = readGroup(src, k)
        if (g) {
          const body = latexToText(g.body)
          out.push(idx ? `${idx}√(${body})` : `√(${body})`)
          i = g.end
          continue
        }
      }
      out.push('√')
      i = k
      continue
    }

    if (name === 'mathbb' && src[j] === '{') {
      const g = readGroup(src, j)
      if (g) {
        out.push([...g.body].map((ch) => BLACKBOARD[ch] ?? ch).join(''))
        i = g.end
        continue
      }
    }

    if (TEXT_WRAPPERS.has(name)) {
      if (src[j] === '{') {
        const g = readGroup(src, j)
        if (g) {
          out.push(latexToText(g.body))
          i = g.end
          continue
        }
      }
      // A font command applied to a BARE token, as in "\mathcal S" or
      // "\mathbb R". TeX scopes it to the single next character; without this
      // the command name ran into its argument and printed "mathcalS".
      const bare = src[j]
      if (bare !== undefined && /[A-Za-z0-9]/.test(bare)) {
        out.push(name === 'mathbb' ? (BLACKBOARD[bare] ?? bare) : bare)
        i = j + 1
        continue
      }
    }

    if (DROP_BARE.has(name)) {
      i = j
      continue
    }

    const symbol = GREEK[name] ?? SYMBOLS[name]
    if (symbol !== undefined) {
      out.push(hadSpace ? `${symbol} ` : symbol)
      i = j
      continue
    }

    // Unknown command: keep its NAME, drop the backslash. "\varphi" reading as
    // "varphi" is imperfect but legible; "\varphi" reads as broken data.
    out.push(hadSpace ? `${name} ` : name)
    i = j
  }

  return out
    .join('')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ([,.;:!?)])/g, '$1')
    .replace(/\( /g, '(')
    .trim()
}

/**
 * Render an abstract as readable prose.
 *
 * Handles both families of noise found in real feeds: publisher abstracts carry
 * JATS/HTML markup and a leading "Abstract:" label, while arXiv abstracts are
 * raw LaTeX.
 */
export function cleanAbstract(raw: string): string {
  if (!raw) return ''
  const withoutMarkup = raw
    // Block-level tags become a space so words either side do not fuse.
    .replace(/<\/?(?:p|div|br|li|tr|h[1-6]|sec|title)[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    // Entities that survive into feed text.
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/^\s*abstract[:.\s-]*/i, '')

  return latexToText(withoutMarkup)
    // TeX quoting and dashes, after the main pass so they cannot be re-split.
    .replace(/``|''/g, '"')
    .replace(/---/g, '—')
    .replace(/--/g, '–')
    .replace(/\s+/g, ' ')
    .trim()
}
