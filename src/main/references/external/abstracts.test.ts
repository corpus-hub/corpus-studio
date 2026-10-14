// The two unwrappers and the junk floor, asserted on their failure modes rather
// than their happy paths.
//
// Each test here stands for a way a WRONG ABSTRACT reaches a reference: a closed
// gap invents a word pair the paper never printed, position-matched replies hand
// one paper another's text, flattened MathML turns prose into digit soup, and a
// four-character deposit lets a reranker score noise. None of those throws; all
// of them read as a plausible paragraph under the right title, which is why they
// get tests and "it parsed some XML" does not.
//
// `fetchImpl` is injected throughout. Nothing here touches the network.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MIN_ABSTRACT_CHARS,
  bibliographicMatch,
  crossrefAbstract,
  openAlexAbstracts,
  printedCoordinate,
  reconstructAbstract,
  unwrapJats
} from './abstracts'

/** A `fetch` that answers from a table keyed by a substring of the URL. */
function fakeFetch(
  handler: (url: string) => { status?: number; body?: unknown } | 'throw'
): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input)
    const r = handler(url)
    if (r === 'throw') throw new Error('socket hang up')
    const status = r.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => r.body
    } as Response
  }) as unknown as typeof fetch
}

const LONG = 'x'.repeat(MIN_ABSTRACT_CHARS + 10)

// ------------------------------------------------------- rate limiting
//
// A 429 says how fast WE are going; it says nothing about the paper. Every
// caller here turns a failed request into "no index could be reached for this
// reference", so an unretried rate limit writes that across a whole
// bibliography — from a corpus whose only fault was asking too quickly.

test('a 429 is waited out and the retry is what answers', async () => {
  let calls = 0
  const waited: number[] = []
  const r = await crossrefAbstract('10.1/a', {
    sleepImpl: async (ms) => {
      waited.push(ms)
    },
    fetchImpl: fakeFetch(() => {
      calls++
      return calls < 3
        ? { status: 429 }
        : { body: { message: { abstract: `<jats:p>${LONG}</jats:p>`, title: ['A paper'] } } }
    })
  })
  assert.equal(calls, 3, 'the rate limit was not retried')
  assert.equal(r.outcome, 'found')
  // Doubling, so a busy index is not asked again at the same rate.
  assert.deepEqual(waited, [1000, 2000])
})

test('an index that keeps refusing is reported, not retried forever', async () => {
  let calls = 0
  const r = await crossrefAbstract('10.1/a', {
    sleepImpl: async () => {},
    fetchImpl: fakeFetch(() => {
      calls++
      return { status: 429 }
    })
  })
  assert.equal(calls, 3, 'the attempt budget is not bounded')
  assert.equal(r.outcome, 'unreachable')
  assert.match(r.error ?? '', /429/)
})

test('a status that is not 429 is not retried', async () => {
  let calls = 0
  const r = await crossrefAbstract('10.1/a', {
    sleepImpl: async () => {},
    fetchImpl: fakeFetch(() => {
      calls++
      return { status: 500 }
    })
  })
  assert.equal(calls, 1, 'a server error was retried as though it were a rate limit')
  assert.equal(r.outcome, 'unreachable')
})

// -------------------------------------------------- inverted index

test('a different position map produces a different reconstruction', () => {
  // Position 2 is missing: OpenAlex stripped whatever stood there. If the slot
  // is skipped, "thermostable" and "improved" become adjacent and the sentence
  // claims something the paper did not.
  const out = reconstructAbstract({
    The: [0],
    thermostable: [1],
    improved: [3],
    yield: [4]
  })
  assert.equal(out, 'The thermostable improved yield')

  // The gap is what the assertion above hides, so assert it directly: the
  // reconstruction must not be the four tokens joined in index order with the
  // hole closed at the JOIN level. Slot 2 existed and was empty.
  const withGapFilled = reconstructAbstract({
    The: [0],
    thermostable: [1],
    lipase: [2],
    improved: [3],
    yield: [4]
  })
  assert.equal(withGapFilled, 'The thermostable lipase improved yield')
  assert.notEqual(out, withGapFilled)
})

