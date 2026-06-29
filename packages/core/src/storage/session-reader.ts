import * as fs from 'node:fs/promises';
import { expectDefined } from '../utils/expect-defined.js';
import type { ContentBlock } from '../types/blocks.js';
import type {
  DefaultSessionReaderOptions,
  SessionExportOptions,
  SessionQuery,
  SessionReader,
  SessionSearchHit,
  SessionSearchQuery,
  SessionSummaryLite,
} from '../types/session-reader.js';
import { compileUserRegex } from '../utils/regex-guard.js';
import { sessionScopedPath } from '../utils/session-scoped-path.js';
import type { SessionData, SessionEvent, SessionMetadata, SessionStore } from '../types/session.js';

/**
 * L2-A: read-only view over a `SessionStore` with query, replay, search,
 * and export helpers. Implemented on top of the public `SessionStore`
 * surface so any concrete store can be inspected without re-implementation.
 */
export class DefaultSessionReader implements SessionReader {
  private readonly store: SessionStore;
  private readonly eventCache = new Map<string, SessionData>();
  private readonly eventCacheMtimes = new Map<string, number>();
  private static readonly EVENT_CACHE_MAX_ENTRIES = 32;

  constructor(opts: DefaultSessionReaderOptions) {
    this.store = opts.store;
  }

  private async loadCachedSessionData(sessionId: string): Promise<SessionData> {
    const storeWithPath = this.store as SessionStore & {
      dir?: string | undefined;
      clearLoadCache?: ((sessionId?: string | undefined) => void) | undefined;
    };
    const rootDir = storeWithPath.dir;
    if (!rootDir) {
      return await this.store.load(sessionId);
    }
    const sessionPath = sessionScopedPath(rootDir, sessionId, '.jsonl');
    let mtimeMs: number | null = null;
    try {
      const stat = await fs.stat(sessionPath);
      mtimeMs = stat.mtimeMs;
    } catch {
      this.eventCache.delete(sessionId);
      this.eventCacheMtimes.delete(sessionId);
      return await this.store.load(sessionId);
    }

    const cachedMtime = this.eventCacheMtimes.get(sessionId);
    const cachedData = this.eventCache.get(sessionId);
    if (cachedData && cachedMtime === mtimeMs) {
      this.eventCache.delete(sessionId);
      this.eventCacheMtimes.delete(sessionId);
      this.eventCache.set(sessionId, cachedData);
      this.eventCacheMtimes.set(sessionId, mtimeMs);
      return cachedData;
    }

    const data = await this.store.load(sessionId);
    this.eventCache.delete(sessionId);
    this.eventCacheMtimes.delete(sessionId);
    this.eventCache.set(sessionId, data);
    this.eventCacheMtimes.set(sessionId, mtimeMs);
    while (this.eventCache.size > DefaultSessionReader.EVENT_CACHE_MAX_ENTRIES) {
      const oldest = this.eventCache.keys().next().value;
      if (oldest === undefined) break;
      this.eventCache.delete(oldest);
      this.eventCacheMtimes.delete(oldest);
    }

    if (data.metadata.endedAt) {
      storeWithPath.clearLoadCache?.(sessionId);
    }

    return data;
  }

