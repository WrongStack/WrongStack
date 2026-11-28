/** Curated public release copy; the version guard requires a refresh on every release. */
export const releaseHighlights = {
  version: '1.7.25',
  title: 'GitHub pull requests and issues, inside WrongStack.',
  summary:
    "WebUI and Desktop list the project's pull requests and issues, review diffs line by line, approve, merge and comment, and hand an item to the agent. Desktop v2 gets a quick model switcher, a graphed context panel and a redesigned shell.",
  socialDescription:
    'WrongStack 1.7.25: GitHub pull requests and issues in WebUI and Desktop, a quick model switcher and a redesigned Desktop v2.',
  cards: [
    {
      title: 'GitHub in your project',
      body: 'Review pull request diffs line by line, send comments as one review, approve, merge, close or re-run failed checks. Every write is pinned to the head you saw.',
      href: '/interfaces',
      linkLabel: 'Explore the interfaces',
    },
    {
      title: 'Quick model switcher',
      body: "Desktop's model chip shows each provider and ACP agent with the one fact that decides the pick: a missing key, quota left, or when a limit resets.",
      href: '/interfaces',
      linkLabel: 'See the desktop app',
    },
    {
      title: 'Desktop v2 redesign',
      body: 'A canvas shell around one workspace card, a graphed context panel, stat tiles and a choice of soft or sharp corners.',
      href: '/getting-started',
      linkLabel: 'Upgrade your installation',
    },
  ],
} as const;
