# Field Notes: design system

## The theme

Field Notes reads like the spreads of a printed journal: wide margins, thin rules, numbered sections and small-caps labels. Serif type carries the reading text and headings, and a quiet sans handles controls, labels and numbers. Colour is restrained: paper, ink and a few earthy accents that each carry one meaning. Nothing glows, nothing gradients, and no emoji appear anywhere. The tokens live in `site/css/tokens.css`, and `scripts/check_contrast.py` proves every text pair meets WCAG.

## Colour plate

| Name | Light | Dark | Role | Contrast checked (light / dark) |
|---|---|---|---|---|
| paper | #F5EFE3 | #1D1915 | Page background | Base for all pairs below |
| paper-raised | #FBF7EF | #26201B | Cards, dialogs | Not a text background yet; re-check before use |
| wash | #EDE6D8 | #2E271F | Panels, chips | Not a text background yet; re-check before use |
| ink | #26211C | #EDE4D3 | Main text | 13.93 / 13.84 on paper; 8.95 / 6.13 on clay |
| ink-soft | #5A5048 | #B9AD9B | Secondary text | 6.85 / 7.91 on paper |
| ink-mute | #6B6055 | #958A7B | Captions, labels | 5.35 / 5.16 on paper |
| rule | #D9CDBB | #3A322A | Hairline dividers (decorative) | 1.37 / 1.39 on paper: never the only boundary |
| edge | #8C7F70 | #7D7163 | Control outlines, icons (added token) | 3.41 / 3.67 on paper (3:1 rule) |
| terracotta | #A34A25 | #E0785A | A flip, a loss, danger | 5.15 / 5.83 on paper |
| ochre | #8A5F1C | #E0AE5C | A correction, a highlight | 4.91 / 8.63 on paper |
| sage | #4F6A4A | #9DB58F | Held firm, ideal | 5.25 / 7.85 on paper |
| teal | #2E5E5B | #7FB3AE | Primary action, links, focus ring | 6.39 / 7.45 on paper; paper on teal 6.39 / 7.45 |
| plum | #6B4A63 | #B894B0 | Commitment, confession | 6.59 / 6.57 on paper |
| clay | #E4B9A6 | #6E4A3F | Soft fill for flips | Ink on clay, see above |

**Colour changes from the brief.** Four light values failed the 4.5:1 text rule and were darkened within their hue family: ink-mute #7A6F63 (4.28:1) became #6B6055; terracotta #B4532A (4.35:1) became #A34A25; ochre #B9832E (2.89:1) became #8A5F1C; sage #5F7A5A (4.15:1) became #4F6A4A. The dark values all passed unchanged. The `edge` token is an addition: the brief's rule colour is too faint for form-control outlines.

## Chart series colours

Charts need one colour per series, in a fixed order: `--cat-1`, `--cat-2`, `--cat-3`, defined in `site/css/tokens.css` for light, the OS dark theme and `data-theme="dark"`. They carry series identity only. Never use them for status, and never for text (text uses the ink tokens).

| Token | Hue | Light | Dark | Contrast on paper, light / dark | Contrast on paper-raised, light / dark |
|---|---|---|---|---|---|
| cat-1 | rust | #892C1A | #AD5349 | 7.52 / 3.42 | 8.06 / 3.15 |
| cat-2 | ochre | #A57C00 | #B4902E | 3.34 / 5.80 | 3.58 / 5.34 |
| cat-3 | plum | #9A6AAF | #B079C6 | 3.63 / 5.32 | 3.89 / 4.90 |

Validator results (dataviz skill `validate_palette.js`, all pairs with `--pairs all`, surface = paper):

| Theme | Lightness (band) | Chroma (floor 0.10) | Normal-vision dE min (floor 15) | Deuteranopia dE min (floor 10) | Protanopia dE min | Contrast min on paper (3:1) | Result |
|---|---|---|---|---|---|---|---|
| Light | 0.43-0.61 (0.43-0.77) | 0.115-0.130 | 21.2 | 18.3 | 21.2 | 3.34:1 | All checks pass |
| Dark | 0.55-0.67 (0.48-0.67) | 0.120-0.126 | 16.8 | 13.0 | 17.4 | 3.42:1 | All checks pass |

Dark cat-2 sits at the top edge of the dark lightness band, so the step is not moved further: lowering it dropped the normal-vision dE to 15.9.