  async query(q: SessionQuery = {}): Promise<SessionSummaryLite[]> {
    // Prefer the store's filtered list when available — it pushes the
    // filter into the cached index instead of fetching 1000 + linear scan.
    const storeWithFilter = this.store as SessionStore & {
      listFiltered?: ((criteria: {
        since?: string | undefined;
        until?: string | undefined;
        provider?: string | undefined;
        model?: string | undefined;
        minTokens?: number | undefined;
        titleContains?: string | undefined;
        limit?: number | undefined;
      }) => Promise<import('../types/session.js').SessionSummary[]>) | undefined;
    };
    let raw: import('../types/session.js').SessionSummary[];
    if (typeof storeWithFilter.listFiltered === 'function') {
      raw = await storeWithFilter.listFiltered({
        since: q.since,
        until: q.until,
        provider: q.provider,
        model: q.model,
        minTokens: q.minTokens,
        titleContains: q.titleContains,
        limit: q.limit,
      });
    } else {
      const fetched = await this.store.list(q.limit ? Math.max(q.limit, 100) : 1000);
      const titleNeedle = q.titleContains?.toLowerCase();
      raw = fetched.filter((s) => {
        if (q.since && s.startedAt < q.since) return false;
        if (q.until && s.startedAt > q.until) return false;
        if (q.provider && s.provider !== q.provider) return false;
        if (q.model && s.model !== q.model) return false;
        if (q.minTokens !== undefined && s.tokenTotal < q.minTokens) return false;
        if (titleNeedle && !s.title.toLowerCase().includes(titleNeedle)) return false;
        return true;
      });
    }
    const out: SessionSummaryLite[] = raw.map((s) => ({
      id: s.id,
      title: s.title,
      startedAt: s.startedAt,
      provider: s.provider,
      model: s.model,
      tokenTotal: s.tokenTotal,
    }));
    return q.limit ? out.slice(0, q.limit) : out;
  }

  async *replay(sessionId: string): AsyncIterable<SessionEvent> {
    const data = await this.loadCachedSessionData(sessionId);
    for (const e of data.events) yield e;
  }

  async search(q: SessionSearchQuery, sessionId?: string | undefined, sessionQuery?: SessionQuery): Promise<SessionSearchHit[]> {
    const limit = q.limit ?? 100;
    const matcher = buildMatcher(q);
    const allowedTypes = q.types ? new Set(q.types) : null;

    // Filter sessions BEFORE scanning events — avoids touching the JSONL
    // for sessions that don't match the time/provider/model criteria.
    let ids: string[];
    if (sessionId) {
      ids = [sessionId];
    } else {
      // Prefer the store's filtered list when available — avoids fetching
      // 1000 sessions and linear-filtering in-process.
      const storeWithFilter = this.store as SessionStore & {
        listFiltered?: ((criteria: {
          since?: string | undefined;
          until?: string | undefined;
          provider?: string | undefined;
          model?: string | undefined;
          minTokens?: number | undefined;
          titleContains?: string | undefined;
          limit?: number | undefined;
        }) => Promise<import('../types/session.js').SessionSummary[]>) | undefined;
      };
      let sessions: import('../types/session.js').SessionSummary[];
      if (typeof storeWithFilter.listFiltered === 'function') {
        sessions = await storeWithFilter.listFiltered({
          since: sessionQuery?.since,
          until: sessionQuery?.until,
          provider: sessionQuery?.provider,
          model: sessionQuery?.model,
          minTokens: sessionQuery?.minTokens,
          titleContains: sessionQuery?.titleContains,
          limit: 1000,
        });
      } else {
        sessions = await this.store.list(1000);
        const titleNeedle = sessionQuery?.titleContains?.toLowerCase();
        sessions = sessions.filter((s) => {
          if (sessionQuery?.since && s.startedAt < sessionQuery.since) return false;
          if (sessionQuery?.until && s.startedAt > sessionQuery.until) return false;
          if (sessionQuery?.provider && s.provider !== sessionQuery.provider) return false;
          if (sessionQuery?.model && s.model !== sessionQuery.model) return false;
          if (sessionQuery?.minTokens !== undefined && s.tokenTotal < sessionQuery.minTokens) return false;
          if (titleNeedle && !s.title.toLowerCase().includes(titleNeedle)) return false;
          return true;
        });
      }
      ids = sessions.map((s) => s.id);
    }

    const hits: SessionSearchHit[] = [];

    // Fast path: when the underlying store supports streaming search,
    // walk each session's JSONL line-by-line and bail out the moment we
    // hit `limit`. This avoids reading + parsing the entire file (which
    // `load()` does) and never reuses `_loadCache`, so concurrent
    // analytics queries don't churn the writer-side cache.
    const streaming = this.store.searchEvents?.bind(this.store);
    if (streaming) {
      for (const id of ids) {
        const matched = await streaming(
          id,
          (ev) => {
            if (allowedTypes && !allowedTypes.has(ev.type)) return false;
            const text = eventText(ev);
            if (text === null) return false;
            return matcher(text) !== null;
          },
          { limit: limit - hits.length },
        );
        for (const m of matched) {
          const text = expectDefined(eventText(m.event));
          const hit = expectDefined(matcher(text));
          hits.push({
            sessionId: id,
            eventIndex: m.eventIndex,
            ts: m.ts,
            type: m.event.type,
            snippet: snippetOf(text, hit.start, hit.end),
          });
          if (hits.length >= limit) return hits;
        }
      }
      return hits;
    }

    // Fallback: stores that don't implement streaming. Loads the full
    // event stream per session — necessary for in-memory or non-file
    // stores that don't expose a streaming surface.
    for (const id of ids) {
      let data;
      try {
        data = await this.loadCachedSessionData(id);
      } catch {
        continue;
      }
      for (let i = 0; i < data.events.length; i++) {
        const ev = expectDefined(data.events[i]);
        if (allowedTypes && !allowedTypes.has(ev.type)) continue;
        const text = eventText(ev);
        if (text === null) continue;
        const hit = matcher(text);
        if (!hit) continue;
        hits.push({
          sessionId: id,
          eventIndex: i,
          ts: ev.ts,
          type: ev.type,
          snippet: snippetOf(text, hit.start, hit.end),
        });
        if (hits.length >= limit) return hits;
      }
    }
    return hits;
  }

