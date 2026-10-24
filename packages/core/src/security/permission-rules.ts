/**
 * The permission rule list: every setting that decides a tool call, compiled
 * into one ordered list of `{action, resource, effect}` rules, first match
 * wins.
 *
 * Nothing here decides a call. `DefaultPermissionPolicy.evaluate` still checks
 * its settings in its own order; this lists the same settings in that order so
 * a person can read them in one place, and `explain` names the rule (by number)
 * that decided a call. `permission-explain-parity.test.ts` holds the two
 * together: every decision it generates must land on a listed rule.
 *
 * Order (matching `evaluate` and the directory wrapper around it):
 * directory rules → "no" answers → trust-file denies → session denies →
 * one-shot "yes" answers → tool-declared deny → session allows → prompt
 * approvals and `--allowed-tools` → trust-file allows → trust-file `auto` →
 * sensitive reads → YOLO → write-after-read → safe tool defaults → ask. The
 * executor's dangerous-capability gate comes after the policy.
 */

import type { AgentContext } from '@wrongstack/contracts/types/context';
import type {
  PermissionPolicy,
  PermissionRule,
  PermissionTrace,
  TrustPolicy,
} from '@wrongstack/contracts/types/permission';
import type { SessionPermissionOverride } from '@wrongstack/contracts/types/session-permission-override';
import type { Tool } from '@wrongstack/contracts/types/tool';
import { matchGlob } from '../utils/glob-match.js';
import { matchesTrust } from './permission-helpers.js';
import { isScopedApprovalPattern, matchingApprovalScope } from './scoped-approval.js';

export type UnnumberedPermissionRule = Omit<PermissionRule, 'n'>;

export const permissionRuleRef = {
  trust: (key: string, pattern: string): string => `trust:${key}:${pattern}`,
  trustAuto: (key: string): string => `trust:${key}:auto`,
  session: (index: number): string => `session:${index}`,
  answer: (key: string): string => `answer:${key}`,
  allowedTools: (pattern: string): string => `allowed-tools:${pattern}`,
  directory: (index: number): string => `dir:${index}`,
};

export interface TrustRuleState {
  policy: TrustPolicy;
  policyInvalid: boolean;
  wildcardEntries: { pattern: string; value: TrustPolicy[string] }[];
  sessionDenied: ReadonlyMap<string, boolean>;
  sessionAllowed: ReadonlyMap<string, boolean>;
  launchAllowedTools: readonly string[];
  yolo: boolean;
  yoloConfirmKinds: ReadonlySet<string>;
  overrides: readonly SessionPermissionOverride[];
}

/** Scoped approvals are stored as hashes; say what they cover instead. */
function describeScopedApproval(pattern: string): string {
  if (pattern.endsWith(':tool')) return 'any input (approved at a prompt)';
  if (pattern.includes(':command:'))
    return 'one exec command, any arguments (approved at a prompt)';
  return 'one exact input and working directory (approved at a prompt)';
}

function expiryNote(entry: TrustPolicy[string]): string | undefined {
  if (entry?.allowUntil === undefined) return undefined;
  return `expires ${new Date(entry.allowUntil).toISOString()}`;
}

function splitAnswerKey(key: string): { tool: string; subject: string } {
  const at = key.indexOf('::');
  return at < 0
    ? { tool: key, subject: '*' }
    : { tool: key.slice(0, at), subject: key.slice(at + 2) };
}

