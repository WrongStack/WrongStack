import { Box, Text } from '../ink.js';
import { useTerminalSize } from '../hooks/use-terminal-size.js';
import type React from 'react';

// ── Types ───────────────────────────────────────────────────────────────

export interface MailboxMessageEntry {
  id: string;
  from: string;
  to: string;
  type: string;
  audience?: 'all' | 'leaders';
  subject: string;
  body: string;
  priority: string;
  timestamp: string;
  readByCount: number;
  readByMe: boolean;
  completed: boolean;
  completedBy?: string;
  outcome?: string;
}

export interface MailboxAgentEntry {
  agentId: string;
  name: string;
  role?: string | undefined;
  sessionId: string;
  status: string;
  currentTool?: string | undefined;
  currentTask?: string | undefined;
  lastSeenAt: string;
  online: boolean;
  source?: string | undefined;
}

interface MailboxPanelProps {
  /** Recent messages (newest first). */
  messages: MailboxMessageEntry[];
  /** Online agents in this project. */
  agents: MailboxAgentEntry[];
  /** Total unread count. */
  unreadCount: number;
  /** Whether the panel is visible. When false, returns null. */
  open: boolean;
}

// ── Helpers ─────────────────────────────────────────────────────────────

function fmtTime(iso: string): string {
  const d = new Date(iso);
  const now = Date.now();
  const diff = now - d.getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.round(diff / 3600_000)}h ago`;
  return d.toLocaleDateString();
}

function fmtBody(body: string, maxLen: number): string {
  const oneLine = body.replace(/\n/g, ' ');
  return oneLine.length > maxLen ? `${oneLine.slice(0, maxLen - 1)}…` : oneLine;
}

const TYPE_ICONS: Record<string, string> = {
  note: '📝',
  ask: '❓',
  assign: '📋',
  steer: '🔄',
  btw: '💬',
  broadcast: '📢',
  status: '🟢',
  result: '✅',
};

// ── Component ───────────────────────────────────────────────────────────

export function MailboxPanel({
  messages,
  agents,
  unreadCount,
  open,
}: MailboxPanelProps): React.ReactElement | null {
  const { columns: termWidth } = useTerminalSize({ fallbackColumns: 90 });

  if (!open) return null;

  const showMessages = messages.slice(0, 6);
  const showAgents = agents.slice(0, 8);
  const maxSubjectLen = Math.max(15, Math.min(30, termWidth - 55));

  return (
    <Box flexDirection="column" marginY={1} flexShrink={0}>
      {/* Header */}
      <Box flexDirection="row" gap={2}>
        <Text bold color="cyan">
          📬 Mailbox
        </Text>
        {unreadCount > 0 ? (
          <Text color="yellow" bold>
            {unreadCount} unread
          </Text>
        ) : (
          <Text dimColor>0 unread</Text>
        )}
        <Text dimColor>│</Text>
        <Text dimColor>
          {agents.length} agent{agents.length === 1 ? '' : 's'} online
        </Text>
      </Box>

      {/* Messages */}
      {showMessages.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text bold dimColor>Messages</Text>
          {showMessages.map((m) => (
            <Box key={m.id} flexDirection="row" gap={1}>
              <Text>{TYPE_ICONS[m.type] ?? '📨'}</Text>
              <Text color={m.readByMe ? undefined : 'yellow'} bold={!m.readByMe}>
                {m.from}
              </Text>
              <Text dimColor>
                {m.subject.length > maxSubjectLen
                  ? `${m.subject.slice(0, maxSubjectLen - 1)}…`
                  : m.subject}
              </Text>
              <Text dimColor>{fmtBody(m.body, 40)}</Text>
              <Text dimColor>{fmtTime(m.timestamp)}</Text>
              {m.audience === 'leaders' ? <Text color="cyan">🔒 leaders</Text> : null}
              {m.readByCount > 0 ? (
                <Text dimColor>
                  👁 {m.readByCount}
                </Text>
              ) : (
                <Text color="yellow" bold>
                  ✉ new
                </Text>
              )}
              {m.completed ? (
                <Text color="green">✓</Text>
              ) : null}
            </Box>
          ))}
        </Box>
      ) : (
        <Box marginTop={1}>
          <Text dimColor>No messages yet.</Text>
        </Box>
      )}

      {/* Online agents */}
      {showAgents.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text bold dimColor>Online agents</Text>
          {showAgents.map((a) => (
            <Box key={a.agentId} flexDirection="row" gap={1}>
              <Text color={a.online ? 'green' : 'dim'}>
                {a.online ? '●' : '○'}
              </Text>
              <Text>{a.name}</Text>
              {a.role ? <Text dimColor>({a.role})</Text> : null}
              <Text dimColor>
                {a.status}
              </Text>
              {a.currentTool ? (
                <Text color="cyan">{a.currentTool}</Text>
              ) : null}
              {a.currentTask ? (
                <Text dimColor>
                  {a.currentTask.length > 25
                    ? `${a.currentTask.slice(0, 24)}…`
                    : a.currentTask}
                </Text>
              ) : null}
              <Text dimColor>{fmtTime(a.lastSeenAt)}</Text>
              {a.source ? <Text dimColor>[{a.source}]</Text> : null}
            </Box>
          ))}
        </Box>
      ) : null}

      {/* Footer */}
      <Box marginTop={1}>
        <Text dimColor>
          /mailbox — Esc to close
        </Text>
      </Box>
    </Box>
  );
}
