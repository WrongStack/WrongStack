/**
 * WrongTrace guardrail hooks — the concrete executor-path integration.
 *
 * These in-process hooks sit on the shared Agent's HookRunner, i.e. in
 * front of the real edit-tool executor (ToolExecutor calls
 * hookRunner.preToolUse before dispatching any tool). That means every
 * `edit` / `write` / `codebase-ast-replace` call from any host (TUI,
 * WebUI, REPL, single-shot) passes this gate before a single byte is
 * written.
 *
 * Behaviour:
 *   preToolUse:  resolve the target path from toolInput; run the
 *                WrongTrace pre-flight (health + lock state). A file
 *                locked by another owner DENIES the call with the
 *                owner/expiry in the reason — the model sees it and can
 *                pick another file. A healthy/fragile/offline daemon
 *                ALLOWs; fragile files additionally get a one-line
 *                "prefer surgical edits" nudge via additionalContext.
 *                On allow we also ACQUIRE the daemon lock for the edit
 *                (owner = session id) so peers see the claim.
 *   postToolUse: release the lock acquired in preToolUse (path-keyed).
 *                The 15-minute daemon TTL is the leak backstop if this
 *                process dies between the two phases.
 *
 * Failure philosophy: this is a COORDINATION optimization, never a hard
 * dependency. Daemon offline → everything allows. Any throw inside the
 * hooks is swallowed by the runner's fail-open policy for non-policy
 * hooks, but we additionally catch here so a slow daemon (timeout) can
 * never add latency surprises to the edit path.
 */

import type {
  HookInput,
  HookInvocationContext,
  PreToolUseOutcome,
} from '@wrongstack/core/hooks';

import { preflightFileEdit, getWrongTrace } from './wrongtrace-gate.js';

/** Tools that mutate a single target file and must pass the gate. */
const EDIT_TOOLS = new Set([
  'edit',
  'write',
  'replace',
  'patch',
  'codebase-ast-replace',
]);

/** Extract the target file path from a mutating tool's input, if present. */
function targetPathOf(toolInput: unknown): string | undefined {
  if (!toolInput || typeof toolInput !== 'object') return undefined;
  const t = toolInput as Record<string, unknown>;
  for (const key of ['path', 'file_path', 'target', 'file']) {
    const v = t[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

/** Paths locked by this hook in preToolUse, released in postToolUse. */
const heldLocks = new Set<string>();

export function createWrongTracePreToolUseHook(sessionId: () => string) {
  return async (
    input: HookInput,
    _runtime: HookInvocationContext,
  ): Promise<PreToolUseOutcome | undefined> => {
    if (!EDIT_TOOLS.has(input.toolName ?? '')) return undefined;
    const path = targetPathOf(input.toolInput);
    if (!path) return undefined;

    try {
      const verdict = await preflightFileEdit(path);
      if (verdict.kind === 'blocked') {
        const owner = verdict.risk.reasons.join('; ');
        return { action: 'deny', reason: `WrongTrace lock: ${owner}` };
      }

      // Allow — and claim the lock so peers see this edit in flight.
      const wt = await getWrongTrace();
      if (wt.isAvailable) {
        const res = await wt.lockFile(path, 'WrongStack edit in progress', {
          owner: `wrongstack:${sessionId()}`,
          ttlSeconds: 900,
        });
        if (res?.ok === true) heldLocks.add(path);
        // Conflict here (ok:false) means a peer grabbed it between the
        // pre-flight and the claim; the file was free at check time, so
        // proceed — the next peer's pre-flight will see our diff anyway.
      }

      if (verdict.risk && verdict.risk.band === 'fragile') {
        return {
          action: 'allow',
          additionalContext: `WrongTrace: ${path} is fragile (${verdict.risk.reasons.join('; ')}). Prefer surgical AST diffs over rewrites.`,
        };
      }
      return { action: 'allow' };
    } catch {
      // Fail-open: coordination must never break the edit path.
      return undefined;
    }
  };
}

export function createWrongTracePostToolUseHook() {
  return async (input: HookInput): Promise<void> => {
    if (!EDIT_TOOLS.has(input.toolName ?? '')) return;
    const path = targetPathOf(input.toolInput);
    if (!path || !heldLocks.has(path)) return;
    heldLocks.delete(path);
    try {
      const wt = await getWrongTrace();
      if (wt.isAvailable) await wt.unlockFile(path);
    } catch {
      // TTL backstop will reap it.
    }
  };
}
