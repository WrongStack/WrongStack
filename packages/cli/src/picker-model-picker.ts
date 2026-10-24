import type { ModelsDevModel, ResolvedProvider } from '@wrongstack/contracts/types';
import {
  color,
  expectDefined,
  setOutputLineGuard,
  setRawMode,
  writeOut,
} from '@wrongstack/core/utils';
import {
  cycleStartupEffort,
  EFFORT_KEEP,
  type StartupEffortChoice,
  startupEffortOptions,
} from './picker-effort.js';
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

/** Effort strip state for the focused row; omitted → no strip line at all. */
export interface LiveModelEffortStrip {
  options: readonly StartupEffortChoice[];
  choice: StartupEffortChoice;
}

export interface LiveModelPick {
  model: ModelsDevModel;
  /** {@link EFFORT_KEEP} when the user left the configured effort alone. */
  effort: StartupEffortChoice;
}

function renderEffortStrip(strip: LiveModelEffortStrip): string {
  const label = color.dim('effort (←/→):');
  if (strip.options.length === 0) {
    return `${label} ${color.dim('not adjustable for this model')}`;
  }
  const levels = strip.options
    .map((option) =>
      option === strip.choice ? theme.accent(color.bold(`[${option}]`)) : color.dim(option),
    )
    .join(color.dim(' · '));
  return `${label} ${levels}`;
}

export function renderLiveModelList(
  query: string,
  filtered: ModelsDevModel[],
  selectedIdx: number,
  header: string,
  effort?: LiveModelEffortStrip,
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
  if (effort) {
    lines.push(boxRow(renderEffortStrip(effort)));
    lines.push(boxDivider());
  }
  lines.push(
    boxRow(
      keyHints([
        ['↑↓', 'move'],
        ...(effort && effort.options.length > 0
          ? ([['←→', 'effort']] as Array<[string, string]>)
          : []),
        ['Enter', 'select'],
        ['Esc', 'clear'],
        ['Ctrl+C', 'quit'],
      ]),
    ),
  );
  lines.push(boxBottom());
  return lines.join('\n');
}

const ARROW_RIGHT = '\x1b[C';
const ARROW_LEFT = '\x1b[D';

export async function runLiveModelPicker(
  provider: ResolvedProvider,
  defaultModel?: string,
): Promise<LiveModelPick | undefined> {
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
  // The chosen effort belongs to ONE row: moving the focus (arrows or a filter
  // edit) resets it to `default`, so a level picked on a sibling never rides
  // along onto a model that cannot carry it — same rule as the `/model` strip.
  let effortChoice: StartupEffortChoice = EFFORT_KEEP;
  let effortOwner: string | undefined;
  const effortStrip = (): {
    options: readonly StartupEffortChoice[];
    choice: StartupEffortChoice;
  } => {
    const focused = ordered[state.selected];
    if (focused?.id !== effortOwner) {
      effortOwner = focused?.id;
      effortChoice = EFFORT_KEEP;
    }
    return { options: startupEffortOptions(focused), choice: effortChoice };
  };
  const preamble = codexPickerPreamble(provider);
  if (preamble) writeOut(preamble);
  let frame = renderLiveModelList(state.query, ordered, state.selected, header, effortStrip());
  writeOut(frame);

  return new Promise<LiveModelPick | undefined>((resolve) => {
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
      frame = renderLiveModelList(state.query, ordered, state.selected, header, effortStrip());
      writeOut(frame);
    };
    const onData = (chunk: string): void => {
      if (chunk === ARROW_RIGHT || chunk === ARROW_LEFT) {
        const { options } = effortStrip();
        if (options.length === 0) return;
        effortChoice = cycleStartupEffort(options, effortChoice, chunk === ARROW_RIGHT ? 1 : -1);
        repaint();
        return;
      }
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
        // Re-derived, not trusted: a row with no strip never carries a level.
        const effort = startupEffortOptions(pick).length > 0 ? effortStrip().choice : EFFORT_KEEP;
        cleanup();
        writeOut('\n');
        resolve({ model: pick, effort });
        return;
      }
      repaint();
    };
    stdin.on('data', onData);
  });
}
