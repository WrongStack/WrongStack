import type { ModelsDevModel, ResolvedProvider } from '@wrongstack/core/types';
import { color } from '@wrongstack/core/utils';
import { boxBottom, boxDivider, boxRow, boxTop, keyHints, padVisible, theme } from './frame.js';

export function filterProviders(query: string, providers: ResolvedProvider[]): ResolvedProvider[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...providers];
  return providers.filter(
    (p) => p.id.toLowerCase().includes(q) || p.name.toLowerCase().includes(q),
  );
}

export interface ProviderPickerState {
  query: string;
  selected: number;
  status: 'typing' | 'submitted' | 'cancelled';
}

/**
 * Advance the live type-to-filter provider picker by one raw input chunk.
 * Pure: given the current state, a key chunk (a single keystroke, a paste, or
 * a multi-byte arrow escape sequence), and the number of providers matching
 * the CURRENT query, returns the next state.
 */
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
      if (query.length > 0) query = query.slice(0, -1);
      selected = 0;
      continue;
    }
    if (ch < ' ') continue;
    query += ch;
    selected = 0;
  }
  return { query, selected, status };
}

/** Preferred family display order; remaining families follow in insertion order. */
const PROVIDER_FAMILY_PREFERRED_ORDER = [
  'anthropic',
  'anthropic-oauth',
  'openai',
  'openai-codex',
  'github-copilot',
  'google',
  'openai-compatible',
];

/** Max providers rendered in one live-picker frame (keeps a frame in-viewport). */
export const LIVE_PICKER_MAX_VISIBLE = 15;

/**
 * Order providers for display: grouped by wire family in preferred order, then
 * alphabetical by id within each family.
 */
export function orderProvidersForDisplay(filtered: ResolvedProvider[]): ResolvedProvider[] {
  const families = new Map<string, ResolvedProvider[]>();
  for (const p of filtered) {
    const arr = families.get(p.family) ?? [];
    arr.push(p);
    families.set(p.family, arr);
  }
  const order = [
    ...PROVIDER_FAMILY_PREFERRED_ORDER.filter((f) => families.has(f)),
    ...[...families.keys()].filter((f) => !PROVIDER_FAMILY_PREFERRED_ORDER.includes(f)),
  ];
  const flat: ResolvedProvider[] = [];
  for (const fam of order) {
    const arr = (families.get(fam) ?? [])
      .slice()
      .sort((a, b) => a.id.toLowerCase().localeCompare(b.id.toLowerCase()));
    flat.push(...arr);
  }
  return flat;
}

export function renderLiveProviderList(
  query: string,
  filtered: ResolvedProvider[],
  selectedIdx: number,
  savedSet?: Set<string>,
): string {
  const ordered = orderProvidersForDisplay(filtered);
  const scrollOffset = Math.max(0, selectedIdx - LIVE_PICKER_MAX_VISIBLE + 1);
  const visible = ordered.slice(scrollOffset, scrollOffset + LIVE_PICKER_MAX_VISIBLE);

  const lines: string[] = [];
  lines.push(boxTop('Select a provider'));
  const caret = query.length > 0 ? color.dim('▏') : theme.cursor('▏');
  lines.push(boxRow(`${theme.accent('❯')} ${color.dim('Select provider:')} ${query}${caret}`));
  lines.push(boxDivider());

  if (scrollOffset > 0) {
    lines.push(boxRow(color.dim(`  ${scrollOffset} more above ↑`)));
  }

  let flat = 0;
  let lastFamily = '';
  for (const p of visible) {
    if (p.family !== lastFamily) {
      lines.push(boxRow(`${theme.accent('·')} ${color.dim(p.family.toUpperCase())}`));
      lastFamily = p.family;
    }
    const selected = flat === selectedIdx - scrollOffset;
    const sel = selected ? theme.cursor('▶') : ' ';
    const marker = savedSet
      ? `${sel} ${savedSet.has(p.id) ? color.cyan('◉') : color.dim('○')}`
      : `${sel}`;
    const id = selected ? theme.accent(color.bold(p.id)) : p.id;
    const name = selected ? p.name : color.dim(p.name);
    lines.push(boxRow(`${marker} ${padVisible(id, 24)} ${name}`));
    flat++;
  }

  if (scrollOffset + LIVE_PICKER_MAX_VISIBLE < ordered.length) {
    lines.push(
      boxRow(
        color.dim(`  ${ordered.length - scrollOffset - LIVE_PICKER_MAX_VISIBLE} more below ↓`),
      ),
    );
  }

  lines.push(boxDivider());
  lines.push(
    boxRow(
      keyHints([
        ['↑↓', 'scroll'],
        ['Enter', 'select'],
        ['Esc', 'clear'],
        ['Ctrl+C', 'quit'],
      ]),
    ),
  );
  lines.push(boxBottom());
  return lines.join('\n');
}

export function filterModels(query: string, models: ModelsDevModel[]): ModelsDevModel[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...models];
  return models.filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
}

export function renderLiveModelList(
  query: string,
  filtered: ModelsDevModel[],
  selectedIdx: number,
  header: string,
): string {
  const ordered = [...filtered].sort((a, b) =>
    (b.release_date ?? '').localeCompare(a.release_date ?? ''),
  );
  const visible = ordered.slice(0, LIVE_PICKER_MAX_VISIBLE);

  const lines: string[] = [];
  lines.push(boxTop('Select a model'));
  lines.push(boxRow(color.dim(header)));
  const caret = query.length > 0 ? color.dim('▏') : theme.cursor('▏');
  lines.push(boxRow(`${theme.accent('❯')} ${color.dim('Select model:')} ${query}${caret}`));
  lines.push(boxDivider());

  let flat = 0;
  for (const m of visible) {
    const selected = flat === selectedIdx;
    const marker = selected ? theme.cursor('▶') : ' ';
    const ctxRaw = m.limit?.context ? `${(m.limit.context / 1000).toFixed(0)}k` : '?';
    const ctx = theme.ctx(ctxRaw.padStart(6));
    const costRaw = m.cost?.input !== undefined ? `$${m.cost.input}/$${m.cost.output ?? '?'}` : '';
    const cost = costRaw ? theme.cost(costRaw) : '';
    const capTags: string[] = [];
    if (m.tool_call) capTags.push('tools');
    if (m.reasoning) capTags.push('reason');
    if (m.modalities?.input?.includes('image')) capTags.push('vision');
    const caps = capTags.map((c) => theme.caps(c)).join(color.dim(' '));
    const id = selected ? theme.accent(color.bold(m.id)) : m.id;
    const row = `${padVisible(id, 34)} ${ctx}  ${padVisible(cost, 12)} ${caps}`;
    lines.push(boxRow(`${marker} ${row}`));
    flat++;
  }

  if (ordered.length > LIVE_PICKER_MAX_VISIBLE) {
    lines.push(
      boxRow(color.dim(`  … ${ordered.length - LIVE_PICKER_MAX_VISIBLE} more — type to filter`)),
    );
  }

  lines.push(boxDivider());
  lines.push(
    boxRow(
      keyHints([
        ['↑↓', 'move'],
        ['Enter', 'select'],
        ['Esc', 'clear'],
        ['Ctrl+C', 'quit'],
      ]),
    ),
  );
  lines.push(boxBottom());
  return lines.join('\n');
}