/** The rules of `DefaultPermissionPolicy`, in `evaluate` order. */
export function listTrustPolicyRules(state: TrustRuleState): UnnumberedPermissionRule[] {
  const rules: UnnumberedPermissionRule[] = [];
  if (state.policyInvalid) {
    rules.push({
      step: 'policy invalid',
      source: 'trust-file',
      action: '*',
      resource: '*',
      effect: 'deny',
      note: 'the trust file is invalid; every call is refused until it is repaired',
    });
    return rules;
  }
  const entries = Object.entries(state.policy);

  for (const key of state.sessionDenied.keys()) {
    const { tool, subject } = splitAnswerKey(key);
    rules.push({
      step: 'session soft deny',
      ref: permissionRuleRef.answer(key),
      source: 'prompt-answer',
      action: tool,
      resource: subject,
      effect: 'deny',
      note: 'answered "no" earlier in this process',
    });
  }
  for (const [key, entry] of entries) {
    for (const pattern of entry.deny ?? []) {
      rules.push({
        step: 'trust deny',
        ref: permissionRuleRef.trust(key, pattern),
        source: 'trust-file',
        action: key,
        resource: pattern,
        effect: 'deny',
      });
    }
  }
  for (const [index, override] of state.overrides.entries()) {
    if (override.effect !== 'deny') continue;
    rules.push({
      step: 'session rule deny',
      ref: permissionRuleRef.session(index),
      source: 'session',
      action: override.tool,
      resource: override.pattern ?? '*',
      effect: 'deny',
    });
  }
  for (const key of state.sessionAllowed.keys()) {
    const { tool, subject } = splitAnswerKey(key);
    rules.push({
      step: 'session soft allow',
      ref: permissionRuleRef.answer(key),
      source: 'prompt-answer',
      action: tool,
      resource: subject,
      effect: 'allow',
      note: 'a one-time "yes", used by the next matching call',
    });
  }
  rules.push({
    step: 'tool default deny',
    source: 'tool',
    action: '*',
    resource: 'the tool declares permission "deny"',
    effect: 'deny',
  });
  for (const [index, override] of state.overrides.entries()) {
    if (override.effect !== 'allow') continue;
    rules.push({
      step: 'session rule allow',
      ref: permissionRuleRef.session(index),
      source: 'session',
      action: override.tool,
      resource: override.pattern ?? '*',
      effect: 'allow',
      note: 'destructive calls and sensitive reads still ask',
    });
  }
  const now = Date.now();
  const unexpired = (entry: TrustPolicy[string]) =>
    entry?.allowUntil === undefined || now < entry.allowUntil;
  for (const [key, entry] of entries) {
    if (!unexpired(entry)) continue;
    for (const pattern of (entry.allow ?? []).filter(isScopedApprovalPattern)) {
      rules.push({
        step: 'scoped trust',
        ref: permissionRuleRef.trust(key, pattern),
        source: 'trust-file',
        action: key,
        resource: describeScopedApproval(pattern),
        effect: 'allow',
        note: ['a destructive call still asks unless the approval was for that exact input']
          .concat(expiryNote(entry) ?? [])
          .join('; '),
      });
    }
  }
  for (const pattern of state.launchAllowedTools) {
    rules.push({
      step: 'scoped trust',
      ref: permissionRuleRef.allowedTools(pattern),
      source: 'allowed-tools',
      action: pattern,
      resource: '*',
      effect: 'allow',
      note: 'destructive calls and sensitive reads still ask',
    });
  }
  for (const [key, entry] of entries) {
    if (!unexpired(entry)) continue;
    for (const pattern of (entry.allow ?? []).filter((p) => !isScopedApprovalPattern(p))) {
      rules.push({
        step: 'trust allow',
        ref: permissionRuleRef.trust(key, pattern),
        source: 'trust-file',
        action: key,
        resource: pattern,
        effect: 'allow',
        note: expiryNote(entry),
      });
    }
  }
  for (const [key, entry] of entries) {
    if (!entry.auto) continue;
    rules.push({
      step: 'trust auto',
      ref: permissionRuleRef.trustAuto(key),
      source: 'trust-file',
      action: key,
      resource: '*',
      effect: 'allow',
    });
  }
  if (!state.yolo) {
    rules.push({
      step: 'sensitive read',
      source: 'built-in',
      action: '*',
      resource: 'a read of credentials or agent state',
      effect: 'ask',
    });
  } else {
    rules.push({
      step: 'yolo destructive gate',
      source: 'yolo',
      action: '*',
      resource: `a destructive call of a gated kind (${[...state.yoloConfirmKinds].sort().join(', ')})`,
      effect: 'ask',
      note: 'settings: autonomy.yoloConfirm',
    });
    rules.push({ step: 'yolo', source: 'yolo', action: '*', resource: '*', effect: 'allow' });
  }
  rules.push({
    step: 'write smart bypass',
    source: 'built-in',
    action: 'write',
    resource: 'a file read earlier in this session (not agent state)',
    effect: 'allow',
  });
  rules.push({
    step: 'safe default auto',
    source: 'tool',
    action: '*',
    resource: 'the tool declares "auto" and changes nothing',
    effect: 'allow',
  });
  rules.push({
    step: 'mutating default confirm',
    source: 'built-in',
    action: '*',
    resource: '*',
    effect: 'ask',
  });
  return rules;
}

/**
 * The full list for one conversation, numbered: the policy's own rules (the
 * directory wrapper puts its rules first), then the executor's gate.
 */
