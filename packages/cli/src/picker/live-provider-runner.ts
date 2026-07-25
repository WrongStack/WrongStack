import type { ResolvedProvider } from '@wrongstack/core/types';
import { setOutputLineGuard, setRawMode, stripAnsi, writeOut } from '@wrongstack/core/utils';
import {
  applyPickerKey,
  filterProviders,
  orderProvidersForDisplay,
  renderLiveProviderList,
  type ProviderPickerState,
} from './live.js';

const QUERY_MARKER = 'Select provider:';

function cursorToQuery(frame: string, query: string): void {
  const rows = frame.split('\n');
  const lastIdx = rows.length - 1;
  const queryIdx = rows.findIndex((r) => r.includes(QUERY_MARKER));
  if (queryIdx < 0) return;
  const up = lastIdx - queryIdx;
  const queryLine = rows[queryIdx] ?? '';
  const plain = stripAnsi(queryLine);
  const markerAt = plain.indexOf(QUERY_MARKER);
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
      ordered = orderProvidersForDisplay(filterProviders(state.query, displayList));
      clamp();
      if (state.status === 'cancelled') {
        cleanup();
        writeOut('\n');
        resolve(undefined);
        return;
      }
      if (state.status === 'submitted') {
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
