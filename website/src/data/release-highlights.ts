/** Curated public release copy; the version guard requires a refresh on every release. */
export const releaseHighlights = {
  version: '1.7.1',
  title: 'Updates that keep your place.',
  summary:
    'The desktop checks for new releases and verifies version-bound signatures before installing Windows and macOS updates. Upgrade from 1.7.0 manually once to enable that path. Session replay, streaming buffers, file recovery and background cleanup also gain focused reliability fixes.',
  socialDescription:
    'WrongStack 1.7.1: signed desktop updates, in-app update notices, safer session replay and streaming, and file recovery that preserves your work.',
  cards: [
    {
      title: 'Updates from the desktop',
      body: 'Check for a new release in Appearance, put it off with Later, or install a verified Windows/macOS update while the separate session host keeps conversations running.',
      href: '/interfaces',
      linkLabel: 'Explore the interfaces',
    },
    {
      title: 'Signed for the version you install',
      body: 'Release publication verifies all four Windows/macOS updater targets and their signed versions before exposing the update manifest. Linux keeps its package-manager flow.',
      href: '/security',
      linkLabel: 'Explore the safeguards',
    },
    {
      title: 'Move from 1.7.0 once',
      body: 'Run wstack update, then wstack desktop update to install the first desktop with the updater public key. Later signed releases can install from the application.',
      href: '/getting-started',
      linkLabel: 'Upgrade your installation',
    },
  ],
} as const;