  async export(sessionId: string, opts: SessionExportOptions): Promise<string> {
    const data = await this.loadCachedSessionData(sessionId);
    const includeTools = opts.includeTools ?? true;
    const includeDiagnostics = opts.includeDiagnostics ?? true;

    const filtered = data.events.filter((e) => {
      if (
        !includeTools &&
        (e.type === 'tool_use' ||
          e.type === 'tool_result' ||
          e.type === 'tool_call_start' ||
          e.type === 'tool_call_end')
      ) {
        return false;
      }
      if (
        !includeDiagnostics &&
        (e.type === 'error' || e.type === 'compaction' || e.type === 'message_truncated')
      ) {
        return false;
      }
      return true;
    });

    if (opts.format === 'json') {
      return JSON.stringify({ metadata: data.metadata, events: filtered }, null, 2);
    }
    if (opts.format === 'text') {
      return renderPlainText(data.metadata, filtered);
    }
    return renderMarkdown(data.metadata, filtered);
  }

  async metadata(sessionId: string): Promise<SessionMetadata> {
    const data = await this.loadCachedSessionData(sessionId);
    return data.metadata;
  }
}

function buildMatcher(
  q: SessionSearchQuery,
): (text: string) => { start: number; end: number } | null {
  const ci = q.caseInsensitive ?? true;
  if (q.regex) {
    const flags = ci ? 'i' : '';
    const compiled = compileUserRegex(q.query, flags);
    if (!compiled.ok) {
      throw new Error(`Invalid search regex "${q.query}": ${compiled.reason}`);
    }
    const re = compiled.regex;
    return (text) => {
      const m = re.exec(text);
      return m ? { start: m.index, end: m.index + m[0].length } : null;
    };
  }
  const needle = ci ? q.query.toLowerCase() : q.query;
  return (text) => {
    const hay = ci ? text.toLowerCase() : text;
    const idx = hay.indexOf(needle);
    return idx === -1 ? null : { start: idx, end: idx + needle.length };
  };
}

function eventText(e: SessionEvent): string | null {
  switch (e.type) {
    case 'user_input':
      return contentToString(e.content);
    case 'llm_response':
      return contentToString(e.content);
    case 'tool_use':
      return `${e.name} ${JSON.stringify(e.input)}`;
    case 'tool_result':
      return typeof e.content === 'string' ? e.content : JSON.stringify(e.content);
    case 'error':
      return `${e.phase}: ${e.message}`;
    case 'session_start':
    case 'session_resumed':
      return `${e.model}/${e.provider}`;
    case 'task_created':
    case 'task_completed':
      return e.title;
    case 'task_failed':
      return `${e.title}: ${e.error}`;
    case 'skill_activated':
    case 'skill_deactivated':
      return e.skillName;
    default:
      return null;
  }
}

