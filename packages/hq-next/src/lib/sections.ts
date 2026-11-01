/**
 * The HQ information architecture: six sections, each with its own tabs.
 *
 * Every legacy `HqViewId` maps to exactly one URL, so a view that still calls
 * `setActiveView()` lands on a real, shareable address and the browser's back
 * button keeps working. The router, the rail, the tabs and the command palette
 * all read this one table.
 */
import type { HqViewId } from '@hq/data/store/index';
import {
  Activity,
  Inbox,
  KanbanSquare,
  LayoutDashboard,
  type LucideIcon,
  Network,
  ServerCog,
} from 'lucide-react';

export type HqSectionId = 'overview' | 'fleet' | 'work' | 'inbox' | 'telemetry' | 'system';

export interface HqTab {
  view: HqViewId;
  label: string;
  href: string;
}

export interface HqSection {
  id: HqSectionId;
  label: string;
  summary: string;
  icon: LucideIcon;
  /** Alt+<digit> jump. */
  shortcut: number;
  tabs: readonly HqTab[];
}

export const HQ_SECTIONS: readonly HqSection[] = [
  {
    id: 'overview',
    label: 'Overview',
    summary: 'What needs you now, and what the fleet is doing.',
    icon: LayoutDashboard,
    shortcut: 1,
    tabs: [{ view: 'cockpit', label: 'Overview', href: '/' }],
  },
  {
    id: 'fleet',
    label: 'Fleet',
    summary: 'Machines, projects, sessions and agents, live.',
    icon: Network,
    shortcut: 2,
    tabs: [
      { view: 'fleet', label: 'Map', href: '/fleet/' },
      { view: 'machines', label: 'Machines', href: '/fleet/machines/' },
      { view: 'projects', label: 'Projects', href: '/fleet/projects/' },
      { view: 'console', label: 'Console', href: '/fleet/console/' },
    ],
  },
  {
    id: 'work',
    label: 'Work',
    summary: 'Project boards and cross-project messages.',
    icon: KanbanSquare,
    shortcut: 3,
    tabs: [
      { view: 'kanban', label: 'Kanban', href: '/work/' },
      { view: 'mailbox', label: 'Mailbox', href: '/work/mailbox/' },
    ],
  },
  {
    id: 'inbox',
    label: 'Inbox',
    summary: 'Decisions waiting on a human, alerts and failures.',
    icon: Inbox,
    shortcut: 4,
    tabs: [
      { view: 'approvals', label: 'Queue', href: '/inbox/' },
      { view: 'alerts', label: 'Alert history', href: '/inbox/alerts/' },
    ],
  },
  {
    id: 'telemetry',
    label: 'Telemetry',
    summary: 'Spend, activity over time, finished sessions, the event archive and decisions.',
    icon: Activity,
    shortcut: 5,
    tabs: [
      { view: 'cost', label: 'Cost', href: '/telemetry/' },
      { view: 'trends', label: 'Trends', href: '/telemetry/trends/' },
      { view: 'sessions', label: 'Sessions', href: '/telemetry/sessions/' },
      { view: 'events', label: 'Event log', href: '/telemetry/events/' },
      { view: 'brain', label: 'Brain', href: '/telemetry/brain/' },
    ],
  },
  {
    id: 'system',
    label: 'System',
    summary: 'Remote commands, worktrees, MCP servers, notifications and access control.',
    icon: ServerCog,
    shortcut: 6,
    tabs: [
      { view: 'control', label: 'Control', href: '/system/' },
      { view: 'worktree', label: 'Worktrees', href: '/system/worktrees/' },
      { view: 'mcp', label: 'MCP', href: '/system/mcp/' },
      { view: 'notifications', label: 'Notifications', href: '/system/notifications/' },
      { view: 'settings', label: 'Security', href: '/system/security/' },
    ],
  },
];

const VIEW_HREF = new Map<HqViewId, string>(
  HQ_SECTIONS.flatMap((section) => section.tabs.map((tab) => [tab.view, tab.href] as const)),
);

export function hrefForView(view: HqViewId): string {
  return VIEW_HREF.get(view) ?? '/';
}

/** Normalise `/fleet` and `/fleet/` (and an exported `/fleet/index.html`). */
export function normalizePath(pathname: string): string {
  const stripped = pathname.replace(/index\.html$/, '');
  return stripped.endsWith('/') ? stripped : `${stripped}/`;
}

export function sectionForPath(pathname: string): HqSection {
  const path = normalizePath(pathname);
  if (path === '/') return HQ_SECTIONS[0]!;
  return (
    HQ_SECTIONS.find(
      (section) => section.id !== 'overview' && path.startsWith(`/${section.id}/`),
    ) ?? HQ_SECTIONS[0]!
  );
}

export function tabForPath(pathname: string): HqTab {
  const path = normalizePath(pathname);
  const section = sectionForPath(path);
  return section.tabs.find((tab) => tab.href === path) ?? section.tabs[0]!;
}
