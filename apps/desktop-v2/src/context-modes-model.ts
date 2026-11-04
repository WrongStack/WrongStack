import { entries, record } from './engine-values.js';

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
/** How a refused mode draft is explained; English unless the caller words it. */
export interface ModeWords {
  id: string;
  name: string;
  percent: (label: string) => string;
  rising: string;
  count: (label: string) => string;
  warn: string;
  soft: string;
  hard: string;
  preserveK: string;
  elise: string;
}
const englishModeWords: ModeWords = {
  id: 'The mode ID uses letters, digits, "-" or "_" (up to 64 characters).',
  name: 'Give the mode a name.',
  percent: (label) => `${label} must be a percentage from 0 to 100.`,
  rising: 'Levels must rise: warning ≤ compaction ≤ hard limit.',
  count: (label) => `${label} must be a whole number of 0 or more.`,
  warn: 'The warning level',
  soft: 'The compaction level',
  hard: 'The hard limit',
  preserveK: 'Recent turns kept',
  elise: 'The elision size',
};

export function modePayload(draft: ModeDraft, words: ModeWords = englishModeWords) {
  const id = draft.id.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)) throw Error(words.id);
  if (!draft.name.trim()) throw Error(words.name);
  const share = (value: string, label: string) => {
    const number = Number(value);
    if (!value.trim() || !Number.isFinite(number) || number < 0 || number > 100)
      throw Error(words.percent(label));
    return number / 100;
  };
  const warn = share(draft.warn, words.warn);
  const soft = share(draft.soft, words.soft);
  const hard = share(draft.hard, words.hard);
  if (!(warn <= soft && soft <= hard)) throw Error(words.rising);
  const count = (value: string, label: string) => {
    const number = Number(value);
    if (!value.trim() || !Number.isSafeInteger(number) || number < 0)
      throw Error(words.count(label));
    return number;
  };
  return {
    id,
    name: draft.name.trim(),
    description: draft.description.trim(),
    thresholds: { warn, soft, hard },
    preserveK: count(draft.preserveK, words.preserveK),
    eliseThreshold: count(draft.eliseThreshold, words.elise),
  };
}
