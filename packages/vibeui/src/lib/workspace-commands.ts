import type { ResourceTab } from '../components/resource-hub';

export interface WorkspaceCommand {
  id: string;
  title: string;
  detail: string;
  disabled?: boolean;
  run: () => void;
}

export type WorkspacePanelTab = 'changes' | 'tasks' | 'agents';

/** Side effects the quick-actions palette can trigger; the workspace owns them. */
export interface WorkspaceCommandActions {
  openGuide: () => void;
  focusMessage: () => void;
  newSession: () => void;
  openHistory: () => void;
  searchConversation: () => void;
  openFiles: () => void;
  openPanel: (tab: WorkspacePanelTab) => void;
  openResources: (tab: ResourceTab) => void;
  openProviders: () => void;
  openContext: () => void;
  openInstructions: () => void;
  openSettings: () => void;
  toggleTheme: () => void;
  requestStop: () => void;
  switchSession: (id: string) => void;
}

const PANEL_TABS: readonly WorkspacePanelTab[] = ['changes', 'tasks', 'agents'];
const RESOURCE_TABS: readonly ResourceTab[] = ['prompts', 'skills', 'tools', 'mcp', 'memory'];

const capitalize = (value: string) => value[0]!.toUpperCase() + value.slice(1);

/** The quick-actions palette entries, in display order, with their lock gating. */
export function buildWorkspaceCommands(input: {
  locked: boolean;
  canStop: boolean;
  activeSessionId: string;
  sessions: readonly { id: string; title: string }[];
  actions: WorkspaceCommandActions;
}): WorkspaceCommand[] {
  const { actions, locked } = input;
  return [
    {
      id: 'guide',
      title: 'Getting started',
      detail: 'A friendly guide to your creative workspace',
      run: actions.openGuide,
    },
    {
      id: 'chat',
      title: 'Focus message',
      detail: 'Return to the composer',
      run: actions.focusMessage,
    },
    {
      id: 'new',
      title: 'New session',
      detail: 'Start a fresh conversation',
      disabled: locked,
      run: actions.newSession,
    },
    {
      id: 'history',
      title: 'Session history',
      detail: 'Find and resume a project conversation',
      run: actions.openHistory,
    },
    {
      id: 'find',
      title: 'Search conversation',
      detail: 'Ctrl/Cmd+Shift+F · Find loaded messages',
      run: actions.searchConversation,
    },
    {
      id: 'files',
      title: 'Files',
      detail: 'Browse project files and previews',
      run: actions.openFiles,
    },
    ...PANEL_TABS.map((tab) => ({
      id: tab,
      title: capitalize(tab),
      detail: 'Open workspace panel',
      run: () => actions.openPanel(tab),
    })),
    ...RESOURCE_TABS.map((tab) => ({
      id: tab,
      title: tab === 'mcp' ? 'MCP connections' : capitalize(tab),
      detail: 'Open workspace resources',
      run: () => actions.openResources(tab),
    })),
    {
      id: 'providers',
      title: 'Providers & accounts',
      detail: 'API keys and subscription sign-in',
      run: actions.openProviders,
    },
    {
      id: 'context',
      title: 'Context window',
      detail: 'Tokens, cache and conversation content',
      run: actions.openContext,
    },
    {
      id: 'instructions',
      title: 'Personal instructions',
      detail: 'Review and edit global agent instructions',
      run: actions.openInstructions,
    },
    {
      id: 'settings',
      title: 'Settings',
      detail: 'Ctrl/Cmd+, · Agent behavior and appearance',
      run: actions.openSettings,
    },
    {
      id: 'theme',
      title: 'Toggle appearance',
      detail: 'Switch light / dark theme',
      run: actions.toggleTheme,
    },
    {
      id: 'stop',
      title: 'Stop all tasks',
      detail: 'Stop this session and its agents; pause queued messages',
      disabled: !input.canStop,
      run: actions.requestStop,
    },
    ...input.sessions.map((session) => ({
      id: `session-${session.id}`,
      title: session.title,
      detail: 'Resume session',
      disabled: locked,
      run: () => {
        if (session.id !== input.activeSessionId) actions.switchSession(session.id);
      },
    })),
  ];
}
