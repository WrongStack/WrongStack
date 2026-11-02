---
name: pdf
description: "PDF generation and processing: HTML-to-PDF via Playwright/Chromium, Typst, pdf-lib merge and forms, embedded fonts, PDF/A, inspection. Use when rendering invoices, reports or printable pages to PDF, fixing page breaks, headers, footers or missing glyphs, merging, splitting, stamping or filling PDFs, or producing archival PDF/A. Not for editable Word output (use docx) or slide decks (use pptx)."
version: 1.2.2
required-capabilities: [filesystem.read, filesystem.write]
required-tools: []
optional-capabilities: [verification.run, web.research]
trigger: "Use when a request mentions a PDF file, page.pdf(), print CSS or @page rules, pdf-lib, PDF/A, PDF forms, or merging and splitting PDFs."
metadata:
  routing-group: media
---

# PDF Documents

## Selection card
- Task: Generate, assemble and inspect PDFs with real text, embedded fonts and correct page geometry.
- Start: Fix page size, margins, header/footer needs, archival or print requirements and the source (HTML template, Typst/LaTeX, existing PDFs); read the current generator code and any print stylesheet.
- Finish: the PDF has the expected page count and size, every font is embedded, text extracts in reading order, rendered pages were viewed, and any PDF/A claim has a validator report; checks below pass.

## Overview

A PDF is a fixed-layout contract with printers and archives: verify page geometry, embedded fonts, real text (not pictures of text) and structure, because no reader reflows your mistakes.
Generators: headless Chromium through Playwright or Puppeteer for HTML, Typst or LaTeX for typeset documents, pdf-lib for assembly (`@playwright/test` / Puppeteer; checked 2026-11-02: pdf-lib 1.17.1, Playwright 1.64.1, Puppeteer 25.16.0).
Chromium writes RGB, non-archival PDFs; PDF/A, PDF/UA and press-ready PDF/X are separate, validated deliverables.

## Rules

1. Text stays text and vectors stay vectors. Never embed a screenshot of a page; `pdftotext` must return the content in reading order, and charts should render as SVG rather than canvas bitmaps.
2. Embed every font. In `pdffonts` output each font needs "emb" yes; Type 3 fonts mean bitmap glyphs. pdf-lib's standard fonts encode WinAnsi only, so Turkish ğ ş ı İ, CJK or emoji throw "WinAnsi cannot encode"; register `@pdf-lib/fontkit` and embed a TTF or OTF with `subset: true`.
3. Before `page.pdf`, wait for real readiness: navigate with `waitUntil: 'networkidle'`, call `page.emulateMedia({ media: 'print' })`, await `document.fonts.ready`, and load lazy images eagerly. Set `printBackground: true`, and `preferCSSPageSize: true` when `@page { size }` should win over the page.pdf format option.
4. Control breaks in CSS: `@page { size: A4; margin: 18mm 16mm }`, `break-inside: avoid` on rows, figures and cards, `break-after: avoid` on headings, `thead { display: table-header-group }` to repeat table headers, `orphans`/`widows` on paragraphs.
5. Running headers and footers: Chromium 131+ supports `@page` margin boxes with `counter(page)` and `counter(pages)`; Playwright and Puppeteer `headerTemplate`/`footerTemplate` are separate documents that need inline styles, an explicit font size, data-URL images and page margins large enough to show them.
6. Structure and metadata: `<html lang>`, a `<title>` (it becomes the PDF Title), real heading hierarchy. Request tagged output and an outline (`tagged: true`, `outline: true` in current Playwright and Puppeteer) and confirm with `pdfinfo`.
7. Archival and print are validated, not asserted: convert to PDF/A with LibreOffice export or Ghostscript plus an ICC profile, and validate with veraPDF; CMYK, bleed and PDF/X go to a prepress tool or printer spec.
8. Manipulation preserves what it does not touch. pdf-lib merges, splits, stamps, fills and flattens forms; it does not render HTML, extract text or decrypt. Editing a signed PDF invalidates the signature; never strip encryption without the owner's authorization.

## First moves by situation

| Request or symptom | First moves |
|---|---|
| Invoice or report from data | HTML template with a print stylesheet and self-hosted fonts; escape data; Playwright `page.pdf` |
| Page breaks in the wrong place | Add `break-*` rules; check flex and grid wrappers around content that must fragment; split very tall blocks |
| "Page X of Y" | `@page` margin boxes, or a footerTemplate with `pageNumber` and `totalPages` spans |
| Boxes or wrong glyphs | `pdffonts`; was the @font-face loaded before printing; does the font cover the script |
| Merge, split, reorder | pdf-lib `copyPages`, or `qpdf --empty --pages a.pdf b.pdf -- out.pdf` |
| Fill a form | pdf-lib `getForm()`, list names with `getFields()`, set values, `flatten()` for final copies; XFA forms are unsupported |
| Archival PDF/A | LibreOffice PDF/A export or Ghostscript pdfwrite with PDF/A settings; validate with veraPDF before claiming compliance |
| File too large | `pdfimages -list` for oversized images and their ppi; downsample sources; object streams via qpdf |
| Extract text or tables | `pdftotext -layout`; table extractors for tabular data; scanned PDFs need OCR (ocrmypdf) |
| Typeset document or book | Typst (`typst compile doc.typ`) for fast deterministic layout; LaTeX for heavy math |

