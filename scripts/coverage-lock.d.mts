export interface CoverageLockOptions {
  [key: string]: unknown;
}

export interface CoverageLock {
  acquire(): Promise<void>;
  execute(): Promise<number>;
  isStale(): boolean;
  readOwner(): string;
  release(): void;
  run(): Promise<number>;
  withLock<T>(runner: () => T | Promise<T>): Promise<T>;
}

export function isDirectRun(metaUrl?: string, argvEntry?: string): boolean;
export function sleep(ms: number): Promise<void>;
export interface ProcessProbeDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  execFile?: (file: string, args: string[], options?: object) => unknown;
  kill?: (pid: number, signal?: number | NodeJS.Signals) => unknown;
}
export function defaultCheckProcessAlive(pid: number, deps?: ProcessProbeDeps): boolean;
export function createCoverageLock(options?: CoverageLockOptions): CoverageLock;
export function executeCoverageLock(options?: CoverageLockOptions): Promise<number>;
