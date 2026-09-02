/**
 * Re-export shim — the implementation moved into `@wrongstack/wrongtrace`
 * (see wrongtrace-gate.ts for why). Same factories, same behaviour, now
 * shared by every host process that executes tools.
 */

export { createWrongTraceHookPair } from '@wrongstack/wrongtrace';
export type {
  WrongTraceGateDecisionEvent,
  WrongTraceHookInput,
  WrongTraceHookOptions,
  WrongTraceHookPair,
  WrongTracePreToolUseOutcome,
} from '@wrongstack/wrongtrace';
