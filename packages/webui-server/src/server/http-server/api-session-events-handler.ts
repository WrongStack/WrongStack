import type * as http from 'node:http';
import { sanitizeApiError } from '@wrongstack/core/security';
import type { ApiSessionEvents } from '@wrongstack/webui-protocol';

/** One line in the session "watch" stream sent to the browser.
 *  Rich enough for the frontend to render full tool call details,
 *  markdown, and structured data — not just pre-clipped text. */
interface WatchEntry {
  ts: string;
  role: 'user' | 'assistant' | 'tool' | 'system' | 'error';
  /** Human-readable text summary (may be clipped for tool input/output). */
  text: string;
  /** Tool name (for tool-role entries). */
  tool?: string;
  /** Structured tool input (object or array — rendered by ToolInputView). */
  input?: unknown;
  /** Structured tool output (rendered as pre-formatted text / markdown). */
  output?: unknown;
  /** Wall-clock duration in ms (tool call / response). */
  durationMs?: number;
  /** Whether the tool/response had an error. */
  isError?: boolean;
  /** Tool use correlation id — pairs tool_call_start with tool_call_end. */
  toolUseId?: string;
}

/** Join the text blocks of a message content value into a single string. */
function blocksToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (b): b is { type: string; text: string } =>
          !!b &&
          typeof b === 'object' &&
          (b as { type?: unknown }).type === 'text' &&
          typeof (b as { text?: unknown }).text === 'string',
      )
      .map((b) => b.text)
      .join('\n');
  }
  return '';
}

