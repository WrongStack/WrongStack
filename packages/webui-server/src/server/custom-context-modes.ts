import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { listContextWindowModes } from '@wrongstack/contracts/types';
import { atomicWrite } from '@wrongstack/core/utils';

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

function validThresholds(value: unknown): value is CustomContextMode['thresholds'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const { warn, soft, hard } = value as Record<string, unknown>;
  return (
    typeof warn === 'number' &&
    Number.isFinite(warn) &&
    warn >= 0 &&
    typeof soft === 'number' &&
    Number.isFinite(soft) &&
    soft >= warn &&
    typeof hard === 'number' &&
    Number.isFinite(hard) &&
    hard >= soft &&
    hard <= 1
  );
}

function numericPolicyError(mode: CustomContextMode): string | undefined {
  if (!Number.isFinite(mode.targetLoad) || mode.targetLoad < 0 || mode.targetLoad > 1) {
    return 'targetLoad must be a finite number between 0 and 1';
  }
  if (!Number.isSafeInteger(mode.preserveK) || mode.preserveK < 0) {
    return 'preserveK must be a non-negative safe integer';
  }
  if (!Number.isSafeInteger(mode.eliseThreshold) || mode.eliseThreshold < 0) {
    return 'eliseThreshold must be a non-negative safe integer';
  }
  return undefined;
}

function validAggressiveOn(value: unknown): value is 'warn' | 'soft' | 'hard' {
  return value === 'warn' || value === 'soft' || value === 'hard';
}

