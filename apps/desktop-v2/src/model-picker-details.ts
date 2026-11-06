import { displayDecimal } from './display-dates';
/** Catalog facts the engine returns for one model; any of them may be unknown. */
export interface PickerModel {
  id: string;
  name: string;
  contextWindow?: number;
  maxOutput?: number;
  inputCost?: number;
  outputCost?: number;
  capabilities: string[];
  status?: string;
}

const positive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;
const price = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** Reads one `provider.models` entry, keeping only well-formed facts. */
export function pickerModel(raw: Record<string, unknown>): PickerModel {
  return {
    id: String(raw['id']),
    name: String(raw['name'] ?? raw['id']),
    ...(positive(raw['contextWindow']) ? { contextWindow: raw['contextWindow'] } : {}),
    ...(positive(raw['maxOutput']) ? { maxOutput: raw['maxOutput'] } : {}),
    ...(price(raw['inputCost']) ? { inputCost: raw['inputCost'] } : {}),
    ...(price(raw['outputCost']) ? { outputCost: raw['outputCost'] } : {}),
    capabilities: Array.isArray(raw['capabilities'])
      ? (raw['capabilities'] as unknown[]).filter(
          (item): item is string => typeof item === 'string',
        )
      : [],
    ...(typeof raw['status'] === 'string' && raw['status'] ? { status: raw['status'] } : {}),
  };
}

/** 1,000,000 → "1M", 200,000 → "200K", 8,192 → "8.2K". */
export function compactCount(value: number): string {
  if (value >= 1_000_000) return `${displayDecimal(value / 1_000_000, 1, true)}M`;
  if (value >= 1_000) return `${displayDecimal(value / 1_000, 1, true)}K`;
  return String(value);
}

const CAPABILITY_LABELS: Record<string, string> = {
  tools: 'tools',
  reasoning: 'reasoning',
  vision: 'images',
  open_weights: 'open weights',
};

/**
 * One short line of known catalog facts; unknown facts are left out rather than shown as zero.
 * Prices are the catalog's USD per million input/output tokens.
 */
export const MODEL_DETAIL_WORDS = {
  context: (value: string) => `${value} context`,
  output: (value: string) => `${value} output`,
  noPrice: () => 'no catalog price',
  price: (input: number, output: number) => `$${input} / $${output} per 1M`,
  capability: (id: string) => CAPABILITY_LABELS[id] ?? id,
};
/** How the detail line is worded; the desktop passes the display-language catalog. */
export type ModelDetailWords = typeof MODEL_DETAIL_WORDS;

export function modelDetailLine(
  model: PickerModel,
  words: ModelDetailWords = MODEL_DETAIL_WORDS,
): string {
  const parts: string[] = [];
  if (model.contextWindow) parts.push(words.context(compactCount(model.contextWindow)));
  if (model.maxOutput) parts.push(words.output(compactCount(model.maxOutput)));
  if (model.inputCost !== undefined && model.outputCost !== undefined)
    parts.push(
      model.inputCost === 0 && model.outputCost === 0
        ? words.noPrice()
        : words.price(model.inputCost, model.outputCost),
    );
  const capabilities = model.capabilities.map(words.capability);
  if (capabilities.length) parts.push(capabilities.join(', '));
  if (model.status && model.status !== 'active') parts.push(model.status);
  return parts.join(' · ');
}
