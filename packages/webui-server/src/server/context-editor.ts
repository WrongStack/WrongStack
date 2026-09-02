import { createHash } from 'node:crypto';
import type { Context } from '@wrongstack/core/agent';
import type { ToolRegistry } from '@wrongstack/core/registry';
import type { ContentBlock, Message } from '@wrongstack/core/types';
import {
  ALLOWED_IMAGE_MEDIA_TYPES,
  base64DecodedBytes,
  isAllowedImageMediaType,
  isValidImageBase64,
  MAX_INCOMING_IMAGE_BYTES,
  repairToolUseAdjacency,
} from '@wrongstack/core/utils';
import { estimateContextBreakdown, messageTokens } from './token-estimator.js';

export type ContextEditorBlock = ContentBlock;

export interface ContextEditorMessage {
  role: Message['role'];
  content: string | ContextEditorBlock[];
  ts?: string | undefined;
}

export interface ContextEditorRemoval {
  messageIndex: number;
  blockIndex?: number | undefined;
  start?: number | undefined;
  end?: number | undefined;
}

export interface ContextEditorMetrics {
  messages: number;
  blocks: number;
  messageTokens: number;
  fullRequestTokens: number;
}

export interface ContextEditorDiagnostics {
  hasToolAdjacencyIssues: boolean;
  orphanToolUses: string[];
  orphanToolResults: string[];
  emptyMessages: number;
  thinkingBlocks: number;
  signedThinkingBlocks: number;
}

export interface ContextEditorRepairPreview {
  changed: boolean;
  removedToolUses: string[];
  removedToolResults: string[];
  removedMessages: number;
}

export interface ContextEditorValidationError {
  path: string;
  code: string;
  message: string;
}

export interface ContextEditorWarning {
  path?: string | undefined;
  code: string;
  severity: 'info' | 'warning' | 'danger';
  message: string;
}

export interface ContextEditorConflict {
  code: 'CONTEXT_REVISION_CONFLICT' | 'RUN_ACTIVE';
  message: string;
}

export interface ContextEditorValidationResult {
  ok: boolean;
  baseRevision: string;
  currentRevision: string;
  before: ContextEditorMetrics;
  after?: ContextEditorMetrics | undefined;
  validationErrors: ContextEditorValidationError[];
  warnings: ContextEditorWarning[];
  repair: ContextEditorRepairPreview;
  conflict?: ContextEditorConflict | undefined;
  messages?: Message[] | undefined;
}

export interface ContextEditorAppliedResult {
  previousRevision: string;
  revision: string;
  before: ContextEditorMetrics;
  after: ContextEditorMetrics;
  removed: {
    messages: number;
    blocks: number;
    toolUses: string[];
    toolResults: string[];
    emptyMessages: number;
  };
  warnings: ContextEditorWarning[];
}

export interface ContextEditorSnapshot {
  revision: string;
  messages: ContextEditorMessage[];
  readonlyContext: {
    systemPromptTokens: number;
    toolSchemaTokens: number;
    toolCount: number;
    totalTokens: number;
    messageTokens: number;
  };
  messageBreakdown: Array<{
    index: number;
    role: Message['role'];
    tokens: number;
    preview: string;
    blockCount: number | null;
    warnings: ContextEditorWarning[];
    pairedAssistantIndices: number[];
  }>;
  diagnostics: ContextEditorDiagnostics;
}

const REVISION_PREFIX = 'wrongstack-context-editor-v1\0';
const MAX_MESSAGE_COUNT_GROWTH = 10;
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
const MAX_STRING_LENGTH = 8 * 1024 * 1024;
const MAX_REMOVAL_COUNT = 4096;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      if (key === '_estTokens' || key === '_toolErrorInfo') continue;
      const item = value[key];
      if (item === undefined) continue;
      sorted[key] = canonicalize(item);
    }
    return sorted;
  }
  return value;
}

export function contextEditorRevision(messages: readonly Message[]): string {
  const hash = createHash('sha256');
  hash.update(REVISION_PREFIX);
  hash.update(JSON.stringify(canonicalize(messages)));
  return hash.digest('hex');
}

