# Corpus Studio — Design Tokens (extracted from the handoff prototype)

Source: `/tmp/ui-handoff/comprehensive-science-tool-ui/project/Corpus.dc.html`.
These are the ground-truth visual tokens. Reuse them exactly. Fonts must be
**vendored locally** (no Google Fonts CDN).

## Typography
- Body / headings: **Instrument Sans** (weights 400,500,600,700; italic 400).
- Mono / eyebrow labels / scores: **Geist Mono** (weights 400,500).
- Base text color: `#211a12`. Font smoothing: antialiased.
- Eyebrow labels (e.g. "SELECTED NODE", "TOPIC RELEVANCE") are Geist Mono,
  uppercase, letter-spaced, color `#8a8073`.

## Color palette
| Token | Hex | Usage |
|-------|-----|-------|
| `--bg` | `#ffffff` / `#fffaf5` | app background |
| `--panel` | `#faf8f5` / `#f6f2ec` | cards, panels |
| `--panel-2` | `#f1ece5` / `#f4efe8` | nested/inset surfaces |
| `--border` | `#ece7e0` / `#e6ded3` / `#ddd6cc` | hairline borders |
| `--ink` | `#211a12` | primary text |
| `--ink-2` | `#3a332a` / `#2c261e` | strong text |
| `--muted` | `#6b6157` | secondary text |
| `--muted-2` | `#8a8073` / `#a89e91` | tertiary / eyebrow |
| `--accent` | `#e2600f` | primary orange (buttons, active) |
| `--accent-strong` | `#c2510c` | links, hover-from |
| `--accent-soft` | `#fdefe4` / `#fbe2cf` / `#fde...` | accent tint backgrounds |
| `--accent-100` | `#f6a35f` / `#e89a5b` | accent light (gradients) |
| `--ok` | `#3f9166` | validated / success green |
| `--warn` | `#c98a1c` | review / caution amber |
| `--danger` | `#c1584a` | conflict / error red |
| scrollbar thumb | `#e6ded3` (hover `#d8cec0`) | |

## Node/status accent colors (graph legend)
- Primary research: ink/neutral outline
- Review: accent orange `#e2600f`
- Foundational: green `#3f9166`
- Method: muted/neutral

## Shape / motion
- Card radius: ~14–16px; chips/pills: 999px; skeleton radius 7px.
- Sidebar width: **246px** fixed, left.
- Skeleton shimmer: `linear-gradient(90deg,#f3efe9 25%,#faf7f2 45%,#f3efe9 65%)`,
  `animation: shimmer 1.5s infinite linear`.
- Keyframes to reuse: `screenIn` (opacity+translateY(8px)), `nodePop`, `pulse`, `spin`, `shimmer`.
- Buttons: primary = accent bg, white text, rounded; secondary = panel bg + border.

## IA (8 base screens, reuse then extend)
1 dashboard/projects · 2 connectome (graph) · 3 paper detail · 4 ranking
· 5 add papers/ingest · 6 extraction · 7 topic dossier · 8 integrations.
Plus new: onboarding/new-project wizard, global search, review queue,
saved searches, settings (NAS/storage), export.
