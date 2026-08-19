import type { ContentBlock, ToolResultBlock, ToolUseBlock } from '../types/blocks.js';
import type { Logger } from '../types/logger.js';
import type { Message } from '../types/messages.js';
import { hasMeaningfulContent } from '../utils/message-invariants.js';
import {
  estimateMessageTokens,
  estimateToolInputTokens,
  estimateToolResultTokens,
} from '../utils/token-estimate.js';

const PATH_HINT_PATTERN =
  /(?:(?:[A-Za-z]:)?[./\\]?[\w@.-]+(?:[\\/][\w@(). -]+)+\.[A-Za-z0-9]{1,12})/g;
const PATH_BACKSLASH_PATTERN = /\\/g;
const PATH_TRIM_PATTERN = /^["'`]+|["'`),;:]+$/g;

const ERROR_LINE_PATTERN =
  /\b(error|exception|failed|failure|fatal|panic|timeout|denied|enoent|eacces|eperm)\b/i;
const STRONG_ERROR_LINE_PATTERN =
  /\b(error|exception|fatal|panic|timeout|denied|enoent|eacces|eperm)\b/i;
const NEWLINE_SPLIT_PATTERN = /\r?\n/;
const WHITESPACE_COLLAPSE_PATTERN = /\s+/g;

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

export interface FileToolLifecycle {
  activeReadIds: Set<string>;
  staleReadPaths: Map<string, string>;
}

function isReadToolName(name: string): boolean {
  return /^(read|read_file|open_file|view)$/.test(name.toLowerCase());
}

function isFileMutationToolName(name: string): boolean {
  return /^(edit|write|replace|patch|apply_patch)$/.test(name.toLowerCase());
}

function didFileMutationRun(use: ToolUseBlock): boolean {
  const name = use.name.toLowerCase();
  if (name === 'replace') return use.input?.['dry_run'] === false;
  if (name === 'patch') return use.input?.['dry_run'] !== true;
  return true;
}

function sameFilePath(a: string, b: string): boolean {
  if (a === b) return true;
  const aAbsolute = /^(?:[a-z]:\/|\/)/.test(a);
  const bAbsolute = /^(?:[a-z]:\/|\/)/.test(b);
  if (aAbsolute === bAbsolute) return false;
  return aAbsolute ? a.endsWith(`/${b}`) : b.endsWith(`/${a}`);
}

export function readPathOf(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined;
  for (const key of ['file_path', 'path', 'file', 'filename']) {
    const v = input[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

export function normalizePathKey(p: string): string {
  return p.replace(PATH_BACKSLASH_PATTERN, '/').replace(/^\.\//, '').toLowerCase();
}

function mutationPathKeys(use: ToolUseBlock, result: ToolResultBlock): string[] {
  const paths = new Set<string>();
  const direct = readPathOf(use.input);
  if (direct) paths.add(normalizePathKey(direct));

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.content);
  } catch {
    return [...paths];
  }
  const visit = (value: unknown, key = ''): void => {
    if (typeof value === 'string') {
      if (/^(path|file|file_path|filename|files)$/.test(key) && value.trim()) {
        paths.add(normalizePathKey(value.trim()));
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
      visit(child, childKey);
    }
  };
  visit(parsed);
  return [...paths];
}

function analyzeFileToolLifecycle(
  messages: readonly Message[],
  acknowledgedBefore: number,
): FileToolLifecycle {
  const uses = new Map<string, ToolUseBlock>();
  const activeByPath = new Map<string, Set<string>>();
  const staleReadPaths = new Map<string, string>();

  for (let i = 0; i < acknowledgedBefore; i++) {
    const message = messages[i];
    if (!message || typeof message.content === 'string') continue;
    for (const block of message.content) {
      if (block.type === 'tool_use') {
        uses.set(block.id, block);
        continue;
      }
      if (block.type !== 'tool_result' || block.is_error === true) continue;
      const use = uses.get(block.tool_use_id);
      if (!use) continue;
      if (isReadToolName(use.name)) {
        const rawPath = readPathOf(use.input);
        if (!rawPath) continue;
        const pathKey = normalizePathKey(rawPath);
        const matchingPath = [...activeByPath.keys()].find((activePath) =>
          sameFilePath(activePath, pathKey),
        );
        const canonicalPath = matchingPath ?? pathKey;
        const reads = activeByPath.get(canonicalPath) ?? new Set<string>();
        reads.add(block.tool_use_id);
        activeByPath.set(canonicalPath, reads);
        continue;
      }

      if (!isFileMutationToolName(use.name) || !didFileMutationRun(use)) continue;
      for (const mutationPath of mutationPathKeys(use, block)) {
        for (const [activePath, activeIds] of activeByPath) {
          if (!sameFilePath(activePath, mutationPath)) continue;
          for (const activeId of activeIds) staleReadPaths.set(activeId, activePath);
          activeByPath.delete(activePath);
        }
      }
    }
  }

  return {
    activeReadIds: new Set([...activeByPath.values()].flatMap((ids) => [...ids])),
    staleReadPaths,
  };
}

export function isElidedResultContent(content: string): boolean {
  return (
    typeof content === 'string' &&
    (content.startsWith('[elided:') || content.startsWith('[stale read of '))
  );
}

export function isElidedToolInput(input: Record<string, unknown> | undefined): boolean {
  return (
    !!input && (Object.hasOwn(input, '__elided_tool_input') || Object.hasOwn(input, '__stale_read'))
  );
}

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
  findPreserveStartFn: (messages: readonly Message[], preserveK: number) => number = findPreserveStart,
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

export function summarizeToolUseInputElision(
  block: ToolUseBlock,
  tokens: number,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(block.input ?? {})) {
    fields[key] = summarizeToolUseInputValue(value);
  }

  return {
    __elided_tool_input: `~${tokens} tokens; original arguments are in the session log`,
    tool: block.name,
    fields,
  };
}

function summarizeToolUseInputValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const oneLine = value.replace(/\s+/g, ' ').trim();
    return oneLine.length <= 160 ? oneLine : `${oneLine.slice(0, 120)}...(${oneLine.length} chars)`;
  }
  if (Array.isArray(value)) {
    return `[array:${value.length}]`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>);
    return `[object:${keys.slice(0, 8).join(',')}${keys.length > 8 ? ',...' : ''}]`;
  }
  return String(value);
}

