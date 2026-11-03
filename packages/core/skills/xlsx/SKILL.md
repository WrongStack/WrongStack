---
name: xlsx
description: "Excel .xlsx workbooks with openpyxl or ExcelJS: formulas and cached values, number formats, tables, charts, financial models. Use when generating a spreadsheet, budget or KPI tracker, editing an existing workbook without losing formulas or charts, fixing #NAME? or #REF! errors or numbers stored as text, or auditing a model's calculations. Not for Word or slide output (use docx or pptx)."
version: 1.2.2
required-capabilities: [filesystem.read, filesystem.write]
required-tools: []
optional-capabilities: [verification.run, web.research]
trigger: "Use when a request names an .xlsx or .xlsm file, Excel formulas, openpyxl or ExcelJS code, or a spreadsheet model."
metadata:
  routing-group: data
---

# Excel Workbooks (XLSX)

## Selection card
- Task: Build, edit and audit Excel workbooks whose numbers are typed, calculated and verified.
- Start: For an existing file, inventory sheets, defined names, tables, charts, pivots, validation, conditional formats and macros before choosing a library; for a new one, write the input, calculation and output layout.
- Finish: the workbook was recalculated by a real engine, formula cells read back without errors or blanks, key totals match an independent computation, and rendered sheets were viewed; checks below pass.

## Overview

A workbook is software computed by someone else's engine: libraries write formulas but not values, so a generated file is unverified until an engine recalculates it and you read results back.
Libraries: exceljs (npm) and openpyxl (Python; checked 2026-11-02: exceljs 4.4.0, openpyxl 3.1.5).
Formats only change display; the stored value is what formulas, exports and pandas see.

## Rules

1. Formulas have no values until calculated. openpyxl and ExcelJS store the formula with no cached result; Excel recalculates on open, but previews, viewers, importers and `data_only=True` readers see blanks. Recalculate with an engine, or write known results (ExcelJS `{ formula, result }`), before quoting any number.
2. Never save a workbook loaded with `data_only=True`: every formula is replaced by its cached value, permanently. Load twice when you need formulas and values.
3. openpyxl does not keep everything: images, charts and shapes in an existing file can be lost on save, and macros survive only with `keep_vba=True` into .xlsm. Inventory first and preserve those parts or stop.
4. Store typed values: numbers as numbers, dates as dates with a date format, percentages as fractions (0.15 shown with `0.0%`). Identifiers, ZIP codes, phone numbers and anything over 15 digits are text with the `@` format, because Excel keeps 15 significant digits.
5. Newer functions need their stored prefix when written by a library (`_xlfn.XLOOKUP`; dynamic-array functions such as FILTER use a longer prefix, so check it). Without it Excel shows #NAME?. When the consumer's Excel is unknown, prefer INDEX/MATCH and SUMIFS.
6. Model structure: labeled inputs with units, calculations, outputs. No constants buried in formulas (`=B5*1.2` hides an assumption); one consistent formula per row or column; deliberate `$` anchoring; defined names or Tables for key ranges.
7. Treat imported text as data: values beginning with `=`, `+`, `-`, `@`, tab or CR are formula-injection vectors in CSV exports and when written as formulas; write them as strings.
8. Keep merged cells out of data regions: they break sorting, filtering, copying and pandas. Center headers with `horizontal='centerContinuous'` instead.

## First moves by situation

| Request or symptom | First moves |
|---|---|
| New model or tracker | README, Inputs, Calc and Output sheets; one Excel Table per dataset; named inputs; number formats; frozen headers; widths |
| Edit an existing workbook | Inventory parts; keep a copy; if it has charts, images, pivots or macros, choose an approach that preserves them |
| #NAME? after generating | Missing function prefix, misspelled function, unsupported function in the target Excel version |
| #REF! after inserting rows | openpyxl `insert_rows` and `delete_rows` do not rewrite formulas, defined names or chart ranges; rebuild references |
| Numbers stored as text | Convert at write time; check `cell.data_type` is `n`, not `s` |
| Dates shifted by four years or one day | 1904 date system workbook, the 1900 leap-year bug before 1900-03-01, timezone-naive datetimes |
| 100k+ rows | openpyxl `write_only=True` or ExcelJS streaming writer; `read_only=True` for reads; sheet limit 1,048,576 rows |
| Charts | openpyxl native charts bound to cell ranges (editable); ExcelJS has no chart API |
| Audit a model | Trace inputs to outputs; find hardcodes in formulas, inconsistent formulas, circular references and error values; recompute totals independently |

## Patterns and pitfalls

