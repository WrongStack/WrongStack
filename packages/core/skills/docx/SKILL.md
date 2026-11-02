---
name: docx
description: "Word .docx authoring and editing with docx (npm) or python-docx: styles, numbering, tables, headers, fields, tracked changes. Use when generating a Word report or contract, filling a Word template, editing an existing .docx without breaking its formatting, adding comments or redlines, or fixing layout that differs between Word and LibreOffice. Not for PDF-only output (use pdf) or drafting the content itself (use doc-coauthoring)."
version: 1.2.1
required-capabilities: [filesystem.read, filesystem.write]
required-tools: []
optional-capabilities: [verification.run, web.research]
trigger: "Use when a request names a .docx or .dotx file, Word styles or templates, tracked changes, or python-docx and docx.js code."
metadata:
  routing-group: workflow
---

# Word Documents (DOCX)

## Selection card
- Task: Create, fill or edit Word documents that stay editable, styled and structurally valid.
- Start: Decide create vs edit; for edits copy the original, run `unzip -l` on it and read word/styles.xml and the target paragraphs in word/document.xml; note the reader's app (Word desktop, Word online, Google Docs, LibreOffice).
- Finish: the file opens without repair, headings and body use real styles, rendered pages were inspected, and edits touched only the intended content; checks below pass.

## Overview

A good .docx is styled, not decorated: content carries paragraph and character styles, layout comes from section and table properties, and computed parts (TOC, page numbers, cross-references) are fields that Word fills in.
Libraries: docx for Node and python-docx for Python (checked 2026-11-02: npm docx 9.15.1, PyPI python-docx 1.2.0; refresh registry before installing).
Neither library renders pages, paginates or updates fields; only a renderer (Word, LibreOffice) shows what the reader will see.

## Rules

1. Styles over direct formatting. Headings use built-in Heading 1-3 (their outline levels drive the TOC, navigation pane and PDF bookmarks); change the style definitions, not individual runs, so the document can be re-themed.
2. Edit in place. Open the original, change only the targeted paragraphs or runs, and keep styles.xml, numbering.xml, section properties, headers and relationships; never regenerate a client document to "edit" it.
3. Text is split across runs by formatting, revision ids and spell-check, so a phrase rarely sits in one `w:r`. Replace at paragraph level while preserving the first run's formatting, or edit the XML deliberately.
4. Units: DXA (twips) for page size, margins, indents and table widths (1440 per inch, about 567 per cm); half-points for font size (`size: 22` is 11 pt); EMU for drawings (914400 per inch).
5. Tables: set the table width, the column grid (`columnWidths`) and every cell width in DXA. Percentage widths render inconsistently in Google Docs and LibreOffice. Mark header rows `tableHeader: true` and keep rows whole with `cantSplit: true`.
6. Lists come from numbering definitions, never typed bullets or "1." characters; a restart needs a new numbering instance.
7. Fields are placeholders until updated: a generated TOC is empty until Word updates fields, and conversions may not update them. Never claim a filled TOC or correct page references without a render.
8. Revisions and comments belong to their authors: write tracked changes as `w:ins`/`w:del` with author and date; never accept, reject or delete someone else's markup unless asked.

## First moves by situation

| Request or symptom | First moves |
|---|---|
| New report from scratch | Use the organization's .dotx or .docx if one exists; define Normal, Heading 1-3, Caption and table styles plus page setup before content |
| Fill a template | Tokens or content controls kept inside single runs; check document.xml that no token is split; docxtpl or python-docx at paragraph level |
| Edit an existing document | Work on a copy; extract `word/document.xml` before and after and compare; touch only target paragraphs |
| Redline for review | `InsertedTextRun`/`DeletedTextRun` in docx, or raw `w:ins`/`w:del` with python-docx; comments anchored to ranges |
| Word and LibreOffice paginate differently | Missing fonts substituted (check `pdffonts`), percentage widths, unsupported fields; compare with a Word render when available |
| Landscape page inside a portrait document | New section with swapped width and height; headers link to the previous section unless unlinked |
| "Word found unreadable content" | Element order inside pPr, rPr or tblPr violates the schema, duplicate ids (bookmarks, comments, drawings), broken relationships, or control characters from pasted input |
| python-docx refuses a .dotx | It rejects the template content type; copy to .docx and patch [Content_Types].xml, or use the template through Word |
| Images | Explicit size, alt text, and the image `type` docx v9 expects; keep originals at print resolution |

## Patterns and pitfalls

