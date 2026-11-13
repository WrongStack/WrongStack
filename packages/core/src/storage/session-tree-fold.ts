import type { ContentBlock } from '@wrongstack/contracts/types/blocks';
import type {
  SessionBranchDescriptor,
  SessionEvent,
  SessionTreeSnapshot,
} from '@wrongstack/contracts/types/session';
import { MAIN_BRANCH_ID } from './session-store/tree-replay.js';

export const BRANCH_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const DEFAULT_BRANCH_FOLD_MAX_TOKENS = 1_200;
const CHARS_PER_TOKEN_ESTIMATE = 4;
const FOLD_TRUNCATION_MARKER = '\n[...truncated to branchFoldMaxTokens budget]';

export function enforceFoldSummaryTokenCap(
  summary: string,
  maxTokens = DEFAULT_BRANCH_FOLD_MAX_TOKENS,
): string {
  const effectiveTokens =
    Number.isFinite(maxTokens) && maxTokens > 0
      ? Math.max(32, Math.floor(maxTokens))
      : DEFAULT_BRANCH_FOLD_MAX_TOKENS;
  const maxChars = effectiveTokens * CHARS_PER_TOKEN_ESTIMATE;
  if (summary.length <= maxChars) return summary;
  const budget = Math.max(16, maxChars - FOLD_TRUNCATION_MARKER.length);
  const slice = summary.slice(0, budget);
  const lastNewline = slice.lastIndexOf('\n');
  const lastSpace = slice.lastIndexOf(' ');
  const cutIndex =
    lastNewline >= Math.floor(budget * 0.6)
      ? lastNewline
      : lastSpace >= Math.floor(budget * 0.6)
        ? lastSpace
        : budget;
  return `${slice.slice(0, cutIndex).trimEnd()}${FOLD_TRUNCATION_MARKER}`;
}

/**
 * A branch's own events minus the prompts a `/rewind` undid. The rewind cuts
 * the journal after the target checkpoint, so that prompt's `user_input` (written
 * before its checkpoint) stays on disk; replay drops it on the `rewound` marker
 * (see `applyEventToBranchState`), and a fold summary must drop it the same way.
 */
export function survivingBranchEvents(branchEvents: readonly SessionEvent[]): SessionEvent[] {
  const kept: SessionEvent[] = [];
  let promptStart: number | null = null;
  for (const ev of branchEvents) {
    if (ev.type === 'user_input') {
      promptStart = kept.length;
    } else if (
      ev.type === 'messages_replaced' ||
      ev.type === 'context_snapshot' ||
      ev.type === 'messages_dropped'
    ) {
      promptStart = null;
    } else if (ev.type === 'rewound') {
      if (promptStart !== null) kept.length = promptStart;
      promptStart = null;
      continue;
    }
    kept.push(ev);
  }
  return kept;
}

export function extractBranchTouchedFiles(branchEvents: readonly SessionEvent[]): string[] {
  const touched = new Set<string>();
  for (const ev of branchEvents) {
    if (ev.type === 'file_snapshot') {
      for (const file of ev.files) touched.add(file.path);
    }
  }
  return [...touched].sort();
}

