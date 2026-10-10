import type { Message } from '../types/messages.js';
import type { SessionEvent, SessionWriter } from '../types/session.js';

export const SUBAGENTS_ALLOWED_META_KEY = 'subagentsAllowed';
export const SUBAGENT_COMPANIONS_ALLOWED_META_KEY = 'subagentCompanionsAllowed';
export const SUBAGENTS_POLICY_LOCKED_META_KEY = 'subagentsPolicyLocked';

/**
 * What a session lets run beside the leader.
 *
 * - `all`: every subagent path (delegate, chimera, background, shadow, ...).
 * - `companions`: solo, except the resident read-only companions (memory and
 *   explore). A round that attributes one outcome to one change stays
 *   attributable: the companions cannot change anything.
 * - `none`: strict solo — nothing spawns.
 */
export type SubagentPolicyMode = 'all' | 'companions' | 'none';

type PolicyContext = {
  messages?: readonly Message[] | undefined;
  meta?: Record<string, unknown> | undefined;
  session?: Pick<SessionWriter, 'id' | 'append'> | undefined;
};

const sessionPolicies = new Map<string, SubagentPolicyMode>();
const lockedSessions = new Set<string>();

/** The wire/journal shape (`allowed` + optional `companions`) as a mode. */
export function subagentPolicyModeFrom(
  allowed: boolean,
  companions?: boolean | undefined,
): SubagentPolicyMode {
  if (allowed) return 'all';
  return companions === true ? 'companions' : 'none';
}

export function subagentPolicyMode(ctx: PolicyContext | null | undefined): SubagentPolicyMode {
  return subagentPolicyModeFrom(
    ctx?.meta?.[SUBAGENTS_ALLOWED_META_KEY] !== false,
    ctx?.meta?.[SUBAGENT_COMPANIONS_ALLOWED_META_KEY] === true,
  );
}

function applyMode(ctx: PolicyContext, mode: SubagentPolicyMode): void {
  if (!ctx.meta) return;
  ctx.meta[SUBAGENTS_ALLOWED_META_KEY] = mode === 'all';
  ctx.meta[SUBAGENT_COMPANIONS_ALLOWED_META_KEY] = mode !== 'none';
}

export function isSubagentPolicyLocked(ctx: PolicyContext): boolean {
  return (
    ctx.meta?.[SUBAGENTS_POLICY_LOCKED_META_KEY] === true ||
    (ctx.session?.id ? lockedSessions.has(ctx.session.id) : false) ||
    ctx.messages?.some((message) => message.role === 'user') === true
  );
}

export function lockSessionSubagentPolicy(ctx: PolicyContext): void {
  if (ctx.meta) ctx.meta[SUBAGENTS_POLICY_LOCKED_META_KEY] = true;
  if (ctx.session?.id) lockedSessions.add(ctx.session.id);
}

export function lockSessionSubagentPolicyForSession(sessionId: string | undefined): void {
  if (sessionId) lockedSessions.add(sessionId);
}

export function unlockSessionSubagentPolicyForSession(sessionId: string | undefined): void {
  if (!sessionId) return;
  lockedSessions.delete(sessionId);
  sessionPolicies.set(sessionId, 'all');
}

/** General subagents (everything but the resident companions). */
export function areSubagentsAllowed(ctx: PolicyContext | null | undefined): boolean {
  return subagentPolicyMode(ctx) === 'all';
}

/** The resident read-only companions (memory, explore). */
export function areSubagentCompanionsAllowed(ctx: PolicyContext | null | undefined): boolean {
  return subagentPolicyMode(ctx) !== 'none';
}

export function areSubagentsAllowedForSession(sessionId: string | undefined): boolean {
  if (!sessionId) return true;
  return (sessionPolicies.get(sessionId) ?? 'all') === 'all';
}

export function areSubagentCompanionsAllowedForSession(sessionId: string | undefined): boolean {
  if (!sessionId) return true;
  return sessionPolicies.get(sessionId) !== 'none';
}

export async function setSessionSubagentPolicy(
  ctx: PolicyContext,
  mode: SubagentPolicyMode,
  options?: { force?: boolean } | undefined,
): Promise<void> {
  if (subagentPolicyMode(ctx) === mode) return;
  if (!options?.force && isSubagentPolicyLocked(ctx)) {
    throw new Error(
      'Subagent policy is locked after the session starts. Start a new session to change it.',
    );
  }
  if (!options?.force && (!ctx.meta || !ctx.session)) {
    throw new Error('Session context is unavailable.');
  }

  if (ctx.session?.append) {
    await ctx.session.append({
      type: 'subagent_policy',
      ts: new Date().toISOString(),
      allowed: mode === 'all',
      ...(mode === 'companions' ? { companions: true } : {}),
    });
  }
  applyMode(ctx, mode);
  if (ctx.meta) {
    ctx.meta[SUBAGENTS_POLICY_LOCKED_META_KEY] = false;
  }
  if (ctx.session?.id) {
    if (options?.force) {
      lockedSessions.delete(ctx.session.id);
    }
    sessionPolicies.set(ctx.session.id, mode);
  }
}

/** Boolean form: `true` = all, `false` = strict solo. */
export function setSessionSubagentsAllowed(ctx: PolicyContext, allowed: boolean): Promise<void> {
  return setSessionSubagentPolicy(ctx, allowed ? 'all' : 'none');
}

export function restoreSessionSubagentPolicy(
  ctx: PolicyContext,
  events: readonly SessionEvent[] | undefined,
  persistedAllowed?: boolean,
  persistedCompanions?: boolean,
): void {
  let mode = subagentPolicyModeFrom(persistedAllowed ?? true, persistedCompanions);
  for (const event of events ?? []) {
    if (event.type === 'subagent_policy')
      mode = subagentPolicyModeFrom(event.allowed, event.companions);
  }
  applyMode(ctx, mode);
  if (ctx.meta) ctx.meta[SUBAGENTS_POLICY_LOCKED_META_KEY] = isSubagentPolicyLocked(ctx);
  if (ctx.session?.id) sessionPolicies.set(ctx.session.id, mode);
  if (isSubagentPolicyLocked(ctx) && ctx.session?.id) lockedSessions.add(ctx.session.id);
}

export function seedSessionSubagentPolicy(ctx: PolicyContext): void {
  const mode = subagentPolicyMode(ctx);
  applyMode(ctx, mode);
  if (ctx.meta) ctx.meta[SUBAGENTS_POLICY_LOCKED_META_KEY] = isSubagentPolicyLocked(ctx);
  if (ctx.session?.id) sessionPolicies.set(ctx.session.id, mode);
}

export function resetSessionSubagentPolicy(ctx: PolicyContext): void {
  applyMode(ctx, 'all');
  if (ctx.meta) ctx.meta[SUBAGENTS_POLICY_LOCKED_META_KEY] = false;
  if (ctx.session?.id) {
    sessionPolicies.set(ctx.session.id, 'all');
    lockedSessions.delete(ctx.session.id);
  }
}
