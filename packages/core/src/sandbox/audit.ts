import type { EventBus } from '@wrongstack/contracts/kernel/events';
import type { SandboxDenyDecision, SandboxExecCall } from './types.js';

/** One audit record — denial, expansion request, or expansion outcome. */
export interface SandboxAuditRecord {
  kind: 'sandbox.denied' | 'sandbox.expansion_requested' | 'sandbox.expansion_outcome';
  tool: string;
  at: string;
  detail: Record<string, unknown>;
}

/**
 * Structural slice of the agent context the sandbox layer may touch: the
 * session journal (plan 28 AC3) only. Kept structural so sandbox code never
 * imports the full agent graph.
 */
export interface SandboxExpansionCtx {
  session?: { append: (event: unknown) => Promise<void> } | undefined;
}

const MAX_AUDIT_RECORDS = 200;

let events: EventBus | undefined;
let expansionApprover: SandboxExpansionApprover | undefined;
const auditLog: SandboxAuditRecord[] = [];

/** Host wiring: give the audit emitters a bus (or detach with `undefined`). */
export function setSandboxAuditEvents(bus: EventBus | undefined): void {
  events = bus;
}

/** Bounded in-memory audit trail — the fallback record when no bus is wired. */
export function getSandboxAuditLog(): readonly SandboxAuditRecord[] {
  return [...auditLog];
}

/** Test helper; production code should not clear the audit trail. */
export function clearSandboxAuditLog(): void {
  auditLog.length = 0;
}

function record(
  kind: SandboxAuditRecord['kind'],
  tool: string,
  detail: Record<string, unknown>,
): SandboxAuditRecord {
  const entry: SandboxAuditRecord = { kind, tool, at: new Date().toISOString(), detail };
  auditLog.push(entry);
  if (auditLog.length > MAX_AUDIT_RECORDS) auditLog.shift();
  return entry;
}

/**
 * Best-effort session-journal record (plan 28 AC3): mirrors a sandbox audit
 * event into the session JSONL when a context is available. Never throws —
 * the journal must not block the agent loop.
 *
 * Deliberately ignores `session.auditLevel`: these are security audit records
 * whose volume is bounded by the exec-family call rate, not per-turn chatter.
 */
export async function recordSandboxSessionEvent(
  ctx: SandboxExpansionCtx | undefined,
  entry: SandboxAuditRecord,
): Promise<void> {
  if (!ctx?.session) return;
  try {
    await ctx.session.append({
      type: 'sandbox_audit',
      ts: entry.at,
      event: entry.kind,
      tool: entry.tool,
      detail: entry.detail,
    });
  } catch {
    // Best-effort by contract (session-events.ts guarantees).
  }
}

/**
 * Expansion approver seam (T6): the host registers a bridge into the standard
 * approval path — CLI wires `createPolicySandboxApprover(permissionPolicy)`.
 * Default: none registered → auto-deny without expansion chatter.
 */
export type SandboxExpansionApprover = (
  call: SandboxExecCall,
  decision: SandboxDenyDecision,
  ctx?: SandboxExpansionCtx,
) => Promise<{ granted: boolean; decidedBy: string }>;

export function setSandboxExpansionApprover(approver: SandboxExpansionApprover | undefined): void {
  expansionApprover = approver;
}

/** Whether a host registered an expansion approver. */
export function getSandboxExpansionApprover(): SandboxExpansionApprover | undefined {
  return expansionApprover;
}

/** Called by the choke point when a backend denies an exec-family call. */
export function emitSandboxDenied(tool: string, decision: SandboxDenyDecision, tier: string): void {
  const at = new Date().toISOString();
  const missing = [...decision.missing];
  record('sandbox.denied', tool, { tier, reason: decision.reason, missing });
  events?.emit('sandbox.denied', { tool, tier, reason: decision.reason, missing, at });
}

/**
 * Ask for a one-call elevation of a denied call. Emits
 * `sandbox.expansion_requested`, consults the registered approver (none →
 * auto-deny; approver throw → fail-closed deny), and emits
 * `sandbox.expansion_outcome` with the resolution. When a session context is
 * supplied, request and outcome are mirrored into the session JSONL (AC3).
 */
export async function requestSandboxExpansion(
  call: SandboxExecCall,
  decision: SandboxDenyDecision,
  requestedBy = 'agent',
  sessionCtx?: SandboxExpansionCtx,
): Promise<{ granted: boolean; decidedBy: string }> {
  const at = new Date().toISOString();
  const missing = [...decision.missing];
  const requested = record('sandbox.expansion_requested', call.tool, {
    requestedBy,
    reason: decision.reason,
    missing,
  });
  await recordSandboxSessionEvent(sessionCtx, requested);
  events?.emit('sandbox.expansion_requested', {
    tool: call.tool,
    requestedBy,
    reason: decision.reason,
    missing,
    at,
  });

  let result: { granted: boolean; decidedBy: string };
  if (expansionApprover) {
    try {
      result = await expansionApprover(call, decision, sessionCtx);
    } catch (error) {
      // String(error), not the `instanceof Error ? .message : String()` form —
      // that expression is a security-ratchet pattern and must not spread.
      result = { granted: false, decidedBy: `approver-error:${String(error)}` };
    }
  } else {
    result = { granted: false, decidedBy: 'auto:no-approver' };
  }

  const at2 = new Date().toISOString();
  const outcome = record('sandbox.expansion_outcome', call.tool, { ...result });
  await recordSandboxSessionEvent(sessionCtx, outcome);
  events?.emit('sandbox.expansion_outcome', { tool: call.tool, ...result, at: at2 });
  return result;
}