test('a leading gap does not shift the text left', () => {
  const out = reconstructAbstract({ second: [1], third: [2] })
  assert.equal(out, 'second third')
})

test('tokens arrive in any order and land at their positions', () => {
  const out = reconstructAbstract({
    catalysis: [3],
    Enzyme: [0],
    is: [1],
    rapid: [2]
  })
  assert.equal(out, 'Enzyme is rapid catalysis')
})

test('a repeated token fills every position it lists', () => {
  const out = reconstructAbstract({ in: [1, 3], interest: [0], vitro: [2], vivo: [4] })
  assert.equal(out, 'interest in vitro in vivo')
})

test('nothing usable yields null rather than an empty string', () => {
  assert.equal(reconstructAbstract(null), null)
  assert.equal(reconstructAbstract('a string'), null)
  assert.equal(reconstructAbstract([]), null)
  assert.equal(reconstructAbstract({}), null)
  assert.equal(reconstructAbstract({ word: 'not an array' }), null)
})

test('a hostile position is refused whole, not reconstructed partially', () => {
  assert.equal(reconstructAbstract({ boom: [50_000_000] }), null)
})

// ------------------------------------------------------------ JATS

test('MathML vanishes with its contents instead of becoming digit soup', () => {
  const xml =
    '<jats:p>The rate constant <mml:math><mml:mi>k</mml:mi><mml:mn>2</mml:mn>' +
    '<mml:mo>=</mml:mo><mml:mn>4.7</mml:mn></mml:math> was measured.</jats:p>'
  const out = unwrapJats(xml)
  assert.equal(out, 'The rate constant was measured.')
  for (const fragment of ['4.7', 'mml', '=', 'k']) {
    assert.equal(out!.includes(fragment), false, `MathML fragment "${fragment}" survived`)
  }
})

test('the literal "Abstract" heading is not part of the abstract', () => {
  const out = unwrapJats(`<jats:title>Abstract</jats:title><jats:p>${LONG}</jats:p>`)
  assert.equal(out, LONG)
})

test('paragraphs break before tags are stripped, so sections do not run together', () => {
  const out = unwrapJats('<jats:p>Background here.</jats:p><jats:p>Results here.</jats:p>')
  assert.equal(out, 'Background here.\n\nResults here.')
})

test('inline formatting is flattened, entities are decoded', () => {
  const out = unwrapJats(
    '<jats:p>k<jats:sub>cat</jats:sub> rose 40&#8211;fold in H&amp;E &lt;buffer&gt;.</jats:p>'
  )
  assert.equal(out, 'kcat rose 40–fold in H&E <buffer>.')
})

test('empty or tag-only JATS yields null', () => {
  assert.equal(unwrapJats(null), null)
  assert.equal(unwrapJats(''), null)
  assert.equal(unwrapJats('<jats:p></jats:p>'), null)
  assert.equal(unwrapJats('<jats:title>Abstract</jats:title>'), null)
})

// ------------------------------------------------------ the junk floor

test('a deposit of "Abstract" or "n/a" is not an abstract', async () => {
  for (const junk of ['Abstract', 'n/a', '—', '<jats:p>n/a</jats:p>']) {
    const r = await crossrefAbstract('10.1000/junk', {
      fetchImpl: fakeFetch(() => ({ body: { message: { abstract: junk, title: ['A paper'] } } }))
    })
    assert.equal(r.outcome, 'absent', `"${junk}" was accepted`)
    assert.equal(r.abstract, null)
    assert.equal(r.source, null)
    // The index DID answer, and holding nothing usable is not a failure.
    assert.equal(r.error, null)
  }
})

