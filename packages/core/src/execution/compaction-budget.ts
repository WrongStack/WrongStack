import type { ContentBlock } from '../types/blocks.js';
import { isTextBlock } from '../types/blocks.js';
import type { Message } from '../types/messages.js';
import { repairToolUseAdjacency } from '../utils/message-invariants.js';
import {
  computeMessageTokens,
  estimateTextTokens,
  estimateToolInputTokens,
  estimateToolResultTokens,
} from '../utils/token-estimate.js';
import {
  findPreserveStart,
  isElidedResultContent,
  isElidedToolInput,
  normalizePathKey,
  readPathOf,
  summarizeToolResultElision,
  summarizeToolUseInputElision,
} from './compaction-elision.js';

export interface HardBudgetResult {
  messages: Message[];
  changed: boolean;
  saved: number;
  trimmedBlocks: number;
  droppedMessages: number;
  withinBudget: boolean;
}

const EMERGENCY_TEXT_TOKEN_CAP = 400;
const EMERGENCY_KEEP_HEAD = 800;
const EMERGENCY_KEEP_TAIL = 300;
const EMERGENCY_FLOOR_HEAD = 400;
const EMERGENCY_FLOOR_TAIL = 150;
const EMERGENCY_MIN_TRIM_TOKENS = 120;

export function headTailTruncate(text: string, keepHead: number, keepTail: number): string {
  if (text.length <= keepHead + keepTail + 60) return text;
  const removedChars = text.length - keepHead - keepTail;
  const approxTokens = Math.ceil(removedChars / 3.5);
  return `${text.slice(0, keepHead)}\n… [truncated ~${approxTokens} tokens — see session log] …\n${text.slice(text.length - keepTail)}`;
}

export function truncateMessageText(
  m: Message,
  keepHead: number,
  keepTail: number,
  minTokens: number,
): { message: Message; trimmed: number } | null {
  if (typeof m.content === 'string') {
    if (estimateTextTokens(m.content) < minTokens) return null;
    const next = headTailTruncate(m.content, keepHead, keepTail);
    if (next === m.content) return null;
    return { message: { ...m, content: next, _estTokens: undefined }, trimmed: 1 };
  }
  let newContent: ContentBlock[] | undefined;
  let trimmed = 0;
  for (let j = 0; j < m.content.length; j++) {
    const b = m.content[j];
    if (!b) continue;
    if (b.type !== 'text') continue;
    if (estimateTextTokens(b.text) < minTokens) continue;
    const next = headTailTruncate(b.text, keepHead, keepTail);
    if (next === b.text) continue;
    newContent ??= m.content.slice();
    newContent[j] = { ...b, text: next };
    trimmed++;
  }
  if (!newContent) return null;
  return { message: { ...m, content: newContent, _estTokens: undefined }, trimmed };
}

export function elideMessageToolIo(m: Message): { message: Message; trimmed: number } | null {
  if (typeof m.content === 'string') return null;
  let newContent: ContentBlock[] | undefined;
  let trimmed = 0;
  for (let j = 0; j < m.content.length; j++) {
    const b = m.content[j];
    if (!b) continue;
    if (b.type === 'tool_result' && !isElidedResultContent(b.content)) {
      const tokens = estimateToolResultTokens(b.content);
      if (tokens < EMERGENCY_MIN_TRIM_TOKENS) continue;
      newContent ??= m.content.slice();
      newContent[j] = {
        type: 'tool_result',
        tool_use_id: b.tool_use_id,
        ...(b.name !== undefined && { name: b.name }),
        content: summarizeToolResultElision(b, tokens),
        is_error: b.is_error,
      };
      trimmed++;
    } else if (b.type === 'tool_use' && !isElidedToolInput(b.input)) {
      const tokens = estimateToolInputTokens(b.input);
      if (tokens < EMERGENCY_MIN_TRIM_TOKENS) continue;
      newContent ??= m.content.slice();
      newContent[j] = { ...b, input: summarizeToolUseInputElision(b, tokens) };
      trimmed++;
    }
  }
  if (!newContent) return null;
  return { message: { ...m, content: newContent, _estTokens: undefined }, trimmed };
}

