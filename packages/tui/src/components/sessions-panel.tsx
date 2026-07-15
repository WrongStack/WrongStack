import { Box, Text } from '../ink.js';
import type React from 'react';
import { theme } from '../theme.js';
import { glyphs } from '../ui-glyphs.js';
import {
  EmptyPanelState,
  KeyCap,
  MonitorShell,
  panelWindow,
  truncatePanelText,
  useMonitorSize,
} from './monitor-shell.js';

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
    case 'active':
      return '●';
    case 'idle':
      return '◉';
    case 'closing':
      return '◐';
    case 'stale':
      return '○';
    default:
      return '?';
  }
}

function agentIcon(status: string): string {
  switch (status) {
    case 'running':
      return '▶';
    case 'streaming':
      return '↻';
    case 'waiting_user':
      return '⏳';
    case 'error':
      return '✗';
    case 'idle':
      return '■';
    default:
      return '?';
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

function statusColor(status: string): string {
  if (status === 'active' || status === 'running') return theme.success;
  if (status === 'idle' || status === 'streaming') return theme.accent;
  if (status === 'error' || status === 'stale') return theme.error;
  if (status === 'waiting_user' || status === 'closing') return theme.warn;
  return theme.textMuted;
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
  const size = useMonitorSize();
  const safeSelected = Math.min(Math.max(0, selected), Math.max(0, sessions.length - 1));
  const agentLimit = Math.max(1, Math.min(4, size.contentRows - 8));
  const sessionLimit = Math.max(1, size.contentRows - agentLimit - (resumeConfirm ? 6 : 4));
  const window = panelWindow(sessions.length, safeSelected, sessionLimit);
  const visible = sessions.slice(window.start, window.end);
  const active = sessions.filter((session) => session.status === 'active').length;
  const agentTotal = sessions.reduce((sum, session) => sum + session.agentCount, 0);

  return (
    <MonitorShell
      accent={theme.accent}
      icon={glyphs.sessions}
      title="SESSIONS"
      kicker={size.columns >= 92 ? 'cross-surface presence' : undefined}
      right={
        <Text>
          <Text color={theme.success}>● {active} active</Text>
          <Text color={theme.textMuted}>
            {' '}
            {sessions.length} sessions · {agentTotal} agents
          </Text>
          {busy ? <Text color={theme.warn}> ↻ syncing</Text> : null}
        </Text>
      }
      footer={
        <Box gap={2}>
          <KeyCap keyName="↑↓" label="select" color={theme.accent} />
          <KeyCap keyName="Enter" label="resume" color={theme.warn} />
          <KeyCap keyName="F10" label="close" color={theme.accent} />
          <Text color={theme.textMuted}>/sessions kill &lt;id&gt;</Text>
        </Box>
      }
    >
      {resumeConfirm ? (
        <Box
          marginTop={1}
          borderStyle="single"
          borderColor={theme.warn}
          paddingX={1}
          flexDirection="column"
        >
          <Text color={theme.warn} bold>
            ⚠ Replace this conversation with “{resumeConfirm.sessionName}”?
          </Text>
          <Text color={theme.textMuted}>
            Enter confirms · Esc cancels · the current session remains stored.
          </Text>
        </Box>
      ) : null}

      {sessions.length === 0 ? (
        busy ? (
          <Text color={theme.textMuted}>Loading sessions…</Text>
        ) : (
          <EmptyPanelState
            icon="◇"
            title="No live sessions"
            detail="Open another WrongStack surface to see shared presence here."
            accent={theme.accent}
          />
        )
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {window.above > 0 ? (
            <Text color={theme.textMuted}> ↑ {window.above} earlier sessions</Text>
          ) : null}
          {visible.map((s, localIndex) => {
            const idx = window.start + localIndex;
            const isSelected = idx === safeSelected;
            return (
              <Box
                key={s.sessionId}
                flexDirection="column"
                marginTop={isSelected ? 1 : 0}
                paddingX={isSelected ? 1 : 0}
              >
                <Box>
                  <Text color={isSelected ? theme.accent : theme.textMuted}>
                    {isSelected ? '› ' : '  '}
                  </Text>
                  <Text color={statusColor(s.status)} bold={isSelected}>
                    {s.sessionId === currentSessionId ? '●' : statusIcon(s.status)}{' '}
                  </Text>
                  <Text
                    color={isSelected ? theme.textPrimary : theme.textSecondary}
                    bold={isSelected}
                  >
                    {truncatePanelText(s.projectName, size.columns >= 90 ? 24 : 16)}
                  </Text>
                  <Text color={theme.textMuted}> {shortSessionId(s.sessionId)}</Text>
                  {s.gitBranch ? (
                    <Text color={theme.brand}> ⎇ {truncatePanelText(s.gitBranch, 20)}</Text>
                  ) : null}
                  <Box flexGrow={1} />
                  <Text color={statusColor(s.status)}>{s.status}</Text>
                  <Text color={theme.textMuted}>
                    {' '}
                    {fmtDuration(s.startedAt)} · {s.agentCount} agents
                  </Text>
                </Box>

                {isSelected ? (
                  <>
                    <Text color={theme.textMuted}>
                      {' '}
                      {truncatePanelText(s.workingDir, size.contentWidth - 4)} · PID {s.pid}
                    </Text>

                    <Box marginLeft={2} flexDirection="column">
                      {s.agents.slice(0, agentLimit).map((a) => (
                        <Box key={a.id}>
                          <Text color={statusColor(a.status)}>{agentIcon(a.status)} </Text>
                          <Text color={theme.textSecondary}>{truncatePanelText(a.name, 20)}</Text>
                          {a.currentTool ? (
                            <Text color={theme.accent}>
                              {' '}
                              {truncatePanelText(a.currentTool, 24)}
                            </Text>
                          ) : null}
                          <Box flexGrow={1} />
                          <Text color={theme.textMuted}>
                            {a.iterations} iter · {a.toolCalls} tools
                          </Text>
                        </Box>
                      ))}
                      {s.agents.length > agentLimit ? (
                        <Text color={theme.textMuted}>
                          {' '}
                          +{s.agents.length - agentLimit} more agents
                        </Text>
                      ) : null}
                    </Box>
                  </>
                ) : null}
              </Box>
            );
          })}
          {window.below > 0 ? (
            <Text color={theme.textMuted}> ↓ {window.below} more sessions</Text>
          ) : null}
        </Box>
      )}
    </MonitorShell>
  );
}
