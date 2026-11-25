import type { TodoItem } from './todo.js';

export interface AcpPlanEntry {
  content: string;
  priority: 'high' | 'medium' | 'low';
  status: TodoItem['status'];
}

export type AcpSessionPlan =
  | { type: 'items'; planId: string | null; entries: AcpPlanEntry[] }
  | { type: 'markdown'; planId: string; content: string };

export interface AcpChildSession {
  id: string;
  parentId: string;
  title: string | null;
  description: string | null;
  state: string;
  stopReason: string | null;
  output: string;
  message?: { senderId: string | null; text: string } | undefined;
  activity?: string | undefined;
}

/** ACP's own option identifiers and values; never coerce them to API-model effort levels. */
export type AcpRuntimeValues = Record<string, string>;
export type AcpRuntimeSelections = Record<string, AcpRuntimeValues>;
export interface AcpRuntimeOption {
  id: string;
  name: string;
  /** Runtime values are stored as strings, but this selector uses a JSON boolean on ACP. */
  type?: 'boolean' | undefined;
  category?: string | undefined;
  description?: string | undefined;
  currentValue: string;
  options: Array<{ value: string; name: string }>;
}
export type AcpRuntimeEdit = (current: AcpRuntimeOption[]) => {
  values: AcpRuntimeValues;
  save(): Promise<void>;
};
export interface AcpNativeRuntimeResult {
  options: AcpRuntimeOption[];
  unavailableRestores?: AcpRuntimeValues | undefined;
}
export interface AcpRuntimeCommand {
  name: string;
  description?: string | undefined;
  inputHint?: string | undefined;
}
export interface AcpRuntimeMode {
  id: string;
  name: string;
  description?: string | undefined;
}
export interface AcpNativeModeSelector extends AcpRuntimeOption {
  selectableValues: string[];
}
export interface AcpNativeModeChoice {
  optionId?: string | undefined;
  value: string;
}
export interface AcpRuntimeCapabilitiesSummary {
  image?: boolean | undefined;
  audio?: boolean | undefined;
  embeddedContext?: boolean | undefined;
  loadSession?: boolean | undefined;
  resume?: boolean | undefined;
  fork?: boolean | undefined;
  list?: boolean | undefined;
  additionalDirectories?: boolean | undefined;
  steering?: boolean | undefined;
}
export interface AcpRuntimeOptionsResult {
  agentId: string;
  options: AcpRuntimeOption[];
  applied: AcpRuntimeValues;
  commands?: AcpRuntimeCommand[] | undefined;
  modes?: AcpRuntimeMode[] | undefined;
  currentModeId?: string | null | undefined;
  capabilities?: AcpRuntimeCapabilitiesSummary | undefined;
}

const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
export function acpRuntimeValuesError(input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    return 'ACP values must be an object';
  const entries = Object.entries(input);
  if (entries.length > 32) return 'At most 32 ACP options may be selected';
  for (const [id, value] of entries) {
    if (
      !id.trim() ||
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
    if (!id.trim() || id.length > 200 || forbidden.has(id)) return 'Invalid ACP agent identifier';
    const error = acpRuntimeValuesError(values);
    if (error) return `${id}: ${error}`;
  }
  return undefined;
}