export function enforceHardBudget(
  messages: readonly Message[],
  budgetTokens: number,
  opts: { preserveK: number },
  findPreserveStartFn: (
    messages: readonly Message[],
    preserveK: number,
  ) => number = findPreserveStart,
): HardBudgetResult {
  const target = Math.max(1, Math.floor(budgetTokens));
  const perMsg: number[] = messages.map((m) =>
    typeof m._estTokens === 'number' && m._estTokens > 0 ? m._estTokens : computeMessageTokens(m),
  );
  let total = perMsg.reduce((a, b) => a + b, 0);
  const before = total;
  if (total <= target) {
    return {
      messages: messages as Message[],
      changed: false,
      saved: 0,
      trimmedBlocks: 0,
      droppedMessages: 0,
      withinBudget: true,
    };
  }

  const work = messages.slice() as Message[];
  const preserveStart = findPreserveStartFn(messages, opts.preserveK);
  let changed = false;
  let trimmedBlocks = 0;

  const setMsg = (i: number, newMsg: Message): void => {
    const t = computeMessageTokens(newMsg);
    total += t - (perMsg[i] ?? 0);
    perMsg[i] = t;
    work[i] = newMsg;
    changed = true;
  };

  for (let i = 0; i < preserveStart && total > target; i++) {
    const m = work[i];
    if (!m) continue;
    const res = elideMessageToolIo(m);
    if (res) {
      trimmedBlocks += res.trimmed;
      setMsg(i, res.message);
    }
  }

  for (let i = 0; i < preserveStart && total > target; i++) {
    const m = work[i];
    if (!m) continue;
    const res = truncateMessageText(
      m,
      EMERGENCY_KEEP_HEAD,
      EMERGENCY_KEEP_TAIL,
      EMERGENCY_TEXT_TOKEN_CAP,
    );
    if (res) {
      trimmedBlocks += res.trimmed;
      setMsg(i, res.message);
    }
  }

  for (let i = 0; i < work.length && total > target; i++) {
    const m = work[i];
    if (!m) continue;
    const elided = elideMessageToolIo(m);
    if (elided) {
      trimmedBlocks += elided.trimmed;
      setMsg(i, elided.message);
      if (total <= target) break;
    }
    const current = work[i];
    if (!current) continue;
    const res = truncateMessageText(
      current,
      EMERGENCY_FLOOR_HEAD,
      EMERGENCY_FLOOR_TAIL,
      EMERGENCY_MIN_TRIM_TOKENS,
    );
    if (res) {
      trimmedBlocks += res.trimmed;
      setMsg(i, res.message);
    }
  }

  let dropFrom = 0;
  while (total > target && dropFrom < work.length - 1) {
    total -= perMsg[dropFrom] ?? 0;
    dropFrom++;
    changed = true;
  }
  let trimmed: Message[] = dropFrom > 0 ? work.slice(dropFrom) : work;
  const droppedMessages = dropFrom;

  if (changed) {
    const repair = repairToolUseAdjacency(trimmed);
    if (repair.report.changed) trimmed = repair.messages;
  }

  return {
    messages: changed ? trimmed : (messages as Message[]),
    changed,
    saved: Math.max(0, before - total),
    trimmedBlocks,
    droppedMessages,
    withinBudget: total <= target,
  };
}

export interface DedupResult {
  messages: Message[];
  changed: boolean;
  saved: number;
  deduped: number;
}

function isHotRead(pathKey: string, hot: readonly string[]): boolean {
  for (const h of hot) {
    if (pathKey === h) return true;
    if (pathKey.endsWith(h) || h.endsWith(pathKey)) return true;
    const base = pathKey.slice(pathKey.lastIndexOf('/') + 1);
    if (base && h.endsWith(base)) return true;
  }
  return false;
}

