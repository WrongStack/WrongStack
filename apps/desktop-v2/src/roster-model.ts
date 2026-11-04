import { englishText } from './desktop-text';
import { entries, record } from './engine-values';
import { prepareSettingsPatch } from './settings-save-model';

export type RosterRecord = Record<string, unknown>;
export const rosterBudgetFields = [
  { key: 'timeoutMs', label: 'Total timeout (ms)' },
  { key: 'idleTimeoutMs', label: 'Idle timeout (ms)' },
  { key: 'maxIterations', label: 'Iterations' },
  { key: 'maxToolCalls', label: 'Tool calls' },
  { key: 'maxTokens', label: 'Tokens' },
  { key: 'maxCostUsd', label: 'Cost (USD)' },
] as const;
export function rosterCatalog(payload: RosterRecord): RosterRecord[] {
  const stats = entries(payload['stats']);
  return entries(payload['catalog'])
    .filter((row) => typeof row['role'] === 'string')
    .map((row) => ({ ...row, stats: stats.find((entry) => entry['role'] === row['role']) ?? {} }));
}
export function rosterConfig(value: RosterRecord): RosterRecord {
  const next = structuredClone(value);
  const budget = { ...record(next['budget']) };
  for (const { key, label } of rosterBudgetFields) {
    const input = budget[key];
    if (input === undefined || input === null || String(input).trim() === '') {
      delete budget[key];
      continue;
    }
    const amount = Number(input);
    if (
      !Number.isFinite(amount) ||
      amount < 0 ||
      (key !== 'maxCostUsd' && !Number.isSafeInteger(amount))
    )
      throw Error(
        englishText('settingsMessage', key === 'maxCostUsd' ? 'rosterNumber' : 'rosterWhole', {
          label,
        }),
      );
    budget[key] = amount;
  }
  if (Object.keys(budget).length) next['budget'] = budget;
  else delete next['budget'];
  for (const key of ['provider', 'model', 'fallbackProfile', 'cwd']) {
    if (typeof next[key] === 'string' && !String(next[key]).trim()) delete next[key];
  }
  if (typeof next['cwd'] === 'string') {
    const cwd = next['cwd'].replaceAll('\\', '/').trim();
    if (cwd.startsWith('/') || /^[a-z]:/i.test(cwd) || cwd.split('/').includes('..'))
      throw Error(englishText('settingsMessage', 'rosterCwd'));
    next['cwd'] = cwd;
  }
  for (const key of ['tools', 'skillNames', 'allowedCapabilities']) {
    if (
      next[key] !== undefined &&
      (!Array.isArray(next[key]) ||
        next[key].some((item: unknown) => typeof item !== 'string' || !item.trim()))
    )
      throw Error(englishText('settingsMessage', 'rosterNames', { key }));
  }
  if (next['availability']) {
    const available = record(next['availability']);
    try {
      new Intl.DateTimeFormat('en', { timeZone: String(available['timezone']) }).format();
    } catch {
      throw Error(englishText('settingsMessage', 'rosterTimezone'));
    }
    if (!Array.isArray(available['days']) || !available['days'].length)
      throw Error(englishText('settingsMessage', 'rosterDays'));
  }
  const policy = record(next['modelPolicy']);
  if (next['modelPolicy']) {
    const allowed = entries(policy['allowed']);
    if (!allowed.length || allowed.some((row) => !row['provider'] || !row['model']))
      throw Error(englishText('settingsMessage', 'rosterPolicy'));
    if (
      entries(policy['fallbacks']).some(
        (row) =>
          !allowed.some(
            (entry) => entry['provider'] === row['provider'] && entry['model'] === row['model'],
          ),
      )
    )
      throw Error(englishText('settingsMessage', 'rosterFallback'));
  }
  return next;
}
export function mergeRosterConfig(
  base: RosterRecord,
  draft: RosterRecord,
  current: RosterRecord,
): RosterRecord {
  return record(
    prepareSettingsPatch({ config: base }, { config: rosterConfig(draft) }, { config: current })[
      'config'
    ] ?? current,
  );
}
export function rosterDocumentKey(projectId: string, role: string, document: string): string {
  return JSON.stringify([projectId, role, document]);
}
