/**
 * Settings catalog — a single typed list that describes every control the
 * SimpleUI SettingsPanel renders. Used by both the panel (to render rows in a
 * stable order) and by the search/filter input (to match user queries against
 * label, hint, keywords, and group title).
 *
 * Pure data, no React. The render component imports the catalog and decides
 * how each entry becomes JSX. That separation lets the filter operate on a
 * plain list and lets the renderer change shape without breaking search.
 *
 * Conventions:
 *   - `id` is stable across releases; it is the filter's primary handle.
 *   - `group` matches the visible `<h2>` heading (e.g. "Autonomy").
 *   - `keywords` are short, lowercase, single words that help search hit
 *     concepts the label/hint don't literally spell out (e.g. "permissions"
 *     for YOLO). At least one keyword per entry.
 *   - The order of `SETTINGS_GROUPS` and the order within each group
 *     determine the visible order in the panel — keep it stable.
 */

export type SettingsEntryKind =
  | 'segmented' // radio-group style choice (Autonomy modes)
  | 'toggle' // on/off switch (YOLO, Model reasoning, Chime, Confirm exit, Refine)
  | 'select' // single-select dropdown (Agent mode)
  | 'palette'; // colour palette swatch row (group of buttons)

export interface SettingsEntryBase {
  /** Stable id, never reused. Primary handle for tests and analytics. */
  id: string;
  /** Visible group heading; must match a SettingsGroup id below. */
  group: SettingsGroupId;
  /** User-facing title shown on the row. */
  label: string;
  /** User-facing explanation under the label. */
  hint: string;
  /** Lowercase single-word search terms that should match this row. */
  keywords: readonly string[];
  /** What kind of control the panel renders. */
  kind: SettingsEntryKind;
}

export interface SettingsGroup {
  id: SettingsGroupId;
  /** Visible heading text (also searched). */
  title: string;
}

export type SettingsGroupId = 'autonomy' | 'refine' | 'mode' | 'palette' | 'session';

/** Display order — keep stable so the panel never reshuffles rows. */
export const SETTINGS_GROUPS: readonly SettingsGroup[] = [
  { id: 'autonomy', title: 'Autonomy' },
  { id: 'refine', title: 'Refine' },
  { id: 'mode', title: 'Mode' },
  { id: 'palette', title: 'Color Palette' },
  { id: 'session', title: 'Session' },
];

export const SETTINGS_CATALOG: readonly SettingsEntry[] = [
  // ── Autonomy ────────────────────────────────────────────────────────
  {
    id: 'autonomy.mode',
    group: 'autonomy',
    label: 'Autonomy',
    hint: 'Choose how much the agent drives a turn.',
    keywords: ['autonomy', 'mode', 'agent', 'permission', 'control'],
    kind: 'segmented',
  },
  {
    id: 'autonomy.yolo',
    group: 'autonomy',
    label: 'YOLO',
    hint: 'Auto-approve tool permissions, including pending ones.',
    keywords: ['yolo', 'auto', 'approve', 'permission', 'tools'],
    kind: 'toggle',
  },

  // ── Refine ──────────────────────────────────────────────────────────
  {
    id: 'refine.enhanceEnabled',
    group: 'refine',
    label: 'Refine prompts',
    hint: 'Rewrite each message before sending, with a review step.',
    keywords: ['refine', 'enhance', 'rewrite', 'prompt', 'review'],
    kind: 'toggle',
  },

  // ── Mode ────────────────────────────────────────────────────────────
  {
    id: 'mode.agentMode',
    group: 'mode',
    label: 'Agent mode',
    hint: 'Pick the role the agent plays in this session.',
    keywords: ['mode', 'agent', 'role', 'preset'],
    kind: 'select',
  },

  // ── Color Palette ───────────────────────────────────────────────────
  {
    id: 'palette.color',
    group: 'palette',
    label: 'Color Palette',
    hint: 'Pick the main color accent for the interface.',
    keywords: ['palette', 'color', 'theme', 'accent', 'appearance'],
    kind: 'palette',
  },

  // ── Session ─────────────────────────────────────────────────────────
  {
    id: 'session.solo',
    group: 'session',
    label: 'Solo session',
    hint: 'Block Chimera, delegation, and every background subagent. Locks after the first message.',
    keywords: ['solo', 'subagent', 'chimera', 'delegate', 'background'],
    kind: 'toggle',
  },
  {
    id: 'session.showModelReasoning',
    group: 'session',
    label: 'Model reasoning',
    hint: "Show the model's thinking and reasoning in the chat.",
    keywords: ['reasoning', 'thinking', 'model', 'show', 'chat'],
    kind: 'toggle',
  },
  {
    id: 'session.chime',
    group: 'session',
    label: 'Chime',
    hint: 'Play a sound when a run finishes.',
    keywords: ['chime', 'sound', 'audio', 'notification', 'finish'],
    kind: 'toggle',
  },
  {
    id: 'session.confirmExit',
    group: 'session',
    label: 'Confirm exit',
    hint: 'Ask before quitting with a run in flight.',
    keywords: ['exit', 'quit', 'confirm', 'safety'],
    kind: 'toggle',
  },
] as const;

export type SettingsEntry = SettingsEntryBase;

/** Group the catalog into a render-ready ordered map. */
export function groupCatalog(): readonly { group: SettingsGroup; entries: readonly SettingsEntry[] }[] {
  return SETTINGS_GROUPS.map((group) => ({
    group,
    entries: SETTINGS_CATALOG.filter((entry) => entry.group === group.id),
  }));
}

/**
 * Match predicate: returns true if `query` (case-insensitive, trimmed) appears
 * in the entry's label, hint, keywords, or group title. Empty/whitespace query
 * matches everything.
 */
export function matchesQuery(entry: SettingsEntry, groupTitle: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return true;
  if (entry.label.toLowerCase().includes(q)) return true;
  if (entry.hint.toLowerCase().includes(q)) return true;
  if (groupTitle.toLowerCase().includes(q)) return true;
  for (const keyword of entry.keywords) {
    if (keyword.includes(q)) return true;
  }
  return false;
}