export function dedupStaleReads(
  messages: readonly Message[],
  repeatedReads: readonly { file: string; count: number }[],
  opts: { preserveK: number },
  findPreserveStartFn: (
    messages: readonly Message[],
    preserveK: number,
  ) => number = findPreserveStart,
): DedupResult {
  const unchanged: DedupResult = {
    messages: messages as Message[],
    changed: false,
    saved: 0,
    deduped: 0,
  };
  const hot = repeatedReads.filter((r) => r.count >= 2).map((r) => normalizePathKey(r.file));
  if (hot.length === 0) return unchanged;

  const newestIndexByKey = new Map<string, number>();
  const readKeyByUseId = new Map<string, string>();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || typeof m.content === 'string') continue;
    for (const b of m.content) {
      if (b.type !== 'tool_use' || b.name.toLowerCase() !== 'read') continue;
      const p = readPathOf(b.input);
      if (!p) continue;
      const key = normalizePathKey(p);
      if (!isHotRead(key, hot)) continue;
      readKeyByUseId.set(b.id, key);
      const prev = newestIndexByKey.get(key);
      if (prev === undefined || i > prev) newestIndexByKey.set(key, i);
    }
  }
  if (newestIndexByKey.size === 0) return unchanged;

  const preserveStart = findPreserveStartFn(messages, opts.preserveK);

  const staleIds = new Map<string, string>();
  for (let i = 0; i < preserveStart; i++) {
    const m = messages[i];
    if (!m || typeof m.content === 'string') continue;
    for (const b of m.content) {
      if (b.type !== 'tool_use') continue;
      const key = readKeyByUseId.get(b.id);
      if (!key) continue;
      const newest = newestIndexByKey.get(key);
      if (newest !== undefined && i < newest) staleIds.set(b.id, key);
    }
  }
  if (staleIds.size === 0) return unchanged;

  let saved = 0;
  let deduped = 0;
  let next: Message[] | undefined;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || typeof m.content === 'string') continue;
    let newContent: ContentBlock[] | undefined;
    for (let j = 0; j < m.content.length; j++) {
      const b = m.content[j];
      if (!b) continue;
      if (b.type === 'tool_use' && staleIds.has(b.id) && !isElidedToolInput(b.input)) {
        newContent ??= m.content.slice();
        newContent[j] = {
          ...b,
          input: {
            __stale_read: `superseded by a later read of ${staleIds.get(b.id)}`,
            tool: b.name,
          },
        };
      } else if (b.type === 'tool_result' && staleIds.has(b.tool_use_id)) {
        const key = staleIds.get(b.tool_use_id);
        if (isElidedResultContent(b.content)) continue;
        const tokens = estimateToolResultTokens(b.content);
        if (tokens < 1) continue;
        saved += tokens;
        deduped++;
        newContent ??= m.content.slice();
        newContent[j] = {
          type: 'tool_result',
          tool_use_id: b.tool_use_id,
          ...(b.name !== undefined && { name: b.name }),
          content: `[stale read of ${key} — superseded by a later read; see session log]`,
          is_error: b.is_error,
        };
      }
    }
    if (newContent) {
      next ??= messages.slice() as Message[];
      next[i] = { ...m, content: newContent, _estTokens: undefined };
    }
  }

  if (!next) return unchanged;
  return { messages: next, changed: true, saved, deduped };
}

export function buildLosslessDigest(messages: readonly Message[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    let text: string;
    let omitted = 0;
    if (typeof m.content === 'string') {
      text = m.content;
    } else {
      const parts: string[] = [];
      for (const b of m.content) {
        if (isTextBlock(b)) parts.push(b.text);
        else if (b.type === 'tool_use' || b.type === 'tool_result') omitted++;
      }
      text = parts.join(' ');
    }
    if (text.trim().length === 0 && omitted === 0) continue;
    const marker = omitted > 0 ? ` [${omitted} tool call(s) omitted — see session log]` : '';
    lines.push(`[${m.role}]: ${text}${marker}`);
  }
  return lines.join('\n');
}

export function hasTextContent(m: Message): boolean {
  if (typeof m.content === 'string') return m.content.trim().length > 0;
  return m.content.some((b) => b.type === 'text' && b.text.trim().length > 0);
}

export function findSafeBoundary(
  messages: readonly Message[],
  from: number,
  to: number,
  hasTextContentFn: (m: Message) => boolean = hasTextContent,
): number {
  for (let i = to; i >= from; i--) {
    const m = messages[i];
    if (!m) continue;
    if (m.role === 'user' && hasTextContentFn(m)) {
      return findExchangeStart(messages, i);
    }
  }
  return -1;
}

export function findExchangeStart(messages: readonly Message[], userIndex: number): number {
  for (let i = userIndex - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    if (m.role === 'assistant') {
      const hasToolUse = Array.isArray(m.content)
        ? m.content.some((b) => b.type === 'tool_use')
        : false;
      if (!hasToolUse) return i + 1;
    } else if (m.role === 'user') {
      return i;
    }
  }
  return 0;
}
