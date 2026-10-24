import { createHash } from 'node:crypto';
import type { Message } from '@wrongstack/contracts/types';
import type { Context } from '@wrongstack/core/agent';
import type { ToolRegistry } from '@wrongstack/core/registry';
import {
  rehydrateContextEvidenceFromMessages,
  repairToolUseAdjacency,
} from '@wrongstack/core/utils';
import type {
  ContextEditorAppliedResult,
  ContextEditorDiagnostics,
  ContextEditorMessage,
  ContextEditorMetrics,
  ContextEditorRemoval,
  ContextEditorRepairPreview,
  ContextEditorSnapshot,
  ContextEditorValidationError,
  ContextEditorValidationResult,
  ContextEditorWarning,
} from './context-editor-types.js';
import {
  error,
  isRecord,
  splitsSurrogatePair,
  validateContextEditorMessages,
} from './context-editor-validation.js';
import { estimateContextBreakdown, messageTokens } from './token-estimator.js';

const REVISION_PREFIX = 'wrongstack-context-editor-v1\0';
const MAX_REMOVAL_COUNT = 4096;
// Host bookkeeping the snapshot round-trip cannot carry: the validator drops
// these block keys, and the snapshot never sends `origin` / `authoredLength`.
// Applied messages come from the server's originals, so they are kept there.
const HOST_BLOCK_KEYS = new Set([
  '_estTokens',
  '_toolErrorInfo',
  '_kanbanBoundary',
  '_resultFormat',
]);

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      if (HOST_BLOCK_KEYS.has(key)) continue;
      const item = value[key];
      if (item === undefined) continue;
      sorted[key] = canonicalize(item);
    }
    return sorted;
  }
  return value;
}

function canonicalizeMessages(messages: readonly Message[]): unknown[] {
  return messages.map(({ origin: _origin, authoredLength: _authoredLength, ...editableMessage }) =>
    canonicalize(editableMessage),
  );
}

export function contextEditorRevision(messages: readonly Message[]): string {
  const hash = createHash('sha256');
  hash.update(REVISION_PREFIX);
  hash.update(JSON.stringify(canonicalizeMessages(messages)));
  return hash.digest('hex');
}

function countBlocks(messages: readonly Message[]): number {
  let total = 0;
  for (const message of messages)
    total += Array.isArray(message.content) ? message.content.length : 1;
  return total;
}

function toolDiagnostics(messages: readonly Message[]): ContextEditorDiagnostics {
  const repair = repairToolUseAdjacency([...messages]);
  let thinkingBlocks = 0;
  let signedThinkingBlocks = 0;
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type !== 'thinking') continue;
      thinkingBlocks++;
      if (block.signature) signedThinkingBlocks++;
    }
  }
  return {
    hasToolAdjacencyIssues: repair.report.changed,
    orphanToolUses: repair.report.removedToolUses,
    orphanToolResults: repair.report.removedToolResults,
    emptyMessages: repair.report.removedMessages,
    thinkingBlocks,
    signedThinkingBlocks,
  };
}

function warningsForMessage(message: Message, index: number): ContextEditorWarning[] {
  const warnings: ContextEditorWarning[] = [];
  if (!Array.isArray(message.content)) return warnings;
  message.content.forEach((block, blockIndex) => {
    if (block.type === 'thinking' && block.signature) {
      warnings.push({
        path: `/messages/${index}/content/${blockIndex}`,
        code: 'SIGNED_THINKING_PRESENT',
        severity: 'warning',
        message:
          'This block contains provider replay metadata and should only be removed with the whole turn if no longer needed.',
      });
    }
    if (block.type === 'image' && block.source.type === 'url') {
      warnings.push({
        path: `/messages/${index}/content/${blockIndex}/source/url`,
        code: 'UNSAFE_IMAGE_URL',
        severity: 'danger',
        message:
          'URL image sources cannot be retained in context editor proposals; remove the whole message before applying other edits.',
      });
    }
    if (block.type === 'tool_result' && block.content.length > 20_000) {
      warnings.push({
        path: `/messages/${index}/content/${blockIndex}`,
        code: 'LARGE_TOOL_RESULT',
        severity: 'info',
        message: 'Large tool result; inspect before removing.',
      });
    }
  });
  return warnings;
}

function collectWarnings(messages: readonly Message[]): ContextEditorWarning[] {
  return messages.flatMap((message, index) => warningsForMessage(message, index));
}

