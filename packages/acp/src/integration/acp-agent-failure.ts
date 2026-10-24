/**
 * Classify the error an external agent ends a turn with.
 *
 * Claude's ACP adapter fails a `session/prompt` with a JSON-RPC internal error
 * whose message carries Claude's own text ("You've hit your limit · resets
 * 3pm") and whose `data.errorKind` names the provider failure. Reported as a
 * generic prompt failure, a spent subscription quota looked like a broken
 * tool: the leader retried a worker that could not run for hours.
 */
import type { SubagentError } from '@wrongstack/contracts/types';

/**
 * Leading text of the usage-limit messages Claude Code synthesises (the SDK's
 * `USAGE_LIMIT_ERROR_PREFIXES`, claude-agent-sdk 2026-10).
 */
const USAGE_LIMIT_PREFIXES: readonly string[] = [
  "You've hit your",
  "You've reached your",
  "You're out of usage credits",
  'Your org is out of usage',
  "Your seat type doesn't include usage",
  "Your seat type doesn't include extra usage",
  'Your usage allocation has been disabled',
  "Your group's usage limit is set to $0",
  'requires usage credits',
  "You're out of extra usage",
  'Claude AI usage limit reached',
];

/** Without a reset time, wait this long before trying the agent again. */
const DEFAULT_QUOTA_HOLD_MS = 15 * 60_000;

/**
 * When the limit resets, read from the message: "resets 3pm", "resets at
 * 14:30", or the older "Claude AI usage limit reached|<epoch seconds>".
 * Times are local; one already past means tomorrow.
 */
function parseQuotaResetAt(text: string, now = Date.now()): number | undefined {
  const epoch = /usage limit reached\|(\d{9,11})/i.exec(text);
  if (epoch?.[1]) return Number(epoch[1]) * 1000;
  const m = /\bresets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i.exec(text);
  if (!m?.[1]) return undefined;
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const meridiem = m[3]?.toLowerCase();
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  if (hour > 23 || minute > 59 || (!meridiem && !m[2])) return undefined;
  const at = new Date(now);
  at.setHours(hour, minute, 0, 0);
  if (at.getTime() <= now) at.setDate(at.getDate() + 1);
  return at.getTime();
}

/**
 * The SubagentError for a JSON-RPC error that names a provider failure, or
 * undefined when it is something else (left to the generic mapping).
 */
export function classifyAgentFailure(
  rpc: { code?: number; message: string; data?: unknown },
  agent: string,
  now = Date.now(),
): SubagentError | undefined {
  const text = rpc.message.replace(/^Internal error:\s*/i, '').trim();
  const errorKind = (rpc.data as { errorKind?: unknown } | null | undefined)?.errorKind;
  const isQuota =
    USAGE_LIMIT_PREFIXES.some((p) => text.startsWith(p) || text.includes(p)) ||
    errorKind === 'billing_error' ||
    errorKind === 'account_on_hold';
  if (isQuota) {
    const resetAt = parseQuotaResetAt(text, now);
    return {
      kind: 'provider_quota',
      message: `${agent}: usage quota spent — ${text || 'the account has no usage left'}`,
      retryable: false,
      backoffMs: resetAt !== undefined ? Math.max(0, resetAt - now) : DEFAULT_QUOTA_HOLD_MS,
    };
  }
  const message = `${agent}: ${text}`;
  switch (errorKind) {
    case 'rate_limit':
      return { kind: 'provider_rate_limit', message, retryable: true, backoffMs: 30_000 };
    case 'overloaded':
    case 'server_error':
      return { kind: 'provider_5xx', message, retryable: true, backoffMs: 10_000 };
    case 'authentication_failed':
    case 'oauth_org_not_allowed':
    case 'verification_required':
    case 'cloud_credential_error':
      return { kind: 'provider_auth', message, retryable: false };
    default:
      // ACP's `auth_required` error (-32000): the agent is signed out.
      return rpc.code === -32000 ? { kind: 'provider_auth', message, retryable: false } : undefined;
  }
}
