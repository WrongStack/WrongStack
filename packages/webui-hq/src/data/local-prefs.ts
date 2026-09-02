/**
 * Local preferences store for the HQ React app.
 *
 * A minimal, framework-free, SSR-safe wrapper over `localStorage` that
 * exposes a tiny subset of `LocalPrefs` the HQ dashboard needs to remember:
 *
 *   - the last command type selected in Control
 *   - the last abort target and spawn role
 *   - the last steer "to" / subject / body so the operator can re-edit
 *     the same steer without retyping
 *   - the Mailbox live filter query + selected types / priorities
 *
 * Kept deliberately tiny — only HQ UI affordances, no settings/TUI/state
 * duplication. Persists under a single key (`wrongstack.hq.local-prefs.v1`)
 * so we can bump the key when the shape changes without colliding with
 * the rest of the app's `wrongstack-local-prefs` zustand store.
 */
import { useSyncExternalStore } from 'react';

/** Theme choice. `system` follows the OS `prefers-color-scheme`. */
export type HqThemeChoice = 'dark' | 'light' | 'system';

/**
 * Optional accent palette layered on top of light/dark. The ids match
 * `packages/webui` exactly, because both surfaces read the same
 * `[data-palette]` token blocks; `signal` is the default and has no block.
 */
export type HqPaletteId =
  | 'signal'
  | 'emerald-gold'
  | 'blue-navy'
  | 'purple-pink'
  | 'cyan-teal'
  | 'rose-copper'
  | 'indigo-amber'
  | 'sage-sand'
  | 'slate-violet'
  | 'coral-mint'
  | 'arctic-ember'
  | 'moss-rust';

export const HQ_PALETTE_IDS: readonly HqPaletteId[] = [
  'signal',
  'emerald-gold',
  'blue-navy',
  'purple-pink',
  'cyan-teal',
  'rose-copper',
  'indigo-amber',
  'sage-sand',
  'slate-violet',
  'coral-mint',
  'arctic-ember',
  'moss-rust',
];

export interface HqLocalPrefs {
  appearance: {
    theme: HqThemeChoice;
    palette: HqPaletteId;
  };
  fleet: {
    scope: 'all' | 'machine' | 'project';
    layout: 'map' | 'compact';
    machineId: string;
    projectId: string;
  };
  console: {
    delivery: 'steer' | 'btw' | 'queue';
    subject: string;
    body: string;
  };
  control: {
    cmdType: 'steer' | 'btw' | 'queue' | 'abort' | 'spawn' | 'broadcast' | 'run-command';
    abortTarget: 'leader' | 'fleet';
    spawnRole: string;
    /** Spawn's initial-task draft — separate from steerBody so composing a
     *  spawn doesn't clobber an in-progress steer message (they used to
     *  share one field). */
    spawnTask: string;
    steerTo: string;
    steerSubject: string;
    steerBody: string;
    broadcastSubject: string;
    broadcastBody: string;
  };
  mailbox: {
    query: string;
    types: string[];
    priorities: string[];
    includeCompleted: boolean;
  };
}

const STORAGE_KEY = 'wrongstack.hq.local-prefs.v1';

const DEFAULT_PREFS: HqLocalPrefs = {
  appearance: {
    theme: 'dark',
    palette: 'signal',
  },
  fleet: {
    scope: 'all',
    layout: 'map',
    machineId: '',
    projectId: '',
  },
  console: {
    delivery: 'steer',
    subject: '',
    body: '',
  },
  control: {
    cmdType: 'steer',
    abortTarget: 'leader',
    spawnRole: 'bug-hunter',
    spawnTask: '',
    steerTo: 'leader',
    steerSubject: '',
    steerBody: '',
    broadcastSubject: '',
    broadcastBody: '',
  },
  mailbox: {
    query: '',
    types: [],
    priorities: [],
    includeCompleted: true,
  },
};

let cached: HqLocalPrefs | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

function deepClone<T>(value: T): T {
  // structuredClone is available in modern browsers + Node 17+; jsdom too.
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function loadFromStorage(): HqLocalPrefs {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
    return deepClone(DEFAULT_PREFS);
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return deepClone(DEFAULT_PREFS);
    const parsed = JSON.parse(raw) as unknown;
    return mergeWithDefaults(parsed);
  } catch {
    return deepClone(DEFAULT_PREFS);
  }
}