test('exactly at the floor is accepted; one character under is not', async () => {
  const at = 'a'.repeat(MIN_ABSTRACT_CHARS)
  const under = 'a'.repeat(MIN_ABSTRACT_CHARS - 1)

  const ok = await crossrefAbstract('10.1000/at', {
    fetchImpl: fakeFetch(() => ({ body: { message: { abstract: `<jats:p>${at}</jats:p>` } } }))
  })
  assert.equal(ok.outcome, 'found')
  assert.equal(ok.abstract, at)

  const no = await crossrefAbstract('10.1000/under', {
    fetchImpl: fakeFetch(() => ({ body: { message: { abstract: `<jats:p>${under}</jats:p>` } } }))
  })
  assert.equal(no.outcome, 'absent')
})

// --------------------------------------------------------- crossref

test('a Crossref hit carries its source and the title it matched', async () => {
  const r = await crossrefAbstract('https://doi.org/10.1000/ABC', {
    fetchImpl: fakeFetch((url) => {
      assert.equal(url.includes('10.1000%2Fabc'), true, `DOI not normalised in ${url}`)
      return { body: { message: { abstract: `<jats:p>${LONG}</jats:p>`, title: ['A Paper'] } } }
    })
  })
  assert.equal(r.doi, '10.1000/abc')
  assert.equal(r.outcome, 'found')
  assert.equal(r.source, 'crossref')
  assert.equal(r.matchedTitle, 'A Paper')
})

test('an HTTP failure is unreachable, never "no abstract on record"', async () => {
  const r = await crossrefAbstract('10.1000/x', {
    fetchImpl: fakeFetch(() => ({ status: 503 }))
  })
  assert.equal(r.outcome, 'unreachable')
  assert.equal(r.error, 'HTTP 503')
})

test('no identifier means we never asked, which is its own outcome', async () => {
  let called = false
  const r = await crossrefAbstract('   ', {
    fetchImpl: fakeFetch(() => {
      called = true
      return { body: {} }
    })
  })
  assert.equal(r.outcome, 'nothing-to-ask-with')
  assert.equal(called, false)
})

// --------------------------------------------------------- openalex

test('replies are matched by DOI, not by position, and a short reply is honest', async () => {
  const idx = (words: string[]): Record<string, number[]> =>
    Object.fromEntries(words.map((w, i) => [w, [i]]))
  const first = `first ${LONG}`.split(' ')
  const third = `third ${LONG}`.split(' ')

  const results = await openAlexAbstracts(['10.1/a', '10.1/b', '10.1/c'], {
    fetchImpl: fakeFetch((url) => {
      assert.equal(url.includes('filter=doi%3A10.1%2Fa%7C10.1%2Fb%7C10.1%2Fc'), true, url)
      return {
        // Reversed, and missing 10.1/b entirely — exactly what OpenAlex does.
        body: {
          results: [
            { doi: 'https://doi.org/10.1/c', title: 'C', abstract_inverted_index: idx(third) },
            { doi: 'https://doi.org/10.1/A', title: 'A', abstract_inverted_index: idx(first) }
          ]
        }
      }
    })
  })

  assert.equal(results.size, 3)
  assert.equal(results.get('10.1/a')!.abstract!.startsWith('first'), true)
  assert.equal(results.get('10.1/c')!.abstract!.startsWith('third'), true)
  // Held by nobody in the reply: the index answered and does not have it.
  assert.equal(results.get('10.1/b')!.outcome, 'absent')
  assert.equal(results.get('10.1/b')!.error, null)
})

test('a work with no inverted index is absent, and keeps its title for the trail', async () => {
  const results = await openAlexAbstracts(['10.1/a'], {
    fetchImpl: fakeFetch(() => ({
      body: { results: [{ doi: '10.1/a', title: 'Titled but abstractless' }] }
    }))
  })
  const r = results.get('10.1/a')!
  assert.equal(r.outcome, 'absent')
  assert.equal(r.matchedTitle, 'Titled but abstractless')
})

