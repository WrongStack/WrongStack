import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { activeLimits, positiveLimit } from '@wrongstack/contracts/types/config/limits';
import type { TaskResult } from '@wrongstack/contracts/types/multi-agent';
import { safeParse } from '../../utils/safe-json.js';
import { formatSubagentStructuredReport } from '../subagent-result-tool.js';
import type {
  DelegateResult,
  DelegationRuntimeOptions,
  SubagentPartial,
} from './delegation-types.js';

/**
 * Per-kind orchestrator hint. Returned alongside the structured error so the
 * calling model has a concrete next step. Undefined for success / unknown.
 */
export function hintForKind(
  kind: string | undefined,
  retryable: boolean | undefined,
  backoffMs: number | undefined,
  partial?: { lastAssistantText?: string | undefined } | undefined,
): string | undefined {
  if (!kind) return undefined;
  switch (kind) {
    case 'provider_rate_limit':
      return `Provider rate-limited. Retry safe after ${backoffMs ?? 5000}ms backoff. Consider a smaller model or fewer parallel delegates.`;
    case 'provider_5xx':
      return `Provider server error. Retry safe after ${backoffMs ?? 3000}ms backoff — usually transient.`;
    case 'provider_timeout':
      return 'Provider network timeout. Retry safe; reduce input size if it persists.';
    case 'provider_auth':
      return 'Provider rejected credentials. Cannot retry — fix the API key / config and re-invoke.';
    case 'provider_quota':
      return 'The worker\'s usage quota is spent. Do not retry it before the reset named in the error; delegate this task to a WrongStack model instead (omit provider "acp"), or tell the user.';
    case 'context_overflow':
      return 'Subagent context exceeded the model limit. Narrow the task, use a larger-context model, or split into multiple delegates.';
    case 'budget_iterations':
    case 'budget_tool_calls':
    case 'budget_tokens':
    case 'budget_cost': {
      const base =
        'Subagent exhausted its budget. The coordinator may auto-extend; otherwise raise the matching `max*` field (e.g. maxToolCalls: 600) on the next delegate, or split the task.';
      if (partial?.lastAssistantText) {
        return `${base}\n\nPartial output produced before budget hit:\n${partial.lastAssistantText}`;
      }
      return base;
    }
    case 'budget_timeout': {
      const base =
        'Subagent hit its wall-clock budget. Raise `timeoutMs` on the next delegate or split the task.';
      if (partial?.lastAssistantText) {
        return `${base}\n\nPartial output produced before timeout:\n${partial.lastAssistantText}`;
      }
      return base;
    }
    case 'aborted_by_parent':
      return 'Subagent was aborted (user Ctrl+C, parent unwound, or sibling failure cascade). Not retryable until the abort condition is resolved.';
    case 'empty_response':
      return 'Subagent ended its turn with no text and no tool calls. Almost always a prompt / config issue — clarify the task or check the model.';
    case 'tool_failed': {
      const base = 'A tool inside the subagent returned ok:false. Retry with corrected inputs.';
      if (partial?.lastAssistantText) {
        return `${base}\n\nAgent reasoning before failure:\n${partial.lastAssistantText}`;
      }
      return base;
    }
    case 'bridge_failed':
      return 'Parent-child bridge transport failed. This is rare — restart the session and retry.';
    default:
      return retryable
        ? 'Failure classified as retryable. Try again with the same input.'
        : undefined;
  }
}

/**
 * Compact summary of what a subagent did — shown in chat history so the user
 * immediately sees the outcome without parsing the full result.
 */
export function buildDelegateSummary(role: string | undefined, result: TaskResult): string {
  const roleLabel = role ?? 'subagent';
  const ms = result.durationMs;
  // Round first, then pick the unit, so 59.7s is "1m" and 59m50s "1.0h" (never "60s"/"60m").
  const duration =
    Math.round(ms / 1000) < 60
      ? `${Math.round(ms / 1000)}s`
      : Math.round(ms / 60_000) < 60
        ? `${Math.round(ms / 60_000)}m`
        : `${(ms / 3_600_000).toFixed(1)}h`;

  if (result.status === 'success') {
    const preview = result.report?.summary
      ? result.report.summary.trim().slice(0, 120).replace(/\n+/g, ' ')
      : typeof result.result === 'string'
        ? result.result.trim().slice(0, 120).replace(/\n+/g, ' ')
        : null;
    const tail = preview ? ` — ${preview}` : '';
    return `[${roleLabel}] done in ${duration} (${result.iterations} iter, ${result.toolCalls} tools)${tail}`;
  }

  const errLabel = result.error?.kind ?? result.status;
  return `[${roleLabel}] ${result.status} after ${duration} (${result.iterations} iter, ${result.toolCalls} tools) — ${errLabel}`;
}

