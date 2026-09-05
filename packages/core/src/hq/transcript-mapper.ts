/**
 * Transcript mapper — converts raw session JSONL events into the canonical
 * {@link HqTranscriptEntry} shape used by HQ for full chat-history rendering.
 *
 * On-disk reality (see `types/session.ts` + `core/agent-tools.ts`):
 *   - A tool CALL (with its arguments) is NOT a standalone event — it is a
 *     `tool_use` content block inside the assistant's `llm_response`.
 *   - The tool RESULT is a separate `tool_result` event carrying the matching
 *     `id`.
 * So we extract each `tool_use` block as a tool entry (args) at the assistant's
 * position, then merge the later `tool_result` (matched by `id`) INTO that same
 * entry — giving one box per tool (args + result) in strict chronological order.
 *
 * @module hq/transcript-mapper
 */

import type { SessionEvent } from '../types/session.js';
import { CHAT_MARKER_SOURCES, sessionEventToMarker } from '../types/session-markers.js';
import type { HqTranscriptEntry, HqTranscriptRole } from './protocol.js';

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

function argsEntry(ts: string, name: unknown, input: unknown, id: unknown): HqTranscriptEntry {
  return {
    ts,
    role: 'tool',
    tool: String(name ?? 'tool'),
    toolInput: input !== undefined && input !== null ? asString(input) : '{}',
    text: '',
    ...(typeof id === 'string' ? { toolUseId: id } : {}),
  };
}

/**
 * Map a single raw JSONL session event to zero or more transcript entries.
 * An `llm_response` can yield an assistant text entry PLUS one tool entry per
 * embedded `tool_use` block.
 */
export function mapSessionEventToEntries(ev: Record<string, unknown>): HqTranscriptEntry[] {
  const ts = typeof ev['ts'] === 'string' ? (ev['ts'] as string) : '';
  const make = (
    role: HqTranscriptRole,
    text: string,
    extra?: Partial<HqTranscriptEntry>,
  ): HqTranscriptEntry => ({
    ts,
    role,
    text,
    ...extra,
  });

  switch (ev['type']) {
    case 'user_input': {
      const t = blocksToText(ev['content']);
      return t.trim() ? [make('user', t)] : [];
    }
    case 'llm_response': {
      const out: HqTranscriptEntry[] = [];
      const content = ev['content'];
      // Thinking blocks precede text/tool_use in an assistant message (provider
      // contract) — surface them first so the transcript preserves that order.
      if (Array.isArray(content)) {
        const thinking = content
          .filter(
            (b): b is { type: string; thinking: string } =>
              !!b &&
              typeof b === 'object' &&
              (b as { type?: unknown }).type === 'thinking' &&
              typeof (b as { thinking?: unknown }).thinking === 'string',
          )
          .map((b) => b.thinking)
          .join('\n');
        if (thinking.trim()) out.push(make('thinking', thinking));
      }
      const t = blocksToText(content);
      if (t.trim()) out.push(make('assistant', t));
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b && typeof b === 'object' && (b as { type?: unknown }).type === 'tool_use') {
            const block = b as { id?: unknown; name?: unknown; input?: unknown };
            out.push(argsEntry(ts, block.name, block.input, block.id));
          }
        }
      }
      return out;
    }
    case 'tool_use':
      return [argsEntry(ts, ev['name'], ev['input'], ev['id'])];
    case 'tool_call_start':
      return [argsEntry(ts, ev['name'], ev['input'] ?? ev['args'], ev['id'])];
    case 'tool_result': {
      const isError = ev['isError'] === true;
      const content = ev['content'] ?? ev['output'];
      const outStr = content !== undefined && content !== null ? asString(content) : '';
      return [
        make(isError ? 'error' : 'tool', outStr, {
          tool: '↳ result',
          ...(isError ? { isError: true } : {}),
          ...(typeof ev['id'] === 'string' ? { toolUseId: ev['id'] } : {}),
        }),
      ];
    }
    case 'tool_call_end': {
      const isError = ev['isError'] === true;
      const content = ev['output'] ?? ev['content'];
      const outStr = content !== undefined && content !== null ? asString(content) : '';
      if (!outStr.trim() && !isError && typeof ev['durationMs'] !== 'number') return [];
      return [
        make(isError ? 'error' : 'tool', outStr, {
          tool: typeof ev['name'] === 'string' ? String(ev['name']) : '↳ result',
          ...(typeof ev['durationMs'] === 'number' ? { durationMs: ev['durationMs'] } : {}),
          ...(isError ? { isError: true } : {}),
          ...(typeof ev['id'] === 'string' ? { toolUseId: ev['id'] } : {}),
        }),
      ];
    }
    case 'task_completed':
      return [make('system', `task done: ${String(ev['title'] ?? '')}`)];
    case 'task_failed':
      return [make('system', `task failed: ${String(ev['title'] ?? '')}`)];
    default: {
      // Audit markers (compaction, mode/skill switches, subagent lifecycle,
      // provider retries/errors, truncation) share their wording with every
      // other surface. This one branch covers both HQ planes: the disk replay
      // behind `/api/sessions/:id/events` and the live `session.transcript`
      // stream, since both funnel through this mapper.
      if (!CHAT_MARKER_SOURCES.has(ev['type'] as SessionEvent['type'])) return [];
      const marker = sessionEventToMarker(ev as unknown as SessionEvent);
      if (!marker) return [];
      // HqTranscriptRole has no 'warn'; warn-level markers keep their leading
      // glyph (⟳ / truncation wording) to stay distinguishable as 'system'.
      return [
        make(marker.level === 'error' ? 'error' : 'system', marker.text, {
          ...(marker.level === 'error' ? { isError: true } : {}),
          ...(marker.agentId !== undefined ? { agentId: marker.agentId } : {}),
        }),
      ];
    }
  }
}

