/**
 * Text views of the permission rule list and of one explained call, shared by
 * `wstack permissions` and the in-session `/permissions` command.
 */

import type {
  PermissionPolicy,
  PermissionRule,
  PermissionTrace,
  Tool,
} from '@wrongstack/contracts/types';
import type { Context } from '@wrongstack/core/agent';
import {
  compilePermissionRules,
  matchedPermissionRule,
  withExecutorGate,
} from '@wrongstack/core/security';

export interface ExplainedCall {
  trace: PermissionTrace;
  rules: PermissionRule[];
  /** The rule that decided the call. */
  rule: PermissionRule | undefined;
}

/** Trace one call through the policy and the executor's gate, and name its rule. */
export async function explainCall(
  policy: Pick<PermissionPolicy, 'explain' | 'listRules'>,
  tool: Tool,
  input: unknown,
  ctx: Context,
  yolo: boolean,
): Promise<ExplainedCall> {
  if (!policy.explain) throw new Error('This permission policy cannot explain its decisions.');
  const trace = withExecutorGate(await policy.explain(tool, input, ctx), tool, yolo);
  const rules = await compilePermissionRules(policy, ctx, { yolo });
  return { trace, rules, rule: matchedPermissionRule(rules, trace) };
}

/** `*` reads as "every": say so (and keep it out of markdown emphasis). */
function actionText(rule: PermissionRule): string {
  return rule.action === '*' ? 'any tool' : rule.action;
}

function resourceText(rule: PermissionRule): string {
  return rule.resource === '*' ? 'any input' : rule.resource;
}

export function describePermissionRule(rule: PermissionRule): string {
  return `#${rule.n} ${rule.effect} ${actionText(rule)} → ${resourceText(rule)} (${rule.source})`;
}

export function formatPermissionRules(rules: readonly PermissionRule[]): string {
  const width = String(rules.length).length;
  const lines = ['Permission rules, in the order they are checked; the first match decides:', ''];
  for (const rule of rules) {
    lines.push(
      `  ${String(rule.n).padStart(width)}. ${rule.effect.padEnd(5)} ${rule.source.padEnd(15)} ${actionText(rule)} → ${resourceText(rule)}`,
    );
    if (rule.note) lines.push(`  ${' '.repeat(width)}  ${' '.repeat(22)}${rule.note}`);
  }
  return lines.join('\n');
}

export function formatExplainedCall({ trace, rule }: ExplainedCall): string {
  const lines: string[] = [];
  lines.push(`Permission trace for "${trace.toolName}"`);
  lines.push(`Subject: ${trace.subject ?? '(none)'}`);
  lines.push('');

  for (let i = 0; i < trace.steps.length; i++) {
    const step = trace.steps[i];
    if (!step) continue;
    const winner = i === trace.winnerIndex ? ' ← WINNER' : '';
    const matched = step.matched ? '✓' : ' ';
    lines.push(`  ${matched} [${i}] ${step.rule}${winner}`);
    lines.push(`        decision: ${step.decision}  source: ${step.source}`);
    lines.push(`        ${step.detail}`);
    if (i < trace.steps.length - 1) lines.push('');
  }

  lines.push('');
  lines.push(`Effective: ${trace.decision.permission} (source: ${trace.decision.source})`);
  if (rule) lines.push(`Rule: ${describePermissionRule(rule)}`);
  if (trace.decision.reason) lines.push(`Reason: ${trace.decision.reason}`);
  if (trace.decision.riskTier) lines.push(`Risk tier: ${trace.decision.riskTier}`);
  return lines.join('\n');
}
