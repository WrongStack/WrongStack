import type {
  ContentBlock,
  ToolResultBlock,
  ToolUseBlock,
} from '@wrongstack/contracts/types/blocks';
import type { Logger } from '@wrongstack/contracts/types/logger';
import type { Message } from '@wrongstack/contracts/types/messages';
import { isElidedResultContent, isElidedToolInput } from '../utils/elision-markers.js';
import { hasMeaningfulContent } from '../utils/message-invariants.js';
import {
  estimateMessageTokens,
  estimateToolInputTokens,
  estimateToolResultTokens,
} from '../utils/token-estimate.js';
import {
  extractPathHints,
  summarizeToolResultElision,
  summarizeToolUseInputElision,
} from './compaction-elision-summaries.js';
import { analyzeFileToolLifecycle } from './compaction-file-lifecycle.js';

export {
  summarizeToolResultElision,
  summarizeToolUseInputElision,
} from './compaction-elision-summaries.js';
export type { FileToolLifecycle } from './compaction-file-lifecycle.js';
export { normalizePathKey, readPathOf } from './compaction-file-lifecycle.js';

export interface CompactionMetrics {
  messageCount: number;
  preserveStart: number;
  fastPathIterations: number;
  fastPathInnerIterations: number;
  fullPassIterations: number;
  fullPassInnerIterations: number;
  tokensSaved: number;
  changed: boolean;
}

function compactionDebugEnabled(): boolean {
  return process.env['NODE_ENV'] === 'development' || process.env['WRONGSTACK_DEBUG'] === '1';
}

let _debugLogger: Logger | undefined;

export function setCompactionDebugLogger(logger: Logger | undefined): void {
  _debugLogger = logger;
}

function emitCompactionMetrics(event: string, metrics: CompactionMetrics): void {
  if (!compactionDebugEnabled()) return;
  const ctx = {
    event,
    messageCount: metrics.messageCount,
    preserveStart: metrics.preserveStart,
    fastPathIterations: metrics.fastPathIterations,
    fastPathInnerIterations: metrics.fastPathInnerIterations,
    fastPathInnerPerOuter:
      metrics.fastPathIterations > 0
        ? metrics.fastPathInnerIterations / metrics.fastPathIterations
        : 0,
    fullPassIterations: metrics.fullPassIterations,
    fullPassInnerIterations: metrics.fullPassInnerIterations,
    fullPassInnerPerOuter:
      metrics.fullPassIterations > 0
        ? metrics.fullPassInnerIterations / metrics.fullPassIterations
        : 0,
    tokensSaved: metrics.tokensSaved,
    changed: metrics.changed,
  };
  if (_debugLogger) {
    _debugLogger.debug(`compaction: ${event}`, ctx);
  } else {
    console.log(JSON.stringify({ level: 'debug', ...ctx }));
  }
}

export interface EliseResult {
  messages: Message[];
  saved: number;
  changed: boolean;
}

export interface AcknowledgedToolResultElision extends EliseResult {
  elidedResults: number;
  retainedTokens: number;
}

export interface AcknowledgedToolReceiptCollapse extends EliseResult {
  collapsedPairs: number;
}

const TOOL_HISTORY_DIGEST_PREFIX = '[tool_history_digest:';

export { isElidedResultContent, isElidedToolInput };