function metricFor(
  ctx: Context,
  messages: readonly Message[],
  tools: ReturnType<ToolRegistry['list']> | undefined,
): ContextEditorMetrics {
  const breakdown = estimateContextBreakdown({
    systemPrompt: ctx.systemPrompt,
    tools: tools ?? ctx.tools ?? [],
    messages,
  });
  return {
    messages: messages.length,
    blocks: countBlocks(messages),
    messageTokens: breakdown.messages.total,
    fullRequestTokens: breakdown.total,
  };
}

function isToolResultMessage(message: Message | undefined): boolean {
  return Boolean(
    message?.role === 'user' &&
      Array.isArray(message.content) &&
      message.content.length > 0 &&
      message.content.every((block) => block.type === 'tool_result'),
  );
}

function pairedAssistantIndices(messages: readonly Message[], userIndex: number): number[] {
  if (messages[userIndex]?.role !== 'user' || isToolResultMessage(messages[userIndex])) return [];
  const paired: number[] = [];
  for (let index = userIndex + 1; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.role === 'user' && !isToolResultMessage(message)) break;
    if (message?.role === 'assistant') paired.push(index);
  }
  return paired;
}

export function buildContextEditorSnapshot(
  ctx: Context,
  tools: ReturnType<ToolRegistry['list']> | undefined,
): ContextEditorSnapshot {
  const messages = ctx.messages.map(
    (message): ContextEditorMessage => ({
      role: message.role,
      content: message.content,
      ...(message.ts ? { ts: message.ts } : {}),
    }),
  );
  const breakdown = estimateContextBreakdown({
    systemPrompt: ctx.systemPrompt,
    tools: tools ?? ctx.tools ?? [],
    messages: ctx.messages,
  });
  return {
    revision: contextEditorRevision(ctx.messages),
    messages,
    readonlyContext: {
      systemPromptTokens: breakdown.systemPrompt,
      toolSchemaTokens: breakdown.tools.total,
      toolCount: breakdown.tools.count,
      totalTokens: breakdown.total,
      messageTokens: breakdown.messages.total,
    },
    messageBreakdown: ctx.messages.map((message, index) => ({
      index,
      role: message.role,
      tokens: messageTokens(message.content),
      preview: breakdown.messages.breakdown[index]?.preview ?? '',
      blockCount: Array.isArray(message.content) ? message.content.length : null,
      warnings: warningsForMessage(message, index),
      pairedAssistantIndices: pairedAssistantIndices(ctx.messages, index),
    })),
    diagnostics: toolDiagnostics(ctx.messages),
  };
}