function jsonByteLength(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return MAX_PAYLOAD_BYTES + 1;
  }
}

function error(
  errors: ContextEditorValidationError[],
  path: string,
  code: string,
  message: string,
): void {
  errors.push({ path, code, message });
}

function isMessageRole(value: unknown): value is Message['role'] {
  return value === 'user' || value === 'assistant' || value === 'system';
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  return isRecord(value);
}

function splitsSurrogatePair(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return false;
  const previous = text.charCodeAt(offset - 1);
  const next = text.charCodeAt(offset);
  return previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
}

function validateCacheControl(
  value: unknown,
  path: string,
  errors: ContextEditorValidationError[],
): { type: 'ephemeral' } | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || value['type'] !== 'ephemeral') {
    error(errors, path, 'INVALID_CACHE_CONTROL', 'cache_control must be { type: "ephemeral" }.');
    return undefined;
  }
  return { type: 'ephemeral' };
}

function validateProviderMeta(
  value: unknown,
  path: string,
  errors: ContextEditorValidationError[],
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!isPlainJsonObject(value)) {
    error(errors, path, 'INVALID_PROVIDER_META', 'providerMeta must be a JSON object.');
    return undefined;
  }
  return value;
}

function validateBlock(
  value: unknown,
  path: string,
  errors: ContextEditorValidationError[],
): ContentBlock | undefined {
  if (!isRecord(value)) {
    error(errors, path, 'INVALID_BLOCK', 'Content block must be an object.');
    return undefined;
  }
  const type = value['type'];
  switch (type) {
    case 'text': {
      const text = value['text'];
      if (typeof text !== 'string') {
        error(errors, `${path}/text`, 'INVALID_TEXT', 'Text block text must be a string.');
        return undefined;
      }
      if (text.length > MAX_STRING_LENGTH) {
        error(errors, `${path}/text`, 'TEXT_TOO_LARGE', 'Text block is too large.');
        return undefined;
      }
      const cacheControl = validateCacheControl(
        value['cache_control'],
        `${path}/cache_control`,
        errors,
      );
      return cacheControl
        ? { type: 'text', text, cache_control: cacheControl }
        : { type: 'text', text };
    }
    case 'tool_use': {
      const id = value['id'];
      const name = value['name'];
      const input = value['input'];
      if (typeof id !== 'string' || id.length === 0) {
        error(
          errors,
          `${path}/id`,
          'INVALID_TOOL_USE_ID',
          'tool_use.id must be a non-empty string.',
        );
      }
      if (typeof name !== 'string' || name.length === 0) {
        error(
          errors,
          `${path}/name`,
          'INVALID_TOOL_NAME',
          'tool_use.name must be a non-empty string.',
        );
      }
      if (!isPlainJsonObject(input)) {
        error(errors, `${path}/input`, 'INVALID_TOOL_INPUT', 'tool_use.input must be an object.');
      }
      const providerMeta = validateProviderMeta(
        value['providerMeta'],
        `${path}/providerMeta`,
        errors,
      );
      if (
        typeof id !== 'string' ||
        id.length === 0 ||
        typeof name !== 'string' ||
        name.length === 0 ||
        !isPlainJsonObject(input)
      ) {
        return undefined;
      }
      return providerMeta === undefined
        ? { type: 'tool_use', id, name, input }
        : { type: 'tool_use', id, name, input, providerMeta };
    }
    case 'tool_result': {
      const toolUseId = value['tool_use_id'];
      const name = value['name'];
      const content = value['content'];
      const isError = value['is_error'];
      if (typeof toolUseId !== 'string' || toolUseId.length === 0) {
        error(
          errors,
          `${path}/tool_use_id`,
          'INVALID_TOOL_RESULT_ID',
          'tool_result.tool_use_id must be a non-empty string.',
        );
      }
      if (name !== undefined && typeof name !== 'string') {
        error(
          errors,
          `${path}/name`,
          'INVALID_TOOL_RESULT_NAME',
          'tool_result.name must be a string.',
        );
      }
      if (typeof content !== 'string') {
        error(
          errors,
          `${path}/content`,
          'INVALID_TOOL_RESULT_CONTENT',
          'tool_result.content must be a string.',
        );
      } else if (content.length > MAX_STRING_LENGTH) {
        error(
          errors,
          `${path}/content`,
          'TOOL_RESULT_TOO_LARGE',
          'tool_result.content is too large.',
        );
      }
      if (isError !== undefined && typeof isError !== 'boolean') {
        error(
          errors,
          `${path}/is_error`,
          'INVALID_TOOL_RESULT_ERROR',
          'tool_result.is_error must be boolean.',
        );
      }
      if (typeof toolUseId !== 'string' || toolUseId.length === 0 || typeof content !== 'string')
        return undefined;
      return {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content,
        ...(typeof name === 'string' ? { name } : {}),
        ...(typeof isError === 'boolean' ? { is_error: isError } : {}),
      };
    }
    case 'image': {
      // WS-032. This case used to check only the *types* of the source fields,
      // never their values — so it was a second image-ingest path that bypassed
      // every control `parseIncomingImages` enforces on the normal one: the
      // media-type allowlist, the base64 alphabet check, and the 8 MB cap.
      //
      // It was also the only way a `type: 'url'` image could enter WebUI
      // history at all (`parseIncomingImages` always emits base64), and the
      // SSRF guard for url-sourced images lives in `routeImagesForModel`, which
      // runs on the new-message path only — never on replayed history. So an
      // arbitrary URL written here went straight to the provider wire
      // (`to-openai` / `to-responses` both forward `source.url` verbatim).
      const source = value['source'];
      if (!isRecord(source)) {
        error(errors, `${path}/source`, 'INVALID_IMAGE_SOURCE', 'image.source must be an object.');
        return undefined;
      }
      const sourceType = source['type'];
      if (sourceType !== 'base64' && sourceType !== 'url') {
        error(
          errors,
          `${path}/source/type`,
          'INVALID_IMAGE_SOURCE_TYPE',
          'image.source.type must be base64 or url.',
        );
        return undefined;
      }
      const mediaType = source['media_type'];
      const data = source['data'];
      const url = source['url'];
      if (mediaType !== undefined && typeof mediaType !== 'string') {
        error(
          errors,
          `${path}/source/media_type`,
          'INVALID_IMAGE_MEDIA_TYPE',
          'image.source.media_type must be a string.',
        );
        return undefined;
      }
      // `media_type` is interpolated into a `data:` URL by the OpenAI and
      // Responses wires, so an unvalidated value is header injection into that
      // URL, not just a wrong label.
      if (typeof mediaType === 'string' && !isAllowedImageMediaType(mediaType)) {
        error(
          errors,
          `${path}/source/media_type`,
          'UNSUPPORTED_IMAGE_MEDIA_TYPE',
          `image.source.media_type must be one of: ${[...ALLOWED_IMAGE_MEDIA_TYPES].join(', ')}.`,
        );
        return undefined;
      }

      if (sourceType === 'base64') {
        if (typeof data !== 'string' || data.length === 0) {
          error(
            errors,
            `${path}/source/data`,
            'INVALID_IMAGE_DATA',
            'image.source.data must be a non-empty string for a base64 source.',
          );
          return undefined;
        }
        if (!isValidImageBase64(data)) {
          error(
            errors,
            `${path}/source/data`,
            'INVALID_IMAGE_DATA',
            'image.source.data is not valid base64.',
          );
          return undefined;
        }
        if (base64DecodedBytes(data) > MAX_INCOMING_IMAGE_BYTES) {
          error(
            errors,
            `${path}/source/data`,
            'IMAGE_TOO_LARGE',
            `image.source.data exceeds the ${MAX_INCOMING_IMAGE_BYTES / (1024 * 1024)} MB limit.`,
          );
          return undefined;
        }
        return {
          type: 'image',
          source: {
            type: 'base64',
            ...(typeof mediaType === 'string' ? { media_type: mediaType } : {}),
            data,
          },
        };
      }

      if (typeof url !== 'string' || url.length === 0) {
        error(
          errors,
          `${path}/source/url`,
          'INVALID_IMAGE_URL',
          'image.source.url must be a non-empty string for a url source.',
        );
        return undefined;
      }
      error(
        errors,
        `${path}/source/url`,
        'UNSAFE_IMAGE_URL',
        'URL image sources are not allowed in context editor proposals; use an ingested base64 image.',
      );
      return undefined;
    }
    case 'thinking': {
      const thinking = value['thinking'];
      const signature = value['signature'];
      if (typeof thinking !== 'string') {
        error(
          errors,
          `${path}/thinking`,
          'INVALID_THINKING',
          'thinking.thinking must be a string.',
        );
        return undefined;
      }
      if (signature !== undefined && typeof signature !== 'string') {
        error(
          errors,
          `${path}/signature`,
          'INVALID_THINKING_SIGNATURE',
          'thinking.signature must be a string.',
        );
      }
      const providerMeta = validateProviderMeta(
        value['providerMeta'],
        `${path}/providerMeta`,
        errors,
      );
      return {
        type: 'thinking',
        thinking,
        ...(typeof signature === 'string' ? { signature } : {}),
        ...(providerMeta === undefined ? {} : { providerMeta }),
      };
    }
    default:
      error(
        errors,
        `${path}/type`,
        'UNKNOWN_BLOCK_TYPE',
        `Unknown content block type: ${String(type)}`,
      );
      return undefined;
  }
}

