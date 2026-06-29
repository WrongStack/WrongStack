import { Box, Text } from '../ink.js';
import type React from 'react';

/** A single session row from the SessionRegistry, exposed via WebSocket. */
export interface LiveSessionEntry {
  sessionId: string;
  projectName: string;
  projectSlug: string;
  projectRoot?: string | undefined;
  workingDir: string;
  gitBranch?: string | undefined;
  status: string;
  pid: number;
  startedAt: string;
  agentCount: number;
  agents: LiveAgentEntry[];
}

export interface LiveAgentEntry {
  id: string;
  name: string;
  status: string;
  currentTool?: string | undefined;
  iterations: number;
  toolCalls: number;
  lastActivityAt: string;
}

export interface SessionsPanelProps {
  sessions: LiveSessionEntry[];
  /** True while the data is being fetched. */
  busy: boolean;
  /** Selected index for arrow-key navigation. */
  selected: number;
  /**
   * When set, the panel shows a confirmation prompt for session resume.
   * Press Enter again to confirm, Esc to cancel.
   */
  resumeConfirm?: { sessionName: string } | undefined;
  /** The current session ID — highlighted with a ● marker. */
  currentSessionId?: string | undefined;
}

function statusIcon(status: string): string {
  switch (status) {
    case 'active': return '●';
    case 'idle': return '◉';
    case 'closing': return '◐';
    case 'stale': return '○';
    default: return '?';
  }
}

function agentIcon(status: string): string {
  switch (status) {
    case 'running': return '▶';
    case 'streaming': return '↻';
    case 'waiting_user': return '⏳';
    case 'error': return '✗';
    case 'idle': return '■';
    default: return '?';
  }
}

function fmtDuration(startedAt: string): string {
  const diff = Date.now() - new Date(startedAt).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return '<1m';
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ${min % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function shortSessionId(sessionId: string): string {
  const leaf = sessionId.split('/').pop() ?? sessionId;
  return leaf.length > 18 ? leaf.slice(0, 18) : leaf;
}

/**
 * Full-width panel showing all live sessions tracked by the SessionRegistry.
 * Opened with F10. Mirrors the output of /sessions status.
 */
export function SessionsPanel({
  sessions,
  busy,
  selected,
  resumeConfirm,
  currentSessionId,
}: SessionsPanelProps): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} flexShrink={0}>
      <Box flexDirection="row" gap={1}>
        <Text bold color="cyan">
          ⧉ Sessions
        </Text>
        <Text dimColor>
          · F10 to close
        </Text>
        {busy && <Text dimColor>· loading…</Text>}
      </Box>

      {resumeConfirm ? (
        <Box marginY={1} borderStyle="single" borderColor="yellow" paddingX={1}>
          <Text color="yellow" bold>
            ⚠ Resume session "{resumeConfirm.sessionName}"?
          </Text>
          <Text dimColor>
            This will replace the current conversation. Press Enter to confirm, Esc to cancel.
          </Text>
        </Box>
      ) : null}

      {sessions.length === 0 ? (
        <Box marginTop={1}>
          <Text dimColor>
            {busy ? 'Loading sessions...' : 'No live sessions. Open another wstack instance to see it here.'}
          </Text>
        </Box>
      ) : (
        sessions.map((s, idx) => (
          <Box key={s.sessionId} flexDirection="column" marginTop={1}>
            {/* Session header */}
            <Box>
              <Text inverse={idx === selected} color={s.status === 'active' ? 'green' : s.status === 'idle' ? 'cyan' : 'yellow'}>
                {s.sessionId === currentSessionId ? '● ' : ''}{statusIcon(s.status)}{' '}
              </Text>
              <Text bold>{s.projectName}</Text>
              <Text dimColor> [{s.projectSlug}]</Text>
              <Text dimColor> · {shortSessionId(s.sessionId)}</Text>
              {s.gitBranch ? (
                <Text color="magenta"> ⎇ {s.gitBranch}</Text>
              ) : null}
              <Text dimColor> · {fmtDuration(s.startedAt)}</Text>
              <Text dimColor> · PID {s.pid}</Text>
            </Box>

            {/* Working directory */}
            <Text dimColor>  wd: {s.workingDir}</Text>

            {/* Agents */}
            <Box marginLeft={2} flexDirection="column">
              {s.agents.slice(0, 8).map((a) => (
                <Box key={a.id}>
                  <Text color={a.status === 'running' ? 'green' : a.status === 'streaming' ? 'cyan' : a.status === 'error' ? 'red' : a.status === 'waiting_user' ? 'yellow' : 'grey'}>
                    {agentIcon(a.status)}{' '}
                  </Text>
                  <Text>{a.name}</Text>
                  {a.currentTool ? (
                    <Text dimColor> [{a.currentTool}]</Text>
                  ) : null}
                  <Text dimColor> · {a.iterations} iter · {a.toolCalls} tools</Text>
                </Box>
              ))}
              {s.agents.length > 8 ? (
                <Text dimColor>  ... and {s.agents.length - 8} more</Text>
              ) : null}
            </Box>
          </Box>
        ))
      )}

      {sessions.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>
            {sessions.length} session{sessions.length === 1 ? '' : 's'} ·
            ↑↓ navigate · Enter to resume/switch · Esc close
          </Text>
          <Text dimColor>
            Tip: /sessions kill {'<id>'} to stop a background session
          </Text>
        </Box>
      )}
    </Box>
  );
}