function validateRemovalPlan(
  value: unknown,
  originalMessages: readonly Message[],
  proposedMessages: readonly Message[],
): { errors: ContextEditorValidationError[]; messages?: Message[] | undefined } {
  const errors: ContextEditorValidationError[] = [];
  if (value === undefined) {
    error(
      errors,
      '/removals',
      'REMOVAL_PLAN_REQUIRED',
      'A removal plan is required for every context editor proposal.',
    );
    return { errors };
  }
  if (!Array.isArray(value)) {
    error(errors, '/removals', 'INVALID_REMOVALS', 'removals must be an array.');
    return { errors };
  }
  if (value.length > MAX_REMOVAL_COUNT) {
    error(
      errors,
      '/removals',
      'TOO_MANY_REMOVALS',
      `removals must contain at most ${MAX_REMOVAL_COUNT} entries.`,
    );
    return { errors };
  }
  const wholeMessages = new Set<number>();
  const touchedUsers = new Set<number>();
  const ranges: ContextEditorRemoval[] = [];
  for (const [removalIndex, raw] of value.entries()) {
    const path = `/removals/${removalIndex}`;
    if (!isRecord(raw) || !Number.isInteger(raw['messageIndex'])) {
      error(errors, path, 'INVALID_REMOVAL', 'Removal must include an integer messageIndex.');
      continue;
    }
    const messageIndex = raw['messageIndex'] as number;
    const original = originalMessages[messageIndex];
    if (!original) {
      error(
        errors,
        `${path}/messageIndex`,
        'INVALID_MESSAGE_INDEX',
        'Removal messageIndex is out of range.',
      );
      continue;
    }
    const start = raw['start'];
    const end = raw['end'];
    const blockIndex = raw['blockIndex'];
    if (start === undefined && end === undefined && blockIndex === undefined) {
      wholeMessages.add(messageIndex);
      if (original.role === 'user') touchedUsers.add(messageIndex);
      continue;
    }
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      (start as number) < 0 ||
      (end as number) <= (start as number)
    ) {
      error(
        errors,
        path,
        'INVALID_RANGE',
        'Range removal requires integer start/end with 0 <= start < end.',
      );
      continue;
    }
    let text: string | undefined;
    if (blockIndex === undefined && typeof original.content === 'string') text = original.content;
    if (Number.isInteger(blockIndex) && Array.isArray(original.content)) {
      const block = original.content[blockIndex as number];
      if (block?.type === 'text') text = block.text;
    }
    if (text === undefined || (end as number) > text.length) {
      error(
        errors,
        path,
        'INVALID_RANGE_TARGET',
        'Range must target existing string or text-block content.',
      );
      continue;
    }
    if (splitsSurrogatePair(text, start as number) || splitsSurrogatePair(text, end as number)) {
      error(
        errors,
        path,
        'INVALID_UNICODE_RANGE',
        'Range boundaries must not split a Unicode surrogate pair.',
      );
      continue;
    }
    ranges.push({
      messageIndex,
      ...(blockIndex === undefined ? {} : { blockIndex: blockIndex as number }),
      start: start as number,
      end: end as number,
    });
    if (original.role === 'user') touchedUsers.add(messageIndex);
  }
  const rangesByTarget = new Map<string, ContextEditorRemoval[]>();
  for (const range of ranges) {
    const key = `${range.messageIndex}:${range.blockIndex ?? 'string'}`;
    const targetRanges = rangesByTarget.get(key) ?? [];
    targetRanges.push(range);
    rangesByTarget.set(key, targetRanges);
  }
  for (const targetRanges of rangesByTarget.values()) {
    targetRanges.sort((left, right) => (left.start ?? 0) - (right.start ?? 0));
    for (let index = 1; index < targetRanges.length; index += 1) {
      const previous = targetRanges[index - 1];
      const current = targetRanges[index];
      if (
        previous?.end !== undefined &&
        current?.start !== undefined &&
        current.start < previous.end
      ) {
        error(
          errors,
          '/removals',
          'OVERLAPPING_RANGES',
          'Removal ranges targeting the same text must not overlap.',
        );
        break;
      }
    }
  }
  for (const userIndex of touchedUsers) {
    for (const assistantIndex of pairedAssistantIndices(originalMessages, userIndex)) {
      if (wholeMessages.has(assistantIndex)) continue;
      error(
        errors,
        '/removals',
        'MISSING_ASSISTANT_PAIR',
        `Editing user message ${userIndex} must also remove assistant message ${assistantIndex}.`,
      );
    }
  }
  const expectedMessages = structuredClone(originalMessages) as Message[];
  for (const targetRanges of rangesByTarget.values()) {
    const first = targetRanges[0];
    if (!first) continue;
    const message = expectedMessages[first.messageIndex];
    if (!message) continue;
    let text: string | undefined;
    if (first.blockIndex === undefined && typeof message.content === 'string') {
      text = message.content;
    } else if (first.blockIndex !== undefined && Array.isArray(message.content)) {
      const block = message.content[first.blockIndex];
      if (block?.type === 'text') text = block.text;
    }
    if (text === undefined) continue;
    const pieces: string[] = [];
    let cursor = 0;
    for (const range of targetRanges) {
      if (range.start === undefined || range.end === undefined) continue;
      pieces.push(text.slice(cursor, range.start));
      cursor = range.end;
    }
    pieces.push(text.slice(cursor));
    const nextText = pieces.join('');
    if (first.blockIndex === undefined && typeof message.content === 'string') {
      message.content = nextText;
    } else if (first.blockIndex !== undefined && Array.isArray(message.content)) {
      const block = message.content[first.blockIndex];
      if (block?.type === 'text') block.text = nextText;
    }
  }
  const expectedProposal = expectedMessages.filter((_, index) => !wholeMessages.has(index));
  if (
    JSON.stringify(canonicalizeMessages(expectedProposal)) !==
    JSON.stringify(canonicalizeMessages(proposedMessages))
  ) {
    error(
      errors,
      '/messages',
      'REMOVAL_PLAN_MISMATCH',
      'Submitted messages do not exactly match the declared removal plan.',
    );
  }
  return errors.length > 0 ? { errors } : { errors, messages: expectedProposal };
}

