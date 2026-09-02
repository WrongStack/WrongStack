/**
 * useSessionTranscript — the data plane behind every HQ chat surface.
 *
 * Extracted from LiveConsoleView so the Fleet Topology chat drawer and the
 * full Console render the SAME transcript pipeline: an initial
 * `/api/sessions/:id/events` (or per-agent `/api/agents/:id/messages`) seed,
 * live `session.transcript` / `agent.message` events folded in exactly once
 * via `transcript-store`, pin-to-bottom scroll management, and running-tool
 * detection. Views own only their markup.
 */
import type {
  HqAgentMessagePayload,
  HqTranscriptAppendPayload,
  HqTranscriptEntry,
} from '@wrongstack/core/hq';
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { VListHandle } from 'virtua';
import {
  applyFetch,
  applyLiveBatch,
  createTranscriptState,
  isToolRunning,
  type TranscriptState,
} from './transcript-store.js';
import { fetchJson } from '../data/api.js';
import { useHqStore } from '../data/store/index.js';

interface TranscriptResponse {
  sessionId: string;
  source?: 'disk' | 'stream';
  projectName?: string;
  total: number;
  entries: HqTranscriptEntry[];
}

/** The id the agent-status tracker assigns the session's main/leader agent. */
export const LEADER_AGENT_ID = 'leader';

/** Stable key for a turn — index + identity fields keep React from thrashing. */
export function turnKey(entry: HqTranscriptEntry, i: number): string {
  return `${i}:${entry.ts}:${entry.role}:${entry.toolUseId ?? ''}`;
}

/**
 * Fold a delta stream back into whole turns. The agent monitor emits one
 * entry per `provider.text_delta` / `thinking_delta`, so a single streamed
 * message arrives as dozens of one-word entries. Merge consecutive
 * assistant/thinking entries (same role, same agent, neither carrying a
 * tool) into one growing bubble; any tool/system/error/user entry between
 * them acts as a turn boundary. Exported for tests.
 */
export function coalesceStreamedText(entries: readonly HqTranscriptEntry[]): HqTranscriptEntry[] {
  const out: HqTranscriptEntry[] = [];
  const isMergeable = (e: HqTranscriptEntry): boolean =>
    (e.role === 'assistant' || e.role === 'thinking') &&
    e.tool === undefined &&
    e.toolUseId === undefined &&
    e.isError !== true;
  for (const e of entries) {
    const prev = out[out.length - 1];
    if (
      prev !== undefined &&
      isMergeable(e) &&
      isMergeable(prev) &&
      prev.role === e.role &&
      (prev.agentId ?? '') === (e.agentId ?? '')
    ) {
      // Deltas are raw fragments — concatenate with no separator. Keep the
      // earliest ts so ordering is stable across re-renders.
      out[out.length - 1] = { ...prev, text: prev.text + e.text };
    } else {
      out.push(e);
    }
  }
  return out;
}

function entryFromAgentMessage(payload: HqAgentMessagePayload): HqTranscriptEntry {
  const role: HqTranscriptEntry['role'] =
    payload.kind === 'thinking'
      ? 'thinking'
      : payload.kind === 'tool_use' || payload.kind === 'tool_result'
        ? 'tool'
        : payload.kind === 'error'
          ? 'error'
          : payload.kind === 'system' || payload.kind === 'status'
            ? 'system'
            : 'assistant';
  return {
    ts: payload.ts,
    role,
    text: payload.content,
    ...(payload.toolName !== undefined ? { tool: payload.toolName } : {}),
    ...(payload.kind === 'error' ? { isError: true } : {}),
    agentId: payload.subagentId,
  };
}

export interface SessionTranscript {
  /** The turns to render (agent-scoped when an agentId was given). */
  entries: HqTranscriptEntry[];
  loading: boolean;
  error: string | null;
  meta: { source?: string; projectName?: string; total: number };
  /** Full-history toggle (session transcripts are truncated to 1000 by default). */
  full: boolean;
  setFull: (v: boolean) => void;
  stats: { turns: number; tools: number; errors: number; running: number };
  isRunningAt: (e: HqTranscriptEntry, i: number) => boolean;
  listRef: RefObject<VListHandle | null>;
  onScroll: () => void;
  pinned: boolean;
  jumpToLatest: () => void;
}

