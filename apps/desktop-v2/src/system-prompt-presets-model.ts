import { entries, record } from './engine-values';

export const PROMPT_VARIANTS = ['lite', 'default', 'pro', 'scout', 'quick'] as const;
export type PromptVariant = (typeof PROMPT_VARIANTS)[number];
export const variantNames: Record<PromptVariant, string> = {
  lite: 'Lite',
  default: 'Standard',
  pro: 'Pro',
  scout: 'Scout',
  quick: 'Quick',
};

export interface PromptPreset {
  id: string;
  name: string;
  baseVariant: PromptVariant;
  text: string;
  revision: number;
  /** The built-in text this preset was based on changed since it was last saved. */
  sourceChanged: boolean;
  currentBaseText: string;
  baseText: string;
}

export interface PromptPresetIssue {
  severity: 'error' | 'warning';
  line: number;
  message: string;
}

const isVariant = (value: unknown): value is PromptVariant =>
  PROMPT_VARIANTS.includes(value as PromptVariant);

const selection = (value: unknown) =>
  Object.fromEntries(
    Object.entries(record(value)).filter(
      (entry): entry is [PromptVariant, string] =>
        isVariant(entry[0]) && typeof entry[1] === 'string',
    ),
  ) as Partial<Record<PromptVariant, string>>;

/** The engine's `system_prompt.presets` reply. */
export function promptPresets(value: unknown): {
  presets: PromptPreset[];
  active: Partial<Record<PromptVariant, string>>;
  projectActive: Partial<Record<PromptVariant, string>>;
  selectedId: string;
} {
  const reply = record(value);
  return {
    presets: entries(reply['presets'])
      .filter((row) => typeof row['id'] === 'string' && isVariant(row['baseVariant']))
      .map((row) => ({
        id: String(row['id']),
        name: String(row['name'] ?? row['id']),
        baseVariant: row['baseVariant'] as PromptVariant,
        text: String(row['text'] ?? ''),
        revision: typeof row['revision'] === 'number' ? row['revision'] : 0,
        sourceChanged: row['sourceChanged'] === true,
        currentBaseText: String(row['currentBaseText'] ?? ''),
        baseText: String(row['baseText'] ?? ''),
      })),
    active: selection(reply['active']),
    projectActive: selection(reply['projectActive']),
    selectedId: typeof reply['selectedId'] === 'string' ? reply['selectedId'] : '',
  };
}

export function promptIssues(value: unknown): PromptPresetIssue[] {
  return entries(record(value)['issues']).map((issue) => ({
    severity: issue['severity'] === 'error' ? 'error' : 'warning',
    line: typeof issue['line'] === 'number' ? issue['line'] : 1,
    message: String(issue['message'] ?? ''),
  }));
}

/** Which preset a variant uses here: a project selection wins over the profile one. */
export function effectivePreset(
  variant: PromptVariant,
  active: Partial<Record<PromptVariant, string>>,
  projectActive: Partial<Record<PromptVariant, string>>,
): { id: string; scope: 'project' | 'profile' | 'built-in' } {
  if (projectActive[variant]) return { id: projectActive[variant]!, scope: 'project' };
  if (active[variant]) return { id: active[variant]!, scope: 'profile' };
  return { id: '', scope: 'built-in' };
}
