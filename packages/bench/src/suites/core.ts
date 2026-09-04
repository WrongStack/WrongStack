import { createBundledLocalSuite, resolveBundledSuiteDir } from './bundled.js';

/** Bundled agent-edit eval. Six Node tasks with hidden-ish tests the agent must not gut. */
export const CORE_TASK_COUNT = 6;

export function resolveCoreSuiteDir(): string {
  return resolveBundledSuiteDir('core');
}

export function createCoreSuite() {
  return createBundledLocalSuite('core');
}