test('a failed batch marks its DOIs unreachable and the next batch still runs', async () => {
  const dois = Array.from({ length: 60 }, (_, i) => `10.1/d${i}`)
  let batch = 0
  const results = await openAlexAbstracts(dois, {
    fetchImpl: fakeFetch(() => {
      batch++
      if (batch === 1) return 'throw'
      return { body: { results: [{ doi: '10.1/d55', title: 'T', abstract_inverted_index: { a: [0] } }] } }
    })
  })

  assert.equal(batch, 2, 'the second batch did not run')
  assert.equal(results.get('10.1/d0')!.outcome, 'unreachable')
  assert.equal(typeof results.get('10.1/d0')!.error, 'string')
  // Second batch answered: present-but-too-short is `none`, not `unreachable`.
  assert.equal(results.get('10.1/d55')!.outcome, 'absent')
  assert.equal(results.get('10.1/d59')!.outcome, 'absent')
})

test('a DOI containing the OR separator is asked alone rather than splitting the filter', async () => {
  const seen: string[] = []
  await openAlexAbstracts(['10.1/a', '10.1/we|ird'], {
    fetchImpl: fakeFetch((url) => {
      seen.push(new URL(url).searchParams.get('filter') ?? '')
      return { body: { results: [] } }
    })
  })
  assert.deepEqual(seen.sort(), ['doi:10.1/a', 'doi:10.1/we|ird'])
})

test('an empty or identifier-free request never opens a socket', async () => {
  let called = false
  const impl = fakeFetch(() => {
    called = true
    return { body: {} }
  })
  assert.equal((await openAlexAbstracts([], { fetchImpl: impl })).size, 0)
  assert.equal((await openAlexAbstracts(['  '], { fetchImpl: impl })).size, 0)
  assert.equal(called, false)
})

// ---------------------------------------------- the bibliographic gate
//
// Every test below stands for a way a wrong abstract would reach a reference
// that has no DOI. The gate's only interesting behaviour is its refusals, so
// that is what is asserted: an accepted match is one case, and the rest are the
// ways a plausible-looking candidate must be turned away. Nothing here is a
// threshold — the accept and the reject differ by a digit, which is the whole
// point of replacing a similarity score with a printed coordinate.

/** A bibliography line in the commonest style: "journal volume:pages". */
const LINE_PNAS =
  'Korendovych IV, et al. (2011) Design of a switchable eliminase. ' +
  'Proc Natl Acad Sci USA 108:6823-6827.'

/** Crossref's reply shape, one item, as `select` returns it. */
function crossrefItem(item: Record<string, unknown>): typeof fetch {
  return fakeFetch(() => ({ body: { message: { items: [item] } } }))
}

const JATS_LONG = `<jats:p>${LONG}</jats:p>`

test('a volume and first page that match what the reference printed is a match', async () => {
  const r = await bibliographicMatch(
    { rawBibText: LINE_PNAS },
    {
      fetchImpl: crossrefItem({
        DOI: '10.1073/PNAS.1018191108',
        title: ['Design of a switchable eliminase'],
        volume: '108',
        page: '6823-6827',
        abstract: JATS_LONG
      })
    }
  )
  assert.equal(r.outcome, 'found')
  assert.equal(r.source, 'crossref')
  assert.equal(r.doi, '10.1073/pnas.1018191108')
  assert.equal(r.matchedTitle, 'Design of a switchable eliminase')
  // A verified coordinate is not a probability, so there is no number to store.
  assert.equal(r.matchConfidence, null)
})

test('a missing volume is not a disagreeing volume, and a book chapter matches on its page', async () => {
  // Methods in Enzymology and its kind are deposited with no volume at all
  // while the page range is exact. Refusing those discards a whole publication
  // type over a field the publisher never filled in.
  const r = await bibliographicMatch(
    {
      rawBibText:
        'Kaufmann KW, et al. (2011) Protein Structure Prediction Using Rosetta. ' +
        'Methods Enzymol 383, 66-93.'
    },
    {
      fetchImpl: crossrefItem({
        DOI: '10.1016/S0076-6879(04)83004-0',
        title: ['Protein Structure Prediction Using Rosetta'],
        volume: null,
        page: '66-93',
        abstract: JATS_LONG
      })
    }
  )
  assert.equal(r.outcome, 'found')
})

