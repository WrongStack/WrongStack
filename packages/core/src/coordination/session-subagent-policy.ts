import type { Message } from '../types/messages.js';
import type { SessionEvent, SessionWriter } from '../types/session.js';

export const SUBAGENTS_ALLOWED_META_KEY = 'subagentsAllowed';
export const SUBAGENTS_POLICY_LOCKED_META_KEY = 'subagentsPolicyLocked';

type PolicyContext = {
  messages?: readonly Message[] | undefined;
  meta?: Record<string, unknown> | undefined;
  session?: Pick<SessionWriter, 'id' | 'append'> | undefined;
};

const sessionPolicies = new Map<string, boolean>();
const lockedSessions = new Set<string>();

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

export function areSubagentsAllowed(ctx: PolicyContext | null | undefined): boolean {
  return ctx?.meta?.[SUBAGENTS_ALLOWED_META_KEY] !== false;
}

export function areSubagentsAllowedForSession(sessionId: string | undefined): boolean {
  if (!sessionId) return true;
  return sessionPolicies.get(sessionId) !== false;
}

export async function setSessionSubagentsAllowed(
  ctx: PolicyContext,
  allowed: boolean,
): Promise<void> {
  const current = areSubagentsAllowed(ctx);
  if (current === allowed) return;
  if (isSubagentPolicyLocked(ctx)) {
    throw new Error(
      'Subagent policy is locked after the session starts. Start a new session to change it.',
    );
  }
  if (!ctx.meta || !ctx.session) throw new Error('Session context is unavailable.');

  await ctx.session.append({
    type: 'subagent_policy',
    ts: new Date().toISOString(),
    allowed,
  });
  ctx.meta[SUBAGENTS_ALLOWED_META_KEY] = allowed;
  ctx.meta[SUBAGENTS_POLICY_LOCKED_META_KEY] = false;
  sessionPolicies.set(ctx.session.id, allowed);
}

export function restoreSessionSubagentPolicy(
  ctx: PolicyContext,
  events: readonly SessionEvent[] | undefined,
  persistedAllowed?: boolean,
): void {
  let allowed = persistedAllowed ?? true;
  for (const event of events ?? []) {
    if (event.type === 'subagent_policy') allowed = event.allowed;
  }
  if (ctx.meta) {
    ctx.meta[SUBAGENTS_ALLOWED_META_KEY] = allowed;
    ctx.meta[SUBAGENTS_POLICY_LOCKED_META_KEY] = isSubagentPolicyLocked(ctx);
  }
  if (ctx.session?.id) sessionPolicies.set(ctx.session.id, allowed);
  if (isSubagentPolicyLocked(ctx) && ctx.session?.id) lockedSessions.add(ctx.session.id);
}

export function seedSessionSubagentPolicy(ctx: PolicyContext): void {
  const allowed = areSubagentsAllowed(ctx);
  if (ctx.meta) {
    ctx.meta[SUBAGENTS_ALLOWED_META_KEY] = allowed;
    ctx.meta[SUBAGENTS_POLICY_LOCKED_META_KEY] = isSubagentPolicyLocked(ctx);
  }
  if (ctx.session?.id) sessionPolicies.set(ctx.session.id, allowed);
}

export function resetSessionSubagentPolicy(ctx: PolicyContext): void {
  if (ctx.meta) {
    ctx.meta[SUBAGENTS_ALLOWED_META_KEY] = true;
    ctx.meta[SUBAGENTS_POLICY_LOCKED_META_KEY] = false;
  }
  if (ctx.session?.id) {
    sessionPolicies.set(ctx.session.id, true);
    lockedSessions.delete(ctx.session.id);
  }
}
