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
  if (value >= 1_000_000) return `${+(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${+(value / 1_000).toFixed(1)}K`;
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
export function modelDetailLine(model: PickerModel): string {
  const parts: string[] = [];
  if (model.contextWindow) parts.push(`${compactCount(model.contextWindow)} context`);
  if (model.maxOutput) parts.push(`${compactCount(model.maxOutput)} output`);
  if (model.inputCost !== undefined && model.outputCost !== undefined)
    parts.push(
      model.inputCost === 0 && model.outputCost === 0
        ? 'no catalog price'
        : `$${model.inputCost} / $${model.outputCost} per 1M`,
    );
  const capabilities = model.capabilities.map((item) => CAPABILITY_LABELS[item] ?? item);
  if (capabilities.length) parts.push(capabilities.join(', '));
  if (model.status && model.status !== 'active') parts.push(model.status);
  return parts.join(' · ');
}