test('a volume that came back and disagrees is a rejection', async () => {
  const r = await bibliographicMatch(
    { rawBibText: LINE_PNAS },
    {
      fetchImpl: crossrefItem({
        DOI: '10.1/other',
        title: ['A different paper that starts on the same page'],
        volume: '109',
        page: '6823-6830',
        abstract: JATS_LONG
      })
    }
  )
  assert.equal(r.outcome, 'ambiguous')
  assert.equal(r.abstract, null)
  assert.equal(r.doi, null)
})

test('a first page one out is a different paper, and one digit is the whole test', async () => {
  // 707 against a printed 706 is a real reply from the corpus. Nothing here
  // scales with how close the numbers are: adjacent and distant fail alike.
  const r = await bibliographicMatch(
    { rawBibText: 'Smith J (2009) A paper. J Mol Biol 391, 706-712.' },
    {
      fetchImpl: crossrefItem({
        DOI: '10.1/near',
        title: ['The article that starts on the next page'],
        volume: '391',
        page: '707-715',
        abstract: JATS_LONG
      })
    }
  )
  assert.equal(r.outcome, 'ambiguous')
})

test('a reference that prints no coordinate is never asked about', async () => {
  let called = false
  const impl = fakeFetch(() => {
    called = true
    return { body: { message: { items: [{ DOI: '10.1/guess', abstract: JATS_LONG }] } } }
  })
  for (const line of [
    'Branden C, Tooze J (1999) Introduction to Protein Structure (Garland, New York).',
    'Okafor N (2013) PhD thesis (University of Lagos).',
    'Reetz MT, et al. Directed evolution of an epoxide hydrolase (submitted).'
  ]) {
    const r = await bibliographicMatch({ rawBibText: line }, { fetchImpl: impl })
    assert.equal(r.outcome, 'nothing-to-ask-with', line)
    assert.equal(r.doi, null)
  }
  // No candidate could have been checked against anything, so the request would
  // have bought an answer we would be obliged to refuse.
  assert.equal(called, false)
})

test('both printed house styles and both dashes parse to the same coordinate', () => {
  const expected = { volume: '34', firstPage: '938' }
  for (const line of [
    'Journal of Something 34:938-945.',
    'Journal of Something 34, 938-945.',
    'Journal of Something 34, 938\u2013945.',
    'Journal of Something 34:938\u2014945.',
    'Journal of Something 34 : 938 - 945.'
  ]) {
    assert.deepEqual(printedCoordinate(line), expected, line)
  }
  assert.equal(printedCoordinate('No numbers at all here.'), null)
  assert.equal(printedCoordinate(''), null)
})

test('the whole printed line is the query, and Crossref score is never requested', async () => {
  let url = ''
  await bibliographicMatch(
    { rawBibText: `  ${LINE_PNAS.replace('(2011)', '(2011)\n  ')}  ` },
    {
      fetchImpl: fakeFetch((u) => {
        url = u
        return { body: { message: { items: [] } } }
      })
    }
  )
  const q = new URL(url).searchParams
  assert.equal(q.get('query.bibliographic'), LINE_PNAS)
  assert.equal(q.get('rows'), '1')
  // `score` is an opaque dial that would only ever be tuned against examples.
  assert.equal((q.get('select') ?? '').includes('score'), false)
})

test('a verified match Crossref has no abstract for keeps its DOI for OpenAlex to try', async () => {
  const r = await bibliographicMatch(
    { rawBibText: LINE_PNAS },
    {
      fetchImpl: crossrefItem({
        DOI: '10.1073/pnas.1018191108',
        title: ['Design of a switchable eliminase'],
        volume: '108',
        page: '6823-6827'
      })
    }
  )
  assert.equal(r.outcome, 'absent')
  assert.equal(r.abstract, null)
  // The chain to OpenAlex only exists because the DOI survives this outcome.
  assert.equal(r.doi, '10.1073/pnas.1018191108')

  const filled = await openAlexAbstracts([r.doi!], {
    fetchImpl: fakeFetch(() => ({
      body: {
        results: [
          {
            doi: 'https://doi.org/10.1073/pnas.1018191108',
            title: 'Design of a switchable eliminase',
            abstract_inverted_index: Object.fromEntries(
              LONG.split('').map((c, i) => [`${c}${i}`, [i]])
            )
          }
        ]
      }
    }))
  })
  assert.equal(filled.get('10.1073/pnas.1018191108')!.outcome, 'found')
  assert.equal(filled.get('10.1073/pnas.1018191108')!.source, 'openalex')
})

