import { entries, record } from './engine-values';
import {
  applyModelAdvanced,
  type ModelAdvancedDraft,
  modelAdvancedDraft,
} from './model-advanced-editor';
import {
  applyModelPriceTiers,
  type ModelPriceTiersDraft,
  modelPriceTiersDraft,
} from './model-price-tiers';

export const modelTextFields = [
  ['name', 'Display name'],
  ['description', 'Description'],
  ['family', 'Model family'],
  ['knowledge', 'Knowledge cutoff'],
  ['release_date', 'Release date'],
  ['last_updated', 'Last updated'],
] as const;
/**
 * The catalog writes dates as `YYYY-MM` or `YYYY-MM-DD` (both occur for every date field):
 * each edits in the picker of its own shape, anything else as the text it is.
 */
export function modelTextInputType(key: string, value: string): 'text' | 'month' | 'date' {
  if (key !== 'knowledge' && key !== 'release_date' && key !== 'last_updated') return 'text';
  if (/^\d{4}-\d{2}$/.test(value)) return 'month';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'date';
  return value ? 'text' : key === 'knowledge' ? 'month' : 'date';
}
export const modelNumberFields = [
  ['limit', 'context', 'Context tokens'],
  ['limit', 'input', 'Maximum input tokens'],
  ['limit', 'output', 'Maximum output tokens'],
  ['cost', 'input', 'Input USD / million tokens'],
  ['cost', 'output', 'Output USD / million tokens'],
  ['cost', 'cache_read', 'Cache read USD / million tokens'],
  ['cost', 'cache_write', 'Cache write USD / million tokens'],
  ['cost', 'cache_write_5m', '5 minute cache write USD / million tokens'],
  ['cost', 'cache_write_1h', '1 hour cache write USD / million tokens'],
  ['cost', 'context_over_200k', 'Over 200k context USD / million tokens'],
  ['cost', 'reasoning', 'Reasoning USD / million tokens'],
  ['cost', 'input_audio', 'Audio input USD / million tokens'],
  ['cost', 'output_audio', 'Audio output USD / million tokens'],
] as const;
export const modelFlags = [
  ['tool_call', 'Tool calls'],
  ['reasoning', 'Reasoning'],
  ['temperature', 'Temperature control'],
  ['attachment', 'Attachments'],
  ['structured_output', 'Structured output'],
  ['open_weights', 'Open weights'],
] as const;
export interface ModelEditorDraft {
  id: string;
  text: Record<string, string>;
  numbers: Record<string, string>;
  flags: Record<string, string>;
  input: string;
  output: string;
  advanced: ModelAdvancedDraft;
  pricing: ModelPriceTiersDraft;
}
export function modelEditorDraft(
  id: string,
  definition: Record<string, unknown>,
): ModelEditorDraft {
  const md = record(definition['modelsDev']);
  const caps = record(definition['capabilities']);
  const legacyFlags: Record<string, unknown> = {
    tool_call: caps['tools'],
    reasoning: caps['reasoning'],
  };
  const legacyNumbers: Record<string, unknown> = {
    'limit.context': caps['maxContext'],
    'limit.output': definition['maxOutput'] ?? caps['maxOutput'],
  };
  const str = (value: unknown) =>
    typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  return {
    id,
    advanced: modelAdvancedDraft(md),
    pricing: modelPriceTiersDraft(record(md['cost'])),
    text: Object.fromEntries(
      modelTextFields.map(([key]) => [
        key,
        str(md[key] ?? (key === 'name' ? definition['name'] : undefined)),
      ]),
    ),
    numbers: Object.fromEntries(
      modelNumberFields.map(([group, key]) => [
        `${group}.${key}`,
        str(record(md[group])[key] ?? legacyNumbers[`${group}.${key}`]),
      ]),
    ),
    flags: Object.fromEntries(
      modelFlags.map(([key]) => {
        const value = md[key] ?? legacyFlags[key];
        return [key, typeof value === 'boolean' ? String(value) : 'inherit'];
      }),
    ),
    input: Array.isArray(record(md['modalities'])['input'])
      ? (record(md['modalities'])['input'] as string[]).join(', ')
      : '',
    output: Array.isArray(record(md['modalities'])['output'])
      ? (record(md['modalities'])['output'] as string[]).join(', ')
      : '',
  };
}
/** Author supported catalog fields while retaining unedited provider-specific metadata. */
export function buildModelDefinition(draft: ModelEditorDraft, initial: Record<string, unknown>) {
  const id = draft.id.trim();
  if (
    !id ||
    id.length > 256 ||
    ['constructor', 'prototype', '__proto__'].includes(id) ||
    /[\u0000-\u001f]/.test(id)
  )
    throw Error('Enter a valid model ID.');
  if (!draft.text['name']?.trim()) throw Error('Enter a display name.');
  const md = { ...record(initial['modelsDev']) };
  applyModelAdvanced(md, draft.advanced);
  for (const [key] of modelTextFields) {
    const value = draft.text[key]?.trim();
    if (value) md[key] = value;
    else delete md[key];
  }
  for (const [group, key, label] of modelNumberFields) {
    const object = { ...record(md[group]) };
    const raw = draft.numbers[`${group}.${key}`]?.trim();
    if (!raw) {
      // Structured upstream rates cannot be represented by the legacy scalar input.
      if (group !== 'cost' || typeof object[key] !== 'object' || object[key] === null)
        delete object[key];
    } else {
      const value = Number(raw);
      if (
        !Number.isFinite(value) ||
        value < 0 ||
        (group === 'limit' && (!Number.isSafeInteger(value) || value === 0))
      )
        throw Error(
          `${label} must be a ${group === 'limit' ? 'positive integer' : 'non-negative number'}.`,
        );
      object[key] = value;
    }
    if (Object.keys(object).length) md[group] = object;
    else delete md[group];
  }
  applyModelPriceTiers(md, draft.pricing);
  for (const [key] of modelFlags) {
    if (draft.flags[key] === 'inherit') delete md[key];
    else md[key] = draft.flags[key] === 'true';
  }
  const modalities = { ...record(md['modalities']) };
  for (const [key, text] of [
    ['input', draft.input],
    ['output', draft.output],
  ]) {
    const values = [
      ...new Set(
        text!
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    ];
    if (values.length) modalities[key!] = values;
    else delete modalities[key!];
  }
  if (Object.keys(modalities).length) md['modalities'] = modalities;
  else delete md['modalities'];
  const definition: Record<string, unknown> = { ...initial, modelsDev: md };
  // Keep legacy fields in sync: runtime consumers still consult these overlays.
  definition['name'] = md['name'];
  const capabilities = { ...record(initial['capabilities']) };
  for (const [legacy, key] of [
    ['tools', 'tool_call'],
    ['reasoning', 'reasoning'],
  ]) {
    if (typeof md[key!] === 'boolean') capabilities[legacy!] = md[key!];
    else delete capabilities[legacy!];
  }
  for (const [legacy, key] of [
    ['maxContext', 'context'],
    ['maxOutput', 'output'],
  ]) {
    const value = record(md['limit'])[key!];
    if (typeof value === 'number') capabilities[legacy!] = value;
    else delete capabilities[legacy!];
  }
  if (typeof record(md['limit'])['output'] === 'number')
    definition['maxOutput'] = record(md['limit'])['output'];
  else delete definition['maxOutput'];
  if (Object.keys(capabilities).length) definition['capabilities'] = capabilities;
  else delete definition['capabilities'];
  return { id, definition };
}
export function savedModelProvider(payload: Record<string, unknown>, providerId: string) {
  return entries(payload['providers']).find((item) => item['id'] === providerId);
}
export function modelDefinition(provider: Record<string, unknown> | undefined, id: string) {
  const definitions = record(provider?.['customModels']);
  return Object.hasOwn(definitions, id) ? record(definitions[id]) : undefined;
}
export function containsModelDefinition(
  actual: unknown,
  expected: Record<string, unknown>,
): boolean {
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false;
  return Object.entries(expected).every(([key, value]) =>
    containsModelValue((actual as Record<string, unknown>)[key], value),
  );
}
function containsModelValue(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((value, index) => containsModelValue(actual[index], value))
    );
  if (expected && typeof expected === 'object')
    return containsModelDefinition(actual, expected as Record<string, unknown>);
  return Object.is(actual, expected);
}