export function eliseAcknowledgedToolResults(
  messages: readonly Message[],
  opts: { maxRetainedTokens: number },
): AcknowledgedToolResultElision {
  const unchanged = (retainedTokens = 0): AcknowledgedToolResultElision => ({
    messages: messages as Message[],
    saved: 0,
    changed: false,
    elidedResults: 0,
    retainedTokens,
  });

  let lastAssistantIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'assistant') {
      lastAssistantIndex = i;
      break;
    }
  }
  if (lastAssistantIndex <= 0) return unchanged();

  const useById = new Map<string, ToolUseBlock>();
  for (let i = 0; i < lastAssistantIndex; i++) {
    const message = messages[i];
    if (!message || typeof message.content === 'string') continue;
    for (const block of message.content) {
      if (block.type === 'tool_use') useById.set(block.id, block);
    }
  }

  const budget = Number.isFinite(opts.maxRetainedTokens)
    ? Math.max(0, Math.floor(opts.maxRetainedTokens))
    : 0;
  const idsToElide = new Set<string>();
  let retainedTokens = 0;
  const fileLifecycle = analyzeFileToolLifecycle(messages, messages.length);

  for (const id of fileLifecycle.staleReadPaths.keys()) idsToElide.add(id);

  for (let i = lastAssistantIndex - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || typeof message.content === 'string') continue;
    for (let j = message.content.length - 1; j >= 0; j--) {
      const block = message.content[j];
      if (block?.type !== 'tool_result') continue;
      const use = useById.get(block.tool_use_id);
      const resultTokens = isElidedResultContent(block.content)
        ? 0
        : estimateToolResultTokens(block.content);
      const useTokens =
        use && !isElidedToolInput(use.input) ? estimateToolInputTokens(use.input) : 0;
      const pairTokens = resultTokens + useTokens;
      if (pairTokens === 0) continue;
      if (fileLifecycle.activeReadIds.has(block.tool_use_id)) {
        retainedTokens += pairTokens;
        continue;
      }
      if (fileLifecycle.staleReadPaths.has(block.tool_use_id)) continue;
      if (pairTokens > budget || retainedTokens + pairTokens > budget) {
        idsToElide.add(block.tool_use_id);
      } else {
        retainedTokens += pairTokens;
      }
    }
  }

  if (idsToElide.size === 0) return unchanged(retainedTokens);

  let next: Message[] | undefined;
  let saved = 0;
  let elidedResults = 0;
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (!message || typeof message.content === 'string') continue;
    let content: ContentBlock[] | undefined;
    for (let j = 0; j < message.content.length; j++) {
      const block = message.content[j];
      if (!block) continue;
      if (
        block.type === 'tool_use' &&
        idsToElide.has(block.id) &&
        !isElidedToolInput(block.input)
      ) {
        const before = estimateToolInputTokens(block.input);
        const stalePath = fileLifecycle.staleReadPaths.get(block.id);
        const input = stalePath
          ? {
              __stale_read: `invalidated by a later successful mutation of ${stalePath}`,
              tool: block.name,
            }
          : summarizeToolUseInputElision(block, before);
        saved += Math.max(0, before - estimateToolInputTokens(input));
        content ??= message.content.slice();
        content[j] = { ...block, input };
      } else if (
        block.type === 'tool_result' &&
        idsToElide.has(block.tool_use_id) &&
        !isElidedResultContent(block.content)
      ) {
        const before = estimateToolResultTokens(block.content);
        const stalePath = fileLifecycle.staleReadPaths.get(block.tool_use_id);
        const receipt = stalePath
          ? `[stale read of ${stalePath} — invalidated by a later successful mutation; see session log]`
          : summarizeToolResultElision(block, before);
        saved += Math.max(0, before - estimateToolResultTokens(receipt));
        elidedResults++;
        content ??= message.content.slice();
        content[j] = { ...block, content: receipt };
      }
    }
    if (content) {
      next ??= messages.slice() as Message[];
      next[i] = { ...message, content, _estTokens: undefined };
    }
  }

  if (!next) return unchanged(retainedTokens);
  return {
    messages: next,
    saved,
    changed: true,
    elidedResults,
    retainedTokens,
  };
}