/** Max characters of a delegation result persisted / delivered as an excerpt. */
export const DELEGATION_RESULT_EXCERPT_CHARS = 4_000;

/**
 * Bounded text rendering of a settled delegation, structured report first.
 * Used for the journal `resultExcerpt` and the leader delivery block.
 */
export function buildDelegationResultExcerpt(
  result: DelegateResult,
  maxChars = positiveLimit(activeLimits().subagentResultChars) ?? DELEGATION_RESULT_EXCERPT_CHARS,
): string {
  let text = '';
  if (result.report) {
    try {
      text = formatSubagentStructuredReport(result.report);
    } catch {
      text = '';
    }
  }
  if (!text) {
    if (typeof result.result === 'string') text = result.result;
    else if (result.result !== undefined) {
      try {
        text = JSON.stringify(result.result, null, 2);
      } catch {
        text = String(result.result);
      }
    }
  }
  if (!text && result.error !== undefined) {
    const e = result.error as { kind?: string; message?: string } | string;
    text = typeof e === 'string' ? e : `${e.kind ?? 'error'}: ${e.message ?? ''}`;
  }
  if (!text) {
    const partial = result.partial as { lastAssistantText?: string } | undefined;
    text = partial?.lastAssistantText ?? '';
  }
  text = text.trim();
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

/**
 * Parse the per-subagent JSONL at `<sessionsRoot>/<runId>/<subagentId>.jsonl`
 * and pull out the last useful pieces — the most recent assistant text, the
 * stop reason, and a count of tool calls — so a timed-out / budget-exhausted
 * worker still returns what it did.
 */
export async function readSubagentPartial(
  opts: Pick<DelegationRuntimeOptions, 'sessionsRoot' | 'directorRunId'>,
  subagentId: string,
): Promise<SubagentPartial | undefined> {
  if (!opts.sessionsRoot) return undefined;
  const candidates: string[] = [];
  if (opts.directorRunId) {
    candidates.push(path.join(opts.sessionsRoot, opts.directorRunId, `${subagentId}.jsonl`));
  } else {
    try {
      const entries = await fsp.readdir(opts.sessionsRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          candidates.push(path.join(opts.sessionsRoot, entry.name, `${subagentId}.jsonl`));
        }
      }
    } catch {
      return undefined;
    }
  }
  for (const file of candidates) {
    let raw: string;
    try {
      raw = await fsp.readFile(file, 'utf8');
    } catch {
      continue;
    }
    const lines = raw.split('\n').filter((l) => l.trim());
    let lastAssistantText: string | undefined;
    let lastStopReason: string | undefined;
    let toolUses = 0;
    for (const line of lines) {
      try {
        const parsed = safeParse<{
          type: string;
          content?: unknown | undefined;
          stopReason?: string | undefined;
          name?: string | undefined;
        }>(line);
        if (!parsed.ok || !parsed.value) continue;
        const ev = parsed.value;
        if (ev.type === 'tool_use') toolUses += 1;
        if (ev.type === 'llm_response') {
          if (typeof ev.stopReason === 'string') lastStopReason = ev.stopReason;
          if (Array.isArray(ev.content)) {
            const txt = (
              ev.content as Array<{ type?: string | undefined; text?: string | undefined }>
            )
              .filter((b) => b.type === 'text')
              .map((b) => b.text ?? '')
              .join('\n')
              .trim();
            if (txt) lastAssistantText = txt;
          }
        }
      } catch {
        // best-effort: one corrupt JSONL line must not invalidate the transcript
      }
    }
    return { lastAssistantText, lastStopReason, toolUsesObserved: toolUses, events: lines.length };
  }
  return undefined;
}
