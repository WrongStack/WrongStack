import { theme } from '../theme.js';
import type { ChipMeta } from './statusline-picker.js';

interface MailboxActivityStatus {
  unread: number;
  onlineAgents: number;
  onlineClients: {
    tui: number;
    webui: number;
    repl: number;
  };
  lastSubject?: string | null | undefined;
  lastFrom?: string | null | undefined;
}

function chipExpired(meta: ChipMeta, now = Date.now()): boolean {
  if (meta.expiresIn == null) return false;
  return now >= meta.shownAt + meta.expiresIn * 60_000;
}

export function isStreamChipVisible(
  key: 'brain' | 'mailbox' | 'enhance' | 'debug_stream',
  dataIsPresent: unknown,
  hiddenSet: ReadonlySet<string>,
  visibleChips: ChipMeta[],
): boolean {
  if (!dataIsPresent) return false;
  if (hiddenSet.has(key)) return false;
  const meta = visibleChips.find((c) => c.key === key);
  if (!meta) return false;
  if (chipExpired(meta)) return false;
  return true;
}

export function hasMailboxActivity(mailbox: MailboxActivityStatus | undefined): boolean {
  if (!mailbox) return false;
  const peerClientCount =
    Math.max(0, mailbox.onlineClients.tui - 1) +
    mailbox.onlineClients.webui +
    mailbox.onlineClients.repl;
  return (
    mailbox.unread > 0 ||
    mailbox.onlineAgents > 1 ||
    peerClientCount > 0 ||
    Boolean(mailbox.lastSubject || mailbox.lastFrom)
  );
}

const MODE_ICONS: Record<string, string> = {
  teach: '◇',
  brief: '⚡',
  'code-reviewer': '⌕',
  'bug-hunter': '◇',
  'security-scanner': '⛨',
  'refactor-planner': '✎',
  architect: '▦',
  debugger: '◇',
  test: '⚗',
  document: '☷',
  'skill-creator': '✱',
};

export function modeIcon(label?: string): string {
  if (!label) return '';
  const icon = MODE_ICONS[label] ?? '▪';
  return `${icon} ${label}`;
}

export function formatSuggestionLabel(label: string, maxLen = 28): string {
  const stripped = label.replace(/^\/next\s+[\d\s]+\s*/, '').trim();
  if (!stripped) return '';
  if (stripped.length <= maxLen) return stripped;
  const shortened = stripped.slice(0, maxLen);
  const lastSpace = shortened.lastIndexOf(' ');
  return lastSpace > 10 ? `${shortened.slice(0, lastSpace)}…` : `${shortened}…`;
}

export function countdownColor(secs: number, warn: number, danger: number): string {
  if (secs > warn) return theme.success;
  if (secs > danger) return theme.warn;
  return theme.error;
}
