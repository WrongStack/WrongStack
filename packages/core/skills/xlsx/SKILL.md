---
name: xlsx
description: "Engineer, format, audit, and calculate Excel spreadsheets (.xlsx) with dynamic formulas, financial models, freeze panes, and custom number formatting. Use when generating complex spreadsheets, budgets, KPI trackers, financial projections, or auditing Excel models for calculation errors."
version: 1.0.0
required-capabilities: [filesystem.read, filesystem.write]
required-tools: []
optional-capabilities: [verification.run, web.research]
trigger: "generating complex spreadsheets, budgets, KPI trackers, financial projections, or auditing Excel models for calculation errors."
metadata:
  routing-group: data
---

# Excel Spreadsheet Engineering (XLSX) — WrongStack

## Selection card
- Task: Build, format, and audit calculated Excel workbooks (.xlsx).
- Start: Define workbook schema, sheet hierarchy, data types, and required formula dependencies.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

High-quality spreadsheet engineering treats workbooks as verifiable software systems.
Never store calculated numbers as static text strings. Separate input assumptions, raw data,
and summary presentation. Use libraries like `exceljs` (npm) or `openpyxl` (Python) to produce
structured, professional workbooks with explicit number formatting, formulas, and navigation locks.

## Core Engineering Rules

1. **Strict Data Typing & Number Formatting**:
   - Store numeric values as actual IEEE floats or integers, never text strings (avoid `'100.00'`).
   - Format currencies (`$#,##0.00` or `₺#,##0.00`), percentages (`0.0%`), and ISO dates (`yyyy-mm-dd`).
   - Align text left, numbers right, and short codes/dates centered.
2. **Formula Integrity & Calculation Engine**:
   - Write dynamic uppercase formulas (`SUM`, `AVERAGE`, `XLOOKUP`, `INDEX/MATCH`, `IFERROR`).
   - Never hardcode intermediate totals; reference calculation cells.
   - Guard against division-by-zero using `IFERROR(value, 0)`.
3. **Workbook Architecture & Multi-Sheet Structure**:
   - **Cover / Readme**: Metadata, authors, update date, color legend.
   - **Inputs / Assumptions**: Global constants, tax rates, growth assumptions.
   - **Data / Calculations**: Granular ledger transactions, normalized records.
   - **Dashboard / Summary**: High-level aggregated KPIs, formatted tables, and charts.
4. **Usability & Presentation Polish**:
   - Freeze header panes (`views: [{ state: 'frozen', ySplit: 1 }]`) so headers remain visible when scrolling.
   - Auto-calculate column widths with safety padding (e.g. `col.width = Math.max(headerLen, maxValLen) + 3`) to prevent `###` display truncation.
   - Distinguish editable inputs (soft yellow `#FFFBEB`) from calculated outputs (neutral light grey `#F3F4F6`).

## Implementation Pattern (npm exceljs)

```typescript
import ExcelJS from 'exceljs';

const workbook = new ExcelJS.Workbook();
workbook.creator = 'WrongStack Engine';
const sheet = workbook.addWorksheet('Financial Summary', {
  views: [{ state: 'frozen', ySplit: 2 }]
});

// Configure columns
sheet.columns = [
  { header: 'Quarter', key: 'qtr', width: 14 },
  { header: 'Revenue', key: 'rev', width: 18, style: { numFmt: '$#,##0' } },
  { header: 'Expenses', key: 'exp', width: 18, style: { numFmt: '$#,##0' } },
  { header: 'Net Profit', key: 'profit', width: 18, style: { numFmt: '$#,##0' } }
];

// Add data rows
sheet.addRow({ qtr: 'Q1', rev: 150000, exp: 95000, profit: { formula: 'B3-C3' } });
sheet.addRow({ qtr: 'Q2', rev: 180000, exp: 110000, profit: { formula: 'B4-C4' } });

// Header styling
const headerRow = sheet.getRow(1);
headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };

await workbook.xlsx.writeFile('financial_model.xlsx');
```

## Acceptance checks

- Numeric cells contain real numeric types with explicit display formats; no raw text strings.
- All totals and aggregates are dynamic formulas rather than hardcoded calculated constants.
- Columns are sized properly to prevent `###` value truncation across all rows.
- Frozen panes are configured on data tables to preserve readable headers during scrolling.
