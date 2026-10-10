---
name: office-documents
description: "Create, edit and convert Word, Excel, PowerPoint and PDF artifacts with format-aware verification. Use when producing docx, xlsx, pptx or PDF files; preserve templates and actual document structure, and render or recalculate before delivery."
version: 1.2.1
required-capabilities: [filesystem.read, filesystem.write]
required-tools: []
optional-capabilities: [verification.run, web.research]
trigger: "producing docx, xlsx, pptx or PDF files; preserve templates and actual document structure, and render or recalculate before delivery."
metadata:
  routing-group: media
---

# Office Documents

## Selection card
- Task: Create and verify Word, spreadsheet, slide or PDF artifacts.
- Start: Identify the existing engine, scene, timeline and delivery format.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

Latest stable npm tools checked 2026-10-09: docx 9.9.0, ExcelJS 4.4.0,
PptxGenJS 4.0.1 and pdf-lib 1.17.1. Recheck versions and import/API compatibility
before installation. A long interval between releases does not prove deprecation.

## Rules

1. Identify the requested format, editing vs. creation, template, audience and
   destination application. Preserve styles, formulas, charts, comments and
   revision metadata when editing existing artifacts.
2. Pick the tool that fits the existing file and environment; TypeScript,
   Python and native renderers are all valid. Inspect actual APIs before coding.
3. Keep data numeric in spreadsheets, dates intentional and presentation
   formatting separate from values. Do not present a formula as calculated
   until a calculation engine or validated cached value supplies its result.
4. Keep document sources editable where requested. A screenshot or PDF does
   not substitute for a promised Word document or slide deck.
5. Verify through the target format: render pages/slides, inspect their images,
   and inspect spreadsheet calculations. File size and ZIP validity are initial
   checks, not visual or semantic proof.
6. Treat imported text and sheet values as data. Avoid accidental formula
   interpretation, external links or macros when writing untrusted inputs.

## Format decisions

| Format | Implementation checks | Delivery checks |
|---|---|---|
| Word | Section/page geometry, styles, table/cell widths; DXA when fixed widths are needed | Render pagination, split rows, headings and long text |
| Excel | Numeric types, formulas, number formats, filters/freeze panes | Recalculate, inspect errors, totals and formula references |
| PowerPoint | Respect template aspect ratio; explicit positioning and licensed fonts | Render every slide; check overflow, overlap and readability |
| PDF | Use native text/vector output when possible; explicit page geometry | Inspect page count, clipping, text extraction and font rendering |

For HTML-to-PDF, use print CSS and the renderer's background setting. Word
pagination is controlled by Word properties, not CSS break-inside.
Do not force 16:9 slides or decorative cards onto an existing template.

## Before returning

- Deliverable format and destination application identified.
- Content, calculations and links checked against the supplied data.
- Pages/slides rendered and inspected, or the exact rendering gap reported.
- Final artifact path and editable source provided when requested.

## Sources

[docx](https://docx.js.org/),
[ExcelJS](https://github.com/exceljs/exceljs),
[PptxGenJS](https://gitbrent.github.io/PptxGenJS/),
[pdf-lib](https://pdf-lib.js.org/).

## Skills in scope

- design-craft — hierarchy and typography.
- data-governance — sensitive content and retention.
- media-production — narrated or animated presentation exports.
