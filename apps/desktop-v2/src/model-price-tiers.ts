import { englishText } from './desktop-text';
import { record } from './engine-values';

export const tierPriceFields = [
  ['input', 'Input'],
  ['output', 'Output'],
  ['cache_read', 'Cache read'],
  ['cache_write', 'Cache write'],
  ['cache_write_5m', '5 minute cache write'],
  ['cache_write_1h', '1 hour cache write'],
  ['reasoning', 'Reasoning'],
  ['input_audio', 'Audio input'],
  ['output_audio', 'Audio output'],
] as const;
export interface PriceTierDraft {
  source: unknown;
  editable: boolean;
  size: string;
  prices: Record<string, string>;
}
export interface ModelPriceTiersDraft {
  changed: boolean;
  unsupported: boolean;
  rows: PriceTierDraft[];
}
export function priceTierDraft(source?: unknown): PriceTierDraft {
  const row = record(source),
    tier = record(row['tier']);
  const editable =
    source === undefined ||
    (tier['type'] === 'context' &&
      tierPriceFields.some(([key]) => typeof row[key] === 'number') &&
      Number.isSafeInteger(tier['size']) &&
      Number(tier['size']) > 0 &&
      tierPriceFields.every(
        ([key]) =>
          row[key] === undefined ||
          (typeof row[key] === 'number' && Number.isFinite(row[key]) && row[key] >= 0),
      ));
  return {
    source,
    editable,
    size: typeof tier['size'] === 'number' ? String(tier['size']) : '',
    prices: Object.fromEntries(
      tierPriceFields.map(([key]) => [key, typeof row[key] === 'number' ? String(row[key]) : '']),
    ),
  };
}
export function modelPriceTiersDraft(cost: Record<string, unknown>): ModelPriceTiersDraft {
  return {
    changed: false,
    unsupported: cost['tiers'] !== undefined && !Array.isArray(cost['tiers']),
    rows: Array.isArray(cost['tiers']) ? cost['tiers'].map(priceTierDraft) : [],
  };
}
export function applyModelPriceTiers(md: Record<string, unknown>, draft: ModelPriceTiersDraft) {
  if (!draft.changed) return;
  if (draft.unsupported) throw Error(englishText('settingsMessage', 'tierFormat'));
  const seen = new Set<number>();
  const tiers = draft.rows.map((row, index) => {
    if (!row.editable) return row.source;
    const size = Number(row.size);
    if (!row.size.trim() || !Number.isSafeInteger(size) || size <= 0)
      throw Error(englishText('settingsMessage', 'tierThreshold', { n: index + 1 }));
    if (seen.has(size)) throw Error(englishText('settingsMessage', 'tierUnique'));
    seen.add(size);
    const next: Record<string, unknown> = {
      ...record(row.source),
      tier: { ...record(record(row.source)['tier']), type: 'context', size },
    };
    for (const [key, label] of tierPriceFields) {
      const raw = row.prices[key]?.trim();
      if (!raw) delete next[key];
      else {
        const value = Number(raw);
        if (!Number.isFinite(value) || value < 0)
          throw Error(
            englishText('settingsMessage', 'tierPrice', {
              n: index + 1,
              field: label.toLowerCase(),
            }),
          );
        next[key] = value;
      }
    }
    if (!tierPriceFields.some(([key]) => typeof next[key] === 'number'))
      throw Error(englishText('settingsMessage', 'tierEmpty', { n: index + 1 }));
    return next;
  });
  const cost = { ...record(md['cost']) };
  if (tiers.length) cost['tiers'] = tiers;
  else delete cost['tiers'];
  if (Object.keys(cost).length) md['cost'] = cost;
  else delete md['cost'];
}
