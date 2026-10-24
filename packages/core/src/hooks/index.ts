export type {
  AnyHookOutcome,
  ConfiguredHook,
  HookEntry,
  HookEvent,
  HookFailurePolicy,
  HookInput,
  HookInvocationContext,
  HookMatcher,
  HookOutcome,
  HookRegistrationOptions,
  HttpHook,
  InProcessHook,
  ObservationalHookEvent,
  PreToolUseOutcome,
  PreToolUseStage,
  ShellHook,
} from '@wrongstack/contracts/types/hooks';
export { HOOK_EVENTS, isHookEvent } from '@wrongstack/contracts/types/hooks';
export type { HttpHookSpec } from './http-executor.js';
export { runHttpHookDetailed } from './http-executor.js';
export { bridgeLifecycleHooks, type LifecycleHookBridgeOptions } from './lifecycle-bridge.js';
export { HookRegistry, hookMatcherMatches } from './registry.js';
export type {
  HookRunEnv,
  HookRunnerOptions,
  ObservationalHookFields,
  PreToolUseResult,
  PromptResult,
} from './runner.js';
export { HookRunner } from './runner.js';
export type {
  HookExecutionFailure,
  HookExecutionFailureKind,
  HookExecutionOptions,
  HookExecutionResult,
  ShellHookSpec,
} from './shell-executor.js';
export { parseHookOutcome, runShellHook, runShellHookDetailed } from './shell-executor.js';
export { countShellHooks, shellHooksEqual } from './shell-hooks-equal.js';
