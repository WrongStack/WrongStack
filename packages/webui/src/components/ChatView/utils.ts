import { expectDefined } from '@wrongstack/core';
import type { ChatMessage } from '@/stores';

export function fmtTok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

// ── Chat row model ──
//
// The transcript is grouped into one descriptor per virtualized row so the
// VList in ChatView can mount only the visible rows. This is the data the old
// inline two-pass IIFE used to build straight into ReactNodes; pulling it out
// makes it (a) memoizable on `messages` identity and (b) unit-testable.

/** A single item inside an agent turn — either a message bubble or a run of
 *  consecutive tool calls rendered as one collapsible group. */
export type AgentItem =
  | { kind: 'msg'; key: string; message: ChatMessage; isFirst: boolean; isContinuation: boolean }
  | {
      kind: 'tools';
      key: string;
      tools: ChatMessage[];
      isContinuation: boolean;
      /** Structural: last tool group of the last item in this turn AND has a
       *  still-running tool. Combined with isLoading at render time to decide
       *  whether to force-open the group. */
      isLastGroup: boolean;
      hasRunningTool: boolean;
    };

/** One virtualized row in the chat list. */
export type ChatRow =
  | { kind: 'day'; key: string; label: string }
  | { kind: 'user'; key: string; message: ChatMessage }
  | { kind: 'agent'; key: string; items: AgentItem[]; isLastTurn: boolean };

const dayKey = (ts: number): string => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};

function dayLabel(ts: number, now: number): string {
  const d = new Date(ts);
  const today = new Date(now);
  const yest = new Date(now - 86_400_000);
  if (dayKey(ts) === dayKey(today.getTime())) return 'Today';
  if (dayKey(ts) === dayKey(yest.getTime())) return 'Yesterday';
  return d.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric',
  });
}

/**
 * Group a flat message list into virtualized rows: day separators, user
 * bubbles, and agent turns (each a list of message/tool-group items). Pure —
 * `now` defaults to Date.now() and is injectable for tests so the Today /
 * Yesterday labels are deterministic.
 */
export function buildChatRows(messages: ChatMessage[], now: number = Date.now()): ChatRow[] {
  // Pass 1: collapse consecutive tool messages into groups, tag continuations.
  type Group =
    | { kind: 'msg'; message: ChatMessage; isFirst: boolean }
    | { kind: 'tools'; tools: ChatMessage[]; key: string };
  const groups: Group[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = expectDefined(messages[i]);
    if (m.role === 'tool') {
      const last = groups[groups.length - 1];
      if (last && last.kind === 'tools') {
        last.tools.push(m);
      } else {
        groups.push({ kind: 'tools', tools: [m], key: m.id });
      }
    } else {
      const prev = messages[i - 1];
      groups.push({ kind: 'msg', message: m, isFirst: !prev || prev.role !== m.role });
    }
  }

  // Pass 2: fold groups into turns — a user message starts a user turn; every
  // run of agent/tool groups between user messages is one agent turn.
  type Turn =
    | { kind: 'user'; message: ChatMessage; key: string }
    | { kind: 'agent'; items: Group[]; key: string };
  const turns: Turn[] = [];
  for (const g of groups) {
    if (g.kind === 'msg' && g.message.role === 'user') {
      turns.push({ kind: 'user', message: g.message, key: g.message.id });
      continue;
    }
    const last = turns[turns.length - 1];
    if (last && last.kind === 'agent') {
      last.items.push(g);
    } else {
      const key = g.kind === 'msg' ? g.message.id : g.key;
      turns.push({ kind: 'agent', items: [g], key });
    }
  }

  const turnTs = (t: Turn): number => {
    if (t.kind === 'user') return t.message.timestamp;
    const first = expectDefined(t.items[0]);
    return first.kind === 'msg' ? first.message.timestamp : (first.tools[0]?.timestamp ?? 0);
  };

  // Emit rows with interleaved day separators.
  const rows: ChatRow[] = [];
  let prevDay: string | null = null;
  for (let idx = 0; idx < turns.length; idx++) {
    const t = expectDefined(turns[idx]);
    const ts = turnTs(t);
    const day = dayKey(ts);
    if (day !== prevDay) {
      rows.push({ kind: 'day', key: `day-${day}-${idx}`, label: dayLabel(ts, now) });
      prevDay = day;
    }
    if (t.kind === 'user') {
      rows.push({ kind: 'user', key: t.key, message: t.message });
      continue;
    }
    const isLastTurn = idx === turns.length - 1;
    const items: AgentItem[] = t.items.map((g, gi) => {
      const isContinuation = gi > 0;
      if (g.kind === 'msg') {
        return {
          kind: 'msg',
          key: g.message.id,
          message: g.message,
          isFirst: !isContinuation && g.isFirst,
          isContinuation,
        };
      }
      return {
        kind: 'tools',
        key: g.key,
        tools: g.tools,
        isContinuation,
        isLastGroup: gi === t.items.length - 1,
        hasRunningTool: g.tools.some((tt) => tt.toolResult === undefined),
      };
    });
    rows.push({ kind: 'agent', key: t.key, items, isLastTurn });
  }
  return rows;
}