- **Display rounding** — a column formatted `#,##0` can show totals that seem off by one; wrap amounts that must reconcile in `ROUND(x, 2)`, and keep money in whole cents where possible.
- **Column width units** — widths are measured in characters of the default font's digit width, not pixels.
- **Format strings** — `#,##0.00`, `0.0%`, `yyyy-mm-dd`, negatives in red with `#,##0;[Red]-#,##0`; locale currency codes vary, so test the exact string in Excel.
- **Formula separators** — files always store commas and English function names; the UI localizes them (semicolons in many locales). Never write localized formulas.
- **Freeze panes** — openpyxl `ws.freeze_panes = 'B2'` freezes row 1 and column A; ExcelJS uses `views: [{ state: 'frozen', xSplit: 1, ySplit: 1 }]`.
- **Sheet names** — 31 characters max, none of `[ ] : * ? / \`; quote names with spaces in references (`='Q1 Sales'!B2`).
- **Tables** — unique names without spaces, string headers matching the cells, no overlapping ranges; overlaps trigger a repair prompt.
- **Recalc hint** — ExcelJS `workbook.calcProperties.fullCalcOnLoad = true` asks Excel to recalculate on open; other viewers still show cached values.
- **Style explosion** — new style objects per cell create thousands of formats until Excel refuses ("too many different cell formats"); reuse named styles.
- **Protection** — sheet protection prevents accidents, not access; never treat it as security.

## Pattern (openpyxl: named input, formulas, Table, frozen header)

```python
from openpyxl import Workbook
from openpyxl.styles import PatternFill
from openpyxl.workbook.defined_name import DefinedName
from openpyxl.worksheet.table import Table, TableStyleInfo

wb = Workbook()
inp = wb.active
inp.title = "Inputs"
inp["A1"], inp["B1"] = "Growth rate", 0.08
inp["B1"].number_format = "0.0%"
inp["B1"].fill = PatternFill("solid", fgColor="FFF2CC")           # marks an input
wb.defined_names["growth"] = DefinedName("growth", attr_text="Inputs!$B$1")

plan = wb.create_sheet("Plan")
plan.append(["Year", "Revenue"])
plan.append([2026, 1_000_000])
for r in range(3, 7):
    plan.append([f"=A{r-1}+1", f"=B{r-1}*(1+growth)"])
for r in range(2, 7):
    plan[f"B{r}"].number_format = "#,##0"
plan.freeze_panes = "A2"
plan.add_table(Table(displayName="PlanTable", ref="A1:B6",
                     tableStyleInfo=TableStyleInfo(name="TableStyleMedium2", showRowStripes=True)))
wb.save("plan.xlsx")                                               # formulas still uncalculated
```

## Workflow

1. Classify: new or existing, consumer application (Excel desktop, web, Google Sheets, LibreOffice, pandas), size.
2. Inventory existing parts and choose the library that preserves them.
3. Lay out inputs, calculations and outputs; write typed values, formats and formulas.
4. Recalculate with an engine and read values back; fix every error value and blank formula result.
5. Cross-check key outputs with an independent computation (pandas or a hand calculation).
6. Render the sheets that people read and inspect widths, formats and frozen panes.
7. Report the recalculation method, checks performed and any parts that could not be preserved.

## Proof

- Uncalculated cells: load the file twice (formulas, and `data_only=True`) and list formula cells whose cached value is None; after recalculation the list must be empty.
- Error scan: `python -c "import openpyxl; wb = openpyxl.load_workbook('recalc/model.xlsx', data_only=True); print([(ws.title, c.coordinate, c.value) for ws in wb for row in ws.iter_rows() for c in row if isinstance(c.value, str) and c.value.startswith('#')])"` prints `[]`.
- Recalculation: run a headless LibreOffice macro that calls `calculateAll()` and stores the file (default load settings can skip recalculating Excel files), or open and save in Excel.
- Render: `soffice --headless --convert-to pdf --outdir render model.xlsx` and `pdftoppm -png -r 80 render/model.pdf render/sheet` for visual inspection.
- Independent totals: recompute the key outputs with pandas from the input data and compare to the recalculated cells.

## Stop and ask

- The existing workbook contains charts, pivots, images or macros the chosen library would drop.
- Model assumptions (rates, prices, dates) are missing and would have to be invented.
- Formula results cannot be recalculated in this environment and the user needs numbers quoted.
- The workbook holds personal or financial data that would be shared outside its audience.

## Before returning

- [ ] Recalculated by an engine; no formula cell has a blank cached value
- [ ] No error values (#REF!, #NAME?, #VALUE!, #DIV/0!) unless intentional and explained
- [ ] Numbers, dates and percentages stored as typed values; identifiers stored as text
- [ ] Inputs separated and labeled; no hardcoded constants inside formulas
- [ ] Existing charts, images, names, validation and macros preserved or their loss approved
- [ ] Key totals match an independent computation
- [ ] Rendered sheets viewed: widths, formats, frozen panes, no `###`

## Sources

[openpyxl](https://openpyxl.readthedocs.io/), [ExcelJS](https://github.com/exceljs/exceljs), [Excel specifications and limits](https://support.microsoft.com/en-us/office/excel-specifications-and-limits-1672b34d-7043-467e-8e27-269d656771c3).

## Skills in scope

- office-documents — integrated DOCX, XLSX, PPTX and PDF workflows.
- database-development — normalized source data and queries feeding the workbook.
- verify-before-done — formula accuracy and boundary checks before delivery.
- data-governance — personal and financial data handling before sharing.
