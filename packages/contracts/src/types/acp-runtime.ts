/** ACP's own option identifiers and values; never coerce them to API-model effort levels. */
export type AcpRuntimeValues = Record<string, string>;
export type AcpRuntimeSelections = Record<string, AcpRuntimeValues>;
export interface AcpRuntimeOption {
  id: string;
  name: string;
  category?: string | undefined;
  description?: string | undefined;
  currentValue: string;
  options: Array<{ value: string; name: string }>;
}
export interface AcpRuntimeOptionsResult {
  agentId: string;
  options: AcpRuntimeOption[];
  applied: AcpRuntimeValues;
}

const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
export function acpRuntimeValuesError(input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    return 'ACP values must be an object';
  const entries = Object.entries(input);
  if (entries.length > 32) return 'At most 32 ACP options may be selected';
  for (const [id, value] of entries) {
    if (
      !id ||
      id.length > 200 ||
      forbidden.has(id) ||
      typeof value !== 'string' ||
      value.length > 2000
    )
      return 'ACP option identifiers and values must be bounded strings';
  }
  return undefined;
}
export function acpRuntimeSelectionsError(input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    return 'ACP settings must be an object';
  if (Object.keys(input).length > 64) return 'At most 64 ACP agents may be configured';
  for (const [id, values] of Object.entries(input)) {
    if (!id || id.length > 200 || forbidden.has(id)) return 'Invalid ACP agent identifier';
    const error = acpRuntimeValuesError(values);
    if (error) return `${id}: ${error}`;
  }
  return undefined;
}
