import { entries, record } from './engine-values';

export interface ContextMode {
  id: string;
  name: string;
  description: string;
  active: boolean;
  custom: boolean;
  thresholds: { warn: number; soft: number; hard: number };
  preserveK: number;
  eliseThreshold: number;
}

/** The engine's `context.modes.list` reply; rows without an id are dropped. */
export function contextModes(payload: Record<string, unknown>): ContextMode[] {
  return entries(payload['modes']).flatMap((row) => {
    if (typeof row['id'] !== 'string' || !row['id']) return [];
    const thresholds = record(row['thresholds']);
    return [
      {
        id: row['id'],
        name: String(row['name'] ?? row['id']),
        description: String(row['description'] ?? ''),
        active: row['isActive'] === true,
        custom: row['custom'] === true,
        thresholds: {
          warn: Number(thresholds['warn'] ?? 0),
          soft: Number(thresholds['soft'] ?? 0),
          hard: Number(thresholds['hard'] ?? 0),
        },
        preserveK: Number(row['preserveK'] ?? 0),
        eliseThreshold: Number(row['eliseThreshold'] ?? 0),
      },
    ];
  });
}

/** Form values for a custom mode, kept as text while editing. Thresholds are percentages. */
export interface ModeDraft {
  id: string;
  name: string;
  description: string;
  warn: string;
  soft: string;
  hard: string;
  preserveK: string;
  eliseThreshold: string;
}

export function modeDraft(mode?: ContextMode): ModeDraft {
  const percent = (value: number) => String(Math.round(value * 1000) / 10);
  return {
    id: mode?.id ?? '',
    name: mode?.name ?? '',
    description: mode?.description ?? '',
    warn: percent(mode?.thresholds.warn ?? 0.6),
    soft: percent(mode?.thresholds.soft ?? 0.75),
    hard: percent(mode?.thresholds.hard ?? 0.9),
    preserveK: String(mode?.preserveK ?? 10),
    eliseThreshold: String(mode?.eliseThreshold ?? 2000),
  };
}

/**
 * The `context.mode.create`/`update` payload, checked against the engine's rules so a refusal
 * is explained here: 0 ≤ warn ≤ soft ≤ hard ≤ 100 % of the window, whole non-negative counts.
 */
export function modePayload(draft: ModeDraft) {
  const id = draft.id.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id))
    throw Error('The mode ID uses letters, digits, "-" or "_" (up to 64 characters).');
  if (!draft.name.trim()) throw Error('Give the mode a name.');
  const share = (value: string, label: string) => {
    const number = Number(value);
    if (!value.trim() || !Number.isFinite(number) || number < 0 || number > 100)
      throw Error(`${label} must be a percentage from 0 to 100.`);
    return number / 100;
  };
  const warn = share(draft.warn, 'The warning level');
  const soft = share(draft.soft, 'The compaction level');
  const hard = share(draft.hard, 'The hard limit');
  if (!(warn <= soft && soft <= hard))
    throw Error('Levels must rise: warning ≤ compaction ≤ hard limit.');
  const count = (value: string, label: string) => {
    const number = Number(value);
    if (!value.trim() || !Number.isSafeInteger(number) || number < 0)
      throw Error(`${label} must be a whole number of 0 or more.`);
    return number;
  };
  return {
    id,
    name: draft.name.trim(),
    description: draft.description.trim(),
    thresholds: { warn, soft, hard },
    preserveK: count(draft.preserveK, 'Recent turns kept'),
    eliseThreshold: count(draft.eliseThreshold, 'The elision size'),
  };
}