export function validateBranchName(
  rawName: string,
  tree: SessionTreeSnapshot,
  excludeId?: string,
): string {
  const name = rawName.trim();
  if (name === MAIN_BRANCH_ID) {
    throw new Error(`Branch name "${MAIN_BRANCH_ID}" is reserved for the root branch.`);
  }
  if (!BRANCH_NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid branch name "${rawName}". Use 1-64 lowercase alphanumeric, '.', '_', or '-' characters starting with [a-z0-9].`,
    );
  }
  for (const branch of Object.values(tree.branches)) {
    if (branch.id !== excludeId && branch.name === name) {
      throw new Error(`A branch named "${name}" already exists (${branch.id}).`);
    }
  }
  return name;
}

export function resolveBranch(tree: SessionTreeSnapshot, ref: string): SessionBranchDescriptor {
  const trimmed = ref.trim();
  const direct = tree.branches[trimmed];
  if (direct) return direct;
  const byName = Object.values(tree.branches).find((b) => b.name === trimmed);
  if (byName) return byName;
  throw new Error(`Unknown session branch: "${ref}"`);
}

function extractTextPreview(content: string | readonly ContentBlock[], maxChars = 240): string {
  const raw =
    typeof content === 'string'
      ? content
      : content
          .map((block) => (block.type === 'text' ? block.text : ''))
          .filter((t) => t.length > 0)
          .join(' ');
  const singleLine = raw.replace(/\s+/g, ' ').trim();
  if (singleLine.length <= maxChars) return singleLine;
  return `${singleLine.slice(0, maxChars - 1)}…`;
}

export function buildDeterministicFoldSummary(
  sourceBranch: SessionBranchDescriptor,
  branchEvents: readonly SessionEvent[],
  focusPrompt?: string,
): string {
  const userPrompts: string[] = [];
  const assistantNotes: string[] = [];
  const touchedFiles = new Set<string>();
  const toolsUsed = new Set<string>();

  for (const ev of branchEvents) {
    if (ev.type === 'user_input') {
      const text = extractTextPreview(ev.content, 200);
      if (text) userPrompts.push(text);
    } else if (ev.type === 'message_appended' && ev.version === 1) {
      if (ev.message.role === 'user') {
        const isToolResultOnly =
          Array.isArray(ev.message.content) &&
          ev.message.content.length > 0 &&
          ev.message.content.every((b) => b.type === 'tool_result');
        if (!isToolResultOnly) {
          const text = extractTextPreview(ev.message.content, 200);
          if (text && userPrompts[userPrompts.length - 1] !== text) userPrompts.push(text);
        }
      } else if (ev.message.role === 'assistant') {
        const text = extractTextPreview(ev.message.content, 320);
        if (text) assistantNotes.push(text);
      }
    } else if (ev.type === 'llm_response') {
      const text = extractTextPreview(ev.content, 320);
      if (text) assistantNotes.push(text);
      for (const block of ev.content) {
        if (block.type === 'tool_use') toolsUsed.add(block.name);
      }
    } else if (ev.type === 'tool_call_start') {
      toolsUsed.add(ev.name);
    } else if (ev.type === 'file_snapshot') {
      for (const file of ev.files) touchedFiles.add(file.path);
    }
  }

  const lines: string[] = [];
  if (focusPrompt?.trim()) {
    lines.push(`Focus: ${focusPrompt.trim()}`);
  }
  lines.push(
    `Explored ${userPrompts.length} prompt(s) on branch "${sourceBranch.name}" (${sourceBranch.id}).`,
  );
  if (userPrompts.length > 0) {
    lines.push('Prompts investigated:');
    for (const prompt of userPrompts.slice(0, 5)) {
      lines.push(`- ${prompt}`);
    }
  }
  if (toolsUsed.size > 0) {
    lines.push(`Tools exercised: ${[...toolsUsed].sort().join(', ')}`);
  }
  if (touchedFiles.size > 0) {
    lines.push(`Files touched during exploration: ${[...touchedFiles].sort().join(', ')}`);
  }
  if (assistantNotes.length > 0) {
    const conclusion = assistantNotes[assistantNotes.length - 1]!;
    lines.push(`Latest conclusion: ${conclusion}`);
  }
  return lines.join('\n');
}

export function buildFoldSynthesisPrompt(
  sourceBranch: SessionBranchDescriptor,
  digest: string,
  focusPrompt?: string,
  additionalInstructions?: string,
): string {
  return [
    `Summarize the findings from exploratory session branch "${sourceBranch.name}" so they can be folded back into the parent branch.`,
    'Keep the summary concise, factual, and actionable (decisions, dead-ends ruled out, files/APIs identified).',
    ...(focusPrompt?.trim() ? [`Prioritize this focus: ${focusPrompt.trim()}`] : []),
    ...(additionalInstructions?.trim()
      ? [`Additional guidance:\n${additionalInstructions.trim()}`]
      : []),
    '',
    'Branch activity digest:',
    digest,
  ].join('\n');
}