**Why the change.** The earlier series candidates (teal, plum, ochre) failed the validator. In light, teal (chroma 0.053) and plum (0.058) read as grey, ochre was at 0.098, and the worst pair was 10.6 normal-vision dE (the brief quoted 13.7). In dark, teal, plum and ochre (#E0AE5C) were outside the lightness band, and plum and teal failed the chroma floor. The new trio keeps the rust, ochre and plum hues of the accents, re-stepped to pass. `scripts/check_contrast.py` checks each series colour against paper at 3:1.

## Typography

- Serif (`--font-serif`): Tiempos Text, then Iowan Old Style, Georgia, Times New Roman.
- Sans (`--font-sans`): Styrene A, then Helvetica Neue, Arial, system-ui.
- Mono (`--font-mono`): ui-monospace, SF Mono, Menlo, Consolas.

| Token | px | rem | Use |
|---|---|---|---|
| `--size-xs` | 12 | 0.75 | Labels: sans, uppercase, `--tracking-label` 0.08em |
| `--size-sm` | 14 | 0.875 | Notes, footnotes |
| `--size-base` | 16 | 1 | Dense UI text, table cells |
| `--size-md` | 18 | 1.125 | Body reading text (serif, line-height 1.55) |
| `--size-lg` | 22 | 1.375 | Section headings |
| `--size-xl` | 28 | 1.75 | Page subheadings |
| `--size-2xl` | 36 | 2.25 | Page titles |
| `--size-3xl` | 48 | 3 | Hero figures |
| `--size-ui` | 15 | 0.9375 | Sans UI text (added between the scale steps, as the brief asks) |

Reading text is capped at `--measure` (66ch). Headings use `--leading-heading` 1.2.

## Spacing and radius

Spacing tokens: `--space-1` 4, `--space-2` 8, `--space-3` 12, `--space-4` 16, `--space-6` 24, `--space-8` 32, `--space-12` 48, `--space-16` 64 (px). Radii: `--radius-sm` 2px, `--radius-md` 4px, `--radius-lg` 8px. Borders (`--rule` or `--edge`) do the work of elevation. The single shadow token `--shadow-soft` is for the token dialog and toast only.

## Motion

Durations: `--dur-fast` 150ms, `--dur-base` 240ms, `--dur-slow` 480ms, easing `--ease-out` cubic-bezier(0.2, 0.7, 0.2, 1). Animate only colour, opacity and transform. Under `prefers-reduced-motion: reduce`, all three durations become 0ms. Animations must still show their end state.

## Focus

Every interactive element gets `outline: 2px solid var(--focus)` with `outline-offset: 2px`, applied through `:focus-visible`. The focus colour is teal in both themes.

## Layout grid

- Below 1024px: a top bar (`.site-header`) holds the brand, the nav list and the tools, in that order.
- From 1024px: a sidebar (`--sidebar-width`, 232px) sits on the left. It is sticky at full viewport height and scrolls on its own if it is short. Brand, then nav, then tools, which sit at the bottom. The page takes the rest of the width beside it.
- With the sidebar, the page (`.page`) is limited by `--dashboard-max`, which is 1440px, and is centred in the space it has. Without the sidebar (the compare page), it is limited by `--content-max`, which is 1120px.
- Dashboards use `.dash`: a 12-column grid (`--grid-columns`) with a `--space-6` (24px) gap. Children are full width by default. From 1024px, the span classes `.span-3`, `.span-4`, `.span-6`, `.span-8` and `.span-12` take that many columns. Below 1024px each child is a full-width row.
- KPI cards sit in `.dash-kpis` above the rest of the view: one row from 1024px, two per row from 560px, one per row below 560px.
- Phones (under 760px): one column with a 16px side gutter (`--page-gutter`). No horizontal page scroll.
- Reading pages (`.page-grid`) use the same 12 columns from 760px: reading text in 8, margin notes in 4.
- Reading column: 66ch (`--measure`). Margin notes sit in the spare columns beside it on wide screens and fall under the text on phones.

## Components

- **Cards**: paper-raised fill, 1px rule border, radius-md, numbered label in small caps.
- **KPI card** (`.kpi-card`): paper-raised fill, 1px rule border, radius-md, 16px padding. Three parts in order: a small-caps label (`.kpi-label`), a large serif value (`.kpi-value`), and a short sans note (`.kpi-note`) that names the source. Each view has 4 cards in `.dash-kpis`, shown first. With no data, the card has `.is-empty`: the value reads "No data loaded" in ink-mute.
- **Panel** (`.panel`): paper-raised fill, 1px rule border, radius-md, 24px sides and 16px top and bottom. The title (`.panel-title`) is a small-caps label with a rule under it. Add a `.section-number` span for a number where the view numbers its panels.
- **Buttons**: primary is teal fill with paper text; secondary is an edge-outlined button with ink text; ghost is ink text with a teal underline on hover. Minimum 44px touch height.
- **Chips**: wash fill, rule border, label style. A flip chip uses clay fill.
- **Checkboxes**: a square with an edge outline; the checked state draws a teal tick. The label stays in serif text.
- **Dropdowns**: paper-raised, edge border, radius-sm, sans text.
- **Progress rules**: a hairline rule that fills in ink; a held-firm segment uses sage.
- **Chart frames**: paper-raised, rule border, a "Fig. n" label in small caps above and a caption in ink-mute below.
- **Token dialog**: paper-raised, rule border, `--shadow-soft`, serif heading.
- **Toast**: paper-raised, rule border, sans text, one line.
- **Level ladder**: numbered rows separated by rules; the current level is marked in ochre text with a rule.
- **Chat bubbles as margin notes**: no bubbles. Each turn has a 2px rule on its left edge, a label in small caps naming the speaker, and serif text. A flip is marked with a clay chip.

## Do

- Use the tokens for every colour, size, space and radius.
- Number sections and figures; keep the labels in small caps.
- Use rules and borders to separate content.
- Keep one accent meaning per view.

## Do not

- Do not use gradients, glossy or coloured shadows, or emoji as icons. Use simple line SVG icons.
- Do not put text on `rule`, `wash` or `clay` without checking the pair first.
- Do not use colour alone to show state; pair it with a label, tick or symbol.
- Do not centre long text blocks or add decorative hero blobs.
- Do not ship font files from this repo; the licensed faces are added later.
