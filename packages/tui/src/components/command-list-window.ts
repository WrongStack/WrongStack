export type CommandRow<T> =
  | { type: 'header'; category: string }
  | { type: 'item'; item: T; index: number };

/** Category context shares the row budget; it must never displace the focus. */
export function commandListWindow<T extends { category: string }>(
  items: readonly T[],
  selected: number,
  capacity: number,
): { rows: CommandRow<T>[]; above: number; below: number; focus: number } {
  const focus = Math.max(0, Math.min(selected, items.length - 1));
  const limit = Math.max(1, Math.floor(capacity));
  if (items.length === 0) return { rows: [], above: 0, below: 0, focus };
  const rows: CommandRow<T>[] = [];
  let category = '';
  for (const [index, item] of items.entries()) {
    const next = item.category || 'App';
    if (next !== category && limit > 1) {
      category = next;
      rows.push({ type: 'header', category });
    }
    rows.push({ type: 'item', item, index });
  }
  const focusedRow = rows.findIndex((row) => row.type === 'item' && row.index === focus);
  let start = Math.max(0, Math.min(rows.length - limit, focusedRow - Math.floor(limit / 2)));
  let visible = rows.slice(start, start + limit);
  if (visible[0]?.type === 'item' && limit > 1) {
    // Reserve one slot for the category, shifting only if focus would be lost.
    if (focusedRow >= start + limit - 1) start++;
    visible = rows.slice(start, start + limit - 1);
    const first = visible[0];
    if (first?.type === 'item') {
      visible.unshift({ type: 'header', category: first.item.category || 'App' });
    }
  }
  const indices = visible.flatMap((row) => (row.type === 'item' ? [row.index] : []));
  return {
    rows: visible,
    above: indices[0] ?? 0,
    below: items.length - (indices.at(-1) ?? focus) - 1,
    focus,
  };
}
