export interface ProviderPickerState {
  query: string;
  selected: number;
  status: 'typing' | 'submitted' | 'cancelled';
}

export function applyPickerKey(
  state: ProviderPickerState,
  chunk: string,
  matchCount: number,
): ProviderPickerState {
  if (chunk === '\x1b[A') return { ...state, selected: Math.max(0, state.selected - 1) };
  if (chunk === '\x1b[B')
    return { ...state, selected: Math.min(Math.max(0, matchCount - 1), state.selected + 1) };
  if (chunk === '\x1b') return { ...state, query: '', selected: 0, status: 'typing' };
  if (chunk.charCodeAt(0) === 0x1b) return state;

  let query = state.query;
  let selected = state.selected;
  const status: ProviderPickerState['status'] = 'typing';
  for (const ch of chunk) {
    if (ch === '\r' || ch === '\n') {
      return { ...state, status: matchCount > 0 ? 'submitted' : 'typing' };
    }
    if (ch === '\x03') return { ...state, status: 'cancelled' };
    if (ch === '\x15') {
      query = '';
      selected = 0;
      continue;
    }
    if (ch === '\x7f' || ch === '\b') {
      query = query.slice(0, -1);
      selected = 0;
      continue;
    }
    if (ch >= ' ' && ch !== '\x7f') {
      query += ch;
      selected = 0;
    }
  }
  return { query, selected, status };
}