## Patterns and pitfalls

- **CSS pixels on paper** — 96 px per inch, so A4 is about 794 x 1123 px; responsive breakpoints fire at print width and can switch to a mobile layout.
- **Backgrounds vanish** — without `printBackground` (and `print-color-adjust: exact` for stubborn elements) fills and background images disappear.
- **Fixed elements repeat** — `position: fixed` content prints on every page and can cover body text.
- **Canvas charts blur** — canvas output is rasterized at device scale; switch chart libraries to SVG rendering for print.
- **pdf-lib geometry** — origin bottom-left, units in points (1/72 in); measure with `font.widthOfTextAtSize`; `drawText` offers basic wrapping via `maxWidth` and `lineHeight`, but there is no layout engine.
- **Encrypted inputs** — `PDFDocument.load` throws on encrypted files; `ignoreEncryption: true` loads them but output may be unusable. Decrypt with qpdf only with the password and the owner's consent.
- **Page boxes** — MediaBox, CropBox, TrimBox and BleedBox differ for print; read them with `pdfinfo -box`.
- **Huge tables** — thousands of rows in one HTML table slow Chromium dramatically; paginate or chunk the data.
- **Fast web view** — `qpdf --linearize in.pdf out.pdf` lets large PDFs display before fully downloading.

## Pattern (Playwright HTML to PDF)

```ts
import { chromium } from 'playwright';

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto('http://localhost:3000/invoices/123?print=1', { waitUntil: 'networkidle' });
  await page.emulateMedia({ media: 'print' });
  await page.evaluate(() => document.fonts.ready);
  await page.pdf({
    path: 'invoice-123.pdf',
    preferCSSPageSize: true,                      // CSS: @page { size: A4; margin: 18mm 16mm 22mm }
    printBackground: true,
    displayHeaderFooter: true,
    headerTemplate: '<span></span>',
    footerTemplate: '<div style="font-size:8pt;width:100%;text-align:right;padding-right:16mm"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
    tagged: true,
    outline: true,
  });
} finally {
  await browser.close();
}
```

## Workflow

1. Specify page size, margins, header/footer, language, archival or print requirements and the audience.
2. Build the source (HTML with print CSS, Typst, or assembly of existing PDFs); self-host fonts and assets.
3. Generate with explicit readiness waits and page options.
4. Inspect: page count and size, fonts, extracted text, rendered page images, links and bookmarks.
5. For PDF/A or print, convert with the dedicated tool and validate.
6. Report generator, options, page count, font list, validation results and anything not checked.

## Proof

- Document facts: `pdfinfo out.pdf` (pages, page size, Title, Tagged, PDF version).
- Fonts: `pdffonts out.pdf` with "emb" yes for every font and no unexpected Type 3.
- Text order: `pdftotext -layout out.pdf - | head -80`
- Pages as images: `pdftoppm -png -r 80 out.pdf page` and view every page, especially breaks and the last page.
- Images: `pdfimages -list out.pdf` for resolution and color space.
- Structure: `qpdf --check out.pdf` reports no errors.
- Archival: `verapdf --flavour 2b out.pdf` (or the required flavour) passes.

## Stop and ask

- The PDF must be signed, or an existing signed PDF would be modified.
- Removing encryption, permissions or redactions on a document the user may not own.
- Print production needs CMYK, bleed or a printer's PDF/X spec that is not provided.
- A compliance claim (PDF/A, PDF/UA, accessibility law) is required without a validator available.

## Before returning

- [ ] Page count, page size and margins match the spec in `pdfinfo` and the rendered pages
- [ ] Every font embedded; non-Latin text renders correctly
- [ ] Text extracts in reading order; no screenshots of text
- [ ] No orphaned headings, split rows or clipped content at page breaks
- [ ] Headers and footers, page numbers, title metadata and language set
- [ ] Tagged output and outline present when accessibility matters
- [ ] PDF/A or print claims backed by a validator report, or explicitly not claimed

## Sources

[Playwright page.pdf](https://playwright.dev/docs/api/class-page#page-pdf), [Chrome page margin boxes](https://developer.chrome.com/blog/print-margins), [pdf-lib](https://pdf-lib.js.org/), [veraPDF](https://verapdf.org/), [Typst](https://typst.app/docs/).

## Skills in scope

- office-documents — multi-format generation across DOCX, XLSX, PPTX and PDF.
- canvas-design — poster-grade editorial layouts, grids and print typography.
- docx — editable Word documents when downstream redlining is required.
- accessibility — tagged structure, reading order and language for accessible PDFs.
