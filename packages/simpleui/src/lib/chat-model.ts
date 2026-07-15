import type { ChatMessage, SimpleSubagent } from '../types.js';

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

export function replayToMessages(replay: unknown): ChatMessage[] {
  if (!Array.isArray(replay)) return [];
  return replay.flatMap((entry, index) => {
    if (!entry || typeof entry !== 'object') return [];
    const value = entry as Record<string, unknown>;
    const role = value['role'];
    if (role !== 'user' && role !== 'assistant' && role !== 'system') return [];
    const text = replayTextContent(value['content']);
    if (!text) return [];
    return [
      {
        id: `replay-${index}`,
        role,
        text,
        ts: typeof value['ts'] === 'string' ? value['ts'] : undefined,
      } satisfies ChatMessage,
    ];
  });
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
