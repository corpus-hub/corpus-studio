# `payload-texts/` — upstream licence texts for the non-JS payloads

One file per `id` in `resources/payloads.json`. `scripts/gen-licences.ts` reads
them, content-addresses them into `../texts/`, and fails loudly if one is
missing — so adding a payload without its licence text cannot build.

They are **checked in** rather than read out of the provisioned tree, because
`resources/bin|lib|models|tesseract` are gitignored. An attribution that
disappears on a machine that has not run `npm run payloads` is exactly the
compliance hole this directory exists to close.

Each file is the upstream text **verbatim**. Provenance:

| file | source |
|---|---|
| `qpdf.txt` | `qpdf/qpdf` `v12.3.2` `LICENSE.txt` **+ `NOTICE.md`** |
| `tessdata-eng.txt` | `tesseract-ocr/tessdata_fast` `4.1.0` `LICENSE` |
| `sqlite-vec.txt` | `asg017/sqlite-vec` `v0.1.9` `LICENSE-APACHE` + `LICENSE-MIT` (dual-licensed; both are reproduced because the choice is the recipient's) |
| `embedding-model.txt` | the canonical `apache.org/licenses/LICENSE-2.0.txt`. Snowflake publishes `snowflake-arctic-embed-s` under `license: apache-2.0` in its model card but ships **no licence file** in the repository, so the canonical text of the licence it names is what gets reproduced. |
| `reranker-model.txt` | the canonical `apache.org/licenses/LICENSE-2.0.txt`, for the same reason: `cross-encoder/ms-marco-MiniLM-L-6-v2` declares `license: apache-2.0` on its model card and carries neither a `LICENSE` nor a `NOTICE` file at the pinned revision (verified against the hub's own file listing), so §4(d) adds nothing and the licence it names is what is reproduced. |

**qpdf ships a `NOTICE.md`** at `v12.3.2` and it carries substantive additional
terms — the Artistic-2.0 option for pre-v7 qpdf, bundled qtest (Artistic-2.0),
a public-domain Rijndael implementation, and sphlib's Projet RNRT SAPHIR MIT
notice. Apache-2.0 §4(d) obligates propagating it, so it is appended to
`qpdf.txt` under a `===== NOTICE.md =====` separator. `tessdata_fast 4.1.0` and
`sqlite-vec v0.1.9` have no `NOTICE` at their pinned tags (verified 404), so for
those §4(d) adds nothing beyond §4(a)–(c).

`../spdx-texts/` holds canonical texts of SPDX ids for npm packages that DECLARE
a licence but ship no file. LGPL-3.0 is there because `@img/sharp-libvips-linux-x64`
genuinely ships (a `libvips-cpp.so`) and LGPL-3 §4 requires the licence to
accompany the work — a manifest field is not a substitute. LGPL-3 incorporates
GPL-3 by reference, so both texts are in that one file.

Update a text in the SAME commit that bumps the payload's version — the pinned
tag is what makes "verbatim" checkable.
