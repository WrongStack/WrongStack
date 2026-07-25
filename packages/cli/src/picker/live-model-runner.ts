import type { ModelsDevModel, ResolvedProvider } from '@wrongstack/core/types';
import { setOutputLineGuard, setRawMode, writeOut } from '@wrongstack/core/utils';
import { codexPickerPreamble } from './codex.js';
import {
  applyPickerKey,
  filterModels,
  LIVE_PICKER_MAX_VISIBLE,
  renderLiveModelList,
  type ProviderPickerState,
} from './live.js';

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