export function collapseAcknowledgedToolReceipts(
  messages: readonly Message[],
  opts: { maxPairs: number },
): AcknowledgedToolReceiptCollapse {
  const unchanged = (): AcknowledgedToolReceiptCollapse => ({
    messages: messages as Message[],
    saved: 0,
    changed: false,
    collapsedPairs: 0,
  });

  let lastAssistantIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'assistant') {
      lastAssistantIndex = i;
      break;
    }
  }
  if (lastAssistantIndex <= 0) return unchanged();

  const acknowledgedIds: string[] = [];
  const seen = new Set<string>();
  for (let i = lastAssistantIndex - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || typeof message.content === 'string') continue;
    for (let j = message.content.length - 1; j >= 0; j--) {
      const block = message.content[j];
      if (block?.type !== 'tool_result' || seen.has(block.tool_use_id)) continue;
      seen.add(block.tool_use_id);
      acknowledgedIds.push(block.tool_use_id);
    }
  }

  const maxPairs = Number.isFinite(opts.maxPairs) ? Math.max(0, Math.floor(opts.maxPairs)) : 0;
  if (acknowledgedIds.length <= maxPairs) return unchanged();
  const fileLifecycle = analyzeFileToolLifecycle(messages, messages.length);
  const acknowledgedSet = new Set(acknowledgedIds);
  const protectedReads = new Set(
    [...fileLifecycle.activeReadIds].filter((id) => acknowledgedSet.has(id)),
  );
  const unprotected = acknowledgedIds.filter((id) => !protectedReads.has(id));
  const unprotectedKeep = Math.max(0, maxPairs - protectedReads.size);
  const idsToDrop = new Set(unprotected.slice(unprotectedKeep));
  if (idsToDrop.size === 0) return unchanged();
  const toolCounts = new Map<string, number>();
  const pathHints = new Set<string>();
  let priorDigestCount = 0;

  for (const message of messages) {
    const digest = toolHistoryDigestText(message);
    if (digest) {
      priorDigestCount = Math.max(priorDigestCount, toolHistoryDigestCount(digest));
      continue;
    }
    if (typeof message.content === 'string') continue;
    for (const block of message.content) {
      if (block.type === 'tool_use' && idsToDrop.has(block.id)) {
        toolCounts.set(block.name, (toolCounts.get(block.name) ?? 0) + 1);
      } else if (block.type === 'tool_result' && idsToDrop.has(block.tool_use_id)) {
        for (const hint of extractPathHints(block.content)) {
          pathHints.add(hint);
          if (pathHints.size >= 6) break;
        }
      }
    }
  }

  const out: Message[] = [];
  for (const message of messages) {
    if (toolHistoryDigestText(message)) continue;
    if (typeof message.content === 'string') {
      out.push(message);
      continue;
    }

    let removedUse = false;
    let hasRemainingUse = false;
    const content: ContentBlock[] = [];
    for (const block of message.content) {
      if (block.type === 'tool_use') {
        if (idsToDrop.has(block.id)) {
          removedUse = true;
          continue;
        }
        hasRemainingUse = true;
      }
      if (block.type === 'tool_result' && idsToDrop.has(block.tool_use_id)) continue;
      content.push(block);
    }

    const compactContent =
      removedUse && !hasRemainingUse
        ? content.filter((block) => block.type !== 'thinking')
        : content;
    if (!hasMeaningfulContent(compactContent)) continue;
    out.push(
      compactContent.length === message.content.length &&
        compactContent.every((block, index) => block === message.content[index])
        ? message
        : { ...message, content: compactContent, _estTokens: undefined },
    );
  }

  const collapsedPairs = idsToDrop.size;
  const totalOmitted = priorDigestCount + collapsedPairs;
  const tools = [...toolCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([name, count]) => `${name}×${count}`)
    .join(', ');
  const files = [...pathHints].slice(0, 6).join(', ');
  const details = [tools ? `tools=${tools}` : '', files ? `files=${files}` : '']
    .filter(Boolean)
    .join('; ');
  out.unshift({
    role: 'system',
    content: `${TOOL_HISTORY_DIGEST_PREFIX} ${totalOmitted} older acknowledged exchange(s) omitted${details ? `; ${details}` : ''}; exact I/O is in the session log]`,
  });

  return {
    messages: out,
    saved: Math.max(0, estimateMessageTokens(messages) - estimateMessageTokens(out)),
    changed: true,
    collapsedPairs,
  };
}

