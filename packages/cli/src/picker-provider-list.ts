import type { ResolvedProvider } from '@wrongstack/contracts/types';
import { color, setOutputLineGuard, setRawMode, stripAnsi, writeOut } from '@wrongstack/core/utils';
import { LOCAL_LLM_PRESETS } from './auth-menu/local-presets.js';
import { applyPickerKey, type ProviderPickerState } from './picker-key-state.js';
import { LIVE_PICKER_MAX_VISIBLE } from './picker-model-picker.js';
import { boxBottom, boxDivider, boxRow, boxTop, keyHints, padVisible, theme } from './picker-ui.js';

/**
 * Filter providers by a free-text query: case-insensitive substring match
 * against the provider id OR display name. An empty/whitespace query returns
 * all providers (as a copy). Input order is preserved. Powers the live
 * type-to-filter provider picker.
 */
/**
 * Append synthetic entries for the built-in local-server presets
 * (OmniRoute / Ollama / vLLM / LM Studio) that aren't already present in
 * the merged list. These are keyless loopback gateways, so they pass the
 * `isKeylessLocalProvider` filter and become immediately selectable even
 * on a fresh install with no config and no catalog entry — mirroring the
 * `wstack auth local` shortcut. An entry is skipped when an id-match
 * already exists (catalog or saved config), so a user's customized
 * provider always wins over the preset default. Mutates and returns
 * `merged` for call-site convenience. Pure aside from the push.
 */
export function appendLocalPresetProviders(merged: ResolvedProvider[]): ResolvedProvider[] {
  const existing = new Set(merged.map((p) => p.id));
  for (const preset of LOCAL_LLM_PRESETS) {
    if (existing.has(preset.id)) continue;
    merged.push({
      id: preset.id,
      name: preset.label,
      family: 'openai-compatible',
      apiBase: preset.defaultBaseUrl,
      // No env vars → with a loopback apiBase this reads as a keyless
      // local gateway, so the picker offers it without a key.
      envVars: [],
      // No catalog models yet; OmniRoute/LM Studio/etc. auto-discover at
      // boot or the user picks `m` to set a list. An empty list still
      // lets the provider be chosen — pickModel surfaces the "no models
      // listed" hint and the user can type an id directly.
      models: [],
    });
  }
  return merged;
}

export function filterProviders(query: string, providers: ResolvedProvider[]): ResolvedProvider[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...providers];
  return providers.filter(
    (p) => p.id.toLowerCase().includes(q) || p.name.toLowerCase().includes(q),
  );
}

/** Preferred family display order; remaining families follow in insertion order. */
export const PROVIDER_FAMILY_PREFERRED_ORDER = [
  'anthropic',
  'anthropic-oauth',
  'openai',
  'openai-codex',
  'github-copilot',
  'google',
  'google-antigravity',
  'openai-compatible',
];

/**
 * Order providers for display: grouped by wire family in preferred order, then
 * alphabetical by id within each family. Pure. Shared by the live render and
 * the raw-stdin loop so the selection index and the rendered cursor always
 * refer to the same provider.
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

/**
 * Render the live type-to-filter provider view as one string: the query line,
 * providers grouped by wire family (preferred order, alphabetical within each
 * family), the selected provider marked with ▶, and a key hint. Capped to
 * LIVE_PICKER_MAX_VISIBLE rows so a frame always fits the viewport (the raw
 * loop redraws by moving the cursor up and clearing). Pure.
 */
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
  // Search field. `Select provider: ${query}` is preserved verbatim (tests +
  // the raw-loop cursor math both depend on it). The prompt glyph is accented;
  // a blinking-style caret block trails the query.
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
      // Family section label — dim, small-caps feel via a leading accent tick.
      lines.push(boxRow(`${theme.accent('·')} ${color.dim(p.family.toUpperCase())}`));
      lastFamily = p.family;
    }
    const selected = flat === selectedIdx - scrollOffset;
    const sel = selected ? theme.cursor('▶') : ' ';
    let marker: string;
    if (savedSet) {
      const mark = savedSet.has(p.id) ? color.cyan('◉') : color.dim('○');
      marker = `${sel} ${mark}`;
    } else {
      marker = `${sel}`;
    }
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

/**
 * Interactive provider + model picker. Lists supported providers grouped
 * by wire family — by default only those with an API key (env or stored
 * config), so you see only what you can actually launch into. Falls back
 * to the full catalog when no keys are found anywhere.
 *
 * When `defaultProvider`/`defaultModel` are passed, they're pre-selected
 * so the user can press Enter to accept the previous choice.
 */