function asString(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/** Map a raw session event to a watch entry. Returns rich structured data
 *  for tool calls (input + output + duration) so the frontend can render
 *  full detail via WatchMessageBubble — matching the main ChatView. */
function mapWatchEntry(ev: Record<string, unknown>): WatchEntry | null {
  const ts = typeof ev['ts'] === 'string' ? (ev['ts'] as string) : '';
  switch (ev['type']) {
    case 'user_input': {
      const text = blocksToText(ev['content']);
      return text.trim() ? { ts, role: 'user', text } : null;
    }
    case 'llm_response': {
      const text = blocksToText(ev['content']);
      return text.trim() ? { ts, role: 'assistant', text } : null;
    }
    case 'tool_use':
    case 'tool_call_start': {
      const toolName = String(ev['name'] ?? 'tool');
      const input = ev['input'] ?? ev['args'];
      const text = input !== undefined && input !== null ? asString(input) : '';
      const toolUseId = typeof ev['id'] === 'string' ? ev['id'] : undefined;
      return {
        ts,
        role: 'tool',
        tool: toolName,
        text,
        input,
        ...(toolUseId !== undefined ? { toolUseId } : {}),
      };
    }
    case 'tool_call_end':
    case 'tool_result': {
      const isError = ev['isError'] === true;
      const content = ev['output'] ?? ev['content'];
      const outStr = content !== undefined && content !== null ? asString(content) : '';
      const durationMs = typeof ev['durationMs'] === 'number' ? ev['durationMs'] : undefined;
      const toolUseId = typeof ev['id'] === 'string' ? ev['id'] : undefined;
      const toolName = typeof ev['name'] === 'string' ? String(ev['name']) : '↳ result';
      if (!outStr.trim() && !isError) return null;
      return {
        ts,
        role: isError ? 'error' : 'tool',
        tool: toolName,
        text: outStr,
        output: content,
        isError,
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(toolUseId !== undefined ? { toolUseId } : {}),
      };
    }
    case 'error':
    case 'provider_error':
      return { ts, role: 'error', text: String(ev['message'] ?? 'error') };
    case 'agent_spawned':
      return { ts, role: 'system', text: `spawned ${String(ev['role'] ?? 'agent')}` };
    case 'task_completed':
      return { ts, role: 'system', text: `task done: ${String(ev['title'] ?? '')}` };
    case 'task_failed':
      return { ts, role: 'system', text: `task failed: ${String(ev['title'] ?? '')}` };
    default:
      return null;
  }
}

/** Correlate tool_call_start + tool_call_end events by id and merge them
 *  into unified WatchEntry entries with full input+output+duration.
 *  Standalone events (unpaired) pass through as-is. */
function correlateToolEvents(entries: WatchEntry[]): WatchEntry[] {
  const pending = new Map<string, WatchEntry>(); // toolUseId → start entry
  const result: WatchEntry[] = [];
  for (const e of entries) {
    if (e.role === 'tool' && e.toolUseId && e.output === undefined && e.durationMs === undefined) {
      // This is a tool_call_start with no result yet — stash it
      pending.set(e.toolUseId, e);
      continue;
    }
    if (e.toolUseId && pending.has(e.toolUseId)) {
      const start = pending.get(e.toolUseId)!;
      pending.delete(e.toolUseId);
      // Merge: keep the start's ts, tool name, and input; add the end's output/duration/error
      result.push({
        ts: start.ts,
        role: e.isError ? 'error' : 'tool',
        text: e.text || start.text,
        ...(e.isError !== undefined ? { isError: e.isError } : {}),
        ...(start.tool !== undefined ? { tool: start.tool } : {}),
        ...(start.input !== undefined ? { input: start.input } : {}),
        ...(e.output !== undefined ? { output: e.output } : {}),
        ...(e.durationMs !== undefined ? { durationMs: e.durationMs } : {}),
        ...(e.toolUseId !== undefined ? { toolUseId: e.toolUseId } : {}),
      });
      continue;
    }
    result.push(e);
  }
  // Unpaired start events: flush at the end
  for (const e of pending.values()) result.push(e);
  return result;
}

export async function handleApiSessionEvents(
  res: http.ServerResponse,
  globalRoot: string | undefined,
  sessionId: string,
  limit: number,
): Promise<void> {
  if (!globalRoot) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'SessionRegistry not available' }));
    return;
  }

  try {
    const { getSessionRegistry, DefaultSessionStore, DefaultSessionReader } = await import(
      '@wrongstack/core/storage'
    );
    const { resolveWstackPaths } = await import('@wrongstack/core/utils');
    const registry = getSessionRegistry(globalRoot);
    const entry = await registry.get(sessionId);
    if (!entry) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session not found' }));
      return;
    }

    const paths = resolveWstackPaths({ projectRoot: entry.projectRoot, globalRoot });
    const store = new DefaultSessionStore({
      dir: paths.projectSessions,
      projectRoot: entry.projectRoot,
    });
    const reader = new DefaultSessionReader({ store });

    // Bounded tail fold.
    //
    // This used to materialise EVERY event of the session — including the
    // structured `input`/`output` of every tool call — and only then apply
    // `limit` (1..500). `correlateToolEvents` then built a second full array
    // plus a Map keyed by every tool-use id. Fleet HQ polls this endpoint
    // while watching long-running sessions whose JSONL runs to hundreds of MB,
    // so each poll allocated two full copies of a corpus the client never
    // renders. Keep a ring generous enough that a tool `start` is still
    // present when its `end` arrives, and drop everything older.
    const RING = Math.max(limit * 4, 2000);
    const ring: WatchEntry[] = [];
    let totalRaw = 0;
    let dropped = false;
    for await (const ev of reader.replay(sessionId)) {
      const mapped = mapWatchEntry(ev as never as Record<string, unknown>);
      if (!mapped) continue;
      totalRaw += 1;
      ring.push(mapped);
      if (ring.length > RING) {
        ring.shift();
        dropped = true;
      }
    }
    // Correlate paired tool call start+end events for rich combined rendering
    const all = correlateToolEvents(ring);
    const tail = all.slice(-limit);

    const payload = JSON.stringify({
      sessionId,
      status: entry.status,
      clientType: entry.clientType,
      projectName: entry.projectName,
      // Exact when the whole session fit in the ring (the previous
      // behaviour). Past that, correlation never ran over the dropped
      // prefix, so report the raw event count — an upper bound — and say so
      // rather than silently understating the session's size.
      total: dropped ? totalRaw : all.length,
      ...(dropped ? { truncated: true } : {}),
      entries: tail,
    } satisfies ApiSessionEvents);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(payload);
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: sanitizeApiError(err) }));
    } else if (!res.writableEnded) {
      res.end();
    }
  }
}
