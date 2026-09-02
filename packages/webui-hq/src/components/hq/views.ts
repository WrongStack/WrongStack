/**
 * The view registry — one table the router, the nav, the command palette and
 * the keyboard shortcuts all read.
 *
 * Adding a surface means adding a row here and a lazy import below; nothing
 * else in the shell needs to change.
 */
import {
  BellRing,
  BrainCircuit,
  ChartNoAxesCombined,
  CircleDollarSign,
  Columns3,
  GitBranch,
  Inbox,
  LayoutDashboard,
  type LucideIcon,
  MessageSquareText,
  Network,
  RadioTower,
  Settings2,
} from 'lucide-react';
import type { HqViewId } from '../../data/store/index.js';

export type HqViewGroup = 'Operations' | 'Intelligence' | 'System';

export interface HqViewDefinition {
  id: HqViewId;
  label: string;
  eyebrow: string;
  description: string;
  group: HqViewGroup;
  icon: LucideIcon;
  /** Alt+<digit> jump. 0 means Alt+0. */
  shortcut?: number;
}

export const HQ_VIEW_GROUPS: readonly HqViewGroup[] = ['Operations', 'Intelligence', 'System'];

export const HQ_VIEWS: readonly HqViewDefinition[] = [
  {
    id: 'cockpit',
    label: 'Cockpit',
    eyebrow: 'Fleet overview',
    description: 'Health, active work, alerts, cost and command shortcuts.',
    group: 'Operations',
    icon: LayoutDashboard,
    shortcut: 1,
  },
  {
    id: 'fleet',
    label: 'Fleet Map',
    eyebrow: 'Topology',
    description: 'Machines, projects, terminals and agents in one live graph.',
    group: 'Operations',
    icon: Network,
    shortcut: 2,
  },
  {
    id: 'console',
    label: 'Live Console',
    eyebrow: 'Transcripts',
    description: 'Stream and inspect session or agent conversations.',
    group: 'Operations',
    icon: MessageSquareText,
    shortcut: 3,
  },
  {
    id: 'mailbox',
    label: 'Mailbox',
    eyebrow: 'Coordination',
    description: 'Cross-project messages, unread work and direct delivery.',
    group: 'Operations',
    icon: Inbox,
    shortcut: 4,
  },
  {
    id: 'kanban',
    label: 'Kanban',
    eyebrow: 'Project work',
    description: 'Read-only project boards synchronized across clones and machines.',
    group: 'Operations',
    icon: Columns3,
  },
  {
    id: 'alerts',
    label: 'Attention',
    eyebrow: 'Operator inbox',
    description: 'Alerts, waiting agents, governance warnings and failed commands.',
    group: 'Intelligence',
    icon: BellRing,
    shortcut: 5,
  },
  {
    id: 'cost',
    label: 'Cost',
    eyebrow: 'Economics',
    description: 'Project, provider and model spending distribution.',
    group: 'Intelligence',
    icon: CircleDollarSign,
    shortcut: 6,
  },
  {
    id: 'trends',
    label: 'Trends',
    eyebrow: 'Telemetry',
    description: 'Cost, token and tool activity over time.',
    group: 'Intelligence',
    icon: ChartNoAxesCombined,
    shortcut: 7,
  },
  {
    id: 'brain',
    label: 'Brain',
    eyebrow: 'Decisions',
    description: 'Autonomous decisions, escalations and interventions.',
    group: 'Intelligence',
    icon: BrainCircuit,
    shortcut: 8,
  },
  {
    id: 'worktree',
    label: 'Worktrees',
    eyebrow: 'Workspace',
    description: 'Distributed branches, worktrees and ownership state.',
    group: 'System',
    icon: GitBranch,
    shortcut: 9,
  },
  {
    id: 'control',
    label: 'Control',
    eyebrow: 'Command plane',
    description: 'Steer, queue, broadcast and audit remote commands.',
    group: 'System',
    icon: RadioTower,
    shortcut: 0,
  },
  {
    id: 'settings',
    label: 'Security',
    eyebrow: 'Access control',
    description: 'Manage the HQ browser password, authentication and active credentials.',
    group: 'System',
    icon: Settings2,
  },
];

export function getHqView(id: HqViewId): HqViewDefinition {
  return HQ_VIEWS.find((view) => view.id === id) ?? HQ_VIEWS[0]!;
}

/** Fuzzy-ish palette search across every field an operator might type. */
export function searchHqViews(query: string): readonly HqViewDefinition[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return HQ_VIEWS;
  return HQ_VIEWS.filter((view) =>
    [view.label, view.eyebrow, view.description, view.group]
      .join(' ')
      .toLowerCase()
      .includes(needle),
  );
}