/**
 * Live type-to-filter provider picker (TTY only). Takes over stdin in raw mode
 * and redraws the filtered, family-grouped list on every keystroke. Thin I/O
 * shell around the pure filterProviders / applyPickerKey / renderLiveProviderList
 * helpers (which are fully unit-tested). Returns the chosen provider, or
 * undefined on cancel. runPicker only calls this when stdin is a TTY; non-TTY
 * callers (CI, piped input, tests) fall through to the numbered readLine picker.
 */
// Marker used to locate the query line within the rendered (boxed) frame.
// renderLiveProviderList emits exactly one line containing this literal.
export const QUERY_MARKER = 'Select provider:';

/**
 * Park the terminal cursor at the end of the live query text inside the
 * boxed frame. The frame is multi-line with a border, so we (1) find which
 * physical line holds the query, (2) move up from the last line to it, then
 * (3) move to the visible column just after the typed query. Visible width
 * is measured with stripAnsi so the box border + accent colors don't offset
 * the cursor.
 */
export function cursorToQuery(frame: string, query: string): void {
  const rows = frame.split('\n');
  const lastIdx = rows.length - 1;
  const queryIdx = rows.findIndex((r) => r.includes(QUERY_MARKER));
  if (queryIdx < 0) return; // frame shape changed unexpectedly — leave cursor
  const up = lastIdx - queryIdx;
  const queryLine = rows[queryIdx] ?? '';
  // Everything on the query line up to and including the typed query, minus
  // the query text itself, is the visible prefix. We locate the marker, then
  // add the marker + separator + query length in visible columns.
  const plain = stripAnsi(queryLine);
  const markerAt = plain.indexOf(QUERY_MARKER);
  // prefix = columns before the query text = markerAt + marker + ': ' gap.
  const col = markerAt + QUERY_MARKER.length + 1 + query.length + 1;
  if (up > 0) writeOut(`\x1b[${up}A`);
  writeOut(`\x1b[${col}G`);
}

export async function runLiveProviderPicker(
  displayList: ResolvedProvider[],
  savedSet?: Set<string>,
): Promise<ResolvedProvider | undefined> {
  const stdin = process.stdin;
  const out = process.stdout;
  if (!stdin.isTTY || !out.isTTY) return undefined;

  setOutputLineGuard(null);
  let state: ProviderPickerState = { query: '', selected: 0, status: 'typing' };
  let ordered = orderProvidersForDisplay(filterProviders(state.query, displayList));
  const visibleCount = (): number => ordered.length;
  const clamp = (): void => {
    if (state.selected >= visibleCount()) state.selected = Math.max(0, visibleCount() - 1);
  };
  clamp();
  let frame = renderLiveProviderList(state.query, ordered, state.selected, savedSet);
  writeOut(frame);
  writeOut('\x1b7');
  cursorToQuery(frame, state.query);

  return new Promise<ResolvedProvider | undefined>((resolve) => {
    const wasRaw = stdin.isRaw;
    const wasPaused = stdin.isPaused();
    setRawMode(stdin, true);
    stdin.resume();
    stdin.setEncoding('utf8');

    const cleanup = (): void => {
      stdin.off('data', onData);
      setRawMode(stdin, wasRaw);
      if (wasPaused) stdin.pause();
    };
    const repaint = (): void => {
      writeOut('\x1b8');
      const ups = (frame.match(/\n/g) ?? []).length;
      writeOut(`\x1b[${ups}A\r\x1b[J`);
      ordered = orderProvidersForDisplay(filterProviders(state.query, displayList));
      clamp();
      frame = renderLiveProviderList(state.query, ordered, state.selected, savedSet);
      writeOut(frame);
      writeOut('\x1b7');
      cursorToQuery(frame, state.query);
    };
    const onData = (chunk: string): void => {
      ordered = orderProvidersForDisplay(filterProviders(state.query, displayList));
      state = applyPickerKey(state, chunk, visibleCount());
      // applyPickerKey may have changed the query (type/paste) — recompute against
      // the NEW query before resolving a selection, so a paste like "zzz\r" can't
      // submit a provider from the pre-paste list.
      ordered = orderProvidersForDisplay(filterProviders(state.query, displayList));
      clamp();
      if (state.status === 'cancelled') {
        cleanup();
        writeOut('\n');
        resolve(undefined);
        return;
      }
      if (state.status === 'submitted') {
        // Query emptied the matches mid-chunk (e.g. paste): stay in the picker.
        if (ordered.length === 0) {
          state = { ...state, status: 'typing' };
          repaint();
          return;
        }
        const pick = ordered[state.selected] ?? ordered[0];
        cleanup();
        writeOut('\n');
        resolve(pick);
        return;
      }
      repaint();
    };
    stdin.on('data', onData);
  });
}
