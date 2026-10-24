/**
 * Per-session permission overrides: `/permissions allow|deny <tool> [pattern]`.
 *
 * They hold for one session only. They are journaled as a
 * `permission_overrides` event (the whole list, last event wins) and never
 * written to the trust file or any config, so resuming the session brings them
 * back and nothing else sees them. A fork starts without them.
 *
 * The live list sits in `ctx.meta` because the permission policy is one object
 * per process while a WebUI holds several sessions at once; reading it from the
 * conversation's own context is what keeps one tab's rule out of another.
 *
 * Only the user sets them (a slash command; no model tool writes them), so the
 * user-owned autonomy invariant holds: an allow here is the user's decision, and
 * the policy treats it like an approval given at a prompt. Deny rules, the
 * sensitive-read prompt and the destructive-call confirm still win over it.
 *
 * The journal is a file, so "no model tool writes them" is only true while the
 * journal cannot be written behind the user's back: a write into the global
 * root (sessions/ included) is the `agent-state` kind for the write tools AND
 * for the shell detector (yolo-risk.ts `looksLikeAgentStateTarget`), and that
 * kind is locked — YOLO cannot un-gate it. `--restricted` ignores allows
 * entirely (WS-2026-09-26-04).
 */

import type { SessionEvent, SessionWriter } from '@wrongstack/contracts/types/session';
import type { SessionPermissionOverride } from '@wrongstack/contracts/types/session-permission-override';
import type { Tool } from '@wrongstack/contracts/types/tool';
import { matchGlob } from '../utils/glob-match.js';
import { hasShellSubject, matchesCommandTrust, matchesTrust } from './permission-helpers.js';

export const SESSION_PERMISSION_OVERRIDES_META_KEY = 'permissionOverrides';

type OverrideContext = {
  meta?: Record<string, unknown> | undefined;
  session?: Pick<SessionWriter, 'append'> | undefined;
};

/** Keep only well-formed entries: the journal payload is untrusted input. */
export function normalizeSessionPermissionOverrides(raw: unknown): SessionPermissionOverride[] {
  if (!Array.isArray(raw)) return [];
  const out: SessionPermissionOverride[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const { effect, tool, pattern } = item as Record<string, unknown>;
    if (effect !== 'allow' && effect !== 'deny') continue;
    if (typeof tool !== 'string' || tool.trim() === '') continue;
    if (pattern !== undefined && (typeof pattern !== 'string' || pattern === '')) continue;
    out.push({ effect, tool, ...(pattern !== undefined ? { pattern } : {}) });
  }
  return out;
}

export function readSessionPermissionOverrides(
  ctx: Pick<OverrideContext, 'meta'> | undefined,
): readonly SessionPermissionOverride[] {
  return normalizeSessionPermissionOverrides(ctx?.meta?.[SESSION_PERMISSION_OVERRIDES_META_KEY]);
}

function toolMatches(override: SessionPermissionOverride, toolName: string): boolean {
  return (
    override.tool === toolName ||
    (override.tool.includes('*') && matchGlob(override.tool, toolName))
  );
}

/**
 * The first override of `effect` that covers this call, with its index in the
 * list. A pattern needs a subject to match; without one only a pattern-less
 * override applies. An allow on a shell stops its wildcard at `;`, `&&` and `|`
 * (`pnpm test*` does not cover `pnpm test; curl …`); a deny keeps the wider
 * match, the same split the trust file uses.
 */
export function matchSessionPermissionOverride(
  overrides: readonly SessionPermissionOverride[],
  effect: SessionPermissionOverride['effect'],
  tool: Tool,
  subject: string | undefined,
): { override: SessionPermissionOverride; index: number } | undefined {
  for (const [index, override] of overrides.entries()) {
    if (override.effect !== effect || !toolMatches(override, tool.name)) continue;
    if (override.pattern === undefined) return { override, index };
    if (subject === undefined) continue;
    const matches =
      effect === 'allow' && hasShellSubject(tool) ? matchesCommandTrust : matchesTrust;
    if (matches([override.pattern], subject)) return { override, index };
  }
  return undefined;
}

/**
 * A deny override with a pattern could not be checked (the call has no
 * subject). Like an unevaluated trust deny, it must not be read as "no deny":
 * the permissive shortcuts are skipped and the call is confirmed.
 */
export function sessionDenyUnevaluated(
  overrides: readonly SessionPermissionOverride[],
  tool: Tool,
  subject: string | undefined,
): boolean {
  return (
    subject === undefined &&
    overrides.some(
      (o) => o.effect === 'deny' && o.pattern !== undefined && toolMatches(o, tool.name),
    )
  );
}

/** Part of the permission decision cache key: a changed list is a new decision. */
export function sessionOverridesFingerprint(
  overrides: readonly SessionPermissionOverride[],
): string {
  return overrides.length === 0 ? '' : JSON.stringify(overrides);
}

export function describeSessionPermissionOverride(override: SessionPermissionOverride): string {
  return `${override.effect} ${override.tool}${override.pattern !== undefined ? ` ${override.pattern}` : ' (any input)'}`;
}

/** Replace the session's list: journal it, then make it live. */
export async function setSessionPermissionOverrides(
  ctx: OverrideContext,
  overrides: readonly SessionPermissionOverride[],
): Promise<void> {
  if (!ctx.meta || !ctx.session) throw new Error('Session context is unavailable.');
  const next = normalizeSessionPermissionOverrides(overrides);
  await ctx.session.append({
    type: 'permission_overrides',
    ts: new Date().toISOString(),
    overrides: next,
  });
  ctx.meta[SESSION_PERMISSION_OVERRIDES_META_KEY] = next;
}

/**
 * The list a journal ends with. `persisted` is `SessionData.permissionOverrides`,
 * which survives the loader dropping old events; a later event in `events`
 * still wins.
 */
export function latestSessionPermissionOverrides(
  events: readonly SessionEvent[] | undefined,
  persisted?: readonly SessionPermissionOverride[] | undefined,
): SessionPermissionOverride[] {
  let latest: unknown = persisted ?? [];
  for (const event of events ?? []) {
    if (event.type === 'permission_overrides') latest = event.overrides;
  }
  return normalizeSessionPermissionOverrides(latest);
}

/** On resume, rewind and redo: make the journal's list the live one. */
export function restoreSessionPermissionOverrides(
  meta: Record<string, unknown> | undefined,
  data: {
    events?: readonly SessionEvent[] | undefined;
    permissionOverrides?: readonly SessionPermissionOverride[] | undefined;
  },
): void {
  if (!meta) return;
  const overrides = latestSessionPermissionOverrides(data.events, data.permissionOverrides);
  if (overrides.length > 0) meta[SESSION_PERMISSION_OVERRIDES_META_KEY] = overrides;
  else delete meta[SESSION_PERMISSION_OVERRIDES_META_KEY];
}