export async function compilePermissionRules(
  policy: Pick<PermissionPolicy, 'listRules'>,
  ctx?: AgentContext | undefined,
  opts: { yolo?: boolean | undefined } = {},
): Promise<PermissionRule[]> {
  const rules = [...((await policy.listRules?.(ctx)) ?? [])];
  if (!opts.yolo) {
    rules.push({
      step: 'dangerous capability',
      source: 'executor',
      action: 'a tool with a dangerous capability',
      resource: '*',
      effect: 'ask',
      note: 'a trust-file allow alone does not skip the prompt; a prompt approval, a session rule or --allowed-tools does',
    });
  }
  return rules.map((rule, index) => ({ n: index + 1, ...rule }));
}

/** The rule that decided a traced call, or `undefined` when none lines up. */
export function matchedPermissionRule(
  rules: readonly PermissionRule[],
  trace: PermissionTrace,
): PermissionRule | undefined {
  const winner = trace.steps[trace.winnerIndex];
  if (!winner) return undefined;
  const sameStep = rules.filter((rule) => rule.step === winner.rule);
  if (winner.ref !== undefined) return sameStep.find((rule) => rule.ref === winner.ref);
  return sameStep.find((rule) => rule.ref === undefined);
}

// ── refs for explain ───────────────────────────────────────────────────────

/** Trust-file keys consulted for a tool: its own, then the first wildcard key. */
function consultedKeys(
  state: Pick<TrustRuleState, 'policy' | 'wildcardEntries'>,
  toolName: string,
): { exact?: string | undefined; wildcard?: string | undefined } {
  const wildcard = state.wildcardEntries.find(({ pattern }) => matchGlob(pattern, toolName));
  return {
    ...(state.policy[toolName] ? { exact: toolName } : {}),
    ...(wildcard ? { wildcard: wildcard.pattern } : {}),
  };
}

/** The key whose `field` the merged entry uses (see `mergeTrustEntries`). */
function permissiveKey(
  state: Pick<TrustRuleState, 'policy' | 'wildcardEntries'>,
  toolName: string,
  field: 'allow' | 'auto',
): string | undefined {
  const { exact, wildcard } = consultedKeys(state, toolName);
  if (exact !== undefined && state.policy[exact]?.[field] !== undefined) return exact;
  return wildcard;
}

export function trustDenyRef(
  state: Pick<TrustRuleState, 'policy' | 'wildcardEntries'>,
  toolName: string,
  subject: string,
): string | undefined {
  const { exact, wildcard } = consultedKeys(state, toolName);
  for (const key of [exact, wildcard]) {
    if (key === undefined) continue;
    const pattern = state.policy[key]?.deny?.find((p) => matchesTrust([p], subject));
    if (pattern !== undefined) return permissionRuleRef.trust(key, pattern);
  }
  return undefined;
}

export function trustScopedRef(
  state: Pick<TrustRuleState, 'policy' | 'wildcardEntries'>,
  tool: Tool,
  input: unknown,
  ctx: AgentContext,
): string | undefined {
  const key = permissiveKey(state, tool.name, 'allow');
  if (key === undefined) return undefined;
  const pattern = (state.policy[key]?.allow ?? []).find(
    (p) => isScopedApprovalPattern(p) && matchingApprovalScope([p], tool, input, ctx) !== undefined,
  );
  return pattern === undefined ? undefined : permissionRuleRef.trust(key, pattern);
}

export function trustAllowRef(
  state: Pick<TrustRuleState, 'policy' | 'wildcardEntries'>,
  toolName: string,
  matches: (pattern: string) => boolean,
): string | undefined {
  const key = permissiveKey(state, toolName, 'allow');
  if (key === undefined) return undefined;
  const pattern = (state.policy[key]?.allow ?? []).find(
    (p) => !isScopedApprovalPattern(p) && matches(p),
  );
  return pattern === undefined ? undefined : permissionRuleRef.trust(key, pattern);
}

export function trustAutoRef(
  state: Pick<TrustRuleState, 'policy' | 'wildcardEntries'>,
  toolName: string,
): string | undefined {
  const key = permissiveKey(state, toolName, 'auto');
  return key === undefined ? undefined : permissionRuleRef.trustAuto(key);
}

export function allowedToolsRef(patterns: readonly string[], toolName: string): string | undefined {
  const pattern = patterns.find((p) =>
    p.endsWith('*') ? toolName.startsWith(p.slice(0, -1)) : p === toolName,
  );
  return pattern === undefined ? undefined : permissionRuleRef.allowedTools(pattern);
}