export function validateContextEditorMessages(
  value: unknown,
  currentMessageCount = 0,
): { messages: Message[]; errors: ContextEditorValidationError[] } {
  const errors: ContextEditorValidationError[] = [];
  const messages: Message[] = [];
  if (!Array.isArray(value)) {
    error(errors, '/messages', 'INVALID_MESSAGES', 'messages must be an array.');
    return { messages, errors };
  }
  if (value.length > currentMessageCount + MAX_MESSAGE_COUNT_GROWTH) {
    error(
      errors,
      '/messages',
      'TOO_MANY_MESSAGES',
      'Context editor is deletion-oriented; proposed message count grew too much.',
    );
  }
  if (jsonByteLength(value) > MAX_PAYLOAD_BYTES) {
    error(errors, '/messages', 'PAYLOAD_TOO_LARGE', 'Context editor payload is too large.');
  }
  value.forEach((item, index) => {
    const path = `/messages/${index}`;
    if (!isRecord(item)) {
      error(errors, path, 'INVALID_MESSAGE', 'Message must be an object.');
      return;
    }
    const role = item['role'];
    if (!isMessageRole(role)) {
      error(
        errors,
        `${path}/role`,
        'INVALID_ROLE',
        'Message role must be user, assistant, or system.',
      );
      return;
    }
    const rawContent = item['content'];
    let content: Message['content'] | undefined;
    if (typeof rawContent === 'string') {
      if (rawContent.length > MAX_STRING_LENGTH) {
        error(errors, `${path}/content`, 'CONTENT_TOO_LARGE', 'Message content is too large.');
        return;
      }
      content = rawContent;
    } else if (Array.isArray(rawContent)) {
      const blocks: ContentBlock[] = [];
      rawContent.forEach((block, blockIndex) => {
        const parsed = validateBlock(block, `${path}/content/${blockIndex}`, errors);
        if (parsed) blocks.push(parsed);
      });
      content = blocks;
    } else {
      error(
        errors,
        `${path}/content`,
        'INVALID_CONTENT',
        'Message content must be a string or content block array.',
      );
      return;
    }
    const ts = item['ts'];
    if (ts !== undefined) {
      if (typeof ts !== 'string' || Number.isNaN(Date.parse(ts))) {
        error(
          errors,
          `${path}/ts`,
          'INVALID_TIMESTAMP',
          'Message ts must be an ISO-like timestamp string.',
        );
        return;
      }
    }
    messages.push({ role, content, ...(typeof ts === 'string' ? { ts } : {}) });
  });
  return { messages, errors };
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
    JSON.stringify(canonicalize(expectedProposal)) !==
    JSON.stringify(canonicalize(proposedMessages))
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
