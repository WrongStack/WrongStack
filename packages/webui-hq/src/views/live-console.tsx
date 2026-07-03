/**
 * LiveConsole view — full chat transcript for the selected session.
 * Fetches /api/sessions/:id/events on selection, then streams live.
 */
import type React from 'react';
import { useEffect, useState } from 'react';
import { useHqStore, fetchJson } from '../store.js';
import type { HqTranscriptEntry } from '@wrongstack/core';

interface TranscriptResponse {
  sessionId: string;
  total: number;
  entries: HqTranscriptEntry[];
}

export function LiveConsoleView(): React.ReactElement {
  const state = useHqStore();
  const sessionId = state.selectedSessionId;
  const [entries, setEntries] = useState<HqTranscriptEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (sessionId === null) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchJson<TranscriptResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/events?limit=500`)
      .then((data) => {
        if (!cancelled) {
          setEntries(data.entries);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // Append live transcript events for this session.
  useEffect(() => {
    if (sessionId === null) return;
    const recent = state.events.filter(
      (e) => e.type === 'session.transcript' && e.sessionId === sessionId,
    );
    if (recent.length === 0) return;
    const newEntries = recent.flatMap((e) => (e.payload as { entries?: HqTranscriptEntry[] }).entries ?? []);
    if (newEntries.length > 0) {
      setEntries((prev) => [...prev, ...newEntries].slice(-1000));
    }
  }, [state.events, sessionId]);

  if (sessionId === null) {
    return <div className="hq-empty">Select a terminal from the Fleet view to see its live transcript.</div>;
  }
  if (loading) return <div className="hq-empty">Loading transcript…</div>;
  if (error !== null) return <div className="hq-empty">Error: {error}</div>;

  return (
    <div>
      <div className="hq-card-title">Live Console — {sessionId}</div>
      <div className="hq-card" style={{ maxHeight: '70vh', overflowY: 'auto' }}>
        {entries.length === 0 ? (
          <div className="hq-empty">No transcript entries yet.</div>
        ) : (
          entries.map((entry, i) => (
            <div key={i} className="hq-row" style={{ alignItems: 'flex-start' }}>
              <span className="hq-pill" style={{ minWidth: 70, justifyContent: 'center', display: 'inline-flex' }}>
                {entry.role}
              </span>
              {entry.tool && <span className="hq-mono" style={{ color: 'var(--cyan)' }}>{entry.tool}</span>}
              <span className="hq-mono" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{entry.text}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
