import type { SpawnSyncOptions, SpawnSyncReturns } from 'node:child_process';

export interface CoverageRun {
  label: string;
  args: string[];
  /** Whether this child command accepts Vitest retry flags. */
  vitest?: boolean | undefined;
}

export type RunCoverageSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnSyncOptions,
) => SpawnSyncReturns<Buffer>;

export type RunCoverageLog = (...args: unknown[]) => void;

export interface RunCoverageOptions {
  pnpmCli?: string | undefined;
  runs?: CoverageRun[] | undefined;
  spawnPnpm?: RunCoverageSpawn | undefined;
  execPath?: string | undefined;
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  log?: RunCoverageLog | undefined;
}

export const COVERAGE_RUNS: CoverageRun[];
export function isDirectRun(metaUrl?: string, argvEntry?: string): boolean;
export function runCoverage(options?: RunCoverageOptions): number;
