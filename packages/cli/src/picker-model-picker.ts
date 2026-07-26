import type { ModelsDevModel, ResolvedProvider } from '@wrongstack/core/types';
import { color, expectDefined, setOutputLineGuard, setRawMode, writeOut } from '@wrongstack/core/utils';
import { applyPickerKey, type ProviderPickerState } from './picker-key-state.js';
import {
  boxBottom,
  boxDivider,
  boxRow,
  boxTop,
  codexPickerPreamble,
  keyHints,
  padVisible,
  theme,
} from './picker-ui.js';

export const LIVE_PICKER_MAX_VISIBLE = 15;

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
    lines.push(boxRow(`${marker} ${padVisible(id, 34)} ${ctx}  ${padVisible(cost, 12)} ${caps}`));
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

export async function runLiveModelPicker(
  provider: ResolvedProvider,
  defaultModel?: string,
): Promise<ModelsDevModel | undefined> {
  const stdin = process.stdin;
  const out = process.stdout;
  if (!stdin.isTTY || !out.isTTY) return undefined;

  const header = `${provider.name} (${provider.id}) models:`;
  const byNewest = (a: ModelsDevModel, b: ModelsDevModel): number =>
    (b.release_date ?? '').localeCompare(a.release_date ?? '');
  const ranked = [...provider.models].sort(byNewest);
  const defaultIdx =
    defaultModel !== undefined ? ranked.findIndex((m) => m.id === defaultModel) : -1;

  setOutputLineGuard(null);
  let state: ProviderPickerState = {
    query: '',
    selected: defaultIdx >= 0 ? defaultIdx : 0,
    status: 'typing',
  };
  const order = (filtered: ModelsDevModel[]): ModelsDevModel[] => [...filtered].sort(byNewest);
  let ordered = order(filterModels(state.query, provider.models));
  const visibleCount = (): number => Math.min(ordered.length, LIVE_PICKER_MAX_VISIBLE);
  const clamp = (): void => {
    if (state.selected >= visibleCount()) state.selected = Math.max(0, visibleCount() - 1);
  };
  clamp();
  const preamble = codexPickerPreamble(provider);
  if (preamble) writeOut(preamble);
  let frame = renderLiveModelList(state.query, ordered, state.selected, header);
  writeOut(frame);

  return new Promise<ModelsDevModel | undefined>((resolve) => {
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
      const ups = (frame.match(/\n/g) ?? []).length;
      writeOut(`\x1b[${ups}A\r\x1b[J`);
      ordered = order(filterModels(state.query, provider.models));
      clamp();
      frame = renderLiveModelList(state.query, ordered, state.selected, header);
      writeOut(frame);
    };
    const onData = (chunk: string): void => {
      ordered = order(filterModels(state.query, provider.models));
      state = applyPickerKey(state, chunk, visibleCount());
      ordered = order(filterModels(state.query, provider.models));
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
        const pick = ordered[state.selected] ?? expectDefined(ordered[0]);
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
