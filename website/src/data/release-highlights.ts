/** Curated public release copy; the version guard requires a refresh on every release. */
export const releaseHighlights = {
  version: '1.7.6',
  title: 'Keys that land once.',
  summary:
    "TUI editing keys now go through Ink's own parser, so Home/End fire once and editing holds up when a PTY or WebSocket splits escape sequences; paste stays isolated in browser terminals. Persisted files written with a byte order mark load, malformed JSON roots are reported instead of crashing, and dependency audits parse Cargo workspaces, wheel and sdist names, PEP 508 ranges and pubspec blocks.",
  socialDescription:
    'WrongStack 1.7.6: TUI editing that holds up in browser terminals, BOM-tolerant locks and manifests, and dependency audits that read real workspace manifests.',
  cards: [
    {
      title: 'TUI input that holds',
      body: 'Home/End fire once, editing survives split escape sequences, and pastes stay data until Enter, including in browser terminals.',
      href: '/interfaces',
      linkLabel: 'Explore the interfaces',
    },
    {
      title: 'Files that load',
      body: 'BOM-prefixed locks, registries, prompts, caches and manifests are read, and malformed JSON roots are reported instead of crashing.',
      href: '/getting-started',
      linkLabel: 'Upgrade your installation',
    },
    {
      title: 'Real dependency manifests',
      body: 'Cargo virtual workspaces, wheel and sdist names, PEP 508 ranges and pubspec blocks are parsed, so audits see real changes.',
      href: '/security',
      linkLabel: 'Explore the safeguards',
    },
  ],
} as const;
