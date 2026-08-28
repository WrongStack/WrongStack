import type { ChatRetentionBudget } from './chat-store-types';
import type { ChatMessage } from './types.js';

export function dedupeRepeatedBlocks(text: string): string {
  if (!text) return text;
  const paraSplit = text.split(/\n{2,}/);
  const paras: string[] = [];
  for (const p of paraSplit) {
    if (paras.length > 0 && paras[paras.length - 1]?.trim() === p.trim()) continue;
    paras.push(p);
  }
  const cleaned = paras.map((p) => {
    const lines = p.split('\n');
    const out: string[] = [];
    for (const line of lines) {
      if (out.length > 0 && line.trim().length > 0 && out[out.length - 1]?.trim() === line.trim()) {
        continue;
      }
      out.push(line);
    }
    return out.join('\n');
  });
  return cleaned.join('\n\n');
}

export const MAX_CHAT_MESSAGES = 1000;
export const MAX_PERSISTED_MESSAGES = 200;
export const MAX_CHAT_RETAINED_BYTES = 48 * 1024 * 1024;
export const MAX_CHAT_FIELD_CHARS = 2 * 1024 * 1024;

export function boundChatField(text: string, maxChars = MAX_CHAT_FIELD_CHARS): string {
  if (text.length <= maxChars) return text;
  const marker = '\n\n… [older streamed text omitted to protect memory] …\n\n';
  if (maxChars <= marker.length) {
    const head = Math.ceil(maxChars / 2);
    return text.slice(0, head) + text.slice(text.length - (maxChars - head));
  }
  const available = maxChars - marker.length;
  const head = Math.ceil(available / 2);
  return text.slice(0, head) + marker + text.slice(text.length - (available - head));
}

const unknownBytesCache = new WeakMap<object, number>();

function estimateUnknownBytes(value: unknown): number {
  if (value === undefined) return 0;
  const cacheable = typeof value === 'object' && value !== null;
  if (cacheable) {
    const cached = unknownBytesCache.get(value as object);
    if (cached !== undefined) return cached;
  }
  let bytes: number;
  try {
    bytes = JSON.stringify(value).length * 2;
  } catch {
    bytes = MAX_CHAT_FIELD_CHARS * 2;
  }
  if (cacheable) unknownBytesCache.set(value as object, bytes);
  return bytes;
}

function normalizeRetainedMessage(message: ChatMessage, maxFieldChars: number): ChatMessage {
  const content = boundChatField(message.content, maxFieldChars);
  const toolResult =
    message.toolResult === undefined
      ? undefined
      : boundChatField(message.toolResult, maxFieldChars);
  const thinkingLog = message.thinkingLog
    ? { ...message.thinkingLog, text: boundChatField(message.thinkingLog.text, maxFieldChars) }
    : undefined;
  const toolInput =
    estimateUnknownBytes(message.toolInput) > maxFieldChars * 2
      ? '[tool input omitted from live transcript to protect memory]'
      : message.toolInput;
  if (
    content === message.content &&
    toolResult === message.toolResult &&
    thinkingLog?.text === message.thinkingLog?.text &&
    toolInput === message.toolInput
  ) {
    return message;
  }
  return {
    ...message,
    content,
    ...(toolResult !== undefined ? { toolResult } : {}),
    ...(thinkingLog ? { thinkingLog } : {}),
    ...(toolInput !== undefined ? { toolInput } : {}),
  };
}

function retainedChatMessageBytes(message: ChatMessage): number {
  let bytes =
    384 +
    message.content.length * 2 +
    (message.toolResult?.length ?? 0) * 2 +
    (message.thinkingLog?.text.length ?? 0) * 2 +
    estimateUnknownBytes(message.toolInput);
  for (const attachment of message.attachments ?? []) {
    bytes += (attachment.dataUrl?.length ?? 0) * 2 + 192;
  }
  for (const line of message.sageLines ?? []) bytes += line.length * 2;
  for (const line of message.progressLines ?? []) bytes += line.length * 2;
  return bytes;
}

export function retainWebChatMessages(
  messages: readonly ChatMessage[],
  budget: ChatRetentionBudget = {},
): ChatMessage[] {
  const maxMessages = Math.max(1, Math.floor(budget.maxMessages ?? MAX_CHAT_MESSAGES));
  const maxBytes = Math.max(1, Math.floor(budget.maxBytes ?? MAX_CHAT_RETAINED_BYTES));
  const maxFieldChars = Math.max(1, Math.floor(budget.maxFieldChars ?? MAX_CHAT_FIELD_CHARS));
  const retained: ChatMessage[] = [];
  let bytes = 0;

  for (let index = messages.length - 1; index >= 0 && retained.length < maxMessages; index -= 1) {
    let message = normalizeRetainedMessage(messages[index]!, maxFieldChars);
    let messageBytes = retainedChatMessageBytes(message);
    if (messageBytes > maxBytes && message.attachments?.some((item) => item.dataUrl)) {
      message = {
        ...message,
        attachments: message.attachments.map((item) => ({ ...item, dataUrl: undefined })),
      };
      messageBytes = retainedChatMessageBytes(message);
    }
    if (retained.length > 0 && bytes + messageBytes > maxBytes) break;
    retained.push(message);
    bytes += messageBytes;
  }

  retained.reverse();
  return retained;
}

export function indexToolMessages(messages: readonly ChatMessage[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const m of messages) {
    if (m.role === 'tool' && m.toolUseId) index.set(m.toolUseId, m.id);
  }
  return index;
}
