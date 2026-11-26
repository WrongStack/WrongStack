import type { AcpSessionPlan } from '@wrongstack/contracts/types/acp-runtime';
import { sanitizeTerminalPreview } from '@wrongstack/core/utils';
import type { PlanEntry } from '../types/acp-v1.js';
import { isRecord } from './acp-session-content.js';

const MAX_PLANS = 64;
const MAX_ENTRIES = 256;
const MAX_ENTRY_CHARS = 2_000;
const MAX_MARKDOWN_CHARS = 64_000;

export function readPlanEntries(input: unknown): PlanEntry[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const entries: PlanEntry[] = [];
  for (const raw of input.slice(0, MAX_ENTRIES)) {
    if (!isRecord(raw)) continue;
    const { content, status, priority } = raw;
    if (
      typeof content !== 'string' ||
      (status !== 'completed' && status !== 'in_progress' && status !== 'pending') ||
      (priority !== 'high' && priority !== 'medium' && priority !== 'low')
    ) {
      continue;
    }
    const safe = sanitizeTerminalPreview(content, {
      maxChars: MAX_ENTRY_CHARS,
      maxLines: MAX_ENTRY_CHARS,
    }).text.trim();
    if (safe) entries.push({ content: safe, status, priority });
  }
  return input.length > 0 && entries.length === 0 ? undefined : entries;
}

export function applyPlanUpdate(
  plans: Map<string | null, AcpSessionPlan>,
  update: Record<string, unknown>,
  identifiedPlansSupported: boolean,
): boolean {
  if (update.sessionUpdate === 'plan') {
    const entries = readPlanEntries(update.entries);
    if (!entries) return false;
    plans.set(null, { type: 'items', planId: null, entries });
    return true;
  }
  if (!identifiedPlansSupported) return false;
  if (update.sessionUpdate === 'plan_removed') {
    if (typeof update.planId !== 'string') return false;
    const planId = update.planId.trim();
    return planId.length > 0 && plans.delete(planId);
  }
  if (update.sessionUpdate !== 'plan_update' || !isRecord(update.plan)) return false;
  const { planId: rawPlanId, type, entries, content } = update.plan;
  if (typeof rawPlanId !== 'string') return false;
  const planId = rawPlanId.trim();
  if (!planId || planId.length > 500) return false;
  if (!plans.has(planId) && plans.size >= MAX_PLANS) return false;
  if (type === 'items') {
    const parsed = readPlanEntries(entries);
    if (!parsed) return false;
    plans.set(planId, { type, planId, entries: parsed });
    return true;
  }
  if (type === 'markdown' && typeof content === 'string') {
    const safe = sanitizeTerminalPreview(content, {
      maxChars: MAX_MARKDOWN_CHARS,
      maxLines: MAX_MARKDOWN_CHARS,
    }).text;
    plans.set(planId, { type, planId, content: safe });
    return true;
  }
  return false;
}
