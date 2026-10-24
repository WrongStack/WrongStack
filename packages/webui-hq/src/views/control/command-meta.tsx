import type { HqCommandAuditEntry } from '@wrongstack/hq';
import {
  Bot,
  ListPlus,
  Megaphone,
  MessageSquareText,
  OctagonX,
  SquareTerminal,
  TriangleAlert,
  Zap,
} from 'lucide-react';
import type * as React from 'react';
import type { ControlCommandType } from '../../domain/control-draft.js';

export type Stage = 'compose' | 'preview';

export interface CommandsResponse {
  commands: HqCommandAuditEntry[];
}

/** What each command type does — rendered on the type cards so the plane
 *  explains itself instead of presenting seven bare words. */
export const COMMAND_META: Record<
  ControlCommandType,
  { label: string; icon: React.ElementType; description: string; danger?: boolean }
> = {
  steer: {
    label: 'steer',
    icon: Zap,
    description: 'High-priority course correction — interrupts the agent at the next safe turn.',
  },
  btw: {
    label: 'btw',
    icon: MessageSquareText,
    description: 'Non-urgent FYI — rides alongside the run without interrupting it.',
  },
  queue: {
    label: 'queue',
    icon: ListPlus,
    description: 'Queue a prompt — picked up after the current run finishes.',
  },
  abort: {
    label: 'abort',
    icon: OctagonX,
    description: 'Stop the leader run, or every subagent on the client. Destructive.',
    danger: true,
  },
  spawn: {
    label: 'spawn',
    icon: Bot,
    description: 'Launch a role subagent (bug-hunter, critic, …) with an optional task.',
  },
  broadcast: {
    label: 'broadcast',
    icon: Megaphone,
    description: 'Mailbox message to every agent in the client’s project.',
  },
  'run-command': {
    label: 'run-command',
    icon: SquareTerminal,
    description:
      'Route a shell command to the client. Gated on --hq-allow-exec plus control.execute.',
    danger: true,
  },
};

export const COMMAND_TYPES = Object.keys(COMMAND_META) as ControlCommandType[];

export const SPAWN_ROLES = [
  'bug-hunter',
  'refactor-planner',
  'critic',
  'security-scanner',
  'code-reviewer',
];

export function DangerNote({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <p className="flex items-start gap-1.5 border border-destructive/40 bg-destructive/5 px-2 py-1.5 text-[11px] text-destructive">
      <TriangleAlert className="mt-px size-3 shrink-0" />
      <span>{children}</span>
    </p>
  );
}
