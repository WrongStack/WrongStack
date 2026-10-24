import { createHash } from 'node:crypto';
import type { AgentContext } from '@wrongstack/contracts/types/context';
import type { Tool } from '@wrongstack/contracts/types/tool';

const PREFIX = 'wrongstack-approval:v1:';

/**
 * How long a prompt-driven "always" answer stays valid (W6 #9). Every surface
 * that persists such an answer — the policy's own prompt, the executor's
 * confirm awaiter and the pending-confirm resolver — must pass it; without it
 * the rule is permanent, which only a hand-authored trust.json entry may be.
 */
export const DEFAULT_ALWAYS_TRUST_TTL_MS = 24 * 60 * 60 * 1000;
export const isPersistentApproval = (decision: string): boolean =>
  ['always', 'always-exact', 'always-command', 'always-tool'].includes(decision);
export const isScopedApprovalPattern = (pattern: string): boolean => pattern.startsWith(PREFIX);

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function exactApprovalKey(input: unknown, ctx: AgentContext): string {
  return createHash('sha256')
    .update(canonical({ input, cwd: ctx.workingDir ?? ctx.cwd, projectRoot: ctx.projectRoot }))
    .digest('hex');
}

function commandKey(tool: Pick<Tool, 'name'>, input: unknown): string | undefined {
  if (tool.name !== 'exec' || !input || typeof input !== 'object') return undefined;
  const command = (input as Record<string, unknown>).command;
  // Only structured argv calls have a reliable executable boundary. Shell
  // strings can contain multiple commands and must use exact/tool approval.
  return typeof command === 'string' && command.trim().length > 0
    ? createHash('sha256').update(command.trim()).digest('hex')
    : undefined;
}

export function scopedApprovalPattern(
  decision: string,
  tool: Pick<Tool, 'name'>,
  input: unknown,
  ctx: AgentContext,
  fallback: string,
): string {
  if (decision === 'always-tool') return `${PREFIX}tool`;
  if (decision === 'always-command') {
    const key = commandKey(tool, input);
    if (key) return `${PREFIX}command:${key}`;
    // A stale/malformed client must never turn an unavailable scope into a
    // broader grant. Fall back to the exact invocation.
  }
  // A legacy client's literal subject may contain our storage prefix. It is
  // still user input, never an instruction to grant a wider scope.
  if (
    decision === 'always-exact' ||
    decision === 'always-command' ||
    (decision === 'always' && isScopedApprovalPattern(fallback))
  )
    return `${PREFIX}exact:${exactApprovalKey(input, ctx)}`;
  return fallback;
}

export function matchingApprovalScope(
  patterns: readonly string[],
  tool: Pick<Tool, 'name'>,
  input: unknown,
  ctx: AgentContext,
): 'exact' | 'command' | 'tool' | undefined {
  if (patterns.includes(`${PREFIX}exact:${exactApprovalKey(input, ctx)}`)) return 'exact';
  const key = commandKey(tool, input);
  if (key && patterns.includes(`${PREFIX}command:${key}`)) return 'command';
  if (patterns.includes(`${PREFIX}tool`)) return 'tool';
  return undefined;
}

/** Keep the persisted rule and its readable scope together for audit/UI events. */
export function approvalRecord(
  decision: string,
  tool: Pick<Tool, 'name'>,
  input: unknown,
  ctx: AgentContext,
  suggestedPattern: string,
): { pattern: string; displayPattern: string; scope?: 'exact' | 'command' | 'tool' } {
  const pattern = scopedApprovalPattern(decision, tool, input, ctx, suggestedPattern);
  const scope = matchingApprovalScope([pattern], tool, input, ctx);
  const displayPattern =
    scope === 'tool'
      ? 'any input'
      : scope === 'command'
        ? `${String((input as Record<string, unknown>).command)} (any arguments)`
        : scope === 'exact'
          ? `${suggestedPattern} (exact input and working directory)`
          : suggestedPattern;
  return { pattern, displayPattern, ...(scope ? { scope } : {}) };
}

/**
 * What an answer to a YOLO question about the user's own rule
 * (`source: 'yolo_user_rule'`) actually does. "Always allow" cannot stick —
 * the user's deny rule is checked first and would turn the new allow into a
 * dead entry that asks again anyway — so it runs the call once, like "yes",
 * and writes nothing. Lifting the rule itself is `/permissions` or the trust
 * file, never a side effect of answering a prompt. Every other answer, and
 * every other prompt, passes through unchanged.
 */
export function userRuleAnswer<C extends string>(
  choice: C,
  decisionSource: string | undefined,
): C | 'yes' {
  return decisionSource === 'yolo_user_rule' && isPersistentApproval(choice) ? 'yes' : choice;
}