export function createCustomModeStore(wrongstackDir: string): CustomModeStore {
  const modes = new Map<string, CustomContextMode>();
  // Set when the file exists but could not be read or parsed: save() must not
  // replace modes this process never saw.
  let unreadable = false;

  const load = async (): Promise<void> => {
    modes.clear();
    unreadable = false;
    let raw: string;
    try {
      raw = await fs.readFile(storePath(wrongstackDir), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') unreadable = true;
      return;
    }
    try {
      // A hand-edited file may start with a UTF-8 BOM, which JSON.parse rejects.
      const parsed = JSON.parse(raw.replace(/^\uFEFF/, '')) as { modes?: CustomContextMode[] };
      if (Array.isArray(parsed.modes)) {
        for (const value of parsed.modes) {
          if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
          const m = value as CustomContextMode;
          const id = typeof m.id === 'string' ? m.id.trim() : '';
          if (
            id.length > 0 &&
            typeof m.name === 'string' &&
            m.name.trim().length > 0 &&
            !BUILTIN_IDS.has(id)
          ) {
            const candidate = { ...m, id, name: m.name.trim(), custom: true };
            if (
              typeof candidate.description !== 'string' ||
              !validThresholds(candidate.thresholds) ||
              numericPolicyError(candidate) !== undefined ||
              !validAggressiveOn(candidate.aggressiveOn)
            ) {
              continue;
            }
            modes.set(id, candidate);
          }
        }
      }
    } catch {
      unreadable = true;
    }
  };

  const save = async (): Promise<void> => {
    if (unreadable) {
      throw new Error(`${STORE_FILENAME} could not be read; refusing to overwrite it`);
    }
    const arr = [...modes.values()];
    const json = JSON.stringify({ modes: arr }, null, 2);
    await atomicWrite(storePath(wrongstackDir), json);
  };

  const create = (mode: CustomContextMode): { ok: boolean; error?: string | undefined } => {
    if (!mode || typeof mode !== 'object' || Array.isArray(mode)) {
      return { ok: false, error: 'mode must be an object' };
    }
    if (typeof mode.id !== 'string' || mode.id.trim().length === 0) {
      return { ok: false, error: 'id is required' };
    }
    const id = mode.id.trim();
    if (BUILTIN_IDS.has(id)) {
      return { ok: false, error: `Cannot override built-in mode "${id}"` };
    }
    if (modes.has(id)) {
      return { ok: false, error: `Mode "${id}" already exists` };
    }
    if (typeof mode.name !== 'string' || mode.name.trim().length === 0) {
      return { ok: false, error: 'name is required' };
    }
    if (mode.description !== undefined && typeof mode.description !== 'string') {
      return { ok: false, error: 'description must be a string' };
    }
    if (mode.aggressiveOn !== undefined && !validAggressiveOn(mode.aggressiveOn)) {
      return { ok: false, error: 'aggressiveOn must be warn, soft, or hard' };
    }
    const entry: CustomContextMode = {
      id,
      name: mode.name.trim(),
      description: mode.description ?? '',
      thresholds: {
        warn: mode.thresholds?.warn ?? 0.6,
        soft: mode.thresholds?.soft ?? 0.75,
        hard: mode.thresholds?.hard ?? 0.9,
      },
      aggressiveOn: mode.aggressiveOn ?? 'soft',
      preserveK: mode.preserveK ?? 10,
      eliseThreshold: mode.eliseThreshold ?? 2000,
      targetLoad: mode.targetLoad ?? 0.65,
      custom: true,
    };
    if (!validThresholds(entry.thresholds)) {
      return { ok: false, error: 'thresholds must satisfy 0 <= warn <= soft <= hard <= 1' };
    }
    const numericError = numericPolicyError(entry);
    if (numericError) return { ok: false, error: numericError };
    if (!validAggressiveOn(entry.aggressiveOn)) {
      return { ok: false, error: 'aggressiveOn must be warn, soft, or hard' };
    }
    modes.set(id, entry);
    void save().catch(() => {});
    return { ok: true };
  };

  const update = (
    id: string,
    patch: Partial<CustomContextMode>,
  ): { ok: boolean; error?: string | undefined } => {
    if (typeof id !== 'string' || id.trim().length === 0) {
      return { ok: false, error: 'id is required' };
    }
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return { ok: false, error: 'patch must be an object' };
    }
    const normalizedId = id.trim();
    if (BUILTIN_IDS.has(normalizedId)) {
      return { ok: false, error: `Cannot modify built-in mode "${normalizedId}"` };
    }
    const existing = modes.get(normalizedId);
    if (!existing) {
      return { ok: false, error: `Mode "${normalizedId}" not found` };
    }
    const next: CustomContextMode = { ...existing };
    if (patch.name !== undefined) {
      if (typeof patch.name !== 'string' || patch.name.trim().length === 0) {
        return { ok: false, error: 'name is required' };
      }
      next.name = patch.name.trim();
    }
    if (patch.description !== undefined) {
      if (typeof patch.description !== 'string') {
        return { ok: false, error: 'description must be a string' };
      }
      next.description = patch.description;
    }
    if (patch.thresholds) {
      next.thresholds = {
        warn: patch.thresholds.warn ?? existing.thresholds.warn,
        soft: patch.thresholds.soft ?? existing.thresholds.soft,
        hard: patch.thresholds.hard ?? existing.thresholds.hard,
      };
      if (!validThresholds(next.thresholds)) {
        return { ok: false, error: 'thresholds must satisfy 0 <= warn <= soft <= hard <= 1' };
      }
    }
    if (patch.preserveK !== undefined) next.preserveK = patch.preserveK;
    if (patch.eliseThreshold !== undefined) next.eliseThreshold = patch.eliseThreshold;
    if (patch.targetLoad !== undefined) next.targetLoad = patch.targetLoad;
    if (patch.aggressiveOn !== undefined) next.aggressiveOn = patch.aggressiveOn;
    const numericError = numericPolicyError(next);
    if (numericError) return { ok: false, error: numericError };
    if (!validAggressiveOn(next.aggressiveOn)) {
      return { ok: false, error: 'aggressiveOn must be warn, soft, or hard' };
    }
    modes.set(normalizedId, next);
    void save().catch(() => {});
    return { ok: true };
  };

  const remove = (id: string): { ok: boolean; error?: string | undefined } => {
    if (typeof id !== 'string' || id.trim().length === 0) {
      return { ok: false, error: 'id is required' };
    }
    const normalizedId = id.trim();
    if (BUILTIN_IDS.has(normalizedId)) {
      return { ok: false, error: `Cannot delete built-in mode "${normalizedId}"` };
    }
    if (!modes.delete(normalizedId)) {
      return { ok: false, error: `Mode "${normalizedId}" not found` };
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
    const custom = [...modes.values()].map((mode) => structuredClone(mode));
    return [...builtins, ...custom];
  };

  return { modes, load, save, create, update, remove, list };
}
