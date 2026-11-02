/**
 * What the command palette lists and searches.
 *
 * The rows come from the section table in `lib/sections.ts`, the same table
 * the rail and the tabs read, so the palette always names a surface the way
 * the navigation does. This file only adds a description and an icon per view;
 * the `Record` makes a new view without them a compile error.
 */
import {
  BellRing,
  BrainCircuit,
  ChartNoAxesCombined,
  CircleDollarSign,
  Columns3,
  FolderGit2,
  GitBranch,
  HeartPulse,
  History,
  Inbox,
  LayoutDashboard,
  type LucideIcon,
  MessageSquareText,
  Monitor,
  Network,
  Plug,
  RadioTower,
  Send,
  Settings2,
  ShieldQuestion,
} from 'lucide-react';
import { HQ_SECTIONS } from '../../../lib/sections';
import type { HqViewId } from '../../data/store/index.js';

export interface HqViewDefinition {
  id: HqViewId;
  /** "Fleet · Console"; a section's only tab is named once. */
  title: string;
  description: string;
  icon: LucideIcon;
}

const DETAIL: Record<HqViewId, { description: string; icon: LucideIcon }> = {
  cockpit: {
    description: 'What needs you, what is running, projects and system health.',
    icon: LayoutDashboard,
  },
  fleet: {
    description: 'Machines, projects, terminals and agents as a list or a graph.',
    icon: Network,
  },
  machines: {
    description: 'Each machine: its clients and releases, projects, spend and what it needs.',
    icon: Monitor,
  },
  projects: {
    description: 'Each project across its machines: open sessions, spend, mail and what it needs.',
    icon: FolderGit2,
  },
  health: {
    description:
      'Every machine side by side: project disk and memory over 7 days, soonest full first.',
    icon: HeartPulse,
  },
  console: {
    description: 'Read any session’s transcript and steer, queue or interrupt it.',
    icon: MessageSquareText,
  },
  kanban: {
    description: 'Boards per project; move, assign and dispatch tasks.',
    icon: Columns3,
  },
  mailbox: {
    description: 'Agent mail across projects; read, reply and compose.',
    icon: Inbox,
  },
  approvals: {
    description: 'Permission prompts and questions waiting for an answer.',
    icon: ShieldQuestion,
  },
  alerts: {
    description: 'Every alert episode, active and resolved, by rule.',
    icon: BellRing,
  },
  cost: {
    description: 'Spend by project, session and model.',
    icon: CircleDollarSign,
  },
  trends: {
    description: 'Cost and token use over time.',
    icon: ChartNoAxesCombined,
  },
  events: {
    description: 'The persisted event log, filtered by type, source and time.',
    icon: History,
  },
  brain: {
    description: 'Autonomous decisions, escalations and interventions.',
    icon: BrainCircuit,
  },
  control: {
    description: 'Send a reviewed command to a session and audit past ones.',
    icon: RadioTower,
  },
  worktree: {
    description: 'Isolated git checkouts per project and how they merged.',
    icon: GitBranch,
  },
  mcp: {
    description: 'Health, latency and failures of every MCP server the terminals run.',
    icon: Plug,
  },
  sessions: {
    description:
      'Every session that ended: where it ran, how long, its cost, and whether HQ lost it.',
    icon: History,
  },
  notifications: {
    description:
      'Push alerts, machines going offline and waiting approvals to ntfy, Slack, Discord or a webhook.',
    icon: Send,
  },
  settings: {
    description: 'Password, two-factor sign-in, sessions and the access log.',
    icon: Settings2,
  },
};

const HQ_VIEWS: readonly HqViewDefinition[] = HQ_SECTIONS.flatMap((section) =>
  section.tabs.map((tab) => ({
    id: tab.view,
    title: section.tabs.length === 1 ? section.label : `${section.label} · ${tab.label}`,
    ...DETAIL[tab.view],
  })),
);

/** Every word must match the title or the description, in any order. */
export function searchHqViews(query: string): readonly HqViewDefinition[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return HQ_VIEWS;
  return HQ_VIEWS.filter((view) => {
    const haystack = `${view.title} ${view.description}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}