export function summarizeToolResultElision(block: ToolResultBlock, tokens: number): string {
  const parts = [`elided: ~${tokens} tokens`];
  if (block.name) parts.push(`tool=${block.name}`);
  const files = extractPathHints(block.content).slice(0, 5);
  if (files.length > 0) parts.push(`files=${files.join(', ')}`);
  const error = firstErrorLine(block.content);
  if (error) parts.push(`error=${error}`);
  const excerpt = semanticToolResultExcerpt(block.content);
  if (excerpt) parts.push(`excerpt=${excerpt}`);
  return `[${parts.join('; ')}]`;
}

function semanticToolResultExcerpt(content: unknown, maxChars = 480): string | undefined {
  const text = safeToolResultString(content).replace(WHITESPACE_COLLAPSE_PATTERN, ' ').trim();
  if (!text) return undefined;
  if (text.length <= maxChars) return text;
  const separator = ' … ';
  const headChars = Math.ceil((maxChars - separator.length) * 0.65);
  const tailChars = maxChars - separator.length - headChars;
  return `${text.slice(0, headChars)}${separator}${text.slice(-tailChars)}`;
}

function safeToolResultString(content: unknown): string {
  if (typeof content === 'string') return content;
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function extractPathHints(content: unknown): string[] {
  const text = safeToolResultString(content);
  const out = new Set<string>();
  for (const match of text.matchAll(PATH_HINT_PATTERN)) {
    const clean = match[0]?.replace(PATH_BACKSLASH_PATTERN, '/').replace(PATH_TRIM_PATTERN, '');
    if (clean && clean.length <= 220) out.add(clean);
    if (out.size >= 5) break;
  }
  return [...out];
}

function firstErrorLine(content: unknown): string | undefined {
  const text = safeToolResultString(content);
  const lines = text.split(NEWLINE_SPLIT_PATTERN);
  for (const pattern of [STRONG_ERROR_LINE_PATTERN, ERROR_LINE_PATTERN]) {
    for (const line of lines) {
      if (!pattern.test(line)) continue;
      const trimmed = line.replace(WHITESPACE_COLLAPSE_PATTERN, ' ').trim();
      if (trimmed) return trimmed.slice(0, 180);
    }
  }
  return undefined;
}
