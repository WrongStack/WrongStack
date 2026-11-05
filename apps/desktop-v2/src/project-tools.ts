/**
 * The project tools a project offers, and the groups they are shown in.
 *
 * One catalog feeds every menu that lists project surfaces — the sidebar's
 * tools launcher and the project's overview — so the two can never disagree
 * about a tool's name, icon or summary. The groups follow the WebUI's tools
 * launcher (work, knowledge, quality, system), which is the reference these
 * desktop menus are built on.
 *
 * A tool is a project page the tools open. The pinned views (files, changes,
 * memory, kanban) sit in the sidebar's project navigation, the live fleet sits
 * inside the agent workspace (the roster owns it, as the WebUI's roster owns
 * its live tab), and the overview promotes a few tools to featured cards.
 */
import {
  Activity,
  BarChart3,
  BookOpen,
  Box,
  Boxes,
  Building2,
  CalendarClock,
  Gauge,
  GitBranch,
  History,
  type LucideIcon,
  Mail,
  Network,
  Palette,
  ScanSearch,
  ShieldCheck,
  Target,
  Users,
  Workflow,
} from 'lucide-react';
import type { ProjectPage } from './useDesktop';

export type ProjectToolGroupId = 'work' | 'knowledge' | 'agents' | 'quality' | 'system';

export interface ProjectTool {
  /** The project page the tool opens. */
  id: ProjectPage;
  /** The tool's icon. Every tool has its own. */
  Icon: LucideIcon;
  /** The tool's one-line summary, a key in the desktop catalog. */
  summaryKey: string;
  /** The overview promotes this tool to a featured card of its own. */
  featured?: boolean;
}

export interface ProjectToolGroup {
  id: ProjectToolGroupId;
  tools: ProjectTool[];
}

const tool = (
  id: ProjectPage,
  Icon: LucideIcon,
  summaryKey: string,
  featured = false,
): ProjectTool => ({
  id,
  Icon,
  summaryKey,
  ...(featured ? { featured } : {}),
});

export const projectToolGroups: ProjectToolGroup[] = [
  {
    id: 'work',
    tools: [
      tool('goals', Target, 'overview.links.goals'),
      tool('sdd', Workflow, 'overview.links.sdd'),
      tool('kit', Box, 'overview.links.kit'),
      tool('skills', BookOpen, 'overview.links.skills'),
      tool('worktrees', GitBranch, 'overview.links.worktrees'),
      tool('automations', CalendarClock, 'overview.links.automations'),
    ],
  },
  {
    id: 'knowledge',
    tools: [
      tool('atlas', Network, 'overview.atlas.body', true),
      tool('chronicle', Activity, 'overview.links.chronicle'),
      tool('history', History, 'overview.links.history'),
      tool('techstack', Boxes, 'overview.links.techstack'),
    ],
  },
  {
    id: 'agents',
    tools: [
      tool('roster', Users, 'overview.links.roster'),
      tool('office', Building2, 'overview.links.office'),
      tool('mailbox', Mail, 'overview.links.mailbox'),
    ],
  },
  {
    id: 'quality',
    tools: [
      tool('reviews', ShieldCheck, 'overview.links.reviews'),
      tool('design', Palette, 'overview.links.design'),
      tool('deadcode', ScanSearch, 'overview.links.deadcode'),
    ],
  },
  {
    id: 'system',
    tools: [
      tool('analytics', BarChart3, 'overview.links.analytics'),
      tool('diagnostics', Gauge, 'overview.links.diagnostics'),
    ],
  },
];

/** Every project tool, in the order the menus show them. */
export const projectTools: ProjectTool[] = projectToolGroups.flatMap((group) => group.tools);

/**
 * The project page a tool stands for while it is open. The live fleet is the
 * roster's live view, so the roster tool stays marked while it is.
 */
export function owningTool(page: ProjectPage | undefined): ProjectPage | undefined {
  if (page === 'live-fleet') return 'roster';
  return page;
}