function toolHistoryDigestText(message: Message): string | undefined {
  if (message.role !== 'system') return undefined;
  if (typeof message.content === 'string') {
    return message.content.startsWith(TOOL_HISTORY_DIGEST_PREFIX) ? message.content : undefined;
  }
  const text = message.content.find(
    (block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text',
  )?.text;
  return text?.startsWith(TOOL_HISTORY_DIGEST_PREFIX) ? text : undefined;
}

function toolHistoryDigestCount(text: string): number {
  const match = /^\[tool_history_digest:\s*(\d+)/.exec(text);
  return match?.[1] ? Number.parseInt(match[1], 10) : 0;
}

function hasMatchingToolPair(
  resultContent: readonly ContentBlock[],
  useContent: readonly ContentBlock[],
): { matched: boolean; iterations: number } {
  let iterations = 0;
  let firstResultId: string | undefined;
  let resultIds: Set<string> | undefined;

  for (const block of resultContent) {
    iterations++;
    if (block.type !== 'tool_result') continue;
    if (firstResultId === undefined) {
      firstResultId = block.tool_use_id;
    } else {
      resultIds ??= new Set([firstResultId]);
      resultIds.add(block.tool_use_id);
    }
  }
  if (firstResultId === undefined) return { matched: false, iterations };

  for (const block of useContent) {
    iterations++;
    if (block.type !== 'tool_use') continue;
    if (resultIds ? resultIds.has(block.id) : block.id === firstResultId) {
      return { matched: true, iterations };
    }
  }

  return { matched: false, iterations };
}

export function findPreserveStart(messages: readonly Message[], preserveK: number): number {
  let pairCount = 0;
  let preserveStart = messages.length;
  for (let i = messages.length - 1; i >= 0 && pairCount < preserveK; i--) {
    const m = messages[i];
    if (!m) continue;
    if (m.role === 'user' || m.role === 'assistant') {
      pairCount++;
      preserveStart = i;
    }
  }

  let pairRepairIterations = 0;
  let pairRepairInnerIterations = 0;
  while (preserveStart > 0) {
    pairRepairIterations++;
    const first = messages[preserveStart];
    const prev = messages[preserveStart - 1];
    if (!first || !prev || first.role !== 'user' || prev.role !== 'assistant') break;
    if (typeof first.content === 'string' || typeof prev.content === 'string') break;
    const pairCheck = hasMatchingToolPair(first.content, prev.content);
    pairRepairInnerIterations += pairCheck.iterations;
    if (!pairCheck.matched) break;
    preserveStart--;
  }

  if (compactionDebugEnabled()) {
    const ctx = {
      event: 'compaction.find_preserve_start.ended',
      messageCount: messages.length,
      preserveK,
      preserveStart,
      pairRepairIterations,
      pairRepairInnerIterations,
      pairRepairInnerPerOuter:
        pairRepairIterations > 0 ? pairRepairInnerIterations / pairRepairIterations : 0,
    };
    if (_debugLogger) {
      _debugLogger.debug('compaction: find_preserve_start.ended', ctx);
    } else {
      console.log(JSON.stringify({ level: 'debug', ...ctx }));
    }
  }

  return preserveStart;
}

export function eliseOldToolResults(
  messages: readonly Message[],
  opts: { preserveK: number; eliseThreshold: number },
  findPreserveStartFn: (
    messages: readonly Message[],
    preserveK: number,
  ) => number = findPreserveStart,
): EliseResult {
  const preserveStart = findPreserveStartFn(messages, opts.preserveK);

  const tokenCache = new Map<ContentBlock, number>();
  const tokensFor = (b: ContentBlock): number => {
    const cached = tokenCache.get(b);
    if (cached !== undefined) return cached;
    const t =
      b.type === 'tool_result'
        ? estimateToolResultTokens(b.content)
        : b.type === 'tool_use'
          ? estimateToolInputTokens(b.input)
          : 0;
    tokenCache.set(b, t);
    return t;
  };

  let hasOversized = false;
  let firstOversizedIndex = -1;
  let fastPathIterations = 0;
  let fastPathInnerIterations = 0;
  for (let i = 0; i < preserveStart && !hasOversized; i++) {
    fastPathIterations++;
    const msg = messages[i];
    if (!msg || !Array.isArray(msg.content)) continue;
    for (const b of msg.content) {
      fastPathInnerIterations++;
      const oversized = tokensFor(b) >= opts.eliseThreshold;
      if (oversized) {
        hasOversized = true;
        firstOversizedIndex = i;
        break;
      }
    }
  }

  emitCompactionMetrics(
    hasOversized
      ? 'compaction.elision.fast_path.oversized_found'
      : 'compaction.elision.fast_path.no_oversized',
    {
      messageCount: messages.length,
      preserveStart,
      fastPathIterations,
      fastPathInnerIterations,
      fullPassIterations: 0,
      fullPassInnerIterations: 0,
      tokensSaved: 0,
      changed: false,
    },
  );

  if (!hasOversized) return { messages: messages as Message[], saved: 0, changed: false };

  let saved = 0;
  let changed = false;
  let fullPassIterations = 0;
  let fullPassInnerIterations = 0;
  let next: Message[] | undefined;
  for (let i = firstOversizedIndex; i < preserveStart; i++) {
    fullPassIterations++;
    const msg = messages[i];
    if (!msg || !Array.isArray(msg.content)) continue;
    const original = msg.content;
    let newContent: ContentBlock[] | undefined;
    for (let idx = 0; idx < original.length; idx++) {
      fullPassInnerIterations++;
      const b = original[idx];
      if (!b) continue;
      if (b.type === 'tool_use') {
        const tokens = tokensFor(b);
        if (tokens < opts.eliseThreshold) continue;
        const elidedInput = summarizeToolUseInputElision(b, tokens);
        saved += Math.max(0, tokens - estimateToolInputTokens(elidedInput));
        newContent ??= original.slice();
        newContent[idx] = { ...b, input: elidedInput };
        continue;
      }

      if (b.type !== 'tool_result') continue;
      const tokens = tokensFor(b);
      if (tokens < opts.eliseThreshold) continue;
      saved += tokens;
      const elided: ToolResultBlock = {
        type: 'tool_result',
        tool_use_id: b.tool_use_id,
        ...(b.name !== undefined && { name: b.name }),
        content: summarizeToolResultElision(b, tokens),
        is_error: b.is_error,
      };
      newContent ??= original.slice();
      newContent[idx] = elided;
    }
    if (newContent) {
      next ??= messages.slice() as Message[];
      next[i] = { ...msg, content: newContent, _estTokens: undefined };
      changed = true;
    }

    if (compactionDebugEnabled()) {
      const ratio = fullPassInnerIterations / fullPassIterations;

      if (ratio > 10) {
        const ctx = {
          event: 'compaction.elision.regression',
          message: `fullPassInnerPerOuter=${ratio.toFixed(2)} exceeds threshold 10 — possible O(n·m) regression`,
          messageCount: messages.length,
          fullPassIterations,
          fullPassInnerIterations,
        };
        if (_debugLogger) {
          _debugLogger.error(`compaction: elision.regression — ratio ${ratio.toFixed(2)}`, ctx);
        } else {
          console.error(JSON.stringify({ level: 'error', ...ctx }));
        }
      }
    }
  }

  emitCompactionMetrics('compaction.elision.full_pass.ended', {
    messageCount: messages.length,
    preserveStart,
    fastPathIterations,
    fastPathInnerIterations,
    fullPassIterations,
    fullPassInnerIterations,
    tokensSaved: saved,
    changed,
  });

  return { messages: changed && next ? next : (messages as Message[]), saved, changed };
}
