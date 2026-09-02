import { listContextWindowModes } from '@wrongstack/core/types';
import { atomicWrite } from '@wrongstack/core/utils';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Custom context modes — user-defined presets that are loaded from disk,
 * merged with the built-in modes, and managed via WebSocket CRUD handlers.
 *
 * Stored in: ~/.wrongstack/profiles/<name>/custom-context-modes.json
 * Format: { "modes": ContextWindowMode[] }
 */

export interface CustomContextMode {
  id: string;
  name: string;
  description: string;
  thresholds: { warn: number; soft: number; hard: number };
  aggressiveOn: string;
  preserveK: number;
  eliseThreshold: number;
  targetLoad: number;
  /** Whether this is a user-defined (custom) or built-in mode. */
  custom: boolean;
}

export interface CustomModeStore {
  modes: Map<string, CustomContextMode>;
  load: () => Promise<void>;
  save: () => Promise<void>;
  create: (mode: CustomContextMode) => { ok: boolean; error?: string | undefined };
  update: (
    id: string,
    patch: Partial<CustomContextMode>,
  ) => { ok: boolean; error?: string | undefined };
  remove: (id: string) => { ok: boolean; error?: string | undefined };
  list: () => CustomContextMode[];
}

const STORE_FILENAME = 'custom-context-modes.json';

function storePath(wrongstackDir: string): string {
  return path.join(wrongstackDir, STORE_FILENAME);
}

const BUILTIN_IDS = new Set(['balanced', 'frugal', 'deep', 'archival']); // archival is reserved as a deprecated built-in alias.

export function createCustomModeStore(wrongstackDir: string): CustomModeStore {
  const modes = new Map<string, CustomContextMode>();

  const load = async (): Promise<void> => {
    modes.clear();
    try {
      const raw = await fs.readFile(storePath(wrongstackDir), 'utf8');
      const parsed = JSON.parse(raw) as { modes?: CustomContextMode[] };
      if (Array.isArray(parsed.modes)) {
        for (const m of parsed.modes) {
          if (m.id && !BUILTIN_IDS.has(m.id)) {
            modes.set(m.id, { ...m, custom: true });
          }
        }
      }
    } catch {
      // File missing or corrupt — start with empty custom modes.
    }
  };

  const save = async (): Promise<void> => {
    const arr = [...modes.values()];
    const json = JSON.stringify({ modes: arr }, null, 2);
    await atomicWrite(storePath(wrongstackDir), json);
  };

  const create = (mode: CustomContextMode): { ok: boolean; error?: string | undefined } => {
    if (!mode.id || typeof mode.id !== 'string') {
      return { ok: false, error: 'id is required' };
    }
    if (BUILTIN_IDS.has(mode.id)) {
      return { ok: false, error: `Cannot override built-in mode "${mode.id}"` };
    }
    if (modes.has(mode.id)) {
      return { ok: false, error: `Mode "${mode.id}" already exists` };
    }
    if (!mode.name) {
      return { ok: false, error: 'name is required' };
    }
    const entry: CustomContextMode = {
      id: mode.id,
      name: mode.name,
      description: mode.description || '',
      thresholds: {
        warn: mode.thresholds?.warn ?? 0.6,
        soft: mode.thresholds?.soft ?? 0.75,
        hard: mode.thresholds?.hard ?? 0.9,
      },
      aggressiveOn: mode.aggressiveOn || 'soft',
      preserveK: mode.preserveK ?? 10,
      eliseThreshold: mode.eliseThreshold ?? 2000,
      targetLoad: mode.targetLoad ?? 0.65,
      custom: true,
    };
    modes.set(mode.id, entry);
    void save().catch(() => {});
    return { ok: true };
  };

  const update = (
    id: string,
    patch: Partial<CustomContextMode>,
  ): { ok: boolean; error?: string | undefined } => {
    if (BUILTIN_IDS.has(id)) {
      return { ok: false, error: `Cannot modify built-in mode "${id}"` };
    }
    const existing = modes.get(id);
    if (!existing) {
      return { ok: false, error: `Mode "${id}" not found` };
    }
    const next: CustomContextMode = { ...existing };
    if (patch.name !== undefined) next.name = patch.name;
    if (patch.description !== undefined) next.description = patch.description;
    if (patch.thresholds) {
      next.thresholds = {
        warn: patch.thresholds.warn ?? existing.thresholds.warn,
        soft: patch.thresholds.soft ?? existing.thresholds.soft,
        hard: patch.thresholds.hard ?? existing.thresholds.hard,
      };
    }
    if (patch.preserveK !== undefined) next.preserveK = patch.preserveK;
    if (patch.eliseThreshold !== undefined) next.eliseThreshold = patch.eliseThreshold;
    if (patch.targetLoad !== undefined) next.targetLoad = patch.targetLoad;
    if (patch.aggressiveOn !== undefined) next.aggressiveOn = patch.aggressiveOn;
    modes.set(id, next);
    void save().catch(() => {});
    return { ok: true };
  };

  const remove = (id: string): { ok: boolean; error?: string | undefined } => {
    if (BUILTIN_IDS.has(id)) {
      return { ok: false, error: `Cannot delete built-in mode "${id}"` };
    }
    if (!modes.delete(id)) {
      return { ok: false, error: `Mode "${id}" not found` };
    }
    void save().catch(() => {});
    return { ok: true };
  };

  const list = (): CustomContextMode[] => {
    const builtins = listContextWindowModes().map((m) => ({
      id: m.id as string,
      name: m.name,
      description: m.description,
      thresholds: { ...m.thresholds },
      aggressiveOn: m.aggressiveOn as string,
      preserveK: m.preserveK,
      eliseThreshold: m.eliseThreshold,
      targetLoad: m.targetLoad,
      custom: false as const,
    }));
    const custom = [...modes.values()];
    return [...builtins, ...custom];
  };

  return { modes, load, save, create, update, remove, list };
}