/**
 * Identify a "result" entry — a tool/error entry that carries a tool-use id but
 * no args (it's the output half of a tool call, to be merged into the args
 * half).
 */
function isResultEntry(e: HqTranscriptEntry): boolean {
  return (
    (e.role === 'tool' || e.role === 'error') &&
    e.toolUseId !== undefined &&
    e.toolInput === undefined
  );
}

/**
 * Merge each tool result into its matching args entry (by `toolUseId`),
 * keeping the args entry's chronological position. Results with no matching
 * args entry are kept as their own entries. Mutates/keeps order; pure w.r.t.
 * input ordering.
 */
export function mergeToolResults(flat: readonly HqTranscriptEntry[]): HqTranscriptEntry[] {
  const out: HqTranscriptEntry[] = [];
  const argsById = new Map<string, HqTranscriptEntry>();
  for (const src of flat) {
    const e: HqTranscriptEntry = { ...src };
    if (isResultEntry(e) && e.toolUseId !== undefined) {
      const tgt = argsById.get(e.toolUseId);
      if (tgt) {
        tgt.text = e.text || '';
        if (e.durationMs !== undefined) tgt.durationMs = e.durationMs;
        if (e.isError) {
          tgt.role = 'error';
          tgt.isError = true;
        }
        continue; // merged into the existing args box — no new entry
      }
    }
    out.push(e);
    if (e.role === 'tool' && e.toolUseId !== undefined && e.toolInput !== undefined) {
      argsById.set(e.toolUseId, e);
    }
  }
  return out;
}

/**
 * Map + merge an array of raw JSONL events into the final transcript-entry
 * list: strict chronological order, with each tool's args and result combined
 * into a single entry.
 */
export function buildTranscriptFromEvents(
  events: Iterable<Record<string, unknown>>,
): HqTranscriptEntry[] {
  const flat: HqTranscriptEntry[] = [];
  for (const ev of events) {
    for (const e of mapSessionEventToEntries(ev)) flat.push(e);
  }
  return mergeToolResults(flat);
}
