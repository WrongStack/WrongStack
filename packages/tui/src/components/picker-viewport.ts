interface PickerViewportOptions {
  columns?: number | undefined;
  maxRows?: number | undefined;
  reservedRows: number;
  rowCap?: number;
}

function cells(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/** Measured main-pane limits are authoritative, including an explicit zero. */
export function pickerViewport(
  terminal: { columns: number; rows: number },
  { columns, maxRows, reservedRows, rowCap }: PickerViewportOptions,
): { columns: number; rows: number; compact: boolean } {
  const width = Math.min(cells(terminal.columns), cells(columns ?? terminal.columns));
  const height = Math.min(
    cells(terminal.rows),
    cells(maxRows ?? terminal.rows - reservedRows),
    cells(rowCap ?? terminal.rows),
  );
  // Borders and chrome should not crowd out the focused result or its controls.
  return { columns: width, rows: height, compact: height < 6 || width < 32 };
}
