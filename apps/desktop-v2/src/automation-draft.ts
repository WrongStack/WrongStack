import type { AutomationJobInput, AutomationJobRecord } from '@wrongstack/webui-protocol';
import type { FormDraftCodec } from './durable-form-draft';

/** One job's unsaved editor state; `selected` is the saved record the draft started from. */
export type AutomationDraft = {
  selected: AutomationJobRecord | null;
  draft: AutomationJobInput;
  commands: string;
};
/** Unsaved drafts of one project, keyed by job id or `@new`, and the job last open. */
export type SavedAutomationDrafts = { active: string; drafts: Record<string, AutomationDraft> };

export const NEW_AUTOMATION = '@new';
const MAX_DRAFTS = 50;
const MAX_BYTES = 1_000_000;
const UNSAFE = ['__proto__', 'constructor', 'prototype'];

/** In-window drafts, shared by every workspace instance of this window. */
export const activeDrafts = new Map<string, AutomationDraft>(),
  jobDrafts = new Map<string, AutomationDraft>();
export const automationDraftKey = (projectId: string, id?: string) =>
  JSON.stringify([projectId, id ?? NEW_AUTOMATION]);

/** The unsaved drafts this window holds for one project, or null when there are none. */
export function projectAutomationDrafts(
  projectId: string,
  activeId: string | undefined,
): SavedAutomationDrafts | null {
  const drafts: Record<string, AutomationDraft> = {};
  for (const [key, value] of jobDrafts) {
    const [owner, id] = JSON.parse(key) as [string, string];
    if (owner === projectId) drafts[id] = value;
  }
  return Object.keys(drafts).length
    ? { active: activeId ?? NEW_AUTOMATION, drafts: structuredClone(drafts) }
    : null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** Versioned, bounded envelope; a draft is only accepted under its own job id. */
export const automationDraftCodec: FormDraftCodec<SavedAutomationDrafts> = {
  serialize: (saved) => ({ version: 1, ...saved }),
  parse: (value) => {
    if (value === null) return null;
    const saved = value as Record<string, unknown>;
    const drafts = isRecord(saved) ? saved['drafts'] : undefined;
    const active = isRecord(saved) ? saved['active'] : undefined;
    const valid =
      isRecord(saved) &&
      saved['version'] === 1 &&
      typeof active === 'string' &&
      active.trim().length > 0 &&
      active.length <= 200 &&
      !UNSAFE.includes(active) &&
      isRecord(drafts) &&
      Object.keys(drafts).length <= MAX_DRAFTS &&
      JSON.stringify(saved).length <= MAX_BYTES &&
      Object.entries(drafts).every(([id, entry]) => {
        if (!id || id.length > 200 || UNSAFE.includes(id) || !isRecord(entry)) return false;
        const selected = entry['selected'];
        return (
          isRecord(entry['draft']) &&
          typeof entry['commands'] === 'string' &&
          (id === NEW_AUTOMATION ? selected === null : isRecord(selected) && selected['id'] === id)
        );
      });
    if (!valid) throw Error('Saved automation drafts have an unsupported format.');
    return structuredClone({
      active: active as string,
      drafts: drafts as Record<string, AutomationDraft>,
    });
  },
};
