# Fonts: how to add the licensed typefaces

This folder is where the licensed web fonts for the site go. The site uses two
typefaces from Klim Type Foundry: **Tiempos** (serif, for reading text and
headings) and **Styrene** (sans, for buttons, labels and numbers).

The site works without any of these files. Until they are added, the browser
uses fallback fonts (Iowan Old Style or Georgia for serif, Helvetica Neue or
Arial for sans). The page still looks right, just not exactly as designed.

## 1. The licence rule

Only add a font file if you hold a licence that allows web use. Check this
before you copy anything into this folder.

- Do not commit or publish font files you are not licensed to host.
- Check the Git repository's visibility before committing font files. A public
  repository publishes them to everyone.
- The project design notes (`site/design/DESIGN.md`) say font files are not
  shipped from this repo. Read that note before you decide to add them here.

## 2. The files to add

Use these exact file names. The names are case-sensitive.

| File name | What it is | Needed? |
|---|---|---|
| `TiemposText-Regular.woff2` | Tiempos Text, normal weight. Body text. | Yes, if licensed |
| `TiemposText-Italic.woff2` | Tiempos Text, italic. Emphasis. | Yes, if licensed |
| `TiemposHeadline-Semibold.woff2` | Tiempos Headline, semibold. Headings. | Optional |
| `StyreneA-Regular.woff2` | Styrene A, normal weight. Controls and labels. | Yes, if licensed |
| `StyreneA-Medium.woff2` | Styrene A, medium weight. | Yes, if licensed |
| `StyreneA-Bold.woff2` | Styrene A, bold weight. | Yes, if licensed |

If you have the Styrene B files instead of Styrene A, save them with the
`StyreneA-` names above. The CSS looks for those names.

Files must be in `.woff2` format. This is a compressed web font format. Most
font vendors give you this format for web use. If you only have `.otf` or
`.ttf` files, ask the vendor for web font files.

## 3. Where to put them

Put the files in this folder, `site/fonts/`, next to this README. For example:

```
site/fonts/TiemposText-Regular.woff2
site/fonts/StyreneA-Regular.woff2
```

## 4. Turn the fonts on

The font rules are in `site/css/fonts.css`. They are all commented out, so
nothing loads yet.

1. Add a font file to this folder.
2. Open `site/css/fonts.css`.
3. Remove the `/*` and `*/` lines around the matching block. Do this for one
   file at a time.
4. Save the file and reload the page.

Do not uncomment a block until its file is here. A missing file makes the
browser ask for the font, get nothing back, and log a "404" error. This does no
harm, but the error is noisy.

The headline file is loaded as "Tiempos Text" with weight 600. Headings only
use it when their CSS sets `font-weight: 600`.

## 5. Check that the fonts load

1. Open the site in Chrome, Edge or Firefox.
2. Open the developer tools (right-click the page, then "Inspect").
3. Open the **Network** tab and choose the **Font** filter. Reload the page.
   Each font file you added should show status **200**. A **404** means the
   file name or folder is wrong.
4. To see which font the browser chose for a piece of text, select the text
   in the **Elements** panel and look at the **Computed** tab. In Chrome,
   open the **Rendered Fonts** section. In Firefox, open the **Fonts** panel.

A font installed on your own computer can look like the licensed font even
when the web file is missing. Use the Network tab to be sure the web file
loaded.

## 6. With no font files at all

The site works with no files in this folder. Leave `fonts.css` fully commented
out, and the fallback fonts are used. Nothing breaks.
