/**
 * Console rules as pure functions: what counts as a sent message's echo, which
 * channel a conversation can be reached through, and how sessions group in the
 * picker. Only types come from the legacy domain, so this runs anywhere.
 */
import type { ConsoleControlTarget } from '@hq/domain/console-target';
import type { buildNavFromTopology, NavClient } from '@hq/domain/fleet-nav-tree';
import type { HqTranscriptEntry } from '@wrongstack/hq';

export type DeliveryMode = 'steer' | 'btw' | 'queue';

export interface CommandReceipt {
  commandId: string;
  type: DeliveryMode | 'abort';
  target: string;
  preview: string;
  createdAt: string;
}

export const MAX_RECEIPTS = 8;
/**
 * How close in time a transcript entry must be to a receipt to count as its
 * echo. Generous on purpose: a busy fleet can take a while to round-trip, and
 * showing a message twice is worse than showing the optimistic copy longer.
 */
const RECEIPT_ECHO_WINDOW_MS = 120_000;

/** Receipts whose message has not yet come back through the transcript. */
export function pendingReceipts(
  receipts: readonly CommandReceipt[],
  entries: readonly HqTranscriptEntry[],
): CommandReceipt[] {
  return receipts.filter((receipt) => {
    if (receipt.type === 'abort') return true;
    const sentAt = Date.parse(receipt.createdAt);
    return !entries.some(
      (entry) =>
        entry.role === 'user' &&
        entry.text.trim() === receipt.preview &&
        Math.abs(Date.parse(entry.ts) - sentAt) < RECEIPT_ECHO_WINDOW_MS,
    );
  });
}

export type ChannelState = 'live' | 'mailbox' | 'read-only' | 'none';

export function channelState(target: ConsoleControlTarget | null): ChannelState {
  if (target === null) return 'none';
  if (target.controllable) return 'live';
  if (target.mailboxServeActive) return 'mailbox';
  return 'read-only';
}

export interface ProjectGroup {
  key: string;
  label: string;
  machines: string[];
  sessions: (NavClient & { machine: string })[];
}

/** Flatten machine → project → session into project groups, then filter. */
export function groupByProject(
  machines: ReturnType<typeof buildNavFromTopology>,
  query: string,
): ProjectGroup[] {
  const needle = query.trim().toLowerCase();
  const groups = new Map<string, ProjectGroup>();
  for (const machine of machines) {
    for (const project of machine.projects) {
      for (const client of project.clients) {
        const haystack = [
          project.label,
          machine.label,
          client.label,
          client.clientKind ?? '',
          ...client.agents.map((agent) => agent.label),
        ]
          .join(' ')
          .toLowerCase();
        if (needle.length > 0 && !haystack.includes(needle)) continue;
        const group = groups.get(project.label) ?? {
          key: project.label,
          label: project.label,
          machines: [],
          sessions: [],
        };
        if (!group.machines.includes(machine.label)) group.machines.push(machine.label);
        group.sessions.push({ ...client, machine: machine.label });
        groups.set(project.label, group);
      }
    }
  }
  return [...groups.values()].sort((left, right) => left.label.localeCompare(right.label));
}

export interface AgentFacts {
  model: string | undefined;
  /** Context window fill, 0–100, when the client reports it. */
  contextPct: number | undefined;
  contextTone: 'ok' | 'warn' | 'bad';
  /** "182k in · 24.5k out", when tokens are known. */
  tokens: string | undefined;
  costUsd: number | undefined;
}

function compact(value: number): string {
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}M`;
  if (value >= 1_000) return `${Number((value / 1_000).toFixed(1))}k`;
  return String(Math.round(value));
}

/**
 * What the console header says about the agent on screen. A session view
 * describes its leader; an agent the client never reported yields nothing.
 */
export function agentFacts(
  session: ConsoleControlTarget['session'] | undefined,
  agent: ConsoleControlTarget['agent'] | undefined,
  agentId: string | null,
): AgentFacts | null {
  const subject =
    agent ?? (agentId === null ? session?.agents?.find((a) => a.id === 'leader') : undefined);
  if (subject === undefined || subject === null) return null;
  const pct =
    typeof subject.ctxPct === 'number' && Number.isFinite(subject.ctxPct)
      ? Math.min(100, Math.max(0, Math.round(subject.ctxPct)))
      : undefined;
  const tokens =
    subject.tokensIn !== undefined || subject.tokensOut !== undefined
      ? `${compact(subject.tokensIn ?? 0)} in · ${compact(subject.tokensOut ?? 0)} out`
      : undefined;
  return {
    model: subject.model,
    contextPct: pct,
    contextTone: pct === undefined || pct < 80 ? 'ok' : pct < 95 ? 'warn' : 'bad',
    tokens,
    costUsd: subject.costUsd,
  };
}
