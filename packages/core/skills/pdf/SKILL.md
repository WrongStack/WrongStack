---
name: pdf
description: "Generate, inspect, assemble, and render vector-quality PDF documents with precise page geometry, print typography, page breaks, and PDF/A standards. Use when generating downloadable reports, invoices, printable whitepapers, combining PDF pages, or rendering HTML to vector PDF."
version: 1.0.0
required-capabilities: [filesystem.read, filesystem.write]
required-tools: []
optional-capabilities: [verification.run, web.research]
trigger: "generating downloadable reports, invoices, printable whitepapers, combining PDF pages, or rendering HTML to vector PDF."
metadata:
  routing-group: media
---

# PDF Document Engineering — WrongStack

## Selection card
- Task: Generate, manipulate, and inspect print-ready vector PDF documents.
- Start: Define target page size (A4, Letter), bleed, margin boundaries, and color space.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

PDF is a fixed-layout vector format designed for visual fidelity across all printing and viewing devices.
Avoid blurry rasterized screenshots disguised as PDFs. Use native vector PDF composition tools
such as `pdf-lib` (npm), Typst, or headless Chromium print engines (`@playwright/test` / Puppeteer)
with explicit print CSS (`@media print`, `@page`) to achieve flawless typography, pagination, and vector line art.

## Core Engineering Rules

1. **Explicit Page & Margin Geometry**:
   - Always declare `@page` dimensions explicitly: `size: A4 portrait; margin: 20mm 15mm 20mm 15mm;`.
   - Prevent ugly page cuts across table rows or headers using `page-break-inside: avoid;` and `break-inside: avoid;`.
   - Force orphan heading protection: `h1, h2, h3 { break-after: avoid; page-break-after: avoid; }`.
2. **Vector Graphics & Font Embedding**:
   - Keep logos, diagrams, and line dividers as pure SVG or PDF vector paths; never compress to lossy JPEGs.
   - Ensure all web fonts are embedded or local system fonts to avoid fallback to generic Courier/Times.
3. **Running Headers & Footers**:
   - For Chromium PDF generation, use `displayHeaderFooter: true` with standard footer templates: `<div style="font-size: 9px; text-align: right; width: 100%; padding-right: 15mm;"><span class="pageNumber"></span> / <span class="totalPages"></span></div>`.
4. **Color & Print Contrast**:
   - Enable `printBackground: true` in the browser renderer so background cards and table fills render faithfully.
   - Maintain pure `#000000` or `#111827` for body copy; avoid pale grey text that washes out on office printers.

## Implementation Pattern (Headless Chromium Print)

```typescript
import { chromium } from 'playwright';
import * as fs from 'fs/promises';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

await page.setContent(`
  <!DOCTYPE html>
  <html>
  <head>
    <style>
      @page { size: A4 portrait; margin: 25mm 20mm 25mm 20mm; }
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #1e293b; line-height: 1.5; }
      h1 { color: #0f172a; font-size: 24pt; margin-bottom: 8pt; break-after: avoid; }
      .meta { font-size: 10pt; color: #64748b; margin-bottom: 24pt; border-bottom: 1pt solid #e2e8f0; padding-bottom: 12pt; }
      table { width: 100%; border-collapse: collapse; margin-top: 16pt; break-inside: auto; }
      tr { break-inside: avoid; }
      th, td { border: 0.5pt solid #cbd5e1; padding: 6pt 10pt; font-size: 9.5pt; text-align: left; }
      th { background-color: #f1f5f9; font-weight: 600; }
    </style>
  </head>
  <body>
    <h1>System Audit & Compliance Report</h1>
    <div class="meta">Generated: 2026-10-10 | Environment: Production Edge</div>
    <p>Detailed verification of global edge gateway policies and TLS termination certificates.</p>
  </body>
  </html>
`, { waitUntil: 'networkidle' });

await page.pdf({
  path: 'compliance_report.pdf',
  format: 'A4',
  printBackground: true,
  displayHeaderFooter: true,
  footerTemplate: '<div style="font-size: 8pt; color: #94a3b8; width: 100%; text-align: right; padding-right: 20mm;"><span class="pageNumber"></span> of <span class="totalPages"></span></div>',
  margin: { top: '25mm', bottom: '25mm', left: '20mm', right: '20mm' }
});

await browser.close();
```

## Acceptance checks

- Document renders with sharp vector text and scalable paths without raster blurriness.
- Page pagination, running headers, and footers ("Page X of Y") render correctly without overlaps.
- Table rows and section headings do not break awkwardly across page edges.
- Colors and backgrounds are preserved via `printBackground: true`.
