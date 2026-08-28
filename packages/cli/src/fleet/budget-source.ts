/**
 * Resolve fleet concurrency + lifetime spawn ceilings with an explicit
 * winning source label (issue #323). Priority matches director-setup:
 * CLI flag → env → profile/config → built-in default.
 */
import { DEFAULT_MAX_FLEET_SPAWNS } from '@wrongstack/core/coordination';
import type { Config } from '@wrongstack/core/types';

export type FleetBudgetSource = 'cli-flag' | 'env' | 'profile' | 'default';

interface ResolvedFleetBudget {
  maxConcurrent: number;
  maxConcurrentSource: FleetBudgetSource;
  maxSpawns: number;
  maxSpawnsSource: FleetBudgetSource;
}

function positiveInt(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  if (typeof raw === 'string' && raw.trim() !== '') {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

export function resolveFleetBudgetSources(input: {
  flags?: Record<string, string | boolean> | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  config?: Config | undefined;
  /** Built-in maxConcurrent when nothing else wins. */
  defaultMaxConcurrent?: number | undefined;
  /** Built-in maxSpawns when nothing else wins. */
  defaultMaxSpawns?: number | undefined;
}): ResolvedFleetBudget {
  const flags = input.flags ?? {};
  const env = input.env ?? process.env;
  const config = input.config;
  const defaultMaxConcurrent = input.defaultMaxConcurrent ?? 4;
  const defaultMaxSpawns = input.defaultMaxSpawns ?? DEFAULT_MAX_FLEET_SPAWNS;

  const maxConcurrentFlag = positiveInt(flags['max-concurrent']);
  const maxConcurrentEnv = positiveInt(env['WRONGSTACK_MAX_CONCURRENT']);
  const maxConcurrentProfile = positiveInt(config?.maxConcurrent);

  let maxConcurrent: number;
  let maxConcurrentSource: FleetBudgetSource;
  if (maxConcurrentFlag !== undefined) {
    maxConcurrent = maxConcurrentFlag;
    maxConcurrentSource = 'cli-flag';
  } else if (maxConcurrentEnv !== undefined) {
    maxConcurrent = maxConcurrentEnv;
    maxConcurrentSource = 'env';
  } else if (maxConcurrentProfile !== undefined) {
    maxConcurrent = maxConcurrentProfile;
    maxConcurrentSource = 'profile';
  } else {
    maxConcurrent = defaultMaxConcurrent;
    maxConcurrentSource = 'default';
  }

  const maxSpawnsFlag = positiveInt(flags['max-spawns']);
  const maxSpawnsEnv = positiveInt(env['WRONGSTACK_MAX_SPAWNS']);
  const maxSpawnsProfile = positiveInt(config?.fleet?.budget?.maxSpawns);

  let maxSpawns: number;
  let maxSpawnsSource: FleetBudgetSource;
  if (maxSpawnsFlag !== undefined) {
    maxSpawns = maxSpawnsFlag;
    maxSpawnsSource = 'cli-flag';
  } else if (maxSpawnsEnv !== undefined) {
    maxSpawns = maxSpawnsEnv;
    maxSpawnsSource = 'env';
  } else if (maxSpawnsProfile !== undefined) {
    maxSpawns = maxSpawnsProfile;
    maxSpawnsSource = 'profile';
  } else {
    maxSpawns = defaultMaxSpawns;
    maxSpawnsSource = 'default';
  }

  return {
    maxConcurrent,
    maxConcurrentSource,
    maxSpawns,
    maxSpawnsSource,
  };
}
