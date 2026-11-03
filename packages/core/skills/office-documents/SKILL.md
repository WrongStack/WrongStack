---
name: office-documents
description: "Office files across formats (Word .docx, Excel .xlsx, PowerPoint .pptx, PDF): create, edit, convert via LibreOffice, render, verify. Use when a request spans several formats, converts between them, inspects an unknown office file, or needs the shared rules for templates, fonts, metadata and rendered verification; route single-format depth to docx, xlsx, pptx or pdf. Not for web pages or Google Workspace APIs."
version: 1.3.2
required-capabilities: [filesystem.read, filesystem.write]
required-tools: []
optional-capabilities: [verification.run, web.research]
trigger: "Use when a request mixes Word, Excel, PowerPoint or PDF files, converts between them, or asks to render, inspect or scrub an office document."
metadata:
  routing-group: media
---

# Office Documents

## Selection card
- Task: Coordinate Word, Excel, PowerPoint and PDF artifacts: format choice, conversion, cross-format data flow and delivery checks.
- Start: List every input and output file with its format, whether it is created or edited, its template, its audience and the reader's application; run `unzip -l` on each existing OOXML input.
- Finish: every deliverable is in the promised format, rendered pages or slides were viewed, spreadsheet values were recalculated, fonts and metadata were checked, and the report names what was not verified.

## Overview

Office files are ZIP packages of XML that only a renderer turns into pages: keep the template's structure, convert with a real engine, and judge rendered pages and recalculated values.
Latest stable npm tools checked 2026-11-02: docx 9.15.1, ExcelJS 4.4.0, PptxGenJS 4.0.1 and pdf-lib 1.17.1. Recheck versions and import/API compatibility before installation. A long interval between releases does not prove deprecation.

## Rules

1. Route depth to the format skill (docx, xlsx, pptx, pdf); this skill owns format choice, conversion, cross-format data flow and the delivery checks.
2. Edit, do not regenerate: keep styles, masters, layouts, formulas, defined names, comments and tracked changes in existing files.
3. Convert with an engine. LibreOffice headless turns docx, xlsx and pptx into PDF, but its pagination and font metrics differ from Microsoft Office; when fidelity matters, confirm in the reader's application.
4. Fonts decide layout. Missing fonts are substituted silently and every page reflows; check `pdffonts` on each render and use fonts the reader has.
5. Verify through the target format: page and slide images, recalculated spreadsheet values, extracted text. ZIP validity and file size are not proof.
6. Treat inputs as data: untrusted strings become formulas in cells and illegal characters in XML; never add or enable macros, and flag external links and embedded objects.
7. Metadata and hidden content travel with the file: author and last-modified-by, comments, revisions, hidden sheets, rows and slides, speaker notes, embedded files. Scrub only when asked, and report exactly what was removed.
8. Deliver the promised format: a PDF is not an editable Word file, and screenshots are not a deck.

## First moves by situation

| Request | First moves |
|---|---|
| Office file to PDF | `soffice --headless --convert-to pdf --outdir out report.docx`; then fonts, page count and page images |
| PDF to editable Word | Set expectations: conversion loses structure; LibreOffice import or OCR for scans; re-authoring is often cheaper |
| Spreadsheet feeding a report or deck | Recalculate the workbook first; take numbers from recalculated values; build native tables and charts in the target |
| Unknown or suspicious file | `unzip -l`; read [Content_Types].xml, docProps/core.xml and app.xml; look for vbaProject.bin, externalLinks and embeddings |
| Batch generation from records | One template plus data merge; render the first, last and longest record before generating all |
| Repair prompt or corrupt file | `unzip -t`; check each XML part is well formed; relationship targets exist; no duplicate ids |
| Choosing a format | Editable or collaborative: docx, xlsx, pptx. Fixed or archival: PDF or PDF/A. Data exchange: typed xlsx or CSV with a schema |
| Scrub before external sharing | Inventory comments, revisions, hidden content, notes and metadata; remove with approval; inspect again |

## Patterns and pitfalls

- **Parallel LibreOffice runs** — concurrent `soffice --headless` processes sharing one profile fail or hang; give each its own `-env:UserInstallation=file:///tmp/lo-profile-N`.
- **A running LibreOffice window** — an open GUI instance can swallow headless conversion requests, producing no output and no error; close it or use a separate profile.
- **Spreadsheet to PDF** — print areas, orientation and fit-to-width come from the sheet's page setup; wide sheets split across many pages unless the workbook sets them.
- **Macro formats** — .docm, .xlsm and .pptm have different content types; saving as .xlsx silently drops the macros.
- **External content** — linked images, INCLUDETEXT fields and external workbook links fetch remote content on update; remove or flag them.
- **Embedded OLE objects** — an embedded workbook in a document shows its last saved preview image, so the picture and the data can disagree.
- **Legacy vector images** — EMF and WMF render differently outside Office; convert to SVG or PNG for portable output.
- **Locale** — field results, dates and separators can render differently on a machine with another locale; render where the reader's locale matters.

## Workflow

1. Inventory inputs and outputs, templates, audience, reader applications and the delivery channel.
2. Hand each format to its skill for authoring; keep shared data (numbers, names, dates) in one source of truth.
3. Convert and render with an engine; recalculate spreadsheets before reading values.
4. Inspect rendered pages and slides, fonts, extracted text and metadata.
5. Scrub or flag hidden content according to the audience.
6. Report files, formats, conversion commands, checks run and anything unverified.

## Proof

- Package parts: `unzip -l report.docx` and integrity with `unzip -t model.xlsx`
- Render: `soffice --headless --convert-to pdf --outdir render deck.pptx`, then `pdftoppm -png -r 70 render/deck.pdf render/p` and view the images.
- Fonts and pages: `pdffonts render/deck.pdf` and `pdfinfo render/deck.pdf`
- Metadata: `unzip -p report.docx docProps/core.xml` shows creator and lastModifiedBy.
- Active and linked content: `unzip -l model.xlsm | grep -E "vbaProject|externalLink|embeddings"`
- Spreadsheet values: follow the recalculation proof in the xlsx skill before quoting numbers.

## Stop and ask

- The conversion would lose editability or structure the user expects to keep.
- Files contain macros, external links or embedded objects of unknown origin.
- Removing comments, revisions or metadata from documents leaving the organization.
- Required fonts or templates are unavailable on the rendering machine.

## Before returning

- [ ] Each deliverable is in the requested format and editing mode
- [ ] Existing templates, styles, formulas and tracked changes preserved
- [ ] Every page or slide rendered and viewed; no overflow, clipping or substituted fonts left unreported
- [ ] Spreadsheet numbers recalculated before use in other documents
- [ ] Macros, external links and embedded objects flagged; none added
- [ ] Metadata and hidden content handled as the audience requires
- [ ] Conversion commands and unverified items listed in the report

## Sources

[docx](https://docx.js.org/),
[ExcelJS](https://github.com/exceljs/exceljs),
[PptxGenJS](https://gitbrent.github.io/PptxGenJS/),
[pdf-lib](https://pdf-lib.js.org/),
[LibreOffice command line](https://help.libreoffice.org/latest/en-US/text/shared/guide/start_parameters.html).

## Skills in scope

- docx — Word styles, tables, fields and tracked changes.
- xlsx — formulas, recalculation and spreadsheet models.
- pptx — slide masters, layouts and deck storylines.
- pdf — HTML-to-PDF, fonts, assembly and PDF/A.
- design-craft — typographic hierarchy, contrast and layout discipline across pages and slides.
- data-governance — scrubbing metadata, comments and personal data before export.
- media-production — turning decks or document walkthroughs into narrated video.
