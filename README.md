# Corpus Studio

**Turn a folder of PDFs into a dataset you can defend.**

You have two hundred papers and one question: what did they actually measure,
under what conditions, and which ones disagree. Answering it by hand means a
spreadsheet, a highlighter, and a slow loss of confidence about where any
particular number came from.

Corpus Studio does that work and keeps the receipts. Every value it extracts
points back at the sentence it was read from.

Everything stays on your machine. Your library is a SQLite file you own, the
app runs with networking disabled, and nothing is uploaded anywhere you did
not point it at.

<img width="1915" alt="Extracted values beside the page they were read from" src="https://github.com/user-attachments/assets/187606b5-fcad-48b0-a508-bbc4d020287b" />

---

## Extraction: your fields, filled from the text

<img width="1918" alt="One row per paper, one column per field you defined" src="https://github.com/user-attachments/assets/5874cec6-45a9-4c20-9262-d29739c443cb" />

You define the columns — the quantity, the unit, the basis. Not a fixed schema
someone else designed for a different field.

- **A value the paper never printed is left empty.** It is not inferred from
  convention, not carried over from a similar paper, not guessed. An empty cell
  is a finding; an invented number is a retraction waiting to happen.
- **Every value is anchored.** Click it and the source sentence is highlighted
  on the page. No hunting through a PDF to check one figure.
- **Every value is labelled by how it was obtained** — reported directly,
  inferred, or supplied by your project's own context — so you can filter to
  only what was stated outright.
- **Coverage is measured, not assumed.** You see which papers filled which
  fields, so a gap in the data is visible as a gap rather than as silence.

Run it across the corpus and export the table to Obsidian, Zotero or plain
files — unfiltered, unrounded, with the model and prompt version that produced
each row.

## References: the citation graph, and what each citation was for

<img width="1916" alt="The reference tree, with cyclic edges and hidden unknowns stated" src="https://github.com/user-attachments/assets/a8e32e47-fe5b-402d-a907-006ba933ee22" />

See how a literature actually hangs together: which papers rest on which, laid
out in reading order, with the ones you have not got yet marked as gaps to fill.

- **Every citation records what it was FOR** — method, comparison, support,
  contrast, background, data source, motivation — so you can ask which papers
  a result was measured *against* rather than merely which were listed.
- **The sentence doing the citing is kept**, along with the raw bibliography
  text, so a reference is never silently reshaped into something tidier than
  the author wrote.
- **A reference no index recognises is kept and shown**, not dropped to make
  the graph look complete.
- **The view states its own limits** — cyclic edges it did not follow, cards
  outside the frame, cited works you do not have. What is missing is on screen
  rather than implied.

## Summaries you can trust for triage

A summary is only useful if you know what it was made from. Each one records
whether it was written from the full text or from an abstract alone, and is
badged accordingly — so an abstract-only summary is never mistaken for a
reading of the paper.

Summaries come in two kinds: a general one, and one written against your
project's own background, which reads the same paper for what it means to your
question specifically.

## Everything an AI touched, it signs

Each analysis stores the model, the provider, the prompt version, the schema
version and a hash of its inputs. When a paper, a prompt or a schema changes,
the affected analyses are marked stale and can be regenerated — the corpus
never quietly mixes results from two different setups.

Relevance and expansion priority are scored **separately and never averaged**,
each with a stored explanation you can read and override. Your override
persists.

## Building

Electron, React and TypeScript, with SQLite in the main process.

```sh
npm install
npm run build       # electron-vite build
npm start           # run it
npm run dist:linux  # AppImage + deb (also dist:win, dist:mac)
```

A fresh install opens empty: no sample corpus, no projects, nobody else's work.
