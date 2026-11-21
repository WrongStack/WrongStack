/** Curated public release copy; the version guard requires a refresh on every release. */
export const releaseHighlights = {
  version: '1.7.15',
  title: 'Adaptive thinking, tool groups, searchable settings.',
  summary:
    'Claude 5 models get adaptive thinking, and sessions and projects can turn whole tool groups on or off. Browser automation moves into its own package, desktop settings become a searchable workspace, and a round of robustness fixes covers long file names, hook bodies and handshake errors.',
  socialDescription:
    'WrongStack 1.7.15: Claude 5 adaptive thinking, sessions choose their tool groups, and desktop settings become a searchable workspace.',
  cards: [
    {
      title: 'Adaptive thinking',
      body: 'Claude 5 models think adaptively, and the prompt cache keeps its 1-hour entries ahead of 5-minute ones.',
      href: '/getting-started',
      linkLabel: 'Upgrade your installation',
    },
    {
      title: 'Tool groups',
      body: 'A session or project can turn whole groups of tools on or off, from /tool or the WebUI Tools settings.',
      href: '/interfaces',
      linkLabel: 'Explore the interfaces',
    },
    {
      title: 'Searchable settings',
      body: 'Desktop settings become a searchable workspace, and a project can be moved from a dialog.',
      href: '/interfaces',
      linkLabel: 'Explore the desktop',
    },
  ],
} as const;
