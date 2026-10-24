/**
 * Sandbox lifecycle events (plan 28 — docs/specs/sandboxed-execution-tiers-sdd.md).
 *
 * Emitted by the exec choke point (`sandbox/audit.ts`) whenever a sandbox
 * backend denies an exec-family call (bash/exec/git) or an expansion request
 * is made / resolved. Fail-open: with no EventBus wired, events are dropped
 * and only the in-memory audit ring buffer keeps the record.
 */
export interface SandboxEventMap {
  /** A sandbox backend denied an exec-family call; the tool call will throw SandboxDeniedError. */
  'sandbox.denied': {
    tool: string;
    tier: string;
    reason: string;
    missing: Array<{ type: 'path' | 'network'; value: string }>;
    at: string;
  };
  /** A consumer asked to elevate one denied call (T6 wires the interactive approval; default is auto-deny). */
  'sandbox.expansion_requested': {
    tool: string;
    requestedBy: string;
    reason: string;
    missing: Array<{ type: 'path' | 'network'; value: string }>;
    at: string;
  };
  /** Resolution of an expansion request — granted runs once with the missing scope, denied does not. */
  'sandbox.expansion_outcome': {
    tool: string;
    granted: boolean;
    decidedBy: string;
    at: string;
  };
}