export function validateContextEditorProposal(input: {
  ctx: Context;
  tools?: ReturnType<ToolRegistry['list']> | undefined;
  baseRevision: string;
  messages: unknown;
  removals: unknown;
  allowRepair: boolean;
  runActive?: boolean | undefined;
}): ContextEditorValidationResult {
  const currentRevision = contextEditorRevision(input.ctx.messages);
  const before = metricFor(input.ctx, input.ctx.messages, input.tools);
  const emptyRepair: ContextEditorRepairPreview = {
    changed: false,
    removedToolUses: [],
    removedToolResults: [],
    removedMessages: 0,
  };
  if (input.runActive) {
    return {
      ok: false,
      baseRevision: input.baseRevision,
      currentRevision,
      before,
      validationErrors: [],
      warnings: [],
      repair: emptyRepair,
      conflict: {
        code: 'RUN_ACTIVE',
        message: 'The agent is currently running. Abort or wait before applying context edits.',
      },
    };
  }
  if (input.baseRevision !== currentRevision) {
    return {
      ok: false,
      baseRevision: input.baseRevision,
      currentRevision,
      before,
      validationErrors: [],
      warnings: [],
      repair: emptyRepair,
      conflict: {
        code: 'CONTEXT_REVISION_CONFLICT',
        message: 'Context changed while the editor was open. Reload before applying.',
      },
    };
  }
  const parsed = validateContextEditorMessages(input.messages, input.ctx.messages.length);
  if (parsed.errors.length > 0) {
    return {
      ok: false,
      baseRevision: input.baseRevision,
      currentRevision,
      before,
      validationErrors: parsed.errors,
      warnings: [],
      repair: emptyRepair,
    };
  }
  const removalPlan = validateRemovalPlan(input.removals, input.ctx.messages, parsed.messages);
  if (removalPlan.errors.length > 0 || !removalPlan.messages) {
    return {
      ok: false,
      baseRevision: input.baseRevision,
      currentRevision,
      before,
      validationErrors: removalPlan.errors,
      warnings: [],
      repair: emptyRepair,
    };
  }
  const repaired = repairToolUseAdjacency(removalPlan.messages);
  const repair: ContextEditorRepairPreview = {
    changed: repaired.report.changed,
    removedToolUses: repaired.report.removedToolUses,
    removedToolResults: repaired.report.removedToolResults,
    removedMessages: repaired.report.removedMessages,
  };
  const finalMessages = repaired.messages;
  const warnings = collectWarnings(finalMessages);
  const after = metricFor(input.ctx, finalMessages, input.tools);
  if (repaired.report.changed && !input.allowRepair) {
    return {
      ok: false,
      baseRevision: input.baseRevision,
      currentRevision,
      before,
      after,
      validationErrors: [],
      warnings,
      repair,
    };
  }
  return {
    ok: true,
    baseRevision: input.baseRevision,
    currentRevision,
    before,
    after,
    validationErrors: [],
    warnings,
    repair,
    messages: finalMessages,
  };
}

export async function applyContextEditorProposal(input: {
  ctx: Context;
  tools?: ReturnType<ToolRegistry['list']> | undefined;
  baseRevision: string;
  messages: unknown;
  removals: unknown;
  allowRepair: boolean;
  runActive?: boolean | undefined;
}): Promise<ContextEditorValidationResult | ContextEditorAppliedResult> {
  const validation = validateContextEditorProposal(input);
  if (!validation.ok || !validation.messages || !validation.after) return validation;
  const previousRevision = validation.currentRevision;
  const beforeMessages = input.ctx.messages.length;
  const beforeBlocks = countBlocks(input.ctx.messages);
  input.ctx.state.replaceMessages(validation.messages);
  rehydrateContextEvidenceFromMessages(input.ctx, validation.messages);
  await input.ctx.flushConversationJournal?.();
  input.ctx.lastRequestTokens = undefined;
  input.ctx.lastRealInputTokens = undefined;
  input.ctx.state.deleteMeta?.('lastRequestTokensAt');
  input.ctx.state.deleteMeta?.('realAnchorMsgCount');
  input.ctx.readFiles.clear();
  input.ctx.fileMtimes.clear();
  const revision = contextEditorRevision(input.ctx.messages);
  const after = metricFor(input.ctx, input.ctx.messages, input.tools);
  const afterBlocks = countBlocks(input.ctx.messages);
  return {
    previousRevision,
    revision,
    before: validation.before,
    after,
    removed: {
      messages: Math.max(0, beforeMessages - input.ctx.messages.length),
      blocks: Math.max(0, beforeBlocks - afterBlocks),
      toolUses: validation.repair.removedToolUses,
      toolResults: validation.repair.removedToolResults,
      emptyMessages: validation.repair.removedMessages,
    },
    warnings: validation.warnings,
  };
}
export type {
  ContextEditorAppliedResult,
  ContextEditorBlock,
  ContextEditorConflict,
  ContextEditorDiagnostics,
  ContextEditorMessage,
  ContextEditorMetrics,
  ContextEditorRepairPreview,
  ContextEditorSnapshot,
  ContextEditorValidationError,
  ContextEditorValidationResult,
  ContextEditorWarning,
} from './context-editor-types.js';
export { validateContextEditorMessages } from './context-editor-validation.js';
