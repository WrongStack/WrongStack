import type { ChatMessage, SimpleSubagent } from '../types.js';

export const SYSTEM_INJECTION_PREFIXES = [
  '[MAILBOX]',
  '[MAILBOX BTW]',
  '[BY THE WAY —',
  '[QUEUED MESSAGES —',
  '[FLEET PULSE]',
  '[loop-detector]',
  '[SESSION RESUME FILE VALIDATION]',
  '[SESSION RESUME INTERRUPTED WORK]',
  '[session.resume] Request targeted session',
] as const;

export function isSystemInjectedMessage(text: string): boolean {
  const trimmed = text.trimStart();
  for (const prefix of SYSTEM_INJECTION_PREFIXES) {
    if (trimmed.startsWith(prefix)) return true;
  }
  return false;
}

export const SIMPLE_CHAT_MAX_MESSAGES = 600;
export const SIMPLE_CHAT_MAX_RETAINED_BYTES = 32 * 1024 * 1024;
export const SIMPLE_CHAT_MAX_TEXT_CHARS = 2 * 1024 * 1024;

interface SimpleChatRetentionBudget {
  maxMessages?: number;
  maxBytes?: number;
  maxTextChars?: number;
}

/** Keep both ends of pathological provider output while bounding its heap. */
export function boundSimpleChatText(text: string, maxChars = SIMPLE_CHAT_MAX_TEXT_CHARS): string {
  if (text.length <= maxChars) return text;
  const marker = '\n\n… [older streamed text omitted to protect memory] …\n\n';
  if (maxChars <= marker.length) {
    const head = Math.ceil(maxChars / 2);
    return text.slice(0, head) + text.slice(text.length - (maxChars - head));
  }
  const available = Math.max(0, maxChars - marker.length);
  const head = Math.ceil(available / 2);
  return text.slice(0, head) + marker + text.slice(text.length - (available - head));
}

function retainedMessageBytes(message: ChatMessage): number {
  let bytes = message.text.length * 2 + 256;
  for (const image of message.images ?? []) {
    bytes += image.data.length * 2 + image.mime.length * 2 + 64;
  }
  return bytes;
}

/**
 * Bound the visible transcript by both count and approximate UTF-16 heap
 * bytes. A count-only cap still permits a few giant replay/vision rows to pin
 * hundreds of MB. The persisted session remains the complete source of truth.
 */
export function retainSimpleChatMessages(
  messages: readonly ChatMessage[],
  budget: SimpleChatRetentionBudget = {},
): ChatMessage[] {
  const maxMessages = Math.max(1, Math.floor(budget.maxMessages ?? SIMPLE_CHAT_MAX_MESSAGES));
  const maxBytes = Math.max(1, Math.floor(budget.maxBytes ?? SIMPLE_CHAT_MAX_RETAINED_BYTES));
  const maxTextChars = Math.max(1, Math.floor(budget.maxTextChars ?? SIMPLE_CHAT_MAX_TEXT_CHARS));
  const retained: ChatMessage[] = [];
  let bytes = 0;

  for (let index = messages.length - 1; index >= 0 && retained.length < maxMessages; index -= 1) {
    const source = messages[index]!;
    let message: ChatMessage =
      source.text.length > maxTextChars
        ? { ...source, text: boundSimpleChatText(source.text, maxTextChars) }
        : source;
    let messageBytes = retainedMessageBytes(message);
    if (messageBytes > maxBytes && message.images?.length) {
      message = { ...message, images: undefined };
      messageBytes = retainedMessageBytes(message);
    }
    if (retained.length > 0 && bytes + messageBytes > maxBytes) break;
    retained.push(message);
    bytes += messageBytes;
  }

  retained.reverse();
  return retained;
}

function blockText(block: unknown): string {
  if (typeof block === 'string') return block;
  if (!block || typeof block !== 'object') return '';
  const value = block as Record<string, unknown>;
  if (typeof value['text'] === 'string') return value['text'];
  if (typeof value['content'] === 'string') return value['content'];
  if (Array.isArray(value['content'])) return contentToText(value['content']);
  return '';
}

/** Convert canonical provider/session content blocks into safe display text. */
export function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(blockText).filter(Boolean).join('\n\n');
  return blockText(content);
}

/**
 * Extract only text content from replay message content blocks, filtering out
 * tool_use, tool_result, thinking, and image blocks that should not appear as
 * visible assistant text in the conversation.
 *
 * During session replay, assistant messages may have mixed ContentBlock[]
 * where tool_use and tool_result blocks are interleaved with text blocks.
 * This function keeps only blocks where `type === 'text'`, aligning replay
 * rendering with the live streaming path (where tool calls are tracked
 * separately in `toolCalls` state and rendered as a grouped accordion at
 * the bottom of the conversation).
 */
function replayTextContent(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter(
        (block): block is { type: 'text'; text: string } =>
          typeof block === 'object' &&
          block !== null &&
          (block as Record<string, unknown>)['type'] === 'text' &&
          typeof (block as Record<string, unknown>)['text'] === 'string',
      )
      .map((block) => block.text)
      .join('\n\n')
      .trim();
  }
  return '';
}

/**
 * Whether a persisted message's content carries a `tool_use` block. Such a
 * message stopped for a tool call, so it is mid-turn — string content cannot
 * hold a tool call and always ends its turn.
 */