export function useSessionTranscript(
  sessionId: string | null,
  agentId: string | null,
): SessionTranscript {
  const storeEvents = useHqStore((s) => s.events);
  // The session LEADER (id 'leader') is the main terminal agent — its
  // conversation IS the session transcript, not a per-agent ring (only
  // director-spawned subagents get their own agent.message ring). So a
  // leader selection reads the session plane; only real subagents use the
  // per-agent path.
  const isLeader = agentId === LEADER_AGENT_ID;
  const viewingSubagent = agentId !== null && !isLeader;
  const [transcript, setTranscript] = useState<TranscriptState>(createTranscriptState);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [full, setFull] = useState(false);
  const [meta, setMeta] = useState<{ source?: string; projectName?: string; total: number }>({
    total: 0,
  });
  const listRef = useRef<VListHandle | null>(null);
  const [pinned, setPinned] = useState(true);
  const pinnedRef = useRef(true);
  const setPin = (v: boolean) => {
    pinnedRef.current = v;
    setPinned(v);
  };
  const transcriptRef = useRef(transcript);
  transcriptRef.current = transcript;

  // ── Subagent history ────────────────────────────────────────────────────
  // Seed from the server's PER-AGENT transcript ring, scoped by session so
  // same-named agents in different sessions (every leader is id 'leader')
  // don't share one ring. Then fold in live agent.message envelopes that
  // match BOTH this session and this agent.
  const [agentSeed, setAgentSeed] = useState<HqTranscriptEntry[]>([]);
  const [agentLoading, setAgentLoading] = useState(false);
  useEffect(() => {
    setAgentSeed([]);
    // The leader has no per-agent ring — its history is the session
    // transcript, fetched by the session effect below.
    if (agentId === null || sessionId === null || !viewingSubagent) return;
    let cancelled = false;
    setAgentLoading(true);
    fetchJson<{ subagentId: string; total: number; entries: HqTranscriptEntry[]; source?: string }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/agents/${encodeURIComponent(agentId)}/messages?full=1`,
    )
      .then((data) => {
        if (cancelled) return;
        setAgentSeed((data.entries ?? []).map((e) => ({ ...e, agentId })));
        // 'disk' = full history (local session); 'stream' = live ring only.
        setMeta((m) => ({ ...m, source: data.source }));
        setAgentLoading(false);
      })
      .catch(() => {
        if (!cancelled) setAgentLoading(false); // ring may be empty — live-only
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, sessionId, viewingSubagent]);

  const agentEntries = useMemo(() => {
    if (!viewingSubagent || agentId === null) return [];
    const live = storeEvents
      .filter(
        (event) =>
          event.type === 'agent.message' &&
          // Scope to THIS session too — otherwise another session's 'leader'
          // messages leak into this agent's transcript.
          (event.sessionId === undefined || event.sessionId === sessionId),
      )
      .map((event) => event.payload as Partial<HqAgentMessagePayload>)
      .filter((payload): payload is HqAgentMessagePayload => payload.subagentId === agentId)
      .map((p) => ({ ...entryFromAgentMessage(p), agentId }));
    // The seed already contains every message the server saw — including the
    // ones mirrored in our live ring — so dedupe on (ts, role, text).
    const seen = new Set<string>();
    const merged: HqTranscriptEntry[] = [];
    for (const entry of [...agentSeed, ...live]) {
      const key = `${entry.ts}|${entry.role}|${entry.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(entry);
    }
    // Fold the per-delta stream back into whole turns.
    return coalesceStreamedText(merged);
  }, [agentSeed, storeEvents, agentId, sessionId, viewingSubagent]);

  // ── Initial (re)fetch ──────────────────────────────────────────────────────
  useEffect(() => {
    if (sessionId === null || viewingSubagent) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    pinnedRef.current = true;
    setPinned(true);
    const qs = full ? 'full=1' : 'limit=1000';
    fetchJson<TranscriptResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/events?${qs}`)
      .then((data) => {
        if (cancelled) return;
        setTranscript((prev) => applyFetch(prev, data.entries));
        setMeta({ source: data.source, projectName: data.projectName, total: data.total });
        setLoading(false);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setError(err.message);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, full, viewingSubagent]);

  // Reset when switching sessions or agents.
  useEffect(() => {
    setTranscript(createTranscriptState());
    setMeta({ total: 0 });
    setFull(false);
  }, [sessionId, agentId]);

  // ── Live appends ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (sessionId === null || viewingSubagent) return;
    let next = transcriptRef.current;
    for (const e of storeEvents) {
      if (e.type !== 'session.transcript' || e.sessionId !== sessionId) continue;
      const payload = e.payload as HqTranscriptAppendPayload;
      if (!Array.isArray(payload.entries)) continue;
      next = applyLiveBatch(next, payload.fromSeq, payload.entries);
    }
    if (next !== transcriptRef.current) setTranscript(next);
  }, [storeEvents, sessionId, viewingSubagent]);

  // ── Follow the newest turn while pinned ───────────────────────────────────
  // Both planes stream text one delta per entry; fold them into whole turns.
  // (agentEntries is already coalesced; the session transcript store is not.)
  const sessionEntries = useMemo(
    () => coalesceStreamedText(transcript.entries),
    [transcript.entries],
  );
  const entries = viewingSubagent ? agentEntries : sessionEntries;
  useEffect(() => {
    if (pinnedRef.current && entries.length > 0) {
      listRef.current?.scrollToIndex(entries.length - 1, { align: 'end' });
    }
  }, [entries.length, transcript.rev]);

  const onScroll = () => {
    const h = listRef.current;
    if (!h) return;
    setPin(h.scrollSize - h.scrollOffset - h.viewportSize < 80);
  };

  const jumpToLatest = () => {
    setPin(true);
    listRef.current?.scrollToIndex(entries.length - 1, { align: 'end' });
  };

  // A result-less tool only counts as "running" near the tail — an old call
  // that never recorded a result is dead, not in flight.
  const runningFrom = Math.max(0, entries.length - 8);
  const isRunningAt = (e: HqTranscriptEntry, i: number) => isToolRunning(e) && i >= runningFrom;

  const stats = useMemo(() => {
    let tools = 0;
    let errors = 0;
    let running = 0;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!;
      if (e.tool !== undefined) tools++;
      if (e.role === 'error' || e.isError) errors++;
      if (isToolRunning(e) && i >= runningFrom) running++;
    }
    return { turns: entries.length, tools, errors, running };
  }, [entries, runningFrom]);

  return {
    entries,
    loading: viewingSubagent ? agentLoading : loading,
    error,
    meta,
    full,
    setFull,
    stats,
    isRunningAt,
    listRef,
    onScroll,
    pinned,
    jumpToLatest,
  };
}
