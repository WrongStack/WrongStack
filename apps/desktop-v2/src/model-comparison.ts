import { compactCount, type PickerModel } from './model-picker-details';

/** More columns stop fitting the picker dialog; the user narrows the set instead. */
export const MAX_COMPARED_MODELS = 4;

export interface ComparisonCell {
  text: string;
  /** Best known value in this row (largest limit, lowest price); never set on unknown values. */
  best: boolean;
}
export interface ComparisonRow {
  label: string;
  cells: ComparisonCell[];
}

const CAPABILITY_LABELS: Record<string, string> = {
  tools: 'Tools',
  reasoning: 'Reasoning',
  vision: 'Images',
  open_weights: 'Open weights',
};

/** Adds or removes a model; adding past the limit is refused rather than dropping another. */
export function toggleCompared(ids: readonly string[], id: string): string[] {
  if (ids.includes(id)) return ids.filter((item) => item !== id);
  if (ids.length >= MAX_COMPARED_MODELS)
    throw Error(`Compare at most ${MAX_COMPARED_MODELS} models at a time.`);
  return [...ids, id];
}

function numericRow(
  label: string,
  values: (number | undefined)[],
  format: (value: number) => string,
  better: 'high' | 'low',
): ComparisonRow {
  const known = values.filter((value): value is number => value !== undefined);
  const target =
    known.length > 1 && new Set(known).size > 1
      ? better === 'high'
        ? Math.max(...known)
        : Math.min(...known)
      : undefined;
  return {
    label,
    cells: values.map((value) => ({
      text: value === undefined ? 'Unknown' : format(value),
      best: value !== undefined && value === target,
    })),
  };
}

/**
 * Side-by-side rows of the catalog facts the engine reported. Unknown facts read "Unknown";
 * a "best" mark needs at least two known, differing values. A price of 0 reads as
 * "$0" because only both prices at 0 mean "no catalog price" for a single model.
 */
export function comparisonRows(models: readonly PickerModel[]): ComparisonRow[] {
  const price = (value: number) => `$${value}`;
  const rows = [
    numericRow(
      'Context',
      models.map((model) => model.contextWindow),
      compactCount,
      'high',
    ),
    numericRow(
      'Output',
      models.map((model) => model.maxOutput),
      compactCount,
      'high',
    ),
    numericRow(
      'Input / 1M',
      models.map((model) => model.inputCost),
      price,
      'low',
    ),
    numericRow(
      'Output / 1M',
      models.map((model) => model.outputCost),
      price,
      'low',
    ),
  ];
  const capabilities = [...new Set(models.flatMap((model) => model.capabilities))];
  for (const capability of capabilities)
    rows.push({
      label: CAPABILITY_LABELS[capability] ?? capability,
      cells: models.map((model) => ({
        text: model.capabilities.includes(capability) ? 'Yes' : 'Not reported',
        best: false,
      })),
    });
  if (models.some((model) => model.status && model.status !== 'active'))
    rows.push({
      label: 'Status',
      cells: models.map((model) => ({ text: model.status ?? 'Unknown', best: false })),
    });
  return rows;
}