function contentToString(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .map((b) => {
      switch (b.type) {
        case 'text':
          return b.text;
        case 'tool_use':
          return `[tool_use:${b.name} ${JSON.stringify(b.input)}]`;
        case 'tool_result':
          return typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
        default:
          return '';
      }
    })
    .join('\n');
}

const SNIPPET_RADIUS = 60;

function snippetOf(text: string, start: number, end: number): string {
  const from = Math.max(0, start - SNIPPET_RADIUS);
  const to = Math.min(text.length, end + SNIPPET_RADIUS);
  const prefix = from > 0 ? '…' : '';
  const suffix = to < text.length ? '…' : '';
  return prefix + text.slice(from, to).replace(/\s+/g, ' ').trim() + suffix;
}

function renderMarkdown(meta: SessionMetadata, events: SessionEvent[]): string {
  const lines: string[] = [];
  lines.push(`# Session ${meta.id}`);
  lines.push('');
  if (meta.model || meta.provider) {
    lines.push(`- **Model:** ${meta.provider ?? '?'}/${meta.model ?? '?'}`);
  }
  lines.push(`- **Started:** ${meta.startedAt}`);
  if (meta.endedAt) lines.push(`- **Ended:** ${meta.endedAt}`);
  lines.push('');
  lines.push('---');
  lines.push('');
  for (const e of events) {
    switch (e.type) {
      case 'user_input': {
        lines.push(`## User — ${e.ts}`);
        lines.push('');
        lines.push(contentToString(e.content));
        lines.push('');
        break;
      }
      case 'llm_response': {
        lines.push(`## Assistant — ${e.ts}`);
        lines.push('');
        lines.push(contentToString(e.content));
        if (e.stopReason && e.stopReason !== 'end_turn') {
          lines.push('');
          lines.push(`*stop: ${e.stopReason}*`);
        }
        lines.push('');
        break;
      }
      case 'tool_use': {
        lines.push(`### Tool call: \`${e.name}\``);
        lines.push('');
        lines.push('```json');
        lines.push(JSON.stringify(e.input, null, 2));
        lines.push('```');
        lines.push('');
        break;
      }
      case 'tool_result': {
        const body = typeof e.content === 'string' ? e.content : JSON.stringify(e.content, null, 2);
        lines.push(`### Tool result${e.isError ? ' (error)' : ''}`);
        lines.push('');
        lines.push('```');
        lines.push(body);
        lines.push('```');
        lines.push('');
        break;
      }
      case 'error': {
        lines.push(`> **Error** (${e.phase}): ${e.message}`);
        lines.push('');
        break;
      }
      case 'compaction': {
        lines.push(`> **Compaction**: ${e.before} → ${e.after} tokens`);
        lines.push('');
        break;
      }
      default:
        break;
    }
  }
  return lines.join('\n');
}

function renderPlainText(meta: SessionMetadata, events: SessionEvent[]): string {
  const lines: string[] = [];
  lines.push(
    `Session ${meta.id} — ${meta.provider ?? '?'}/${meta.model ?? '?'} — started ${meta.startedAt}`,
  );
  lines.push(''.padEnd(72, '-'));
  for (const e of events) {
    switch (e.type) {
      case 'user_input':
        lines.push(`[${e.ts}] USER`);
        lines.push(contentToString(e.content));
        lines.push('');
        break;
      case 'llm_response':
        lines.push(`[${e.ts}] ASSISTANT`);
        lines.push(contentToString(e.content));
        lines.push('');
        break;
      case 'tool_use':
        lines.push(`[${e.ts}] TOOL_USE ${e.name} ${JSON.stringify(e.input)}`);
        break;
      case 'tool_result':
        lines.push(
          `[${e.ts}] TOOL_RESULT${e.isError ? ' (error)' : ''} ${
            typeof e.content === 'string' ? e.content : JSON.stringify(e.content)
          }`,
        );
        break;
      case 'error':
        lines.push(`[${e.ts}] ERROR (${e.phase}): ${e.message}`);
        break;
      default:
        break;
    }
  }
  return lines.join('\n');
}