function hasToolUseBlock(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some(
    (block) =>
      typeof block === 'object' &&
      block !== null &&
      (block as Record<string, unknown>)['type'] === 'tool_use',
  );
}

function isSystemInjected(text: string): boolean {
  return isSystemInjectedMessage(text);
}

/**
 * Rebuild the visible chat history from a `session.start` replay.
 *
 * `markers` carries the audit timeline (compaction, mode/skill switches,
 * subagent lifecycle, provider retries, truncation) projected server-side.
 * They are interleaved by timestamp so a page refresh shows the same events
 * the live stream did. Ties keep the conversation message first, and a
 * message with no `ts` does not advance the marker cursor — the same merge
 * rule the TUI resume renderer uses.
 *
 * Note the injection filter deliberately applies to conversation entries
 * only: markers are generated by this projection, not folded into the
 * conversation by the agent loop, so they never look like fake user input.
 */
export function replayToMessages(replay: unknown, markers?: unknown): ChatMessage[] {
  if (!Array.isArray(replay)) return [];
  const markerList = Array.isArray(markers) ? markers : [];
  const out: ChatMessage[] = [];
  let markerIndex = 0;

  const pushMarker = (marker: Record<string, unknown>, index: number): void => {
    const text = typeof marker['text'] === 'string' ? marker['text'] : '';
    if (!text) return;
    out.push({
      id: `replay-marker-${index}`,
      role: 'system',
      text,
      ts: typeof marker['ts'] === 'string' ? marker['ts'] : undefined,
    } satisfies ChatMessage);
  };
  const markerTs = (index: number): string | undefined => {
    const marker = markerList[index];
    if (!marker || typeof marker !== 'object') return undefined;
    const ts = (marker as Record<string, unknown>)['ts'];
    return typeof ts === 'string' ? ts : undefined;
  };
  const flushMarkersBefore = (boundary: unknown): void => {
    if (typeof boundary !== 'string') return;
    for (;;) {
      const ts = markerTs(markerIndex);
      if (ts === undefined || ts >= boundary) break;
      pushMarker(markerList[markerIndex] as Record<string, unknown>, markerIndex);
      markerIndex += 1;
    }
  };

  for (const [index, entry] of replay.entries()) {
    if (!entry || typeof entry !== 'object') continue;
    const value = entry as Record<string, unknown>;
    flushMarkersBefore(value['ts']);
    const role = value['role'];
    if (role !== 'user' && role !== 'assistant' && role !== 'system') continue;
    const text = replayTextContent(value['content']);
    if (!text) continue;
    // Filter out system-injected metadata blocks that were folded into the
    // conversation by the agent loop (mailbox, BTW, fleet-pulse, loop-
    // detector).  These exist for the LLM at runtime; the human does not
    // need to re-read them on page refresh.
    if (isSystemInjected(text)) continue;
    out.push({
      id: `replay-${index}`,
      role,
      text,
      ts: typeof value['ts'] === 'string' ? value['ts'] : undefined,
      // An assistant message carrying a tool_use block stopped for a tool
      // call, so its prose is mid-turn and must not offer suggestions on
      // resume. Anything else ended its turn.
      ...(role === 'assistant' ? { final: !hasToolUseBlock(value['content']) } : {}),
    } satisfies ChatMessage);
  }

  while (markerIndex < markerList.length) {
    const marker = markerList[markerIndex];
    if (marker && typeof marker === 'object') {
      pushMarker(marker as Record<string, unknown>, markerIndex);
    }
    markerIndex += 1;
  }

  return retainSimpleChatMessages(out);
}

function upsert(
  agents: SimpleSubagent[],
  id: string,
  patch: Partial<SimpleSubagent>,
): SimpleSubagent[] {
  if (!id || id === 'leader') return agents;
  const current = agents.find((agent) => agent.id === id);
  if (!current) return [...agents, { id, name: id, status: 'idle', ...patch }];
  return agents.map((agent) => (agent.id === id ? { ...agent, ...patch } : agent));
}

/** Apply the intentionally small subagent projection used by the header strip. */
export function updateSubagents(
  agents: SimpleSubagent[],
  payload: Record<string, unknown>,
): SimpleSubagent[] {
  const id = typeof payload['subagentId'] === 'string' ? payload['subagentId'] : '';
  const kind = typeof payload['kind'] === 'string' ? payload['kind'] : '';
  if (kind === 'removed') return agents.filter((agent) => agent.id !== id);

  const task =
    typeof payload['description'] === 'string'
      ? payload['description']
      : typeof payload['task'] === 'string'
        ? payload['task']
        : undefined;
  if (kind === 'spawned') {
    return upsert(agents, id, {
      name: typeof payload['name'] === 'string' ? payload['name'] : id,
      status: 'idle',
      task,
      model: typeof payload['model'] === 'string' ? payload['model'] : undefined,
    });
  }
  if (kind === 'task_started') return upsert(agents, id, { status: 'running', task });
  if (kind === 'task_completed') {
    const status = typeof payload['status'] === 'string' ? payload['status'] : 'completed';
    return upsert(agents, id, { status, task: undefined });
  }
  return upsert(agents, id, {});
}
