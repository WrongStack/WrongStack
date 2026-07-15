/**
 * LiveConsole view — full chat transcript for the selected session, rendered
 * as a WebUI-grade conversation: user / assistant bubbles with real markdown,
 * collapsed thinking cards, collapsible tool cards with real result views
 * (diffs, terminal output, numbered reads, JSON, todos), and subtle
 * system/error lines.
 *
 * The transcript pipeline (seed fetch + live folding + pinning) lives in
 * `lib/use-session-transcript` and is shared with the Fleet Topology chat
 * drawer; this view owns only the console chrome (picker, pills, layout).
 */

import { ArrowDownToLine, Bot, History, MessageSquareText } from 'lucide-react';
import type React from 'react';
import { useMemo } from 'react';
import { VList } from 'virtua';
import { useShallow } from 'zustand/react/shallow';
import { turnKey, useSessionTranscript } from '../lib/use-session-transcript.js';
import { useHqStore } from '../store.js';
import { FleetNav } from './fleet-nav.js';
import { TranscriptTurn } from './transcript-turn.js';

export function LiveConsoleView(): React.ReactElement {
  const { selectedSessionId, selectedAgentId, snapshot } = useHqStore(
    useShallow((s) => ({
      selectedSessionId: s.selectedSessionId,
      selectedAgentId: s.selectedAgentId,
      snapshot: s.snapshot,
    })),
  );
  const sessionId = selectedSessionId;
  const agentId = selectedAgentId;
  const viewingAgent = agentId !== null;

  const chat = useSessionTranscript(sessionId, agentId);
  const { entries, meta, stats } = chat;

  const sessions = snapshot?.liveSessions ?? [];
  const selectedAgent = useMemo(
    () => sessions.flatMap((s) => s.agents).find((a) => a.id === agentId) ?? null,
    [agentId, sessions],
  );

  return (
    <div className="hq-console-shell">
      <FleetNav
        snapshot={snapshot ?? null}
        selectedSessionId={sessionId}
        selectedAgentId={agentId}
      />
      <div className="hq-console">
        <div className="hq-chat-header">
          <MessageSquareText size={15} className="hq-chat-header-icon" />
          <span className="hq-card-title hq-title-inline">
            Console
          </span>
          {viewingAgent && (
            <span className="hq-pill active">
              <Bot size={12} /> {selectedAgent?.name ?? agentId}
            </span>
          )}
          {meta.projectName !== undefined && !viewingAgent && (
            <span className="hq-pill">{meta.projectName}</span>
          )}
          {meta.source !== undefined && (
            <span
              className="hq-pill"
              title={
                meta.source === 'disk'
                  ? 'disk = full history replayed from this machine'
                  : 'stream = live ring only (remote or not yet persisted)'
              }
            >
              {meta.source === 'disk' ? 'full history' : 'live ring'}
            </span>
          )}
          <span className="hq-chat-counts">
            <span className="hq-pill">{stats.turns} turns</span>
            <span className="hq-pill">{stats.tools} tools</span>
            {stats.running > 0 && <span className="hq-pill running">{stats.running} running</span>}
            {stats.errors > 0 && <span className="hq-pill error">{stats.errors} err</span>}
            {!viewingAgent && !chat.full && meta.total > entries.length && (
              <button
                type="button"
                className="hq-btn secondary hq-chat-fullbtn"
                onClick={() => chat.setFull(true)}
                title={`History is truncated — load all ${meta.total} turns`}
              >
                <History size={12} /> load all {meta.total}
              </button>
            )}
          </span>
        </div>

        {sessionId === null ? (
          <div className="hq-empty">Pick a client or agent from the tree on the left.</div>
        ) : chat.loading && entries.length === 0 ? (
          <div className="hq-empty">
            {viewingAgent ? 'Loading agent history…' : 'Loading transcript…'}
          </div>
        ) : chat.error !== null ? (
          <div className="hq-empty">Error: {chat.error}</div>
        ) : (
          <div className="hq-chat-scroll">
            {entries.length === 0 ? (
              <div className="hq-empty">
                {viewingAgent
                  ? `No messages from ${selectedAgent?.name ?? agentId ?? 'this agent'} yet.`
                  : 'No transcript entries yet.'}
              </div>
            ) : (
              <VList ref={chat.listRef} onScroll={chat.onScroll} className="hq-chat-vlist">
                {entries.map((entry, i) => (
                  <div key={turnKey(entry, i)} className="hq-chat-rowpad">
                    <TranscriptTurn entry={entry} running={chat.isRunningAt(entry, i)} />
                  </div>
                ))}
              </VList>
            )}
            {!chat.pinned && entries.length > 0 && (
              <button
                type="button"
                className="hq-chat-jump"
                onClick={chat.jumpToLatest}
                title="Jump to latest"
              >
                <ArrowDownToLine size={14} />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
