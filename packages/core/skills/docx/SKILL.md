---
name: docx
description: "Author, edit, inspect, and style Microsoft Word documents (.docx) with structured XML formatting, professional typography, headers/footers, and custom styles. Use when generating formal Word reports, contracts, manuals, whitepapers, or editing existing docx documents without corrupting formatting."
version: 1.0.0
required-capabilities: [filesystem.read, filesystem.write]
required-tools: []
optional-capabilities: [verification.run, web.research]
trigger: "generating formal Word reports, contracts, manuals, whitepapers, or editing existing docx documents without corrupting formatting."
metadata:
  routing-group: workflow
---

# Word Document Engineering (DOCX) — WrongStack

## Selection card
- Task: Create, format, and manipulate professional .docx Word documents.
- Start: Define document purpose, layout geometry (A4/Letter, margins), and style hierarchy.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

Word document authoring requires structured OpenXML manipulation via libraries like `docx` (npm)
or `python-docx`. Raw text dumping produces unreadable documents. Professional documents require
deliberate typographic scales, table geometry, header/footer pagination, and consistent paragraph spacing.

## Core Engineering Rules

1. **Typographic Hierarchy & Heading Styles**:
   - Explicitly define Heading 1, Heading 2, Heading 3, and Body styles with coordinated font families, weights, and colors.
   - Use `keepNext: true` on all headings to prevent orphan headings at the bottom of pages.
2. **Page & Section Geometry**:
   - Set standard page geometry: A4 (11906 x 16838 DXA) or US Letter (12240 x 15840 DXA) with 1-inch (1440 DXA) margins.
   - Distinct first page header/footer for title/cover sheets.
   - Insert running headers with document title and page numbering ("Page X of Y") in the footer.
3. **Table Formatting & Cell Widths**:
   - Always define explicit cell widths using percentages or fixed DXA measurements.
   - Include header rows with `cantSplit: true` and `tblHeader: true` so multi-page tables repeat headers properly.
   - Apply subtle cell padding (e.g. 120 DXA top/bottom, 160 DXA left/right) and alternating zebra striping for data readability.
4. **Callout Boxes & Accents**:
   - Use bordered single-cell tables with light shading (e.g. `#F4F5F7`) and left accent borders (3pt solid) for notes, warnings, and quotes.

## Implementation Pattern (npm docx)

```typescript
import { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, AlignmentType, PageNumber } from 'docx';
import * as fs from 'fs/promises';

const doc = new Document({
  styles: {
    default: { document: { run: { font: 'Calibri', size: 22, color: '1A1A1A' } } },
    paragraphStyles: [
      { id: 'DocTitle', name: 'Document Title', run: { font: 'Calibri Light', size: 48, bold: true, color: '0F172A' }, paragraph: { spacing: { after: 300 } } },
      { id: 'Heading1', name: 'Heading 1', run: { font: 'Calibri Light', size: 32, bold: true, color: '1E293B' }, paragraph: { spacing: { before: 400, after: 160 }, keepNext: true } }
    ]
  },
  sections: [{
    properties: { page: { margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } } },
    footers: {
      default: {
        children: [
          new Paragraph({
            alignment: AlignmentType.RIGHT,
            children: [new TextRun('Page '), PageNumber.CURRENT, new TextRun(' of '), PageNumber.TOTAL_PAGES]
          })
        ]
      }
    },
    children: [
      new Paragraph({ text: 'Enterprise Architecture Specification', style: 'DocTitle' }),
      new Paragraph({ text: '1. Executive Summary', style: 'Heading1' }),
      new Paragraph({ text: 'This document defines the high-availability migration path for core services.' })
    ]
  }]
});

const buffer = await Packer.toBuffer(doc);
await fs.writeFile('specification.docx', buffer);
```

## Acceptance checks

- Document validates cleanly as a standard OpenXML ZIP container without corruption.
- Heading styles enforce `keepNext: true` to prevent orphaned headings across page breaks.
- Tables have explicit column widths and repeat headers across page breaks.
- Footers contain dynamic page numbers and margins are verified.
