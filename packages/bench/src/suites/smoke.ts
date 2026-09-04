import { createBundledLocalSuite, resolveBundledSuiteDir } from './bundled.js';

/** Bundled wiring-only tasks. Not a quality leaderboard — use `core` for that. */
export const SMOKE_TASK_COUNT = 3;

export function resolveSmokeSuiteDir(): string {
  return resolveBundledSuiteDir('smoke');
}

export function createSmokeSuite() {
  return createBundledLocalSuite('smoke');
}
