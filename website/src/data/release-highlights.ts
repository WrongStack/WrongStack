/** Curated public release copy; the version guard requires a refresh on every release. */
export const releaseHighlights = {
  version: '1.7.2',
  title: 'The new engine, when you are ready.',
  summary:
    'After an update the desktop notices when conversations still run on the previous engine and offers to restart it; conversations stop gracefully and resume through Reconnect. 1.7.1 desktops can install this release in place, TUIs fit browser terminals and small panes, and fleet, OAuth, ACP and path-safety fixes close races and containment gaps.',
  socialDescription:
    'WrongStack 1.7.2: an engine restart that moves conversations onto an updated desktop, the first in-place desktop update, terminal-friendly TUI pickers and concurrency and path-safety fixes.',
  cards: [
    {
      title: 'Restart onto the new engine',
      body: 'When conversations still run on an earlier desktop engine, a notice offers to restart it after you confirm; conversations stop gracefully and resume through Reconnect.',
      href: '/interfaces',
      linkLabel: 'Explore the interfaces',
    },
    {
      title: 'The first in-place update',
      body: 'Desktops on 1.7.1 install this release from the update notice on Windows and macOS, verified against its signed version.',
      href: '/getting-started',
      linkLabel: 'Upgrade your installation',
    },
    {
      title: 'Terminals and safety',
      body: 'Browser terminals get portable glyphs and pickers fit small panes; fleet, OAuth, ACP and patch-containment fixes close races and gaps.',
      href: '/security',
      linkLabel: 'Explore the safeguards',
    },
  ],
} as const;