test('an empty result set is absent rather than a guess', async () => {
  const r = await bibliographicMatch(
    { rawBibText: LINE_PNAS },
    { fetchImpl: fakeFetch(() => ({ body: { message: { items: [] } } })) }
  )
  assert.equal(r.outcome, 'absent')
  assert.equal(r.doi, null)
})

test('a Crossref that cannot be reached is retryable, not absent', async () => {
  const r = await bibliographicMatch(
    { rawBibText: LINE_PNAS },
    { fetchImpl: fakeFetch(() => 'throw') }
  )
  assert.equal(r.outcome, 'unreachable')
  assert.equal(typeof r.error, 'string')
})


// -------------------------------------------- JATS: markup vs prose

test('a bare < in an inequality is prose, not a tag opener', () => {
  // The generic `<[^>]*>` strip read the `<` as opening a tag and deleted
  // everything up to the `>` after kcat — nine words, silently, in exactly the
  // kinetics phrasing this app reads most.
  assert.equal(
    unwrapJats('<jats:p>Tm < 50 degrees and kcat > 3</jats:p>'),
    'Tm < 50 degrees and kcat > 3'
  )
})

test('an unclosed math element vanishes instead of degrading into digits', () => {
  // No `</mml:math>` ever arrives, so the paired removal cannot fire and the
  // generic strip used to flatten the operators into "We show 3+4 improves." —
  // the digit soup the paired removal exists to prevent.
  assert.equal(
    unwrapJats(
      '<jats:p>We show <mml:math><mml:mn>3</mml:mn><mml:mo>+</mml:mo><mml:mn>4</mml:mn> improves.</jats:p>'
    ),
    'We show'
  )
})

test('unclosed math costs its own paragraph and no other', () => {
  const out = unwrapJats(
    '<jats:p>Broken <mml:math><mml:mn>7</mml:mn></jats:p><jats:p>Intact sentence.</jats:p>'
  )
  assert.equal(out, 'Broken\n\nIntact sentence.')
})

test('a CDATA section is unwrapped to its contents, terminator and all', () => {
  assert.equal(unwrapJats('<jats:p><![CDATA[k < 5 & t > 2]]></jats:p>'), 'k < 5 & t > 2')
})

test('an XML comment is removed with its contents', () => {
  // A comment is the depositor talking to themselves. Keeping its text would
  // attribute a production note to the paper.
  assert.equal(
    unwrapJats('<jats:p>Real body.<!-- typeset by vendor X --></jats:p>'),
    'Real body.'
  )
})

test('an Abstract heading with trailing punctuation does not weld onto the body', () => {
  assert.equal(unwrapJats('<jats:title>ABSTRACT.</jats:title><jats:p>Body</jats:p>'), 'Body')
  assert.equal(unwrapJats('<jats:title>Abstract:</jats:title><jats:p>Body</jats:p>'), 'Body')
})

test('a section heading breaks from its body rather than joining it', () => {
  // Not the literal "Abstract" heading, so it is kept — but as a heading, not as
  // the first word of the sentence under it.
  const out = unwrapJats('<jats:sec><jats:title>Results</jats:title><jats:p>We found X.</jats:p></jats:sec>')
  assert.equal(out, 'Results\n\nWe found X.')
})

test('duplicate positions are last-writer-wins, and nothing is merged', () => {
  // OpenAlex emits one token per position, so this reply is already malformed.
  // The behaviour is stated rather than defended: inventing "first/second"
  // would be prose neither the paper nor the index wrote.
  assert.equal(reconstructAbstract({ first: [0], second: [0] }), 'second')
})