function mergeWithDefaults(input: unknown): HqLocalPrefs {
  if (!isPlainObject(input)) return deepClone(DEFAULT_PREFS);
  const appearance = isPlainObject(input['appearance']) ? input['appearance'] : {};
  const fleet = isPlainObject(input['fleet']) ? input['fleet'] : {};
  const consolePrefs = isPlainObject(input['console']) ? input['console'] : {};
  const ctl = isPlainObject(input['control']) ? input['control'] : {};
  const mb = isPlainObject(input['mailbox']) ? input['mailbox'] : {};
  const merged: HqLocalPrefs = {
    appearance: {
      theme:
        appearance['theme'] === 'light' || appearance['theme'] === 'system'
          ? appearance['theme']
          : 'dark',
      palette: HQ_PALETTE_IDS.includes(appearance['palette'] as HqPaletteId)
        ? (appearance['palette'] as HqPaletteId)
        : 'signal',
    },
    fleet: {
      scope:
        fleet['scope'] === 'machine' || fleet['scope'] === 'project'
          ? fleet['scope']
          : 'all',
      layout: fleet['layout'] === 'compact' ? 'compact' : 'map',
      machineId: typeof fleet['machineId'] === 'string' ? fleet['machineId'] : '',
      projectId: typeof fleet['projectId'] === 'string' ? fleet['projectId'] : '',
    },
    console: {
      delivery:
        consolePrefs['delivery'] === 'btw' || consolePrefs['delivery'] === 'queue'
          ? consolePrefs['delivery']
          : 'steer',
      subject: typeof consolePrefs['subject'] === 'string' ? consolePrefs['subject'] : '',
      body: typeof consolePrefs['body'] === 'string' ? consolePrefs['body'] : '',
    },
    control: {
      cmdType:
        ctl['cmdType'] === 'btw' ||
        ctl['cmdType'] === 'queue' ||
        ctl['cmdType'] === 'abort' ||
        ctl['cmdType'] === 'spawn' ||
        ctl['cmdType'] === 'broadcast' ||
        ctl['cmdType'] === 'run-command'
          ? ctl['cmdType']
          : DEFAULT_PREFS.control.cmdType,
      abortTarget: ctl['abortTarget'] === 'fleet' ? 'fleet' : 'leader',
      spawnRole:
        typeof ctl['spawnRole'] === 'string' && ctl['spawnRole'].length > 0
          ? ctl['spawnRole']
          : DEFAULT_PREFS.control.spawnRole,
      spawnTask:
        typeof ctl['spawnTask'] === 'string' ? ctl['spawnTask'] : DEFAULT_PREFS.control.spawnTask,
      steerTo: typeof ctl['steerTo'] === 'string' ? ctl['steerTo'] : DEFAULT_PREFS.control.steerTo,
      steerSubject:
        typeof ctl['steerSubject'] === 'string'
          ? ctl['steerSubject']
          : DEFAULT_PREFS.control.steerSubject,
      steerBody:
        typeof ctl['steerBody'] === 'string' ? ctl['steerBody'] : DEFAULT_PREFS.control.steerBody,
      broadcastSubject:
        typeof ctl['broadcastSubject'] === 'string'
          ? ctl['broadcastSubject']
          : DEFAULT_PREFS.control.broadcastSubject,
      broadcastBody:
        typeof ctl['broadcastBody'] === 'string'
          ? ctl['broadcastBody']
          : DEFAULT_PREFS.control.broadcastBody,
    },
    mailbox: {
      query: typeof mb['query'] === 'string' ? mb['query'] : DEFAULT_PREFS.mailbox.query,
      types: Array.isArray(mb['types'])
        ? (mb['types'] as unknown[]).filter((x): x is string => typeof x === 'string')
        : [],
      priorities: Array.isArray(mb['priorities'])
        ? (mb['priorities'] as unknown[]).filter((x): x is string => typeof x === 'string')
        : [],
      includeCompleted: typeof mb['includeCompleted'] === 'boolean' ? mb['includeCompleted'] : true,
    },
  };
  return merged;
}

function ensureLoaded(): HqLocalPrefs {
  if (cached === null) cached = loadFromStorage();
  return cached;
}

function writeToStorage(prefs: HqLocalPrefs): void {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    /* best-effort: quota / private mode */
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): HqLocalPrefs {
  return ensureLoaded();
}

function getServerSnapshot(): HqLocalPrefs {
  return DEFAULT_PREFS;
}

export function useHqLocalPrefs(): HqLocalPrefs {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export function setHqControlPrefs(patch: Partial<HqLocalPrefs['control']>): void {
  const next = ensureLoaded();
  cached = { ...next, control: { ...next.control, ...patch } };
  writeToStorage(cached);
  notify();
}

export function setHqAppearancePrefs(patch: Partial<HqLocalPrefs['appearance']>): void {
  const next = ensureLoaded();
  cached = { ...next, appearance: { ...next.appearance, ...patch } };
  writeToStorage(cached);
  notify();
}

export function setHqFleetPrefs(patch: Partial<HqLocalPrefs['fleet']>): void {
  const next = ensureLoaded();
  cached = { ...next, fleet: { ...next.fleet, ...patch } };
  writeToStorage(cached);
  notify();
}

export function setHqConsolePrefs(patch: Partial<HqLocalPrefs['console']>): void {
  const next = ensureLoaded();
  cached = { ...next, console: { ...next.console, ...patch } };
  writeToStorage(cached);
  notify();
}

export function setHqMailboxPrefs(patch: Partial<HqLocalPrefs['mailbox']>): void {
  const next = ensureLoaded();
  cached = { ...next, mailbox: { ...next.mailbox, ...patch } };
  writeToStorage(cached);
  notify();
}

export function getHqLocalPrefsSnapshot(): HqLocalPrefs {
  return ensureLoaded();
}

export function resetHqLocalPrefs(): void {
  cached = deepClone(DEFAULT_PREFS);
  writeToStorage(cached);
  notify();
}

/**
 * Reload prefs from `localStorage`. Tests use this after seeding storage
 * directly; production code should prefer `setHqControlPrefs` /
 * `setHqMailboxPrefs`.
 */
export function reloadHqLocalPrefs(): void {
  cached = loadFromStorage();
  notify();
}

export const __test__ = { STORAGE_KEY, DEFAULT_PREFS };
