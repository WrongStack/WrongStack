import type { SideEffect } from '@wrongstack/contracts/types';
import { record } from './engine-values';

type Words = (key: string, values: Record<string, string>) => string;

/**
 * A recorded outcome in the display language. Tools record English text in a few shapes
 * ("launched (pid 42)", "timed out (exit 1)"); other text is shown as recorded.
 */
export function outcomeText(outcome: string, t: Words): string {
  const text = outcome.trim();
  let m = /^launched \(pid (\S+)\)$/.exec(text);
  if (m) return t('effectsView.outcome.launched', { pid: m[1] ?? '' });
  m = /^started background job (\S+) \(PID: (\S+)\)$/.exec(text);
  if (m) return t('effectsView.outcome.backgroundJob', { job: m[1] ?? '', pid: m[2] ?? '' });
  if (text === 'aborted') return t('effectsView.outcome.aborted', {});
  if (text === 'success') return t('effectsView.outcome.success', {});
  m = /^timed out \(exit (\S+)\)$/.exec(text);
  if (m) return t('effectsView.outcome.timedOut', { code: m[1] ?? '' });
  m = /^exit (\S+)$/.exec(text);
  if (m) return t('effectsView.outcome.exit', { code: m[1] ?? '' });
  m = /^error \((.*)\)$/s.exec(text);
  if (m) return t('effectsView.outcome.error', { message: m[1] ?? '' });
  return outcome;
}

export const effectKinds = ['shell', 'package', 'network', 'fs.write', 'config'] as const;
export const effectLabels: Record<string, string> = {
  shell: 'Shell',
  package: 'Packages',
  network: 'Network',
  'fs.write': 'File writes',
  config: 'Configuration',
};
export interface EffectsSnapshot {
  entries: SideEffect[];
  total: number | null;
  truncated: boolean;
  /** Position of the first entry in the runtime history; null from engines without paging. */
  start: number | null;
}
export function effectsSnapshot(
  payload: Record<string, unknown>,
  sessionId: string,
): EffectsSnapshot {
  if (payload['sessionId'] !== sessionId || !Array.isArray(payload['sideEffects']))
    throw Error('Side-effect history belongs to another conversation or has no records.');
  const entries = payload['sideEffects'].map((value) => {
    const row = record(value);
    if (
      !['toolUseId', 'toolName', 'risk', 'ts'].every(
        (key) => typeof row[key] === 'string' && row[key],
      ) ||
      !Number.isFinite(Date.parse(String(row['ts']))) ||
      !row['input'] ||
      typeof row['input'] !== 'object' ||
      Array.isArray(row['input']) ||
      (row['outcome'] !== undefined && typeof row['outcome'] !== 'string')
    )
      throw Error('The engine returned an invalid side-effect record.');
    return {
      toolUseId: String(row['toolUseId']),
      toolName: String(row['toolName']),
      ts: String(row['ts']),
      risk: row['risk'] as SideEffect['risk'],
      input: record(row['input']),
      ...(typeof row['outcome'] === 'string' ? { outcome: row['outcome'] } : {}),
    };
  });
  const total = payload['total'];
  if (total !== undefined && (!Number.isSafeInteger(total) || Number(total) < entries.length))
    throw Error('The side-effect record count is inconsistent.');
  return {
    entries,
    total: typeof total === 'number' ? total : null,
    truncated:
      payload['truncated'] === true || (typeof total === 'number' && total > entries.length),
    start:
      Number.isSafeInteger(payload['start']) && Number(payload['start']) >= 0
        ? Number(payload['start'])
        : null,
  };
}

/**
 * Reads the `journalSideEffects` page of a `session.inspect` reply: the durable copy of the
 * records in the session journal, which outlives the runtime window and host restarts.
 */
export function journalEffectsSnapshot(
  result: Record<string, unknown>,
  sessionId: string,
): EffectsSnapshot {
  const page = result['journalSideEffects'];
  if (!page || typeof page !== 'object')
    throw Error(
      typeof result['error'] === 'string' && result['error']
        ? result['error']
        : 'This engine does not read side effects from the session journal.',
    );
  const snapshot = effectsSnapshot(record(page), sessionId);
  if (snapshot.start === null || snapshot.total === null)
    throw Error('The engine returned a journal page without its position.');
  return snapshot;
}

/**
 * Appends an older page in front of the loaded records. The page is requested to end with the
 * oldest record already loaded; if it does not, the runtime dropped or reordered records in
 * between and the page is refused rather than leaving a silent gap.
 */
export function withOlderPage(loaded: readonly SideEffect[], page: EffectsSnapshot): SideEffect[] {
  const oldest = loaded[0];
  const last = page.entries.at(-1);
  if (!oldest || last?.toolUseId !== oldest.toolUseId)
    throw Error('The retained history changed while paging. Refresh and load older records again.');
  return [...page.entries.slice(0, -1), ...loaded];
}
export function effectSummary(effect: SideEffect): string {
  for (const key of ['command', 'url', 'filePath', 'path', 'packages']) {
    const value = effect.input[key];
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.filter((item) => typeof item === 'string').join(', ');
  }
  return Object.keys(effect.input).length
    ? `${Object.keys(effect.input).length} recorded input fields`
    : 'No input details recorded';
}
function csvCell(value: string): string {
  const safe = /^(?:[\t\r\n]|\s*[=+@-])/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}
export function effectsCsv(entries: SideEffect[]): string {
  return [
    ['timestamp', 'tool', 'kind', 'detail', 'outcome', 'tool_call_id'],
    ...entries.map((entry) => [
      entry.ts,
      entry.toolName,
      entry.risk,
      effectSummary(entry),
      entry.outcome ?? '',
      entry.toolUseId,
    ]),
  ]
    .map((row) => row.map(csvCell).join(','))
    .join('\r\n');
}
