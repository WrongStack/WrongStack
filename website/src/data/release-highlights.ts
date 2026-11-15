/** Curated public release copy; the version guard requires a refresh on every release. */
export const releaseHighlights = {
  version: '1.7.3',
  title: 'Nothing left behind after an update.',
  summary:
    'After an update, a newer client asks Chronicle, Kanban, Session Catalog, SAGE and mailbox daemons of an older release to stop and starts its own, and Windows desktops retire engine hosts that earlier builds left running. Long timers stay within platform limits, scoped grep globs keep their search root, and lookups and paths reject inherited properties and escaping symlinks.',
  socialDescription:
    'WrongStack 1.7.3: updated clients replace project daemons and desktop engine processes left by earlier releases, with timer, search and path-safety fixes.',
  cards: [
    {
      title: 'Daemons follow the update',
      body: 'A client of a newer release replaces project daemons of an older one; daemons of the same or a newer release are reused, so mixed installations converge on the newest.',
      href: '/getting-started',
      linkLabel: 'Upgrade your installation',
    },
    {
      title: 'Clean Windows desktops',
      body: 'Hosts and engine processes that earlier desktop builds left running are retired, while development builds and other running desktops are kept.',
      href: '/interfaces',
      linkLabel: 'Explore the interfaces',
    },
    {
      title: 'Timers, search and paths',
      body: 'Long deadlines are chunked within platform timer limits, grep globs keep their search root, and checkpoint and symlink paths cannot escape the project.',
      href: '/security',
      linkLabel: 'Explore the safeguards',
    },
  ],
} as const;