- **Page numbers in docx** — `new TextRun({ children: ['Page ', PageNumber.CURRENT, ' of ', PageNumber.TOTAL_PAGES] })`; placing PageNumber outside a TextRun emits nothing useful.
- **Heading override** — style id `Heading1` with name `Heading 1` customizes the built-in heading that `HeadingLevel.HEADING_1` references; a new id creates a style the TOC ignores.
- **Python style names** — python-docx looks styles up by UI name (`'Heading 1'`), and `table.style = 'Table Grid'` raises KeyError when the template lacks that style.
- **Pagination control** — `keepNext` and `keepLines` in heading styles, `pageBreakBefore` in a style rather than manual breaks, widow control on body text.
- **Headers per section** — each section has its own headers; a different first page needs `titlePage`, and even/odd pages need the document-level setting.
- **Invalid characters** — C0 control characters (vertical tab, form feed) from pasted text are illegal in XML and corrupt the file; strip everything below 0x20 except tab and newline.
- **Fonts** — generators do not embed fonts; a font missing on the reader's machine is substituted and the layout reflows.
- **Comments** — python-docx 1.2 added a comments API (check its docs for the call shape); docx builds comments through the document's comments option plus range start, end and reference elements.
- **Metadata** — docProps/core.xml keeps author and last-modified-by; comments and revisions carry names. Scrub only when asked, and say what was removed.

## Pattern (docx, A4, styled heading, fixed table, page numbers)

```ts
import { AlignmentType, Document, Footer, HeadingLevel, Packer, PageNumber, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from 'docx';
import { writeFile } from 'node:fs/promises';

const cell = (text: string, w: number) =>
  new TableCell({ width: { size: w, type: WidthType.DXA }, children: [new Paragraph(text)] });

const doc = new Document({
  styles: {
    default: { document: { run: { font: 'Calibri', size: 22 } } },                 // 11 pt
    paragraphStyles: [{ id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true,
      run: { size: 32, bold: true }, paragraph: { spacing: { before: 360, after: 120 }, keepNext: true, keepLines: true } }],
  },
  sections: [{
    properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } },
    footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.RIGHT,
      children: [new TextRun({ children: ['Page ', PageNumber.CURRENT, ' of ', PageNumber.TOTAL_PAGES] })] })] }) },
    children: [
      new Paragraph({ heading: HeadingLevel.HEADING_1, text: '1. Summary' }),
      new Table({ width: { size: 9026, type: WidthType.DXA }, columnWidths: [3026, 6000],              // A4 text width
        rows: [new TableRow({ tableHeader: true, cantSplit: true, children: [cell('Item', 3026), cell('Detail', 6000)] })] }),
    ],
  }],
});
await writeFile('report.docx', await Packer.toBuffer(doc));
```

## Workflow

1. Classify: create, fill or edit; template; audience; reader's application; whether tracked changes are expected.
2. For edits, copy the original and map its styles, numbering, sections and the paragraphs to change.
3. Build or modify through styles; tables in DXA; lists through numbering; computed parts as fields.
4. Check structure: the zip lists the expected parts and every XML part is well formed.
5. Render to PDF and page images; inspect headings, tables across page breaks, headers, footers and lists.
6. Report what changed, which styles were used, and limits (fields that update in Word, fonts that may substitute).

## Proof

- Style audit: `python -c "import docx; d = docx.Document('out.docx'); print([(p.style.name, p.text[:40]) for p in d.paragraphs][:40])"`
- Well-formed XML: `unzip -p out.docx word/document.xml | xmllint --noout -`
- Render: `soffice --headless --convert-to pdf --outdir render out.docx`, then `pdftoppm -png -r 80 render/out.pdf render/page` and view every page.
- Fonts and pages: `pdffonts render/out.pdf` (no unexpected substitutes) and `pdfinfo render/out.pdf` (page count, size).
- Text order: `pdftotext -layout render/out.pdf - | head -60`
- Edit scope: extract word/document.xml from the original and the result and compare them; only the intended paragraphs differ.
- Revisions: `unzip -p out.docx word/document.xml | grep -c "<w:ins "` matches the intended number of insertions.

## Stop and ask

- Accepting or rejecting another author's tracked changes, or deleting comments.
- Legal or contractual wording would change beyond the requested edit.
- Template fonts or branding assets are unavailable.
- Removing metadata, history or hidden content from a document that leaves the organization.

## Before returning

- [ ] Opens without a repair prompt; every XML part is well formed
- [ ] Headings and body text use real styles; no manual bullets or typed numbering
- [ ] Tables have DXA grid and cell widths; header rows repeat; rows do not split
- [ ] Page geometry, sections, headers and footers correct in the rendered PDF
- [ ] Fields (TOC, page numbers) present and their update behavior stated
- [ ] For edits: only intended content changed; styles, numbering and tracked changes preserved
- [ ] Rendered pages inspected; font substitutions reported

## Sources

[docx](https://docx.js.org/), [python-docx](https://python-docx.readthedocs.io/), [ECMA-376 Office Open XML](https://ecma-international.org/publications-and-standards/standards/ecma-376/).

## Skills in scope

- office-documents — cross-format pipelines across DOCX, XLSX, PPTX and PDF.
- pdf — print-ready PDF rendering and archival exports.
- doc-coauthoring — drafting and cold-reader review before layout.
- data-governance — scrubbing metadata, comments and personal data before external release.
