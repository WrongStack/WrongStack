import { entries, record } from './engine-values';
import { sameSetting } from './settings-save-model';

export interface BrainTarget {
  provider: string;
  model: string;
}
export interface BrainVoter extends BrainTarget {
  persona: string;
  weight: string;
  veto: 'default' | 'yes' | 'no';
}
export interface BrainSeatDefault {
  persona: string;
  veto: 'default' | 'yes' | 'no';
}
export interface BrainTargetsDraft {
  pool: BrainTarget[];
  strategy: string;
  voters: BrainVoter[];
  seats: BrainSeatDefault[];
  judge: BrainTarget;
}
export const emptyBrainTarget = (): BrainTarget => ({ provider: '', model: '' });
export const emptyBrainSeat = (): BrainSeatDefault => ({ persona: '', veto: 'default' });
export const emptyBrainVoter = (): BrainVoter => ({
  ...emptyBrainTarget(),
  persona: '',
  weight: '',
  veto: 'default',
});
const target = (value: unknown): BrainTarget => {
  const row = record(value);
  return { provider: String(row['provider'] ?? ''), model: String(row['model'] ?? '') };
};
export function brainTargetsDraft(config: Record<string, unknown>): BrainTargetsDraft {
  const council = record(config['council']);
  return {
    pool: entries(config['models']).map(target),
    strategy: String(config['strategy'] ?? 'fallback'),
    seats: entries(council['seats']).map((row) => ({
      persona: String(row['persona'] ?? ''),
      veto: row['veto'] === undefined ? 'default' : row['veto'] === true ? 'yes' : 'no',
    })),
    voters: entries(council['voters']).map((row) => ({
      ...target(row),
      persona: String(row['persona'] ?? ''),
      weight: row['weight'] === undefined ? '' : String(row['weight']),
      veto: row['veto'] === undefined ? 'default' : row['veto'] === true ? 'yes' : 'no',
    })),
    judge: target(council['judge']),
  };
}
type BrainPart = 'models' | 'strategy' | 'voters' | 'seats' | 'judge';
const englishTargetWords = {
  pool: (n: number) => `Brain pool model ${n}`,
  voter: (n: number) => `Brain voter ${n}`,
  judge: 'Council judge',
  needsModel: (label: string) =>
    `${label} needs a model ID. Remove an empty row to inherit instead.`,
  strategy: 'Choose a valid Brain model-pool strategy.',
  seatLens: (n: number) => `Brain seat default ${n} needs a decision lens.`,
  seatVeto: 'Choose a valid seat-default veto policy.',
  weight: (n: number) => `Brain voter ${n} needs a positive vote weight or an empty default.`,
  voterVeto: 'Choose a valid council veto policy.',
  changed: (part: BrainPart) =>
    `Brain ${part} changed elsewhere. Reload saved Brain values before applying this edit.`,
  mismatch: (part: BrainPart) =>
    `Brain ${part} did not match the saved configuration. Reload before retrying.`,
};
/** How model-pool and council validation is worded; English unless a page passes its own. */
export type BrainTargetWords = typeof englishTargetWords;
function wireTarget(value: BrainTarget, label: string, words: BrainTargetWords) {
  const model = value.model.trim(),
    provider = value.provider.trim();
  if (!model) throw Error(words.needsModel(label));
  return { ...(provider ? { provider } : {}), model };
}
export function brainTargetsWire(draft: BrainTargetsDraft, words = englishTargetWords) {
  if (!['fallback', 'round-robin'].includes(draft.strategy)) throw Error(words.strategy);
  return {
    models: draft.pool.length
      ? draft.pool.map((row, index) => wireTarget(row, words.pool(index + 1), words))
      : null,
    strategy: draft.strategy,
    seats: draft.seats.length
      ? draft.seats.map((row, index) => {
          const persona = row.persona.trim();
          if (!persona) throw Error(words.seatLens(index + 1));
          if (!['default', 'yes', 'no'].includes(row.veto)) throw Error(words.seatVeto);
          return { persona, ...(row.veto === 'default' ? {} : { veto: row.veto === 'yes' }) };
        })
      : null,
    voters: draft.voters.length
      ? draft.voters.map((row, index) => {
          const model = wireTarget(row, words.voter(index + 1), words),
            weight = row.weight === '' ? undefined : Number(row.weight);
          if (weight !== undefined && (!Number.isFinite(weight) || weight <= 0))
            throw Error(words.weight(index + 1));
          if (!['default', 'yes', 'no'].includes(row.veto)) throw Error(words.voterVeto);
          return {
            ...model,
            ...(row.persona.trim() ? { persona: row.persona.trim() } : {}),
            ...(weight === undefined ? {} : { weight }),
            ...(row.veto === 'default' ? {} : { veto: row.veto === 'yes' }),
          };
        })
      : null,
    judge:
      draft.judge.model.trim() || draft.judge.provider.trim()
        ? wireTarget(draft.judge, words.judge, words)
        : null,
  };
}
export function brainTargetsPatch(
  base: BrainTargetsDraft,
  draft: BrainTargetsDraft,
  live: BrainTargetsDraft,
  words = englishTargetWords,
): Record<string, unknown> {
  const before = brainTargetsWire(base, words),
    next = brainTargetsWire(draft, words),
    current = brainTargetsWire(live, words);
  const patch: Record<string, unknown> = {},
    council: Record<string, unknown> = {};
  for (const key of ['models', 'strategy', 'voters', 'seats', 'judge'] as const) {
    if (sameSetting(before[key], next[key])) continue;
    if (!sameSetting(before[key], current[key]) && !sameSetting(next[key], current[key]))
      throw Error(words.changed(key));
    if (key === 'models' || key === 'strategy') patch[key] = next[key];
    else council[key] = next[key];
  }
  if (Object.keys(council).length) patch['council'] = council;
  return patch;
}
export function mergeBrainPatches(
  policy: Record<string, unknown>,
  targets: Record<string, unknown>,
) {
  return {
    ...policy,
    ...targets,
    ...(policy['council'] || targets['council']
      ? { council: { ...record(policy['council']), ...record(targets['council']) } }
      : {}),
  };
}
export function verifyBrainTargets(
  patch: Record<string, unknown>,
  saved: Record<string, unknown>,
  words = englishTargetWords,
) {
  const wire = brainTargetsWire(brainTargetsDraft(saved), words);
  for (const key of ['models', 'strategy', 'voters', 'seats', 'judge'] as const) {
    const owner = key === 'models' || key === 'strategy' ? patch : record(patch['council']);
    if (Object.hasOwn(owner, key) && !sameSetting(owner[key], wire[key]))
      throw Error(words.mismatch(key));
  }
}
