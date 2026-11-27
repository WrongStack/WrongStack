/** Curated public release copy; the version guard requires a refresh on every release. */
export const releaseHighlights = {
  version: '1.7.23',
  title: 'A command palette for the desktop workbench.',
  summary:
    'Search commands, projects and sessions from one desktop palette. Open the session inspector without shifting the transcript, use project services from desktop-hosted ACP leaders, and navigate WebUI more easily with a keyboard or screen reader.',
  socialDescription:
    'WrongStack 1.7.23: a desktop command palette, ACP project services and better WebUI keyboard and screen-reader navigation.',
  cards: [
    {
      title: 'Desktop workbench',
      body: 'Use Ctrl+K to find commands, projects and sessions. Pick a model from your saved catalogs or type a model reference in settings.',
      href: '/interfaces',
      linkLabel: 'Explore the interfaces',
    },
    {
      title: 'ACP project services',
      body: 'Desktop-hosted ACP leaders can use project indexing, SAGE, Mailbox, Kanban and Intake.',
      href: '/acp',
      linkLabel: 'Use WrongStack over ACP',
    },
    {
      title: 'WebUI accessibility',
      body: 'Dialogs restore focus, tab groups respond to arrow keys, and screen readers announce loading states and icon controls.',
      href: '/getting-started',
      linkLabel: 'Upgrade your installation',
    },
  ],
} as const;
